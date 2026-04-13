# Plik: docs/mother-server.md

## Architektura serwera Mother (Lobby)

---

## Przegląd

`mother-lobby` to serwer pośredniczący między graczami a serwerami gry. Jego zadania:

1. **Serwowanie statycznych plików** gry (HTML, JS, obrazy, modele 3D)
2. **HTTP REST API** — rejestracja i logowanie kont graczy (Express.js)
3. **WebSocket Lobby** — lista aktywnych serwerów, zarządzanie kontem, dołączanie do gry (uWS)
4. **Pośrednictwo w dołączaniu** — generowanie tokenów jednorazowych do `child.js`

---

## Porty i frameworki

| Port | Framework | Cel |
|---|---|---|
| `9876` | Express.js | HTTP API (rejestracja, logowanie) + pliki statyczne |
| `3001` | uWebSockets.js | WebSocket — połączenia klientów lobby |

```javascript
// mother.js — CONFIG
const CONFIG = {
    HTTP_PORT:   9876,  // Express — REST API
    CLIENT_PORT: 3001,  // uWS — WebSocket lobby
    MONGO_URL:   process.env.MONGO_URL || 'mongodb://localhost:27017',
    REDIS_URL:   process.env.REDIS_URL || 'redis://localhost:6379',
    BCRYPT_ROUNDS: 10,  // ~100ms na hashowanie hasła
};
```

Zmienna `MONGO_URL` w Kubernetes pochodzi z Kubernetes Secret `cosmos-db-secret` (klucz `MONGO_URL`) — connection string do Azure CosmosDB. Nie jest wpisana jako literał w konfiguracji, żeby hasło nie trafiło do repozytorium.

---

## Sekwencja startu serwera

```javascript
connectDatabase()       // 1. MongoDB — potrzebne dla rejestracji/logowania
    .then(connectRedis) // 2. Redis — lista gier i subskrypcja lobby_update
    .then(function () {
        setupExpressApp();                    // 3. HTTP API (Express)
        c_man = new ClientManager(CONFIG.CLIENT_PORT); // 4. WebSocket (uWS)
    })
    .catch(function (err) {
        console.error('Startup error:', err);
        process.exit(1); // K8s zobaczy exit code 1 → restart pod
    });
```

Kolejność jest celowa — każdy krok zależy od poprzedniego. Przypisanie `c_man` odblokuje callback Redis `lobby_update` (guard `if (c_man)` w subskrypcji).

---

## Połączenie z bazami danych

### MongoDB (`connectDatabase`)

```javascript
async function connectDatabase() {
    const client = await MongoClient.connect(CONFIG.MONGO_URL);
    const db = client.db('gra');
    db_users = db.collection('users');
    await db_users.createIndex({ email: 1 }, { unique: true });
}
```

Indeks unikalny na `email`:
- **Unikalność:** MongoDB odrzuca `insertOne` gdy email już istnieje (error code `11000`)
- **Wydajność:** `findOne({ email })` działa w O(log n) zamiast O(n)

### Struktura dokumentu gracza w MongoDB

```json
{
  "_id":          "ObjectId (12 bajtów BSON)",
  "email":        "gracz@example.com",
  "password_hash": "$2b$10$...",
  "points":       10000000,
  "total_points": 10000000,
  "name":         "User8234521",
  "last_login":   "Date",
  "skin":         [3, 7, 12],
  "acc_data":     []
}
```

`points` — aktualna waluta (zmniejszana przez zakupy, zwiększana przez grę)
`total_points` — łącznie zarobione punkty, nigdy nie maleje (do rankingów globalnych)
`skin` — tablica zakupionych numerów skinów (sprawdzana przy dołączaniu do gry)

### Redis (`connectRedis`)

Dwa klienty, subskrypcja kanału `lobby_update`:

```javascript
async function connectRedis() {
    await redis.connect();
    await redisSub.connect();
    await redisSub.subscribe('lobby_update', () => {
        if (c_man) c_man.broadcast_games().catch(console.error);
    });
}
```

---

## HTTP API (Express.js — port 9876)

### `POST /auth/register`

```javascript
// Walidacja wejściowa
if (!email || !password || password.length < 4)
    return res.status(400).json({ error: '...' });

// Hashowanie hasła
const hash = await bcrypt.hash(password, CONFIG.BCRYPT_ROUNDS);

// Nowe konto z 10M punktów startowych
const newAccount = {
    email, password_hash: hash,
    points: 10000000, total_points: 10000000,
    name: 'User' + ((Math.random() * 0xffffff) | 0),
    last_login: new Date(), skin: [], acc_data: [],
};

const result = await db_users.insertOne(newAccount);
res.json({ id: result.insertedId.toString() });
```

| HTTP status | Znaczenie |
|---|---|
| `200` | Sukces — zwraca `{ id: "ObjectId" }` |
| `400` | Brak emaila/hasła lub hasło < 4 znaki |
| `409` | Email już zajęty (MongoDB error `11000`) |
| `500` | Błąd serwera |

### `POST /auth/login`

```javascript
const user = await db_users.findOne({ email });

if (!user) return res.status(401).json({ error: '...' });

const match = await bcrypt.compare(password, user.password_hash);
if (!match) return res.status(401).json({ error: '...' });

db_users.updateOne({ _id: user._id }, { $currentDate: { last_login: true } });
// bez await — logowanie daty nie jest krytyczne, odpowiedź natychmiast

res.json({ id: user._id.toString() });
```

**Bezpieczeństwo:** ten sam komunikat błędu dla "brak emaila" i "złe hasło" — uniemożliwia atakującemu sprawdzenie czy email jest zarejestrowany (user enumeration).

### Pliki statyczne

```javascript
app.get('/',         (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));
app.get('/ads.txt',  (req, res) => res.sendFile(path.join(PUBLIC, 'ads.txt')));
app.get('/lang',     (req, res) => res.send(req.headers['cf-ipcountry']));
app.use('/obj',  express.static(path.join(PUBLIC, 'obj')));   // modele 3D
app.use('/js',   express.static(path.join(PUBLIC, 'js')));    // JS klienta
app.use('/mp3',  express.static(path.join(PUBLIC, 'mp3')));   // dźwięki
app.use('/img',  express.static(path.join(PUBLIC, 'img')));   // tekstury
app.use('/site', express.static(path.join(PUBLIC, 'site')));  // CSS, fonty
```

`/lang` zwraca nagłówek Cloudflare `cf-ipcountry` — kod kraju ISO 3166 (np. `"PL"`, `"DE"`). Używany przez klienta do ustawienia języka UI.

---

## WebSocket Lobby — `ClientManager` (uWS, port 3001)

### Architektura

```javascript
function ClientManager(port) {
    this.app = uWS.App();
    this.app.ws('/*', { upgrade, open, message, close }).listen(port, cb);
    this.broadcast_games = async function () { /* ... */ };
    // + handlery wiadomości jako funkcje wewnętrzne
}
c_man = new ClientManager(CONFIG.CLIENT_PORT);
```

### Obsługa połączenia (`open`)

```javascript
open: function (ws) {
    ws.subscribe('lobby'); // dołącz do grupy uWS pub/sub

    // Wyślij listę gier natychmiast
    buildGamesPacket().then(buf => {
        try { ws.send(buf, true); } catch (_) {}
    });

    // Wyślij dane skinów (ceny + kolory) — typ 3
    ps.new_type(3);
    ps.s_int32_arr(SKIN_COSTS,  SKIN_COSTS.length);
    ps.s_int32_arr(SKIN_LIGHTS, SKIN_LIGHTS.length);
    ws.send(ps.get_buf(), true);
}
```

`ws.subscribe('lobby')` to **wewnętrzny** pub/sub uWS (nie Redis). Pozwala na `app.publish('lobby', buf, true)` — wysłanie bufora do wszystkich subskrybentów w jednym wywołaniu.

### Broadcast do wszystkich klientów (`broadcast_games`)

```javascript
this.broadcast_games = async function () {
    const buf = await buildGamesPacket(); // pobierz z Redis, spakuj binarnie
    self.app.publish('lobby', buf, true); // wyślij do WSZYSTKICH jednocześnie
};
```

Wywoływana przy każdym `lobby_update` z Redis — klienci widzą aktualizację listy serwerów w czasie rzeczywistym (np. `"EU-Phantom: 3/15"` → `"EU-Phantom: 4/15"`).

### Obsługa wiadomości (`message`)

```javascript
message: function (ws, message, isBinary) {
    const p = new packet_get();
    p.set_buffer(message);
    p.g_int8(); // pomiń pierwszy bajt
    switch (p.g_int8()) { // drugi bajt = typ
        case 0: handleJoinGame(p, ws);     break;
        case 1: handleFetchAccount(p, ws); break;
        case 2: handleBuySkin(p, ws);      break;
        case 3: handleChangeName(p, ws);   break;
        case 4: handleChangeName(p, ws);   break;
        case 5: handleReconnect(p, ws);    break;
        case 6: /* ręczny refresh listy */  break;
    }
}
```

---

## Handlery wiadomości WebSocket

### `handleJoinGame` (typ 0)

Główna logika dołączania gracza do serwera gry:

```javascript
function handleJoinGame(p, ws) {
    const gameId    = p.g_uint32();
    const name      = p.g_string16();
    const skinId    = p.g_uint8();
    const accountId = p.g_string(); // "" = gość

    // Sprawdź czy serwer nie jest pełny
    const gameData = await redis.hGetAll(`game:${gameId}`);
    if (parseInt(gameData.g_players_len) >= parseInt(gameData.g_players_lim)) return;

    const token = gen_id(); // losowy uint32

    // Wyślij token do child.js przez Redis
    await redis.publish(`join:${gameId}`, JSON.stringify({ token, name, skin_id, account }));

    // Wyślij token + IP + port do klienta z 50ms opóźnieniem
    // (daje czas child.js na przetworzenie tokenu zanim klient się połączy)
    setTimeout(() => ws.send(clientPacket, true), 50);
}
```

Dla skinów 1–5 (darmowych) gracz przechodzi bezpośrednio. Dla płatnych skinów (0, 6–22) wykonywane jest sprawdzenie w MongoDB: `{ _id: accountId, skin: skinId }` — czy gracz kupił wybrany skin.

### `handleBuySkin` (typ 2)

Atomowy zakup skina — jedna operacja `findOneAndUpdate` zamiast dwóch (bez race condition):

```javascript
db_users.findOneAndUpdate(
    {
        _id:    accountId,
        skin:   { $ne: buyId },       // gracz jeszcze nie ma tego skina
        points: { $gt: SKIN_COSTS[buyId] }, // ma wystarczająco punktów
    },
    {
        $inc:  { points: -SKIN_COSTS[buyId] }, // odejmij punkty
        $push: { skin: buyId },                // dodaj skin do kolekcji
    },
    { returnDocument: 'after' }
).then(result => { if (result) send_account(ws, result); });
```

### `handleChangeName` (typ 3/4)

```javascript
db_users.findOneAndUpdate(
    { _id: accountId },
    { $set: { name } },
    { returnDocument: 'after' }
).then(result => { if (result) send_account(ws, result); });
```

Walidacja: `!name || name.length >= 20` — maksymalnie 19 znaków.

### `handleReconnect` (typ 5)

Sprawdza czy serwer gry nadal żyje w Redis i odsyła aktualne dane konta:

```javascript
redis.exists(`game:${gameId}`).then(exists => {
    if (!exists) return null;
    return db_users.findOneAndUpdate(
        { _id: accountId },
        { $currentDate: { last_login: true } },
        { returnDocument: 'after' }
    );
}).then(result => { if (result) send_account(ws, result); });
```

---

## Stan globalny serwera

| Zmienna | Typ | Opis |
|---|---|---|
| `db_users` | `Collection` | Referencja do kolekcji MongoDB `users` |
| `c_man` | `ClientManager` | Instancja WebSocket serwera lobby |
| `ps` | `packet_set(1000)` | Globalny bufor do budowania pakietów wychodzących |
| `redis` | `RedisClient` | Klient do operacji i publish |
| `redisSub` | `RedisClient` | Klient wyłącznie do subscribe |

**Uwaga:** `ps` jest współdzielony w całym module — nie można go używać jednocześnie w dwóch miejscach. `buildGamesPacket()` tworzy własny lokalny `lps` żeby uniknąć konfliktu z `ps`.
