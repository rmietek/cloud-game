# Plik: docs/redis-pubsub.md

## Komunikacja między serwerami przez Redis Pub/Sub

---

## Przegląd architektury

Redis pełni rolę **magistrali komunikacyjnej** między serwerami `mother-lobby` a `child-gameserver`. Żaden z serwerów nie zna adresów sieciowych drugiego — całość komunikacji przechodzi przez Redis.

```
mother.js  ──publish──►  Redis  ──subscribe──►  child.js
child.js   ──publish──►  Redis  ──subscribe──►  mother.js
```

---

## Wzorzec dwóch klientów Redis

Protokół Redis wymaga **dwóch osobnych połączeń TCP** — po jednym na każdym serwerze:

**W `mother.js`:**
```javascript
const redis    = createClient({ url: CONFIG.REDIS_URL }); // operacje + publish
const redisSub = createClient({ url: CONFIG.REDIS_URL }); // TYLKO subscribe
```

**W `child.js`:**
```javascript
redis_pub = createClient({ url: REDIS_URL }); // hSet, expire, sAdd, del, publish
redis_sub = createClient({ url: REDIS_URL }); // TYLKO subscribe
```

**Dlaczego dwa klienty?** Po wywołaniu `SUBSCRIBE`, Redis przełącza klienta w tryb "subscriber mode" — w tym trybie klient może **wyłącznie** odbierać wiadomości. Żadne inne komendy (`GET`, `SET`, `PUBLISH` itp.) nie są dozwolone. Stąd potrzeba osobnego klienta do normalnych operacji.

---

## Kanały Pub/Sub

### 1. Kanał `lobby_update`

**Kierunek:** `child.js` → Redis → `mother.js`

**Kiedy `child.js` publikuje:**
- Rejestracja nowego serwera gry (`redis_connect()` — serwer startuje)
- Co ~1 sekundę: aktualizacja liczby graczy (`redis_update_player_count()`)
- Zamknięcie serwera gry (`redis_cleanup()` — SIGTERM lub pusty serwer)

**Co robi `mother.js` po odebraniu:**
```javascript
// mother.js — connectRedis()
await redisSub.subscribe('lobby_update', () => {
    if (c_man) c_man.broadcast_games().catch(console.error);
});
```
`broadcast_games()` pobiera aktualną listę gier z Redis i wysyła pakiet binarny (typ 2) do **wszystkich** podłączonych klientów lobby przez wbudowany pub/sub uWS (`app.publish('lobby', buf, true)`).

**Przykład publikacji w `child.js`:**
```javascript
// Przy rejestracji serwera
await redis_pub.publish('lobby_update', '1');

// Przy aktualizacji liczby graczy
redis_pub.hSet(`game:${game_id}`, 'g_players_len', player_length.toString())
    .then(() => redis_pub.expire(`game:${game_id}`, 5))
    .then(() => redis_pub.publish('lobby_update', '1'))
    .catch(console.error);
```

Wiadomość `'1'` to dowolna wartość — ważny jest **sam sygnał**, nie treść.

---

### 2. Kanał `join:<game_id>`

**Kierunek:** `mother.js` → Redis → `child.js`

**Format kanału:** `join:3482901234` (każdy serwer gry ma swój dedykowany kanał)

**Kiedy `mother.js` publikuje:**
Gdy gracz kliknie "Dołącz" i przejdzie walidację (`handleJoinGame`):
```javascript
// mother.js — handleJoinGame()
await redis.publish(`join:${gameId}`, JSON.stringify({
    token,
    name,
    skin_id: skinId,
    account: accountId ? accountId.toString() : '',
}));
```

**Co robi `child.js` po odebraniu:**
```javascript
// child.js — redis_connect()
await redis_sub.subscribe(`join:${game_id}`, (message) => {
    const data = JSON.parse(message);
    tokens[data.token] = {
        token:    data.token,
        name:     data.name,
        skin_id:  data.skin_id,
        account:  data.account,
        timelive: frame + 10000, // token ważny przez ~160 sekund
    };
});
```

Token trafia do lokalnej mapy `tokens{}`. Gdy klient próbuje nawiązać połączenie WebSocket z URL `ws://ip:port/<token>`, funkcja `upgrade()` sprawdza `have_token(token_id)` — jeśli token istnieje, połączenie jest akceptowane.

---

## Dane w Redis (nie pub/sub — klucze stałe)

Poza pub/sub, `child.js` zapisuje dane statyczne które `mother.js` czyta przez `HGETALL` / `SMEMBERS`:

### Hash `game:<game_id>`

Tworzony przez `child.js` przy starcie (`redis_connect()`):
```javascript
await redis_pub.hSet(`game:${game_id}`, {
    g_port:        AGONES_PORT.toString(), // port WebSocket serwera gry
    g_players_len: "0",                    // liczba graczy (aktualizowana co ~1s)
    g_players_lim: MAX_PLAYERS.toString(), // limit graczy (np. "15")
    serv_ip:       AGONES_IP,              // publiczne IP węzła K8s
    serv_loc:      COUNTRY,                // region: "EU", "US", "ASIA" itp.
    serv_name:     SERVER_NAME,            // czytelna nazwa: "EU-Phantom"
});
await redis_pub.expire(`game:${game_id}`, 5); // TTL 5s — "dead man's switch"
```

**Mechanizm TTL (dead man's switch):** Jeśli serwer gry crashnie bez SIGTERM, klucz automatycznie zniknie z Redis po maksymalnie 5 sekundach. `redis_update_player_count()` wywołuje `expire()` co ~1 sekundę, odnawiając TTL. Lobby nie pokaże martwego serwera.

### Set `game_ids`

```javascript
await redis_pub.sAdd('game_ids', game_id.toString()); // przy starcie
await redis_pub.sRem('game_ids', game_id.toString()); // przy zamknięciu
```

`mother.js` pobiera listę przez `redis.sMembers('game_ids')`, a następnie dla każdego ID wywołuje `redis.hGetAll('game:${id}')`.

---

## Pełny przepływ: gracz dołącza do gry

```
Gracz klika "Dołącz"
        │
        ▼
mother.js: handleJoinGame()
  1. redis.hGetAll(`game:${gameId}`) — czy serwer istnieje?
  2. Sprawdź czy g_players_len < g_players_lim
  3. token = gen_id() — losowy uint32
  4. redis.publish(`join:${gameId}`, JSON({token, name, skin_id, account}))
  5. Wyślij do klienta: pakiet typ 0 [token, port, ip] z 50ms opóźnieniem
        │
        ▼
child.js: subskrypcja `join:${game_id}`
  6. tokens[token] = { name, skin_id, account, timelive: frame+10000 }
        │
        ▼
Klient: ws://ip:port/<token>
        │
        ▼
child.js: upgrade()
  7. have_token(token) → true → akceptuj WebSocket
  8. open(): delete tokens[token], utwórz gracza
```

---

## Przepływ: zamknięcie serwera gry (SIGTERM)

```javascript
// child.js — redis_cleanup()
async function redis_cleanup() {
    await redis_pub.del(`game:${game_id}`);        // usuń hash natychmiast
    await redis_pub.sRem('game_ids', game_id.toString()); // usuń z setu
    await redis_pub.publish('lobby_update', '1');  // powiadom lobby
}

process.on('SIGTERM', () => {
    is_shutting_down = true; // zatrzymaj redis_update_player_count()
    redis_cleanup().then(() => setTimeout(() => process.exit(0), 1000));
});
```

Flaga `is_shutting_down` zapobiega **race condition**: bez niej `redis_update_player_count()` (wywoływana co ~1 sekundę) mogłaby odtworzyć klucz `game:<id>` zaraz po tym jak `redis_cleanup()` go usunęła.
