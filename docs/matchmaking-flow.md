# Matchmaking Flow — Przepływ Dołączania do Gry

## 1. Cel i architektura

Matchmaking to proces łączenia gracza z konkretną sesją gry. System jest w pełni bezstanowy po stronie Mother: każde dołączenie to: odczyt Redis → generowanie tokenu → publish do Child → opóźniony send do klienta. Nie ma centralnego matchmakera — gracz sam wybiera serwer z listy.

### Przepływ wysokiego poziomu

```
Klient lobby (WS)
  │ type 0: {gameId, name, skinId, accountId}
  ▼
Mother.handleJoinGame()
  ├─ redis.hGetAll('game:{gameId}') — weryfikacja stanu serwera
  ├─ gen_id() → token (uint32)
  ├─ redis.publish('join:{gameId}', {token, name, skin_id, account})
  └─ setTimeout(50ms) → ws.send type 0: {token, port, ip}

Redis pub/sub
  │ message do kanału 'join:{gameId}'
  ▼
Child.redis_sub subscriber
  └─ tokens[token] = {name, skin_id, account, timelive: frame+10000}

Klient gry (WS)
  │ ws://AGONES_IP:AGONES_PORT/TOKEN
  ▼
Child.upgrade()
  └─ have_token(token) → true → akceptuj WS handshake
```

---

## 2. Kluczowa logika i przepływ

### `handleJoinGame()` — pełna implementacja

```javascript
// apps/mother-lobby/main.js
function handleJoinGame(p, ws) {
    let gameId, name, skinId, accountId;
    try {
        gameId    = p.g_uint32();
        name      = p.g_string16();
        skinId    = p.g_uint8();
        accountId = p.g_string();
        if (accountId !== '') accountId = new ObjectId(accountId);  // konwersja tylko dla zalogowanych (pusty string = gość)
    } catch (e) {}

    if (name == null || name.length > 9) return;
    // Nieprawidłowy format → name zostaje undefined → ta walidacja wyłapie i zrobi return

    async function doAddPlayer() {
        const gameData = await redis.hGetAll(`game:${gameId}`);
        if (!gameData || !gameData.g_port) return;

        if (parseInt(gameData.g_players_len) >= parseInt(gameData.g_players_lim)) return;
        // Race condition guard: ktoś mógł wypełnić serwer w ciągu ostatnich ms

        const token = gen_id();  // losowy uint32

        await redis.publish(`join:${gameId}`, JSON.stringify({
            token, name,
            skin_id: skinId,
            account: accountId ? accountId.toString() : '',
        }));

        const clientPacket = Buffer.from(ps.get_buf());  // KOPIA bufora przed setTimeout

        setTimeout(() => {
            try { ws.send(clientPacket, true); } catch (_) {}
        }, 50);
        // 50ms delay: Redis pub musi dotrzeć do Child ZANIM klient spróbuje połączyć
    }

    // Weryfikacja skina po stronie serwera
    if (skinId >= 1 && skinId <= 5) {
        doAddPlayer().catch(console.error);  // skiny 1-5 darmowe
    } else {
        db_users.findOne({ _id: accountId, skin: skinId })
            .then(result => { if (result) doAddPlayer(); });
    }
}
```

### Dlaczego 50ms opóźnienie

```
T=0ms:    Mother: redis.publish('join:{gameId}', {token, ...})
T=1-5ms:  Redis: dostarczenie wiadomości do Child (pub/sub latency)
T=5ms:    Child: tokens[token] = {...} (przetworzenie callback)

Bez opóźnienia (T=0ms):
  Mother wysyła token do klienta JEDNOCZEŚNIE z publish do Redis
  Klient łączy się: ws://IP:PORT/token
  Child upgrade(): have_token(token) = false → HTTP 401 → odrzucony

Z 50ms opóźnieniem:
  T=50ms: Mother wysyła token do klienta
  Token istnieje w Child od T=5ms → have_token(token) = true → sukces
  45ms buforu na wolniejsze sieci/systemy
```

### Token — jednorazowość i TTL

```javascript
// Mother: generowanie — IIFE + closure, bufor reużywany (nie alokuje tablicy per call)
const gen_id = (function () {
    const buf = new Uint32Array(1);
    return function () {
        buf[0] = Math.random() * 0xffffffff;  // Uint32Array rzutuje na unsigned uint32
        return buf[0];
    };
})();

// Child: przechowywanie
tokens[data.token] = {
    token:    data.token,
    name:     data.name,
    skin_id:  data.skin_id,
    account:  data.account,
    timelive: frame + 10000,  // ~160s (10000 ticków × 16ms)
};

// Child: zużycie (jednorazowe)
tokens[token_id] = null;
delete tokens[token_id];
// null + delete = podwójne zabezpieczenie przed wielokrotnym użyciem
```

---

## 3. Przykłady z kodu (implementacja)

### Pakiet type 0 do klienta

```javascript
// apps/mother-lobby/main.js
ps.new_type(0);
ps.s_uint32(token);
ps.s_uint16(parseInt(gameData.g_port));  // port zewnętrzny Agones
ps.s_string(gameData.serv_ip);           // publiczne IP węzła K8s
const clientPacket = Buffer.from(ps.get_buf());
// Buffer.from() = kopia PRZED setTimeout (ps może być nadpisany)
```

### Child: obsługa upgrade (walidacja tokena)

```javascript
// apps/child-gameserver/main.js
upgrade: (res, req, context) => {
    const token_id = req.getUrl().slice(1);  // "/TOKEN" → "TOKEN"
    if (!have_token(token_id)) {
        res.writeStatus('401 Unauthorized').end();
        return;
    }
    res.upgrade({ token_id }, ...);
}
```

### Czyszczenie wygasłych tokenów

```javascript
// apps/child-gameserver/main.js
// W pętli gry co 10000 ticków (~160s) — nie co tick (iteracja O(n) po tokens{} byłaby marnotrawstwem)
if (!(frame % 10000)) {
    for (const i in tokens) {
        if (tokens[i].timelive < frame) {
            tokens[i] = null;    // null + delete = podwójne zabezpieczenie
            delete tokens[i];
            // Token ważny przez ~160s od publikacji (10000 ticków × 16ms)
        }
    }
}
```

---

## 4. Zależności i Protokoły

### Sekwencja diagram

```
Klient          Mother           Redis          Child
  │               │                │              │
  ├─type0────────►│                │              │
  │               │ hGetAll(game)  │              │
  │               ├───────────────►│              │
  │               │◄───────────────┤              │
  │               │  gen_id()→tok  │              │
  │               │  publish(join) │              │
  │               ├────────────────►──subscribe──►│
  │               │                │  tokens[tok] │
  │               │ 50ms delay     │              │
  │◄──token+ip────┤                │              │
  ├─ws://IP:PORT/TOKEN───────────────────────────►│
  │                                               │ upgrade() → have_token()
  │◄──────────────────────────────────────────────┤
  │           WS connected, gra rozpoczęta        │
```

### Kanały Redis

| Channel | Wiadomość | Format |
|---|---|---|
| `join:{game_id}` | Mother → Child | `JSON: {token, name, skin_id, account}` |

---

## 5. Skąd pochodzi `game_id` — 6-krokowy Przepływ ID

Klient nie "zgaduje" do której gry dołączyć — dostaje listę ID od Mother, wybiera jedno i odsyła je. Oto pełny łańcuch:

**Krok 1 — Child generuje ID przy starcie:**
```javascript
const game_id = gen_id();  // losowy Uint32, np. 3847291650
```

**Krok 2 — Child rejestruje się w Redis pod tym ID:**
```javascript
await redis_pub.hSet(`game:${game_id}`, {
    g_port: AGONES_PORT.toString(), g_players_len: "0",
    g_players_lim: MAX_PLAYERS.toString(), serv_ip: AGONES_IP,
    serv_loc: COUNTRY, serv_name: SERVER_NAME,
});
await redis_pub.sAdd('game_ids', game_id.toString());
```

**Krok 3 — Child subskrybuje kanał ze SWOIM ID:**
```javascript
await redis_sub.subscribe(`join:${game_id}`, (message) => { ... });
// Słucha TYLKO na join:3847291650 — żadna inna instancja nie dostanie tej wiadomości
```

**Krok 4 — Mother czyta listę i wysyła do klienta:**
```javascript
const ids = await redis.sMembers('game_ids');
for (const id of ids) {
    const g = await redis.hGetAll(`game:${id}`);
    if (g && g.g_port) games.push({ id: parseInt(id), ...g });
}
// Klient otrzymuje: [{ id: 3847291650, players_len: 7, serv_name: "EU-Nexus" }, ...]
```

**Krok 5 — Klient wybiera grę i odsyła jej ID:**
```
joinGame(gameId=3847291650, name="Phantom", skinId=3, accountId="...")
```

**Krok 6 — Mother publikuje na kanał TEGO konkretnego Child:**
```javascript
await redis.publish(`join:${gameId}`, JSON.stringify({ token, name, skin_id, account }));
//                          ↑
//                 3847291650 — ID przesłane przez klienta
// Tylko child.js z game_id = 3847291650 odbierze tę wiadomość.
```

### Schemat przepływu ID

```
child.js (game_id=3847291650)
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

## 6. Szczegółowy 9-krokowy Join Flow

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

Krok 1 — Klient wysyła pakiet type 0 do Mother z wyborem serwera.
Krok 2 — Mother weryfikuje czy serwer istnieje i ma wolne miejsca (`hGetAll` + porównanie `g_players_len < g_players_lim`).
Krok 3 — Mother generuje losowy `token = gen_id()` (uint32).
Krok 4-5 — Mother publikuje token do Redis; Child odbiera przez callback subskrypcji i zapamiętuje w `tokens{}`.
Krok 6 — Po 50ms (bufor na latencję Redis) Mother odsyła klientowi `{token, port, ip}`.
Krok 7 — Klient otwiera nowe połączenie WebSocket bezpośrednio z Child: `ws://ip:port/TOKEN`.
Krok 8 — Child weryfikuje token w `upgrade()`: `have_token(token) → true` → akceptuj, `false` → HTTP 401.
Krok 9 — Child tworzy gracza, token zostaje zniszczony (`null + delete`).

---

## 7. Konfiguracja 

| Parametr | Wartość | Lokalizacja |
|---|---|---|
| Opóźnienie tokena | 50ms | `setTimeout(..., 50)` w Mother |
| TTL tokena | ~160s | `frame + 10000` w Child |
| Max nick w grze | 9 znaków | `name.length > 9` w Mother |
| Max nick konta | 19 znaków | `name.length >= 20` w handleChangeName |

 
