# Architektura Bazy Danych i Warstwy Cache

## Wprowadzenie

Projekt wykorzystuje dwie bazy danych z podziałem odpowiedzialności:

- **MongoDB** — trwały zapis danych graczy (konta, punkty, skiny)
- **Redis** — komunikacja między serwerami i stan aktywnych gier (w RAM, ulotne)

Warstwa logiki biznesowej to **mother.js** (Node.js) — orkiestruje operacje między klientem, MongoDB i Redis.

```
Przeglądarka ──WebSocket──► mother.js ──CRUD──► MongoDB (konta graczy)
                                      ──pub/sub─► Redis  (stan gier, tokeny)
child.js (serwer gry) ────────────────────────► Redis  (rejestracja, heartbeat)
```

---

## 1. MongoDB — Struktura Dokumentów

### 1.1 Baza danych i kolekcje

Baza danych: `gra`
Kolekcja: `users`

Tworzona automatycznie przy pierwszym połączeniu przez `connectDatabase()` w `mother.js`.

### 1.2 Schemat dokumentu gracza (`users`)

```json
{
  "_id":          "ObjectId(\"507f1f77bcf86cd799439011\")",
  "email":        "gracz@example.com",
  "password_hash":"$2b$10$XWxkV3q7YmJkVWJR...",
  "points":       15000,
  "total_points": 45000,
  "name":         "Kacper",
  "last_login":   "2024-01-15T12:34:56.789Z",
  "skin":         [3, 7, 12],
  "acc_data":     []
}
```

| Pole | Typ | Opis |
|------|-----|------|
| `_id` | `ObjectId` | Klucz główny MongoDB — generowany automatycznie |
| `email` | `string` | Email gracza — **unikalny indeks** (`createIndex({ email: 1 }, { unique: true })`) |
| `password_hash` | `string` | Hash bcrypt (rounds=10) — nigdy plaintext |
| `points` | `number` | Aktualna waluta — zmniejszana przy zakupach, zwiększana przez rozgrywkę |
| `total_points` | `number` | Łącznie zarobione — **nigdy nie maleje**, używane do rankingów globalnych |
| `name` | `string` | Nick wyświetlany nad postacią — zmienialny przez `handleChangeName()` |
| `last_login` | `Date` | Timestamp ostatniego logowania — aktualizowany przy każdym `handleFetchAccount()` |
| `skin` | `number[]` | Lista ID zakupionych skinów — np. `[3, 7, 12]` |
| `acc_data` | `string[]` | Zarezerwowane: osiągnięcia, tytuły, historia konta |

### 1.3 Indeksy

```javascript
// Tworzony przy starcie serwera (idempotentny — bezpieczny przy każdym restarcie):
await db_users.createIndex({ email: 1 }, { unique: true });
```

**Efekty indeksu:**
- `findOne({ email })` — O(log n) zamiast O(n) — szybkie nawet przy milionach kont
- Automatyczne odrzucenie duplikatów — `insertOne()` rzuca `err.code === 11000` gdy email zajęty

### 1.4 Co jest przechowywane na stałe

MongoDB przechowuje wyłącznie dane które muszą przetrwać restart serwerów:

| Dane | Operacja | Kiedy |
|------|----------|-------|
| Konto gracza | `insertOne` | Rejestracja (`POST /auth/register`) |
| Data logowania | `$currentDate` | Każde logowanie i `handleFetchAccount` |
| Punkty gracza | `$inc { points, total_points }` | Po śmierci gracza — child.js aktualizuje przez własne połączenie |
| Zakupiony skin | `$push { skin: buyId }` | Zakup w sklepie (`handleBuySkin`) |
| Nick gracza | `$set { name }` | Zmiana nazwy (`handleChangeName`) |

---

## 2. Redis — Struktura Kluczy i Danych

### 2.1 Klucze i typy danych

Redis w tym projekcie **nie przechowuje danych graczy** — służy jako magistrala komunikacyjna między serwerami.

#### Klucz: `game_ids` — SET aktywnych gier

```
Typ:    Redis SET
Klucz:  game_ids
Wartości: { "3482901234", "1234567890", "9876543210" }
```

Zapisywany przez `child.js` przy starcie serwera gry.
Odczytywany przez `mother.js` w `buildGamesPacket()`:

```javascript
const ids = await redis.sMembers('game_ids');
// Zwraca: ["3482901234", "1234567890"]
```

Dlaczego SET zamiast `KEYS game:*`? `SEMEMBERS` = O(n) gdzie n = liczba gier. `KEYS` skanuje całą bazę Redis — niebezpieczne przy dużej liczbie kluczy.

---

#### Klucz: `game:{id}` — HASH danych serwera gry

```
Typ:    Redis HASH
Klucz:  game:3482901234
Pola:
  g_port        → "30542"
  g_players_len → "5"
  g_players_lim → "15"
  serv_ip       → "34.89.123.45"
  serv_loc      → "EU"
  serv_name     → "EU-Phantom"
```

Zapisywany przez `child.js` przy rejestracji serwera gry.
Odczytywany przez `mother.js`:

```javascript
const g = await redis.hGetAll(`game:${id}`);
// Zwraca: { g_port: "30542", g_players_len: "5", ... }
// Uwaga: wszystkie wartości to STRINGI — parseInt() wymagane przy użyciu
```

---

### 2.2 Kanały Pub/Sub

Redis pub/sub służy do komunikacji w czasie rzeczywistym między procesami Node.js.

#### Kanał: `lobby_update`

```
Producent:  child.js  (publikuje "1" gdy zmienia się liczba graczy / nowa gra / gra znika)
Konsument:  mother.js (redisSub.subscribe → broadcast_games() do wszystkich klientów lobby)
```

```javascript
// child.js — po zmianie liczby graczy:
await redis.publish('lobby_update', '1');

// mother.js — reaguje:
await redisSub.subscribe('lobby_update', () => {
  if (c_man) c_man.broadcast_games(); // odśwież listę u wszystkich graczy w lobby
});
```

**Efekt:** Lista serwerów w lobby aktualizuje się automatycznie — gracz widzi `"EU-Phantom: 3/15"` zmieniające się na `"4/15"` bez odświeżania strony.

---

#### Kanał: `join:{game_id}`

```
Producent:  mother.js (publikuje token gdy gracz klika PLAY)
Konsument:  child.js  (subskrybuje swój kanał → dodaje token do tokens{})
```

```javascript
// mother.js — gracz klika PLAY:
await redis.publish(`join:${gameId}`, JSON.stringify({
  token:   3482901234,  // losowy uint32
  name:    "Kacper",
  skin_id: 7,
  account: "507f1f77bcf86cd799439011"  // lub "" dla gościa
}));

// child.js — odbiera i zapamiętuje token:
redisSub.subscribe(`join:${game_id}`, (msg) => {
  const data = JSON.parse(msg);
  tokens[data.token] = data; // gracz może się teraz połączyć z serwerem gry
});
```

---

### 2.3 TTL (Time to Live) — wygasanie danych

| Klucz | TTL | Mechanizm |
|-------|-----|-----------|
| `game:{id}` | ~5 sekund | child.js odświeża co ~1s przez `EXPIRE game:{id} 5` (heartbeat). Brak heartbeatu (crash) → klucz wygasa automatycznie → serwer "znika" z listy |
| `game_ids` | brak | child.js usuwa swoje ID przy shutdown (`SREM game_ids {id}`) |
| Kanały pub/sub | — | Wiadomości pub/sub nie mają TTL — są "fire and forget" |

Mechanizm heartbeatu w `child.js`:
```javascript
// co ~1 sekundę:
await redis.expire(`game:${game_id}`, 5);
// Jeśli child.js crashnie → brak EXPIRE → klucz wygasa po 5s → serwer znika z listy
```

---

### 2.4 Dwa klienty Redis — dlaczego?

```javascript
const redis    = createClient({ url: CONFIG.REDIS_URL }); // operacje R/W + publish
const redisSub = createClient({ url: CONFIG.REDIS_URL }); // TYLKO subscribe
```

Protokół Redis: po wywołaniu `SUBSCRIBE` klient wchodzi w tryb "subscriber mode" — może tylko odbierać wiadomości, nie może wykonywać `GET`, `HGETALL`, `PUBLISH` itp. Dwa osobne połączenia TCP to wymaganie protokołu.

---

## 3. Rola mother.js — Orkiestracja

### 3.1 Kiedy uderza do MongoDB, kiedy do Redis

| Operacja | Cel | Funkcja |
|----------|-----|---------|
| Rejestracja konta | **MongoDB** `insertOne` | `POST /auth/register` |
| Logowanie | **MongoDB** `findOne` + `updateOne` (last_login) | `POST /auth/login` |
| Pobranie danych konta | **MongoDB** `findOneAndUpdate` | `handleFetchAccount` |
| Zakup skina | **MongoDB** `findOneAndUpdate` (atomowe) | `handleBuySkin` |
| Zmiana nicku | **MongoDB** `findOneAndUpdate` | `handleChangeName` |
| Lista serwerów | **Redis** `SMEMBERS` + `HGETALL` | `buildGamesPacket` |
| Dołączenie do gry | **Redis** `HGETALL` (weryfikacja) + `PUBLISH` (token) | `handleJoinGame` |
| Reconnect do gry | **Redis** `EXISTS` | `handleReconnect` |

### 3.2 Strategia cache'owania

W tym projekcie **nie stosuje się klasycznego Cache Aside** dla danych graczy — MongoDB jest jedynym źródłem prawdy dla kont.

Redis **nie jest cache'em danych graczy** — jest cache'em stanu aktywnych gier (zapisywanym przez child.js) i kanałem komunikacyjnym.

```
Dane gracza  → zawsze z MongoDB (bez pośrednika Redis)
Stan gier    → zawsze z Redis   (child.js jest właścicielem tych danych)
```

### 3.3 Atomowość operacji na MongoDB

Krytyczne operacje używają `findOneAndUpdate` zamiast osobnych `findOne` + `updateOne`:

```javascript
// NIEBEZPIECZNE (race condition przy zakupie):
const user = await db_users.findOne({ _id: accountId });
if (user.points > SKIN_COSTS[buyId]) {
  await db_users.updateOne(...); // między tymi dwoma operacjami może zajść drugi request!
}

// BEZPIECZNE (atomowe):
await db_users.findOneAndUpdate(
  { _id: accountId, points: { $gt: SKIN_COSTS[buyId] }, skin: { $ne: buyId } },
  { $inc: { points: -SKIN_COSTS[buyId] }, $push: { skin: buyId } },
  { returnDocument: 'after' }
);
// MongoDB wykonuje filtr + update jako jedna niepodzielna operacja
```

---

## 4. Przepływ Danych — Data Flow

### 4.1 Rejestracja gracza

```
Przeglądarka
  │  POST /auth/register { email, password }
  ▼
mother.js (Express)
  │  bcrypt.hash(password, 10)  → ~100ms
  │  db_users.insertOne({
  │    email, password_hash,
  │    points: 10_000_000,
  │    total_points: 10_000_000,
  │    name: "User8234521",
  │    skin: [], acc_data: []
  │  })
  ▼
MongoDB (users)
  │  Zapis dokumentu + weryfikacja unikalności email
  │  Zwraca: { insertedId: ObjectId }
  ▼
mother.js
  │  res.json({ id: "507f1f77..." })
  ▼
Przeglądarka
     Zapisuje id w localStorage → używa przy dalszych operacjach
```

---

### 4.2 Dołączenie do gry (token flow)

```
Przeglądarka
  │  WebSocket → mother.js: [type=0, gameId, nick, skinId, accountId]
  ▼
mother.js (handleJoinGame)
  │  1. redis.hGetAll("game:3482901234")
  │     → sprawdź czy serwer istnieje i nie jest pełny
  │
  │  2. (jeśli skin płatny) db_users.findOne({ _id: accountId, skin: skinId })
  │     → sprawdź czy gracz kupił ten skin
  │
  │  3. token = gen_id()  → losowy uint32
  │
  │  4. redis.publish("join:3482901234", JSON.stringify({ token, name, skin_id, account }))
  │     → wyślij token do child.js przez Redis pub/sub
  ▼
child.js (subskrybuje "join:3482901234")
  │  tokens[token] = { name, skin_id, account }
  │  → zapamiętuje token, gracz może się połączyć
  ▼
mother.js
  │  setTimeout(50ms)  → daj czas child.js na przetworzenie tokena
  │  ws.send([type=0, token, port, ip])
  ▼
Przeglądarka
     Łączy się: ws://34.89.123.45:30542/  z tokenem w pakiecie
```

---

### 4.3 Zapis punktów po śmierci gracza

```
child.js (serwer gry)
  │  Gracz ginie → oblicz zarobione punkty
  │  db_users.updateOne(
  │    { _id: accountId },
  │    { $inc: { points: earned, total_points: earned } }
  │  )
  ▼
MongoDB (users)
  │  Atomowa aktualizacja obu pól
  │  points += earned        (można wydać w sklepie)
  │  total_points += earned  (nigdy nie maleje — do rankingów)
  ▼
child.js
     Wysyła do gracza przez WebSocket: [type=12, gold: earned]
     → gracz widzi "Zarobiłeś X punktów"
```

**Uwaga:** child.js łączy się z MongoDB bezpośrednio (własne połączenie), nie przez mother.js. mother.js i child.js są niezależnymi procesami Node.js.

---

### 4.4 Aktualizacja listy serwerów w lobby (real-time)

```
child.js
  │  Co ~1 sekundę:
  │    redis.hSet("game:3482901234", "g_players_len", currentCount)
  │    redis.expire("game:3482901234", 5)
  │    redis.publish("lobby_update", "1")
  ▼
Redis pub/sub
  │  Dostarcza wiadomość do wszystkich subskrybentów "lobby_update"
  ▼
mother.js (redisSub)
  │  broadcast_games():
  │    ids = redis.sMembers("game_ids")
  │    dla każdego id: redis.hGetAll("game:{id}")
  │    buildGamesPacket() → bufor binarny
  │    app.publish("lobby", buf)  ← uWS pub/sub do wszystkich klientów
  ▼
Przeglądarki (wszyscy w lobby)
     Lista serwerów odświeża się automatycznie
     "EU-Phantom: 3/15" → "EU-Phantom: 4/15"
```
