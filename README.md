# 🔴 Redis Pub/Sub — jak zintegrowaliśmy `child.js` z `mother.js`

---

## 1. Dlaczego wybraliśmy Redis Pub/Sub?

Nasz system składa się z dwóch niezależnych procesów: serwera lobby (`mother.js`) i serwerów gry (`child.js`). Potrzebowaliśmy lekkiego, asynchronicznego kanału komunikacji między nimi — bez bezpośrednich połączeń TCP między procesami. Postawiliśmy na **Redis Pub/Sub**, bo daje nam gotowy broker wiadomości oparty na modelu kanałów:

- **Publisher** wysyła wiadomość na kanał — nie wie i nie musi wiedzieć, kto jej słucha.
- **Subscriber** nasłuchuje na kanale i reaguje na każdą nadchodzącą wiadomość.
- Redis pełni rolę brokera — odbiera wiadomość od wydawcy i natychmiast dostarcza ją do wszystkich aktywnych subskrybentów.

Zdecydowaliśmy się na ten wzorzec ze względu na kilka kluczowych właściwości, które pasowały do naszego przypadku:
- Komunikacja **fire-and-forget** — serwer gry wysyła sygnał i nie czeka na odpowiedź.
- Wiadomości **nie są buforowane** — jeśli subskrybent jest offline, traci wiadomość. W naszej architekturze to zachowanie jest pożądane.
- Klient Redis w trybie `subscribe` **nie może wykonywać innych komend** (np. `GET`, `SET`). Dlatego w każdym pliku tworzymy **dwa osobne klienty Redis**: jeden do publikowania i operacji na danych, drugi wyłącznie do nasłuchiwania.

> W efekcie Redis pełni w naszym projekcie rolę **magistrali zdarzeń (event bus)** łączącej lobby z serwerami gry bez żadnych bezpośrednich połączeń między nimi.

---

## 2. Kto publikuje, kto subskrybuje?

Zaprojektowaliśmy komunikację jako **dwukierunkową** — oba komponenty pełnią obie role, ale na różnych kanałach i w różnych celach.

### `child.js` — Serwer Gry

```
redis_pub  →  klient do PUBLISH i operacji na danych (hSet, sAdd, del, expire)
redis_sub  →  klient dedykowany wyłącznie do SUBSCRIBE
```

| Rola | Kanał | Co robimy |
|------|-------|-----------|
| **PUB** | `lobby_update` | Informujemy lobby o zmianach stanu gry |
| **SUB** | `join:{game_id}` | Nasłuchujemy na żądania dołączenia gracza |

### `mother.js` — Serwer Lobby

```
redis     →  klient do PUBLISH i operacji na danych (sMembers, hGetAll, exists)
redisSub  →  klient dedykowany wyłącznie do SUBSCRIBE
```

| Rola | Kanał | Co robimy |
|------|-------|-----------|
| **PUB** | `join:{game_id}` | Wysyłamy token dołączenia do konkretnego serwera gry |
| **SUB** | `lobby_update` | Nasłuchujemy na zmiany w liście dostępnych gier |

### Schemat ról

```
mother.js  ──PUB──►  join:{game_id}  ──SUB──►  child.js
child.js   ──PUB──►  lobby_update   ──SUB──►  mother.js
```

Komunikacja jest **dwukierunkowa, ale asymetryczna** — każdy kierunek używa innego kanału i służy innemu celowi.

---

## 3. Nasze dwa kanały komunikacyjne

### Kanał 1: `lobby_update`

```
Nadawca:    child.js
Odbiorcy:   mother.js (i wszystkie inne instancje nasłuchujące)
```

To kanał **globalny** — wiele serwerów gry może na niego publikować jednocześnie. Używamy go w trzech miejscach w `child.js`:

- `redis_connect()` — przy rejestracji nowej gry  
- `redis_cleanup()` — przy wyłączaniu serwera gry  
- `redis_update_player_count()` — przy każdej zmianie liczby graczy  

### Kanał 2: `join:{game_id}`

```
Nadawca:    mother.js
Odbiorcy:   konkretna instancja child.js o danym game_id
```

To kanał **per-instancja** — `game_id` to losowy 32-bitowy numer (Uint32), np. `join:3847291650`. Każdy serwer gry subskrybuje **tylko swój własny** kanał join. Dzięki temu `mother.js` może precyzyjnie zaadresować konkretny serwer gry bez wiedzy o jego fizycznym adresie.

---

## 4. Co wysyłamy w wiadomościach?

### Na kanale `lobby_update` (child.js → mother.js)

```javascript
await redis_pub.publish('lobby_update', '1');
```

Celowo wysyłamy tutaj tylko zwykły string `"1"` — to **sygnał, nie dane**. Zastosowaliśmy wzorzec *"Notification without payload"*: zamiast pakować dane do wiadomości, po odebraniu sygnału `mother.js` samo odpytuje Redis o aktualny stan. Treść wiadomości jest w callbacku celowo ignorowana.

### Na kanale `join:{game_id}` (mother.js → child.js)

```javascript
await redis.publish(`join:${gameId}`, JSON.stringify({
    token,
    name,
    skin_id: skinId,
    account: accountId ? accountId.toString() : '',
}));
```

Tu przesyłamy pełny JSON z danymi gracza, np.:

```json
{
    "token": 2947183650,
    "name": "PlayerXYZ",
    "skin_id": 3,
    "account": "64a1b2c3d4e5f6789abcdef0"
}
```

| Pole | Typ | Opis |
|------|-----|------|
| `token` | `number` (Uint32) | Jednorazowy token autoryzacyjny do połączenia WebSocket |
| `name` | `string` | Nazwa gracza (max 9 znaków) |
| `skin_id` | `number` (Uint8) | ID skórki wybranej przez gracza |
| `account` | `string` | ObjectId MongoDB konta gracza (lub `""` dla gości) |

---

## 4a. Jak mother.js wie, do której gry wysłać gracza?

To jeden z kluczowych elementów naszego projektu. Rozwiązaliśmy ten problem elegancko: **klient sam mówi `mother.js`, do której gry chce dołączyć**, podając `game_id` — a ID to pochodzi z listy, którą wcześniej dostał właśnie od `mother.js`.

### Pełny łańcuch: skąd pochodzi `game_id`

#### Krok 1 — child.js generuje swoje ID przy starcie

Każdy serwer gry przy uruchomieniu wywołuje `gen_id()` i zapamiętuje wynik:

```javascript
// child.js 
const game_id = gen_id();  // losowy Uint32, np. 3847291650
```

Jest to **unikalny identyfikator tej konkretnej instancji** serwera gry. Dwie różne instancje `child.js` mają różne `game_id` — kolizja jest astronomicznie mało prawdopodobna przy 32-bitowej losowości.

#### Krok 2 — child.js rejestruje się w Redis pod tym ID

```javascript
// child.js — funkcja redis_connect(),
await redis_pub.hSet(`game:${game_id}`, {
    g_port:        AGONES_PORT.toString(),
    g_players_len: "0",
    g_players_lim: MAX_PLAYERS.toString(),
    serv_ip:       AGONES_IP,
    serv_loc:      COUNTRY,
    serv_name:     SERVER_NAME,
});
await redis_pub.sAdd('game_ids', game_id.toString());
```

W Redis tworzymy dwie struktury:
- `SET game_ids` — zbiór wszystkich aktywnych `game_id`
- `HASH game:{id}` — szczegóły konkretnego serwera (port, IP, liczba graczy...)

#### Krok 3 — child.js subskrybuje kanał ze SWOIM ID

```javascript
// child.js 
await redis_sub.subscribe(`join:${game_id}`, (message) => { ... });
```

Każdy `child.js` nasłuchuje **tylko i wyłącznie** na `join:{własne_game_id}`. Wiadomości wysłane na `join:1234567890` dotrą tylko do instancji z `game_id = 1234567890`.

#### Krok 4 — mother.js czyta listę wszystkich gier i wysyła ją klientowi

```javascript
// mother.js — funkcja buildGamesPacket()
const ids   = await redis.sMembers('game_ids');
const games = [];
for (const id of ids) {
    const g = await redis.hGetAll(`game:${id}`);
    if (g && g.g_port) games.push({ id: parseInt(id), ...g });
}
// budujemy pakiet binarny i wysyłamy do klienta przez WebSocket
```

Klient otrzymuje listę, np.:

```javascript
[
  { id: 3847291650, players_len: 7,  players_lim: 15, serv_name: "EU-Nexus" },
  { id: 1234567890, players_len: 3,  players_lim: 15, serv_name: "EU-Titan" }
]
```

#### Krok 5 — klient wybiera grę i odsyła jej ID

Klient klika "EU-Nexus" i wysyła do `mother.js`:

```
joinGame(gameId=3847291650, name="Phantom", skinId=3, accountId="...")
```

`gameId` w tej wiadomości to dokładnie to samo ID, które `child.js` wygenerował w kroku 1.

#### Krok 6 — mother.js publikuje na kanał tego konkretnego child.js

```javascript
// mother.js — handleJoinGame(),
await redis.publish(`join:${gameId}`, JSON.stringify({ token, name, skin_id, account }));
//                          ↑
//                 3847291650 — ID przesłane przez klienta
```

Tylko `child.js` z `game_id = 3847291650` nasłuchuje na `join:3847291650` — tylko on odbierze wiadomość.

### Schemat przepływu ID

```
child.js (game_id=3847291650)
    │
    │── redis: hSet game:3847291650 {...}
    │── redis: sAdd game_ids "3847291650"
    │── redis: subscribe join:3847291650   ← czeka na wiadomości
    │
mother.js
    │── redis: sMembers game_ids          → ["3847291650", "1234567890"]
    │── redis: hGetAll game:3847291650    → { port, ip, players... }
    │── WS: send Type2 → Klient           → lista gier z ich ID
    │
Klient
    │── wybrał "EU-Nexus" (id=3847291650)
    │── WS: send joinGame(gameId=3847291650, ...) → mother.js
    │
mother.js
    │── redis: publish join:3847291650    ← celuje w konkretny child.js
    │
child.js (game_id=3847291650)
    └── odbiera! bo subskrybuje join:3847291650
```

---

## 4b. Token jednorazowy — jak go generujemy i przesyłamy

### Generowanie tokenu

Token generujemy w `mother.js`, wewnątrz `handleJoinGame()`, tuż przed opublikowaniem wiadomości w Redis:

```javascript
// mother.js — gen_id zdefiniowane na początku pliku 
const gen_id = (function () {
    const buf = new Uint32Array(1);
    return function () {
        buf[0] = Math.random() * 0xffffffff;
        return buf[0];
    };
})();

// handleJoinGame() 
const token = gen_id();
```

`gen_id()` to nasza prosta funkcja generująca losową liczbę całkowitą 32-bit:
- Używa `Uint32Array(1)` — pojedynczej komórki 32-bitowej bez znaku
- Mnoży `Math.random()` przez `0xffffffff` (4294967295)
- Przypisanie do `Uint32Array` automatycznie obcina wynik do zakresu **0 – 4294967295**

> Token **nie jest** UUID ani kryptograficznie bezpiecznym losowaniem — to `Math.random()`, wystarczający jako jednorazowy klucz wejścia. Nie stosujemy go w kontekstach wymagających bezpieczeństwa kryptograficznego.

### Wysyłamy token w dwóch miejscach jednocześnie

Token trafia zarówno do Redis, jak i do klienta — ale z celowym przesunięciem czasowym.

#### 1. Do Redisa (kanał `join:{gameId}`) 

```javascript
await redis.publish(`join:${gameId}`, JSON.stringify({
    token,
    name,
    skin_id: skinId,
    account: accountId ? accountId.toString() : '',
}));
```

Redis natychmiast dostarcza wiadomość do `child.js`, który zapamiętuje token w słowniku `tokens` w pamięci RAM.

#### 2. Do klienta (WebSocket) —   z opóźnieniem 50ms ⏱️

```javascript
ps.new_type(0);
ps.s_uint32(token);
ps.s_uint16(parseInt(gameData.g_port));
ps.s_string(gameData.serv_ip);
const clientPacket = Buffer.from(ps.get_buf());

setTimeout(() => {
    try { ws.send(clientPacket, true); } catch (_) {}
}, 50);  // ← celowe opóźnienie 50 milisekund
```

### Dlaczego dodaliśmy opóźnienie 50ms?

Rozwiązaliśmy w ten sposób **race condition**, który wykryliśmy w testach:

```
Bez opóźnienia — możliwy problem:

t=0ms   mother.js  PUBLISH join:{id} → Redis
t=1ms   mother.js  WS.send(token) → Klient
t=2ms   Klient     WS connect → child.js  // child.js JESZCZE nie odebrał z Redisa!
t=5ms   child.js   odbiera z Redisa, zapisuje token
                   → za późno, połączenie już odrzucone (401)

Z opóźnieniem 50ms — bezpieczne:

t=0ms   mother.js  PUBLISH join:{id} → Redis
t=1ms   child.js   odbiera z Redisa, zapisuje token  // Redis lokalny, ~1ms
t=50ms  mother.js  WS.send(token) → Klient
t=51ms  Klient     WS connect → child.js  // token już czeka w tokens{}
                   → połączenie akceptowane
```

50ms to nasz bufor bezpieczeństwa — zakładamy, że Redis zdąży dostarczyć wiadomość do `child.js` zanim klient zdąży otworzyć nowe połączenie WebSocket.

### Jak długo żyje token?

Token jest ważny przez **10000 klatek** liczonych od momentu odebrania przez `child.js`:

```javascript
// child.js 
tokens[data.token] = {
    token:    data.token,
    name:     data.name,
    skin_id:  data.skin_id,
    account:  data.account,
    timelive: frame + 10000,  // wygasa po 10000 tickach
};
```

Przy `SERVER_TICK_MS = 16ms` → 10000 × 16ms = **160 sekund (~2.7 minuty)**.

Tokeny czyścimy w game loop co 10000 klatek (`child.js`):

```javascript
if (!(frame % 10000)) {
    for (const i in tokens) {
        if (tokens[i].timelive < frame) {
            tokens[i] = null;
            delete tokens[i];
        }
    }
}
```

Token jest też **natychmiast usuwany po użyciu** — w momencie gdy gracz otworzy połączenie WebSocket (handler `open`):

```javascript
tokens[token_id] = null;
delete tokens[token_id];  // jednorazowy, nie można użyć dwa razy
```

---

## 5. Przepływ danych krok po kroku

### Przepływ A: Rejestracja serwera gry i aktualizacja lobby

```
child.js                     Redis                      mother.js
   │                            │                            │
   │── hSet game:{id} ─────────►│                            │
   │   (port, ip, players...)   │                            │
   │── expire game:{id} 5s ────►│                            │
   │── sAdd game_ids ──────────►│                            │
   │── PUBLISH lobby_update "1"►│                            │
   │                            │── SUB lobby_update ───────►│
   │                            │   (callback wywoływany)    │
   │                            │                            │── broadcast_games()
   │                            │◄── sMembers game_ids ──────│
   │                            │◄── hGetAll game:{id} ──────│  (dla każdego id)
   │                            │── dane gier ──────────────►│
   │                            │                            │── publish przez WS
   │                            │                            │   do wszystkich klientów
   │                            │                            │   subskrybujących 'lobby'
```

`child.js` publikuje `lobby_update` w trzech sytuacjach:
1. **Przy starcie** — po rejestracji w Redis (`redis_connect` )
2. **Co 60 klatek gry** (~co 1 sekundę przy 16ms tick) — po zmianie liczby graczy (`redis_update_player_count`)
3. **Przy zamykaniu** — po usunięciu danych gry (`redis_cleanup` )

`mother.js` po odebraniu sygnału :

```javascript
await redisSub.subscribe('lobby_update', () => {
    if (c_man) c_man.broadcast_games().catch(console.error);
});
```

Wywołujemy `broadcast_games()`, która buduje pakiet binarny z listą gier i rozsyła go przez WebSocket do wszystkich podłączonych klientów lobby (mechanizm `uWS publish` na temacie `'lobby'`).

---

### Przepływ A (szczegóły): Co mother.js robi po odebraniu "1"?

#### Krok 1 — Ignorujemy treść wiadomości

```javascript
// mother.js  
await redisSub.subscribe('lobby_update', () => {
    if (c_man) c_man.broadcast_games().catch(console.error);
});
```

Callback celowo nie przyjmuje parametru z wiadomością. Treść `"1"` **nigdy nie jest odczytana** — to tylko fizyczny sygnał że coś się zmieniło. Wzorzec *"notification without payload"*: `child.js` mówi "odśwież dane", a `mother.js` samo wie skąd je wziąć.

#### Krok 2 — broadcast_games() wywołuje buildGamesPacket()

```javascript
// mother.js 
this.broadcast_games = async function () {
    const buf = await buildGamesPacket();
    self.app.publish('lobby', buf, true);
};
```

#### Krok 3 — buildGamesPacket() odpytuje Redis o aktualną listę gier

```javascript
// mother.js 
async function buildGamesPacket() {
    const ids   = await redis.sMembers('game_ids');
    const games = [];
    for (const id of ids) {
        const g = await redis.hGetAll(`game:${id}`);
        if (g && g.g_port) games.push({ id: parseInt(id), ...g });
    }
    // ... buduj pakiet binarny
}
```

Gry których hash nie istnieje (TTL 5s wygasł) są automatycznie pomijane przez warunek `if (g && g.g_port)`.

#### Krok 4 — buildGamesPacket() buduje binarny pakiet type 2

```javascript
const lps = new packet_set(1000);
lps.new_type(2);
lps.s_length8(games.length);
for (const g of games) {
    lps.s_uint32(g.id);
    lps.s_uint8(parseInt(g.g_players_len) || 0);
    lps.s_uint8(parseInt(g.g_players_lim) || 0);
    lps.s_string(g.serv_loc || '');
    lps.s_string(g.serv_name || g.serv_loc || 'Server');
}
return Buffer.from(lps.get_buf());
```

Format naszego pakietu binarnego (type 2):

| Pole | Rozmiar | Opis |
|------|---------|------|
| type | 1 bajt | `2` — identyfikator pakietu lista gier |
| games.length | 1 bajt | liczba gier w liście |
| `id` | 4 bajty (uint32) | unikalny identyfikator serwera gry |
| `g_players_len` | 1 bajt (uint8) | aktualna liczba graczy |
| `g_players_lim` | 1 bajt (uint8) | maksymalna liczba graczy |
| `serv_loc` | string | kod lokalizacji (np. `"PL"`, `"DE"`) |
| `serv_name` | string | wyświetlana nazwa serwera (np. `"EU-Nexus"`) |

`serv_ip` i `g_port` celowo nie wchodzą do pakietu type 2 — klient nie potrzebuje adresu serwera dopóki nie prosi o dołączenie.

#### Krok 5 — Rozsyłamy pakiet do wszystkich klientów WebSocket

```javascript
self.app.publish('lobby', buf, true);
```

Korzystamy z mechanizmu **topic-based broadcasting** biblioteki uWebSockets.js:
- Każdy klient który podłącza się do `mother.js` natychmiast subskrybuje topic `'lobby'` (`ws.subscribe('lobby')`)
- `app.publish('lobby', buf)` wysyła `buf` do **wszystkich** klientów subskrybujących `'lobby'` jednocześnie
- Nie ma pętli po klientach — uWS robi to wewnętrznie w jednej operacji

Efekt: jeden sygnał `"1"` od dowolnego `child.js` powoduje, że **wszyscy klienci lobby** otrzymują świeżą listę gier w ciągu kilku milisekund.

#### Kompletny łańcuch wywołań po odebraniu "1"

```
child.js
  └── redis_pub.publish('lobby_update', '1')
          │
          ▼ (Redis broker)
mother.js — redisSub callback  
  └── c_man.broadcast_games()                   
        └── buildGamesPacket()                  
              ├── redis.sMembers('game_ids')     → ["id1", "id2", ...]
              ├── redis.hGetAll('game:id1')      → {g_port, g_players_len, ...}
              ├── redis.hGetAll('game:id2')      → {g_port, g_players_len, ...}
              └── buduje pakiet binarny type 2
        └── self.app.publish('lobby', buf)        
              ├── → Klient A (WebSocket, subskrybuje 'lobby')
              ├── → Klient B (WebSocket, subskrybuje 'lobby')
              └── → Klient N (WebSocket, subskrybuje 'lobby')
```

`buildGamesPacket()` wywołujemy nie tylko przez `broadcast_games()` — są jeszcze dwa przypadki:

| Miejsce |  | Kiedy |
|---------|-------|-------|
| `broadcast_games()` |  | po odebraniu `lobby_update` — aktualizacja dla wszystkich klientów |
| handler `open` |  | gdy **nowy klient** się podłącza — dostaje aktualną listę natychmiast |
| handler `message` case 6 |  | gdy klient **jawnie prosi** o odświeżenie listy (wiadomość type 6) |

---

### Przepływ B: Klient wchodzi na serwer — 9 kroków 🎮

#### Krok 1 — Klient wysyła prośbę o dołączenie

Klient kliknął "EU-Nexus". Wysyła przez WebSocket binarny pakiet (type `0`) do `mother.js`:

```
gameId    = 3847291650
name      = "Phantom"
skinId    = 3
accountId = "64a1b..."
```

W kodzie `mother.js` trafia to do `handleJoinGame()`.

#### Krok 2 — Sprawdzamy czy gra istnieje i ma miejsce

```javascript
// mother.js  
const gameData = await redis.hGetAll(`game:${gameId}`);
if (!gameData || !gameData.g_port) return;

if (parseInt(gameData.g_players_len) >= parseInt(gameData.g_players_lim)) return;
```

Jeśli gra padła (TTL 5s wygasł) lub serwer jest pełny — milcząco odrzucamy prośbę.

#### Krok 3 — Generujemy jednorazowy token

```javascript
// mother.js — 
const token = gen_id();  // np. 2921693985
```

#### Krok 4 — Publikujemy token przez Redis do konkretnego child.js

```javascript
// mother.js  
await redis.publish(`join:${gameId}`, JSON.stringify({
    token:   2921693985,
    name:    "Phantom",
    skin_id: 3,
    account: "64a1b2c3d4e5f6789abcdef0",
}));
```

Redis dostarcza wiadomość do `child.js` zwykle w < 1ms.

#### Krok 5 — child.js zapamiętuje dane gracza w RAM

```javascript
// child.js —  callback subskrypcji
await redis_sub.subscribe(`join:${game_id}`, (message) => {
    const data = JSON.parse(message);
    tokens[data.token] = {
        token:    data.token,        // 2921693985
        name:     data.name,         // "Phantom"
        skin_id:  data.skin_id,      // 3
        account:  data.account,      // "64a1b..."
        timelive: frame + 10000,     // wygasa za ~160 sekund
    };
});
```

#### Krok 6 — Wysyłamy klientowi token + adres gry (po 50ms)

```javascript
// mother.js 
ps.new_type(0);
ps.s_uint32(token);                        // 2921693985
ps.s_uint16(parseInt(gameData.g_port));    // np. 5001
ps.s_string(gameData.serv_ip);             // "185.23.14.1"
const clientPacket = Buffer.from(ps.get_buf());

setTimeout(() => {
    ws.send(clientPacket, true);
}, 50);
```

#### Krok 7 — Klient otwiera połączenie WebSocket z child.js

```
ws://185.23.14.1:5001/2921693985
                       ↑
                 token jako ścieżka URL
```

#### Krok 8 — Weryfikujemy token przy handshake WebSocket

```javascript
// child.js — handler upgrade, 
upgrade: (res, req, context) => {
    const token_id = req.getUrl().slice(1);

    if (!have_token(token_id)) {
        res.writeStatus('401 Unauthorized').end();
        return;
    }

    res.upgrade({ token_id: token_id }, ...);
}
```

#### Krok 9 — Gracz wchodzi do gry, token zostaje skonsumowany

```javascript
// child.js — handler open, 
open: (ws) => {
    const token_id = ws.getUserData().token_id;
    const id = free_ids.pop();
    players[id] = new player(id, ws, tokens[token_id]);

    tokens[token_id] = null;
    delete tokens[token_id];   // jednorazowy — nie można użyć ponownie

    player_length++;
}
```

### Kompletny diagram przepływu B

```
Klient WS       mother.js               Redis               child.js
    │               │                      │                     │
    │  KROK 1       │                      │                     │
    │──joinGame────►│                      │                     │
    │  gameId=X     │  KROK 2              │                     │
    │  name,skin    │── hGetAll game:X ───►│                     │
    │               │◄── {port,ip,...} ────│                     │
    │               │   [walidacja]        │                     │
    │               │                      │                     │
    │               │  KROK 3              │                     │
    │               │  token = gen_id()    │                     │
    │               │                      │                     │
    │               │  KROK 4              │                     │
    │               │── PUBLISH ──────────►│  KROK 5             │
    │               │   join:X             │─────────────────── ►│
    │               │   {token,name,...}   │                     │── tokens[token]={...}
    │               │                      │                     │
    │  KROK 6       │                      │                     │
    │◄──(50ms)──────│                      │                     │
    │  {token,      │                      │                     │
    │   port, ip}   │                      │                     │
    │               │                      │                     │
    │  KROK 7       │                      │                     │
    │──────── ws://{ip}:{port}/{token} ──────────────────────── ►│
    │               │                      │    KROK 8           │
    │               │                      │    have_token()?    │
    │               │                      │    TAK → akceptuj   │
    │               │                      │    NIE → 401        │
    │               │                      │    KROK 9           │
    │               │                      │    stwórz gracza    │
    │◄─────────────────────────────── stan gry (type 3,4,7,9) ───│
```

---

## Podsumowanie — trzy role Redisa w naszym projekcie 🏗️

```
┌─────────────────────────────────────────────────────────────┐
│                     REDIS SERVER                             │
│                                                              │
│  Struktury danych:                                           │
│  ┌──────────────────┐    ┌──────────────────────────────┐   │
│  │  SET: game_ids   │    │  HASH: game:{id}             │   │
│  │  [id1, id2, ...]  │    │  {port, ip, players, limit,  │   │
│  │                  │    │   loc, name} TTL: 5s          │   │
│  └──────────────────┘    └──────────────────────────────┘   │
│                                                              │
│  Kanały Pub/Sub:                                             │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  lobby_update      ←PUB child.js  / SUB mother.js    │   │
│  │  join:{game_id}    ←PUB mother.js / SUB child.js     │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
          ▲                              ▲
          │                              │
   ┌──────┴───────┐              ┌───────┴──────┐
   │  mother.js   │              │   child.js   │
   │  (Lobby)     │              │  (Game Srv)  │
   │  port: 3001  │              │  port: 5000+ │
   └──────┬───────┘              └───────┬──────┘
          │                              │
          │ WebSocket                    │ WebSocket
          ▼                              ▼
   [Klienci lobby]              [Gracze w grze]
```

Redis spełnia w naszej architekturze **trzy role jednocześnie**:

1. 🗄️ **Baza danych** — przechowuje rejestr aktywnych serwerów gry (`HASH`, `SET`)
2. 🔍 **Service Discovery** — `mother.js` odkrywa dostępne serwery gry przez Redis zamiast hardkodowanych adresów
3. 📡 **Event Bus** — Pub/Sub synchronizuje stan lobby i autoryzuje graczy bez bezpośrednich połączeń między procesami



---
---







# 📡 Protokół WebSocket — mother.js / child.js

---

## Dlaczego binarnie, nie JSON?

Większość aplikacji webowych przesyła dane przez WebSocket jako tekst JSON, np.:

```json
{ "type": "move", "x": 256, "y": -400 }
```

Nasz projekt tego **nie robi**. Zamiast tego zdecydowaliśmy się na **surowe bajty** — dane binarne bez nazw pól, cudzysłowów ani nawiasów klamrowych:

```
00 03 05 43 80 00 00 C3 C8 00 00 FE ...
```

Zrobiliśmy to z konkretnego powodu: nasz serwer gry działa z tickiem **16ms (60 razy na sekundę)**. JSON dla 30 graczy to kilka kilobajtów tekstu na każdy tick. Format binarny zajmuje kilkakrotnie mniej miejsca — co bezpośrednio przekłada się na mniejsze opóźnienia i zużycie pasma.

Całą serializację i deserializację zaimplementowaliśmy w pliku `binary.js`, który eksportuje dwie klasy:
- `packet_set` — **zapisuje** dane do bufora (używana na backendzie przy wysyłaniu)
- `packet_get` — **odczytuje** dane z bufora (używana na backendzie przy odbieraniu i na frontendzie)

---

## Format ramki WebSocket

Zaprojektowaliśmy format, w którym jedna wiadomość WebSocket może nieść **kilka pakietów naraz**:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Bajt 0        │  Bajt 1    │  Bajty 2..N  │  Bajt N+1  │  ...     │
│  LICZBA        │  TYP       │  DANE        │  TYP       │  DANE    │
│  sub-pakietów  │  pakietu 1 │  pakietu 1   │  pakietu 2 │  ...     │
└─────────────────────────────────────────────────────────────────────┘
```

**Przykład:** W jednej wiadomości serwer gry wysyła jednocześnie informację o graczu który umarł + aktualny ranking + pozycje wszystkich graczy w pobliżu. Frontend czyta bajt 0 (np. `3`) i w pętli przetwarza 3 sub-pakiety.

---

## Nasze typy danych (słownik protokołu)

Każde pole ma z góry ustalony rozmiar — nie ma separatorów, odczyt jest czysto sekwencyjny.

| Nazwa | Rozmiar | Zakres / opis |
|-------|---------|---------------|
| `uint8` | 1 bajt | 0 – 255 |
| `int8` | 1 bajt | -128 – 127 |
| `uint16` | 2 bajty | 0 – 65535 |
| `uint32` | 4 bajty | 0 – ~4 mld (np. token, punkty) |
| `float32` | 4 bajty | Liczba zmiennoprzecinkowa (pozycja X/Y) |
| `string` | 1+N bajtów | `[długość: uint8]` + znaki ASCII (1B/znak) |
| `string16` | 1+2N bajtów | `[długość: uint8]` + znaki UTF-16 (2B/znak) — dla nicków i emaili |
| `tablica uint8` | 2+N bajtów | `[długość: uint16]` + bajty |
| `tablica int32` | 2+4N bajtów | `[długość: uint16]` + liczby 32-bit |
| `tablica string` | 2+... bajtów | `[długość: uint16]` + stringi |

> **Ważne:** Wszystkie wielobajtowe liczby kodujemy w **big-endian** (najważniejszy bajt pierwszy).
> To domyślne zachowanie `DataView` w JavaScript — nie należy przekazywać `true` jako argumentu do `getUint16`/`getFloat32` itp.

---

## Dwa serwery, dwa protokoły 🏗️

Nasz system składa się z **dwóch niezależnych serwerów WebSocket** z oddzielnymi protokołami:

```
                      ┌──────────────────┐
                      │    REDIS         │  ← wspólna "tablica ogłoszeń"
                      └────────┬─────────┘
                               │
              ┌────────────────┴──────────────────┐
              │                                   │
   ┌──────────▼──────────┐             ┌──────────▼──────────┐
   │     mother.js        │             │      child.js        │
   │   SERWER LOBBY       │             │   SERWER GRY         │
   │   port 3001          │             │   port 5000+         │
   │                      │             │                      │
   │ - lista gier         │             │ - fizyka gry         │
   │ - logowanie          │             │ - game loop 16ms     │
   │ - zakup skinów       │             │ - synchronizacja     │
   │ - redirect do gry    │             │   stanu graczy       │
   └──────────┬──────────┘             └──────────┬──────────┘
              │ WS (Protokół A)                   │ WS (Protokół B)
              │                                   │
         [Klient w lobby]                   [Klient w grze]
```

**Przepływ dołączania do gry** zaimplementowaliśmy w sześciu krokach:
1. Klient łączy się z `mother.js` (port 3001)
2. Klient klika "Graj" → `mother.js` wysyła do Redisa token + dane gracza
3. `child.js` odbiera z Redisa, zapamiętuje token w pamięci RAM (ważny ~160s)
4. `mother.js` odsyła klientowi: `{ token, ip, port }`
5. Klient sam łączy się z `child.js` pod adresem `ws://{ip}:{port}/{token}`
6. `child.js` weryfikuje token → akceptuje połączenie lub zwraca `401`

---

## PROTOKÓŁ A — mother.js (Lobby)

### Pakiety serwer → klient

---

#### Type `0` — Możesz dołączyć do gry

Wysyłamy ten pakiet po tym jak klient kliknie "Graj" i zarezerwujemy mu miejsce na serwerze.

```
Struktura: [token: uint32] [port: uint16] [ip: string]

Przykład zdekodowany:
{
  token: 2921693985,   // jednorazowy "klucz wejścia" do game servera
  port:  5001,         // port na który się połączyć
  ip:    "185.23.14.1" // adres IP game servera
}
```

Klient po odebraniu tego pakietu powinien **natychmiast** otworzyć nowe połączenie WebSocket: `ws://185.23.14.1:5001/2921693985`

---

#### Type `1` — Dane konta użytkownika

Wysyłamy po zalogowaniu, zakupie skina lub zmianie nazwy.

```
Struktura:
  [email:        string16 ]
  [points:       uint32   ]  ← aktualna "waluta" gracza
  [total_points: uint32   ]  ← łączne punkty do globalnego rankingu
  [name:         string16 ]  ← nick wyświetlany w grze
  [skin:         tablica int8  ]  ← lista ID posiadanych skinów (wartości 0–22)
  [acc_data:     tablica string]  ← dodatkowe dane konta

Przykład zdekodowany:
{
  email:        "gracz@example.com",
  points:       125000,
  total_points: 980000,
  name:         "Phantom",
  skin:         [0, 1, 3, 7],
  acc_data:     []
}
```

---

#### Type `2` — Lista aktywnych serwerów gry

Wysyłamy zaraz po wejściu do lobby oraz za każdym razem gdy zmieni się liczba graczy na którymkolwiek serwerze (sygnał z Redisa).

```
Struktura:
  [liczba_gier: uint8]
  ← dla każdej gry: →
  [id: uint32] [gracze_teraz: uint8] [gracze_max: uint8]
  [lokalizacja: string] [nazwa_serwera: string]

Przykład zdekodowany:
[
  { id: 43981, players_len: 7,  players_lim: 15, serv_loc: "EU", serv_name: "EU-Nexus" },
  { id: 4660,  players_len: 3,  players_lim: 15, serv_loc: "EU", serv_name: "EU-Titan" },
  { id: 9001,  players_len: 15, players_lim: 15, serv_loc: "EU", serv_name: "EU-Storm" }
]
```

---

#### Type `3` — Konfiguracja skinów (raz przy połączeniu)

Wysyłamy synchronicznie jako **pierwszy pakiet** zaraz po otwarciu połączenia — przed listą gier (type `2`), która trafia do klienta z lekkim opóźnieniem, bo czeka na odpowiedź Redisa. Zawiera ceny i kolory wszystkich 23 skinów.

```
Struktura:
  [SKIN_COSTS:  tablica int32]  ← 23 ceny, np. [5000, 0, 0, 8000, ..., 800000]
  [SKIN_LIGHTS: tablica int32]  ← 23 kolory RGB hex, np. [0xffffff, 0xff0000, ...]

Przykład zdekodowany:
{
  costs:  [5000, 0, 0, 0, 0, 0, 8000, 15000, 10000, 18000, 25000, 35000, ...],
  lights: [16777215, 255, 65280, 16750336, 6316641, 61695, ...]
}
```

---

### Pakiety klient → mother.js

Każda wiadomość od klienta zaczyna się od **dwóch bajtów nagłówka**: pierwszy jest przez nas ignorowany, drugi to numer komendy.

```
[_ignorowany: int8] [komenda: int8] [dane...]
```

| Komenda | Nazwa | Dane | Opis |
|---------|-------|------|------|
| `0` | Dołącz do gry | `[gameId: uint32][name: string16][skinId: uint8][accountId: string]` | Prośba o miejsce w grze |
| `1` | Pobierz konto | `[accountId: string]` | Odśwież dane profilu |
| `2` | Kup skina | `[accountId: string][skinId: uint8]` | Zakup skina za punkty |
| `3`/`4` | Zmień nick | `[accountId: string][name: string16]` | Zmiana wyświetlanej nazwy |
| `5` | Reconnect | `[gameId: uint32][token: uint32][accountId: string]` | Powrót do opuszczonej gry |
| `6` | Odśwież listę | *(brak danych)* | Żądanie aktualnej listy gier |

---

## PROTOKÓŁ B — child.js (Game Server)

### Game loop i mechanizm wysyłania

Co 16 milisekund nasz serwer gry wykonuje jeden tick:
1. Przesuwa wszystkich graczy i boty
2. Sprawdza kolizje i zdarzenia
3. Buduje i wysyła pakiety binarne

Wysyłanie zoptymalizowaliśmy przez mechanizm **dual-buffer**:

```
KROK 1: Zapisz dane WSPÓLNE dla wszystkich graczy:
        [gracze którzy umarli] [gracze którzy dołączyli] [ranking top6] ...
                       ↓
KROK 2: Zaznacz "punkt kontrolny" → end_global()
                       ↓
KROK 3: Dla każdego gracza z osobna dopisz dane PRYWATNE:
        [jego pozycja w rankingu] [jego życia] [jego punkty]
        [lista graczy widocznych z jego poziomu]
                       ↓
        Wyślij [dane wspólne + dane prywatne] → get_uniq_buf()
        Cofnij do punktu kontrolnego → gotowy na następnego gracza
                       ↓
KROK 4: Wyczyść bufor → p.clear()
```

Dzięki temu **nie serializujemy wspólnych danych N razy** — robimy to raz i doklejamy tylko indywidualny fragment dla każdego gracza.

---

### Pakiety serwer → klient

---

#### Type `0` — Pozycje graczy (co tick, per-gracz)

Każdy gracz widzi tylko graczy ze **swojego zakresu poziomów** (jego poziom ±2 do +5).

```
Struktura:
  [liczba_graczy: uint8]
  ← dla każdego widocznego gracza: →
  [id: int8] [x: float32] [y: float32] [event_use: int8]

  event_use to stan animacji:
    -3 = właśnie oberwał (trafił w kolce)
    -2 = normalny ruch
    -1 = aktywuje event (skacze przez platformę)
     N (0+) = numer poziomu na którym ląduje

Przykład zdekodowany:
[
  { id: 5,  x: 256.0, y: -400.0, event_use: -2 },  // normalny ruch
  { id: 12, x: 288.0, y: -416.0, event_use: -3 },  // właśnie oberwał
  { id: 1,  x: 252.0, y: -384.0, event_use: -1 }   // skacze
]
```

---

#### Type `1` — Gracze którzy właśnie dołączyli (globalne)

```
Struktura:
  [liczba: uint8]
  ← dla każdego: →
  [id: int8] [name: string16] [skin_id: int8]

Przykład: [{ id: 7, name: "Phantom", skin_id: 3 }]
```

---

#### Type `2` — Gracze którzy wyszli z gry (globalne)

```
Struktura: [liczba: uint8] [id: int8] [id: int8] ...

Przykład zdekodowany: [7, 12]  ← gracze o ID 7 i 12 opuścili grę
```

---

#### Type `3` — Inicjalizacja: pełny stan gry przy wejściu

Wysyłamy **raz**, zaraz po zaakceptowaniu połączenia WebSocket. Zawiera listę wszystkich obecnych graczy (włącznie z botami) i własne ID gracza.

```
Struktura:
  [moje_id: uint8]
  [liczba_graczy: uint8]
  ← dla każdego gracza: →
  [id: uint8] [name: string16] [skin_id: uint8]

Przykład zdekodowany:
{
  ownId: 4,
  players: [
    { id: 0,  name: "Bot",     skin_id: 5 },
    { id: 1,  name: "Orion",   skin_id: 1 },
    { id: 4,  name: "Phantom", skin_id: 3 },  // to ja
    ...
  ]
}
```

Po type `3` wysyłamy w tym samym `send()` type `7` (martwi gracze) i type `9` (ranking), a w **osobnym** `send()` type `4` (pierwsze poziomy).

---

#### Type `4` — Dane poziomów (kafelki mapy)

Wysyłamy przy połączeniu (pierwsze 10 poziomów) oraz gdy gracz wspina się wysoko i potrzebuje kolejnych chunków.

```
Struktura:
  [liczba_chunków: uint8]  ← zazwyczaj 10
  ← dla każdego chunku: →
  [kafelki: tablica uint8 długości 128]

Każdy bajt w tablicy to typ kafelka:
  0 = powietrze (można przejść)
  1 = platforma (ląduje się na niej)
  2 = kolce    (zadają obrażenia)
```

---

#### Type `5` — Gracze którzy zginęli (globalne)

```
Struktura: [liczba: uint8] [id: int8]...

Przykład: [3, 7, 12]  ← ID graczy którzy właśnie zginęli
```

---

#### Type `6` — Gracze którzy się odrodzili (globalne)

```
Struktura: [liczba: uint8] [id: int8]...
```

---

#### Type `7` — Lista już martwych graczy (przy inicjalizacji)

Wysyłamy razem z type `3` — informujemy nowego gracza kto już nie żyje w momencie jego wejścia.

```
Struktura: [liczba: uint8] [id: uint8]...
```

---

#### Type `9` — Top 6 rankingu (globalne)

Wysyłamy gdy ktoś awansuje w top 6 lub przy inicjalizacji.
`byte_point` to nasza skompresowana wartość punktów (0–255).

```
Struktura:
  [liczba: uint8]  ← max 6
  ← dla każdego: →
  [id: int8] [byte_point: int8]

Przykład zdekodowany:
[
  { id: 2,  byte_point: 187 },  // ~1 100 000 punktów
  { id: 7,  byte_point: 95  },
  { id: 14, byte_point: 60  }
]
```

> Dekodowanie byte_point → punkty: wartości 0-99 = `val * 1000`,
> 100-188 = `(val-100) * 10000 + 100000`, 189-255 = `(val-189) * 100000 + 1000000`

---

#### Type `10` — Moja pozycja w rankingu (per-gracz)

```
Struktura: [ranking_id: int8] [byte_point: int8]

Przykład: { ranking_id: 5, byte_point: 42 }
  → jestem na 5. miejscu rankingu z 42000 punktami
```

---

#### Type `11` — Moje aktualne życia / eventy (per-gracz)

```
Struktura: [event: int8]

event to liczba pozostałych "żyć" gracza (0–10).
Przy 0 następne trafienie w kolce = śmierć.
```

---

#### Type `12` — Punkty zdobyte w tej rozgrywce (per-gracz, przy śmierci)

```
Struktura: [points: uint32]

Wysyłamy przy śmierci gracza — informujemy ile punktów zarobił w tej rundzie.
```

---

#### Type `13` — Gracz zmienił skina (globalne)

```
Struktura:
  [liczba: uint8]
  ← dla każdego: →
  [id: int8] [skin_id: uint8]
```

---

### Pakiety klient → child.js

Format: `[typ: uint8] [dane...]` — **bez** bajtu licznika na początku (inaczej niż w Protokole A).

| Typ | Nazwa | Dane | Opis |
|-----|-------|------|------|
| `0` | Ruch | `[dx: int8]` | Poziomy ruch (-128 = lewo, +127 = prawo) |
| `1` | Czat | `[text: string16]` | Wiadomość czatu |
| `2` | Event | *(brak)* | Aktywuj event (skok przez platformę) |
| `8` | Respawn | `[ads: int8][skin_id: uint8]` | Odrodzenie po śmierci, opcjonalnie nowy skin |

---

## Perspektywa frontendu — co faktycznie wysyłamy i odbieramy

Poniższe sekcje opisują komunikację z punktu widzenia `index.html` — na podstawie kodu klienta, nie dokumentacji protokołu.

---

## Frontend ↔ mother.js 🏠

### Frontend → mother.js

Format każdego pakietu: `[typ: uint8] [dane...]` — brak bajtu licznika (pełna wiadomość = jeden pakiet).

#### Type `0` — Dołącz do gry

Wysyłamy gdy gracz kliknie przycisk PLAY i wybierze serwer z listy.

```javascript
// index.html — linia ~2297
packetSender.new_type(0);
packetSender.s_uint32(selectedGame.g_id);  // ID wybranego serwera gry
packetSender.s_string16(playerNick);        // nick (UTF-16, max 9 znaków)
packetSender.s_uint8(skinId);               // ID wybranego skina
packetSender.s_string(userId);              // MongoDB ObjectId lub '' dla gości
motherSocket.send(packetSender.get_buf());
```

```
Struktura: [gameId: uint32] [name: string16] [skinId: uint8] [accountId: string]
```

---

#### Type `1` — Pobierz dane konta

Wysyłamy po zalogowaniu przez HTTP, gdy WebSocket z lobby jest już otwarty.

```javascript
// index.html — linia ~2105
packetSender.new_type(1);
packetSender.s_string(id);  // MongoDB ObjectId zalogowanego gracza
motherSocket.send(packetSender.get_buf());
```

```
Struktura: [accountId: string]
```

---

#### Type `2` — Kup skina

Wysyłamy gdy gracz kliknie "KUP" w karuzeli skinów.

```javascript
// index.html — linia ~2050
packetSender.new_type(2);
packetSender.s_string(id);
packetSender.s_uint8(skinId);
motherSocket.send(packetSender.get_buf());
```

```
Struktura: [accountId: string] [skinId: uint8]
```

---

#### Type `3` — Zmień nick

Wysyłamy po potwierdzeniu edycji nicku w panelu konta.

```javascript
// index.html — linia ~1945
packetSender.new_type(3);
packetSender.s_string(id);
packetSender.s_string16(newName);
motherSocket.send(packetSender.get_buf());
```

```
Struktura: [accountId: string] [name: string16]
```

---

#### Type `5` — Reconnect (powrót do gry)

Wysyłamy automatycznie przy odświeżeniu strony jeśli gracz miał aktywną grę (`gameToken` zapisany lokalnie). Używamy `s_int32` (signed) zamiast `s_uint32` — dla zakresu wartości gameId i tokenu jest bez znaczenia.

```javascript
// index.html — linia ~2110
packetSender.new_type(5);
packetSender.s_int32(selectedGame.g_id);  // ← s_int32, nie s_uint32
packetSender.s_int32(gameToken);
packetSender.s_string(id);
motherSocket.send(packetSender.get_buf());
```

```
Struktura: [gameId: int32] [token: int32] [accountId: string]
```

---

#### Type `6` — Odśwież listę gier

Wysyłamy automatycznie co 500ms (polling) — tylko gdy gracz jest w lobby i nie jest w grze.

```javascript
// index.html — linia ~1640
packetSender.new_type(6);
motherSocket.send(packetSender.get_buf());
```

```
Struktura: (brak danych — sam typ)
```

---

### mother.js → Frontend

#### Type `0` — Token + adres serwera gry

```javascript
// index.html — case 0 w handleMotherMessage, linia ~2339
const token = p.g_uint32();
const port  = p.g_uint16();
const ip    = p.g_string();
gameToken = token;
initGame('ws://' + ip + ':' + port + '/' + token);
```

Frontend zapamiętuje token jako flagę "jesteśmy w grze" i natychmiast otwiera połączenie z serwerem gry.

---

#### Type `1` — Dane konta

```javascript
// index.html — case 1 w handleMotherMessage, linia ~2356
const email  = p.g_string16();
const points = p.g_uint32();
const tp     = p.g_uint32();     // total_points
const name   = p.g_string16();
const os     = p.g_int8_arr();   // lista posiadanych skinów
p.g_string_arr();                // acc_data — odczytywana ale ignorowana (zarezerwowane)
```

---

#### Type `2` — Lista gier

```javascript
// index.html — case 2 w handleMotherMessage, linia ~2384
for (let a = p.g_length8(); a--;) {
    games.push({
        g_id:          p.g_uint32(),
        g_players_len: p.g_uint8(),
        g_players_lim: p.g_uint8(),
        g_location:    p.g_string(),
        g_name:        p.g_string(),
    });
}
```

---

#### Type `3` — Konfiguracja skinów

```javascript
// index.html — case 3 w handleMotherMessage, linia ~2422
skins      = p.g_int32_arr();  // ceny 23 skinów
lightSkins = p.g_int32_arr();  // kolory 23 skinów
```

---

#### Type `4` — Serwer pełny ⚠️

```javascript
// index.html — case 4 w handleMotherMessage, linia ~2438
alert('Server is full — try again in a moment.');
```

> **Uwaga:** `mother.js` aktualnie **nigdy nie wysyła** tego pakietu — przy pełnym serwerze po prostu milcząco odrzuca żądanie (`return`). Handler w frontendzie istnieje, ale nie jest wyzwalany. Może być użyty w przyszłości.

---

## Frontend ↔ child.js 🎮

### Frontend → child.js

Format: `[typ: uint8] [dane...]` — **płaskie bajty, bez licznika** sub-pakietów.

#### Type `0` — Ruch poziomy

Wysyłamy przy każdym zdarzeniu `keydown`/`mousemove`/`touchmove` gdy gracz się porusza. Nie wysyłamy gdy `dx = 0` (brak ruchu = brak pakietu).

```javascript
// index.html — funkcja smi(), linia ~4213
gs.send(new Uint8Array([0, v]).buffer);
// [0x00] = typ, [v] = Int8 prędkość/kierunek
```

```
Struktura: [typ=0: uint8] [dx: int8]    ← łącznie 2 bajty
  dx < 0 = obrót w lewo (kąt kołowy maleje)
  dx > 0 = obrót w prawo (kąt kołowy rośnie)
  |dx| maks 127 (klampowane przez: if (Math.abs(v) >= 127) v = v < 0 ? -127 : 127)
```

---

#### Type `1` — Wiadomość czatu

Wysyłamy po naciśnięciu Enter w polu czatu.

```javascript
// index.html — linia ~4180
packetSender.s_uint8(1);
packetSender.s_string16(this.value);
gs.send(packetSender.get_buf());
```

```
Struktura: [typ=1: uint8] [text: string16]
```

---

#### Type `2` — Aktywuj event

Wysyłamy po kliknięciu przycisku eventu (lub klawisz strzałka w górę). Brak dodatkowych danych.

```javascript
// index.html — linia ~3305
gs.send(new Uint8Array([2]).buffer);
```

```
Struktura: [typ=2: uint8]    ← 1 bajt
```

---

#### Type `8` — Respawn

Wysyłamy po kliknięciu przycisku RESPAWN na ekranie śmierci.

```javascript
// index.html — linia ~2186
gameSocket.send(new Uint8Array([8, canShowAd, skinId]).buffer);
```

```
Struktura: [typ=8: uint8] [ads: int8] [skin_id: uint8]    ← 3 bajty
  ads     = 1 jeśli gracz obejrzał reklamę (bonus punktowy), 0 jeśli nie
  skin_id = ID skina wybranego na ekranie śmierci
```

---

### child.js → Frontend

Każda wiadomość zaczyna się od bajtu licznika sub-pakietów (tak jak w Protokole B).

#### Type `0` — Pozycje graczy (~60 Hz, per-gracz)

```javascript
// index.html — hgm case 0, linia ~3385
for (let ix = p.g_length8(); ix--;) {
    const id       = p.g_uint8();
    pl.set_pos(p.g_float(), p.g_float());
    const ec       = p.g_int8();   // event_use: stan animacji
}
```

---

#### Type `1` — Nowi gracze dołączyli

```javascript
// hgm case 1
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8(), n = p.g_string16(), sk = p.g_uint8();
    if (!players[id]) players[id] = new Player(id, n, sk);
}
```

---

#### Type `2` — Gracze wyszli

```javascript
// hgm case 2
for (let ix = p.g_length8(); ix--;) {
    players[p.g_uint8()].destructor();
}
```

---

#### Type `3` — Inicjalizacja (raz przy połączeniu)

```javascript
// hgm case 3
myPlayerId = p.g_uint8();
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8(), n = p.g_string16(), sk = p.g_uint8();
    players[id] = new Player(id, n, sk);
}
```

---

#### Type `4` — Dane poziomów mapy

Odbieramy przy połączeniu (pierwsze 10 poziomów) i proaktywnie gdy gracz zbliża się do końca pobranych danych.

```javascript
// hgm case 4
for (let ix = p.g_length8(); ix--;) {
    levels[levelsReceived + ix] = p.g_int8_arr(); // Uint8Array[128]
}
levelsReceived += 10;
```

---

#### Type `5` — Gracze zginęli

```javascript
// hgm case 5
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8();
    players[id].obj.visible = false;
    if (players[id] === myPlayer) showRespawnMenu(gs, resetRings); // pokaż ekran śmierci
}
```

---

#### Type `6` — Gracze odrodzili się ⚠️

```javascript
// hgm case 6 — frontend IGNORUJE dane
for (let ix = p.g_length8(); ix--;) p.g_uint8(); // dane są odczytywane ale odrzucane
```

> **Uwaga:** `child.js` wysyła listę ID odrodzonych graczy, ale frontend aktualnie tylko przesuwa wskaźnik odczytu bez żadnej akcji (zarezerwowane do przyszłej implementacji).

---

#### Type `7` — Ukryj gracza (martwi przy inicjalizacji)

```javascript
// hgm case 7
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8();
    if (players[id]) players[id].obj.visible = false;
}
```

---

#### Type `8` — Wiadomość czatu 📢

> Tego pakietu **nie było** w oryginalnym opisie Protokołu B — dodajemy go tutaj.

`child.js` rozsyła wiadomości czatu do wszystkich graczy globalnie.

```javascript
// hgm case 8
for (let ix = p.g_length8(); ix--;) {
    const id  = p.g_uint8();
    const msg = p.g_string16();
    if (players[id]) appendChat(players[id], msg);
}
```

```
Struktura: [liczba: uint8] × N: [id: uint8] [text: string16]
```

---

#### Type `9` — Ranking TOP 6

```javascript
// hgm case 9
const cnt = p.g_length8();
for (let ix = cnt; ix--;) {
    const id  = p.g_uint8();
    const pts = p.g_uint8(); // byte_point (skompresowane)
    // aktualizuj wiersz rankingu
}
```

---

#### Type `10` — Moja pozycja w rankingu (per-gracz)

```javascript
// hgm case 10
const rank = p.g_uint8(); // pozycja (0-indexed)
const pts  = p.g_uint8(); // byte_point
// jeśli rank > 5: pokaż dodatkowy wiersz za TOP6
```

---

#### Type `11` — Postęp eventu (per-gracz)

```javascript
// hgm case 11
const prog = p.g_uint8(); // 0–10
$('#eventb').children[1].innerText = prog + '/10';
```

---

#### Type `12` — Zarobione złoto (per-gracz, przy śmierci)

```javascript
// hgm case 12
const gold = p.g_uint32();
$('#win_points').innerText = gold + ' Gold!';
```

---

#### Type `13` — Zmiana skina podczas gry

```javascript
// hgm case 13
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8(), sk = p.g_uint8();
    if (players[id]) players[id].cheange_skin(sk);
}
```

--- 



---

# 🔌 Własny binarny protokół sieciowy — `binary.js`

> Zamiast JSONa wybraliśmy własny serializer binarny. Poniżej tłumaczymy dlaczego — i jak dokładnie go zbudowaliśmy.

---

## Problem, który musieliśmy rozwiązać

Nasz serwer gry (`child.js`) wysyła dane o pozycjach wszystkich graczy **co 16 ms** (60 razy na sekundę). Przy 15 graczach i 37 botach mamy **52 obiekty ruchu na każdy tick**.

Każdy obiekt to cztery pola: `id`, `x`, `y`, `event_use`.

Stanęliśmy przed pytaniem: **w jakim formacie przesyłać te dane przez WebSocket?**

---

## Dlaczego odrzuciliśmy JSON

JSON był pierwszym, oczywistym kandydatem — ale po analizie stwierdziliśmy, że jest za kosztowny dla naszego przypadku użycia.

### Jak wyglądałby JSON dla 3 graczy

```json
[
  {"id":5,"x":256.0,"y":-400.0,"event_use":-2},
  {"id":12,"x":288.0,"y":-416.0,"event_use":-3},
  {"id":1,"x":252.0,"y":-384.0,"event_use":-1}
]
```

**Rozmiar:** ~105 bajtów

Zidentyfikowaliśmy trzy główne źródła marnotrawstwa:

- **Nazwy pól powtarzają się przy każdym obiekcie.** Sama nazwa `"event_use"` to 11 znaków — przy 3 graczach płacimy 33 bajty tylko za tę nazwę, choć frontend z góry wie, co ona oznacza.
- **Liczby jako tekst.** Wartość `256.0` to 5 znaków (5 bajtów), podczas gdy `float32` zajmuje dokładnie 4 bajty.
- **Separatory składniowe bez wartości informacyjnej.** `{`, `}`, `[`, `]`, `:`, `,` — wszystkie potrzebne parserowi, żadne niepotrzebne nam.

Frontend i serwer z góry uzgodniły kolejność pól — ta wiedza jest zakodowana w funkcjach serializująco-deserializujących. Nazwy pól w JSONie są więc **całkowicie redundantne**.

### Nasz format binarny dla tych samych 3 graczy

```
03                        ← liczba graczy: 1 bajt (uint8)
05                        ← id=5: 1 bajt (int8)
43 80 00 00               ← x=256.0: 4 bajty (float32 big-endian)
C3 C8 00 00               ← y=-400.0: 4 bajty (float32 big-endian)
FE                        ← event_use=-2: 1 bajt (int8)
0C 43 90 00 00 C3 D0 00 00 FD   ← gracz id=12 (10 bajtów)
01 43 7C 00 00 C3 C0 00 00 FF   ← gracz id=1  (10 bajtów)
```

**Rozmiar:** 31 bajtów — czyli **3.5× mniej** niż JSON.

---

## Porównanie przy pełnej grze (52 graczy/botów, 60 tick/s)

| Format | Rozmiar pakietu | Dane/sekundę | Dane/minutę |
|--------|----------------|--------------|-------------|
| JSON | ~1 820 B | ~109 KB/s | ~6.5 MB |
| MessagePack | ~700 B | ~42 KB/s | ~2.5 MB |
| Protobuf | ~530 B | ~32 KB/s | ~1.9 MB |
| **Nasz binarny** | **~521 B** | **~31 KB/s** | **~1.9 MB** |

Osiągamy **identyczny rozmiar co Protobuf**, ale bez żadnych zewnętrznych zależności i bez kompilatora schematu.

Przy 15 podłączonych graczach serwer wysyła **15 różnych wersji pakietu pozycji** (każdy widzi inne jednostki — patrz mechanizm dual-buffer). Gdybyśmy używali JSON, `JSON.stringify` byłby wywoływany 15 razy na tick — **900 razy na sekundę**. Nasz serializer przygotowuje część globalną **raz**, a część per-gracza dokłada osobno.

---


---
---



```js
/*
 * ============================================================
 * PRZEPŁYW: UŻYTKOWNIK ŁĄCZY SIĘ I WYBIERA GRĘ
 * (mother.js ↔ child.js)
 * ============================================================
 *
 * KROK 1 — Logowanie (HTTP)
 *   Klient wysyła POST /auth/login z { email, password }.
 *   mother.js weryfikuje hasło przez bcrypt.compare().
 *   Jeśli OK → zwraca { success: true, nick, ... } + zapisuje last_login w MongoDB.
 *
 * KROK 2 — Połączenie WebSocket z mother.js
 *   Klient otwiera połączenie WS na porcie 9876.
 *   mother.js przypisuje mu obiekt w ClientManager (userData, ws).
 *
 * KROK 3 — Pobranie danych konta (handleFetchAccount)
 *   Klient wysyła żądanie fetchAccount przez WS.
 *   mother.js odpytuje MongoDB → zwraca punkty, skiny, nick itp.
 *
 * KROK 4 — Lista dostępnych gier (buildGamesPacket)
 *   mother.js czyta z Redisa klucze aktywnych serwerów child.js (HGETALL).
 *   Każdy child.js rejestruje się w Redis przy starcie (HSET) z adresem i liczbą graczy.
 *   mother.js pakuje tę listę i wysyła klientowi → klient widzi lobby z grami.
 *
 * KROK 5 — Wybór gry przez użytkownika (handleJoinGame)
 *   Klient wysyła przez WS identyfikator wybranego serwera child.js.
 *   mother.js:
 *     a) Generuje unikalny token (losowy string).
 *     b) Publikuje token do Redisa (PUBLISH) na kanał nasłuchiwany przez wybrany child.js.
 *        Wiadomość zawiera: token + _id + nick + punkty + skiny użytkownika.
 *     c) Czeka 50 ms (setTimeout), żeby child.js zdążył zarejestrować token w swojej pamięci.
 *     d) Wysyła klientowi adres serwera child.js + token przez WS.
 *
 * KROK 6 — Połączenie WebSocket z child.js
 *   Klient otwiera nowe połączenie WS bezpośrednio z child.js,
 *   przesyłając token otrzymany od mother.js.
 *
 * KROK 7 — Weryfikacja tokenu w child.js
 *   child.js sprawdza czy token istnieje w swojej mapie tokenów (zarejestrowany przez Redis pub/sub).
 *   Jeśli token pasuje → użytkownik jest uwierzytelniony.
 *   Token zostaje usunięty (jednorazowy).
 *
 * KROK 8 — Inicjalizacja gracza w child.js
 *   child.js wysyła klientowi:
 *     - Pakiet typ 3: dane startowe (ID gracza, lista botów, aktualne poziomy itp.)
 *     - Pakiet typ 4: dane poziomów (10 poziomów na raz, tablice 128-elementowe)
 *     - Pakiet typ 9: aktualny ranking top 6
 *
 * KROK 9 — Pętla gry (game loop, tick co 16 ms)
 *   child.js przetwarza fizykę: grawitację, skoki, kolizje (gracz↔gracz, gracz↔teren).
 *   Rozsyła pozycje graczy (pakiet typ 0) do wszystkich klientów w zasięgu.
 *   Śmierć gracza → pakiet typ 5; respawn → pakiet typ 6.
 *   Zdobyte punkty → pakiet typ 12; child.js zapisuje je bezpośrednio do MongoDB.
 *
 * KROK 10 — Rozłączenie
 *   Gracz rozłącza się → child.js wysyła pakiet typ 2 (player left) do pozostałych.
 *   child.js aktualizuje licznik graczy w Redisie (HSET).
 *   mother.js nie uczestniczy w rozłączeniu z child.js — obsługuje tylko lobby.
 */
/*
 * ============================================================
 * INFRASTRUKTURA: PORTY, SKALOWANIE, LOAD BALANCING
 * ============================================================
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  PORT 9876  — HTTP (Express.js)                                     │
 * │  Obsługuje: POST /auth/login, POST /auth/register, pliki statyczne  │
 * │  W K8s: Service "mother" wystawia ten port jako LoadBalancer        │
 * │  Docelowo: zmienić na 80 (patrz CONFIG.HTTP_PORT)                   │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  PORT 3001  — WebSocket lobby (uWebSockets.js)                      │
 * │  Obsługuje: połączenia klientów do lobby (lista gier, join, skiny)  │
 * │  W K8s: Service "mother" wystawia ten port jako LoadBalancer        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ── KTO PRZEKIEROWUJE RUCH? ──────────────────────────────────────────
 *
 *  Kubernetes Service typu LoadBalancer (prz-mother.yaml):
 *
 *    spec:
 *      type: LoadBalancer        <- Azure przydziela zewnętrzny IP
 *      ports:
 *        - name: http        port: 9876   -> pod:9876  (Express)
 *        - name: client-ws   port: 3001   -> pod:3001  (uWS)
 *
 *  Azure Load Balancer (tworzony automatycznie przez AKS) rozdziela
 *  ruch TCP round-robin między wszystkie repliki poda "mother".
 *  Oba porty (9876 i 3001) trafiają zawsze pod ten sam zewnętrzny IP,
 *  ale są routowane niezależnie.
 *
 * ── DLACZEGO WEBSOCKET JEST STATELESS I DA SIĘ SKALOWAĆ? ────────────
 *
 *  Klasyczny problem WS: klient podłączony do repliki A nie widzi
 *  zdarzeń z repliki B — load balancer nie może swobodnie przełączać.
 *
 *  Tu ten problem nie istnieje, bo:
 *   1. Każdy klient utrzymuje jedno połączenie WS z JEDNĄ repliką mother
 *      przez cały czas pobytu w lobby — nie ma potrzeby synchronizacji
 *      stanu sesji między replikami.
 *   2. Stan globalny (lista gier) żyje w Redisie, a NIE w pamięci poda.
 *      Każda replika mother czyta go z Redis (HGETALL) i może odpowiedzieć
 *      identycznie — żadna replika nie jest "specjalna".
 *   3. Aktualizacje listy gier (gdy child.js zmienia liczbę graczy)
 *      trafiają do Redisa (PUBLISH), a każda replika mother subskrybuje
 *      ten kanał osobno i rozsyła aktualizację do swoich klientów WS.
 *
 *  Schemat skalowania:
 *
 *    Klient 1 --WS--> mother-pod-A --Redis pub/sub--> child-pod-X
 *    Klient 2 --WS--> mother-pod-A  \
 *    Klient 3 --WS--> mother-pod-B   +== Redis (wspólna lista gier)
 *    Klient 4 --WS--> mother-pod-B  /
 *
 *  HPA (mother-hpa.yaml) skaluje liczbę podów mother od 1 do 10
 *  na podstawie zużycia CPU (próg: 10% średniej).
 *  Azure LB automatycznie dołącza nowe pody do puli bez przestojów.
 *
 * ──────────────────────────────────────────────────────────────────────
 *
 *  WS to długotrwałe połączenie TCP — po zestawieniu
 *  przez LB nie jest ponownie routowane. Klient siedzi na tej samej
 *  replice do rozłączenia. Przy reconnect może trafić na inną replikę —
 *  to jest OK, bo stan jest w Redisie, nie w pamięci poda.
 *
 * ── PODSUMOWANIE PORTÓW ───────────────────────────────────────────────
 *
 *  Zewnętrzny IP (Azure LB):
 *    :9876  -> HTTP  (logowanie, rejestracja)
 *    :3001  -> WS    (lobby: lista gier, dołączanie, skiny)
 *
 *  Wewnątrz klastra K8s (ClusterIP):
 *    redis:6379     -> Redis (stan gier, pub/sub)
 *    cosmos-db      -> MongoDB via secret MONGO_URL (konta, punkty)
 *
 *  Serwery gier (child.js) — osobne pody/NodePorty, adresy w Redisie:
 *    child-pod:PORT -> WS gry (klient łączy się bezpośrednio po tokenie)
 */

/*
 * ── JAK TO MOŻLIWE: JEDEN PORT, WIELE REPLIK? ────────────────────────
 *
 *  Z zewnątrz klient zawsze łączy się na TEN SAM adres i port,
 *  np. ws://20.10.5.123:3001 — ale każde połączenie trafia do INNEGO poda.
 *
 *  Jak to działa warstwami:
 *
 *  1. KAŻDY POD nasłuchuje na tym samym porcie (3001 / 9876)
 *     wewnątrz swojego izolowanego kontenera.
 *     Pod-A: 10.0.0.4:3001
 *     Pod-B: 10.0.0.5:3001   <- ten sam port, inny prywatny IP
 *     Pod-C: 10.0.0.6:3001
 *
 *  2. KUBERNETES SERVICE (ClusterIP wewnętrzna warstwa)
 *     Przypisuje jeden wirtualny IP (np. 10.1.0.20) do serwisu "mother".
 *     kube-proxy na każdym węźle tłumaczy ten VIP na losowy pod z puli
 *     (przez reguły iptables / IPVS) — to jest wewnętrzny load balancer K8s.
 *
 *  3. AZURE LOAD BALANCER (warstwa zewnętrzna)
 *     Dostaje zewnętrzny publiczny IP (np. 20.10.5.123).
 *     Przyjmuje TCP :3001 i forward'uje do węzłów klastra (NodePort).
 *     Stamtąd kube-proxy przekazuje dalej do konkretnego poda.
 *
 *  Schemat:
 *
 *    Klient
 *      |
 *      v  ws://20.10.5.123:3001  (zawsze ten sam adres)
 *    Azure Load Balancer  (zewnętrzny IP Azure, port 3001)
 *      |        |        |
 *      v        v        v    (round-robin TCP)
 *    węzeł-1  węzeł-2  węzeł-3  (VM-ki w AKS node pool)
 *      |
 *    kube-proxy (iptables/IPVS)
 *      |        |        |
 *      v        v        v
 *    pod-A    pod-B    pod-C   (każdy: :3001 ten sam port)
 *
 *  Dlaczego każdy pod może mieć TEN SAM port?
 *    Pody mają osobne przestrzenie sieciowe (network namespace).
 *    Port 3001 w pod-A i port 3001 w pod-B to dwa różne gniazda
 *    na dwóch różnych prywatnych IP — nie ma konfliktu.
 *    Dla systemu operacyjnego węzła to jakby dwie osobne maszyny.
 *
 *  Co widzi klient?
 *    Nic. Łączy się zawsze z 20.10.5.123:3001.
 *    Nie wie, do którego poda trafił. Nie musi wiedzieć.
 *    Połączenie WS jest długotrwałe — po zestawieniu LB już nie
 *    ingeruje, klient "siedzi" na jednym podzie aż do rozłączenia.
 */
```
