# Plik: docs/child-server.md

## Architektura serwera Child (Serwer gry + Agones)

---

## Przegląd

`child-gameserver` to właściwy serwer gry — jedna instancja na jedną sesję multiplayer. Odpowiada za:

1. **Pętlę gry** — fizyka, kolizje, AI botów (co 16ms, ~62.5 tick/s)
2. **WebSocket** — połączenia graczy przez uWebSockets.js
3. **Integrację z Agones** — cykl życia GameServer w Kubernetes
4. **Rejestrację w Redis** — żeby `mother.js` wiedział o jego istnieniu
5. **Zapis punktów** — do MongoDB przy śmierci gracza / rozłączeniu

---

## Konfiguracja i stałe

```javascript
const COUNTRY         = "EU";       // kod regionu serwera
const SERVER_NAME     = COUNTRY + "-" + losowe_słowo; // np. "EU-Phantom"
const SERVER_PORT     = parseInt(process.env.PORT || process.argv[2] || 5000);
const MAX_PLAYERS     = 15;         // limit ludzkich graczy (boty nie liczą się)
const SERVER_TICK_MS  = 16;         // ms na tick → ~62.5 Hz
const GRAVITY         = 0.1;        // odejmowane od v_y co tick
const PLAYER_RADIUS   = 11;         // promień hitboxa (kołowego)
const BOT_COUNT       = 37;         // boty AI tworzone przy starcie
const MAX_FREE_IDS    = 255;        // max obiektów (uint8 → ID w pakiecie binarnym)
const REDIS_URL       = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGO_URL       = process.env.MONGO_URL || 'mongodb://localhost:27017';
```

**Pula nazw serwera** (`SERVER_NAME_WORDS`): 20 słów (`"Nexus"`, `"Phantom"`, `"Vortex"` itd.) — losowana raz przy starcie procesu. Gracze zapamiętują `"EU-Phantom"` łatwiej niż `"game-server-7f3a"`.

**`SERVER_PORT`** — trzy źródła (priorytet malejący):
1. `process.env.PORT` — Kubernetes/Docker
2. `process.argv[2]` — ręczne uruchomienie: `node main.js 6000`
3. `5000` — domyślny fallback

W produkcji Agones przydziela zewnętrzny port z zakresu `7000–8000` (NodePort) i zwraca go przez SDK. Zewnętrzny port trafia do `AGONES_PORT`, który jest zapisywany w Redis jako `g_port`.

---

## Integracja z Agones SDK

### Flagi środowiskowe

```javascript
const USE_AGONES = process.env.USE_AGONES === 'true';
const IS_LOCAL   = process.env.USE_AGONES !== 'true';
```

Bez ustawionego `USE_AGONES=true` (np. lokalny development) SDK jest całkowicie pomijany.

### Stany GameServer w Agones

```
Starting → Ready → Allocated → (Shutdown)
```

| Stan | Opis |
|---|---|
| `Starting` | Pod się uruchamia, nie przyjmuje graczy |
| `Ready` | Gotowy do przyjęcia graczy, autoskaler może przydzielić |
| `Allocated` | Gracz dołączył — autoskaler go nie ruszy |
| `Shutdown` | Kończy działanie |

### `connectAgones()` — sekwencja inicjalizacji

```javascript
async function connectAgones() {
    if (!USE_AGONES) {
        await redis_connect(); // lokalnie: od razu zarejestruj w Redis
        return;
    }

    await agonesSDK.connect();        // połącz z sidecar kontenerem Agones
    const gs = await agonesSDK.getGameServer(); // pobierz metadane GameServera

    // Pobierz zewnętrzny port
    const allocatedPorts = gs.status.portsList || gs.status.ports;
    if (allocatedPorts && allocatedPorts.length > 0) {
        AGONES_PORT = allocatedPorts[0].port; // zewnętrzny NodePort
    }

    // Pobierz publiczne IP węzła K8s
    if (gs.status.address) {
        AGONES_IP = gs.status.address; // np. "34.89.123.45"
    }

    await agonesSDK.ready(); // StartingReady (autoskaler może teraz przydzielić)

    // Heartbeat co 2 sekundy
    health_interval = setInterval(() => {
        try { agonesSDK.health(); } catch (_) {}
    }, 2000);

    await redis_connect(); // rejestruj dopiero gdy znamy prawdziwy IP i port
}
```

**Dlaczego `ready()` jest wywoływane PO pobraniu IP i portu?**
Gdyby lobby zobaczyło serwer zanim mamy prawidłowe dane połączenia, gracze próbowaliby połączyć się pod błędny adres.

### Heartbeat (health check)

```javascript
setInterval(() => {
    try { agonesSDK.health(); } catch (_) {}
}, 2000); // co 2 sekundy
```

Agones monitoruje czy heartbeat przychodzi regularnie. Brak sygnału przez ~30 sekund → Agones uznaje serwer za martwy i restartuje pod. Mechanizm "watchdog" chroni przed zawieszonymi procesami.

### Agones i cykl życia gracza

```javascript
// open() — pierwszy gracz dołącza
if (player_length === 1 && !is_allocated) {
    is_allocated = true;
    if (USE_AGONES) agonesSDK.allocate().catch(console.log);
    // Ready → Allocated (autoskaler nie ruszy tego serwera)
}

// close() — ostatni gracz wychodzi
if (player_length === 0 && is_allocated) {
    is_allocated = false;
    if (USE_AGONES) agonesSDK.ready().catch(console.log);
    // Allocated → Ready (serwer wraca do puli dostępnych)
}
```

---

## Rejestracja w Redis

### `redis_connect()` — przy starcie

```javascript
async function redis_connect() {
    redis_pub = createClient({ url: REDIS_URL });
    redis_sub = createClient({ url: REDIS_URL });
    await redis_pub.connect();
    await redis_sub.connect();

    // MongoDB — do zapisu punktów
    const mongoClient = await MongoClient.connect(MONGO_URL);
    db_users = mongoClient.db('gra').collection('users');

    // Zarejestruj serwer jako hash w Redis
    await redis_pub.hSet(`game:${game_id}`, {
        g_port:        AGONES_PORT.toString(),
        g_players_len: "0",
        g_players_lim: MAX_PLAYERS.toString(),
        serv_ip:       AGONES_IP,
        serv_loc:      COUNTRY,
        serv_name:     SERVER_NAME,
    });

    await redis_pub.expire(`game:${game_id}`, 5);   // dead man's switch (TTL 5s)
    await redis_pub.sAdd('game_ids', game_id.toString()); // dodaj do listy aktywnych gier
    await redis_pub.publish('lobby_update', '1');    // powiadom lobby o nowym serwerze

    // Subskrybuj tokeny dołączania
    await redis_sub.subscribe(`join:${game_id}`, (message) => {
        const data = JSON.parse(message);
        tokens[data.token] = {
            token: data.token, name: data.name,
            skin_id: data.skin_id, account: data.account,
            timelive: frame + 10000,
        };
    });
}
```

### `redis_update_player_count()` — co ~1 sekundę (co 60 ticków)

```javascript
function redis_update_player_count() {
    if (!redis_pub || is_shutting_down) return;
    redis_pub.hSet(`game:${game_id}`, 'g_players_len', player_length.toString())
        .then(() => redis_pub.expire(`game:${game_id}`, 5)) // odnów TTL (heartbeat)
        .then(() => redis_pub.publish('lobby_update', '1'))
        .catch(console.error);
}
```

**Dead man's switch:** TTL jest odnawiany co sekundę. Jeśli serwer crashnie bez SIGTERM, klucz automatycznie zniknie z Redis po max 5 sekundach. Lobby nie pokaże martwego serwera.

### `redis_cleanup()` — przy zamknięciu

```javascript
async function redis_cleanup() {
    await redis_pub.del(`game:${game_id}`);          // usuń hash natychmiast
    await redis_pub.sRem('game_ids', game_id.toString()); // usuń z setu
    await redis_pub.publish('lobby_update', '1');    // powiadom lobby
}
```

---

## Obsługa SIGTERM

```javascript
process.on('SIGTERM', () => {
    console.log('Otrzymano SIGTERM. Usuwam grę z Redis i zamykam.');
    is_shutting_down = true; // zatrzymaj redis_update_player_count()
    redis_cleanup().then(() => {
        setTimeout(() => process.exit(0), 1000); // czekaj 1s na propagację Redis
    }).catch(console.error);
});
```

**Kolejność ważna:**
1. `is_shutting_down = true` — zatrzymuje `redis_update_player_count()` (race condition protection)
2. `redis_cleanup()` — usuwa serwer z Redis i powiadamia lobby
3. `setTimeout(1s)` — daje czas na dotarcie wiadomości do lobby (Redis latency ~1-5ms)
4. `process.exit(0)` — clean exit, kod 0 = sukces

---

## Pętla gry

```javascript
game_loop_interval = setInterval(function () {
    frame++;

    // Co 10000 ticków (~160s): usuń wygasłe tokeny
    if (frame % 10000 === 0) {
        for (const t in tokens) {
            if (tokens[t] && tokens[t].timelive < frame) delete tokens[t];
        }
    }

    // AI botów: ruch w lewo/prawo
    for (let i = bots.length; i--;) {
        const b = bots[i];
        b.time--;
        if (b.time < 0) {
            b.move = (Math.random() * 3) | 0; // 0=stój, 1=lewo, 2=prawo
            b.time = (Math.random() * 100) | 0;
        }
        if (b.move === 1) b.player.move_x -= (Math.random() * 3) | 0;
        if (b.move === 2) b.player.move_x += (Math.random() * 3) | 0;
    }

    // Fizyka wszystkich graczy
    for (const i in players) {
        if (!players[i].is_dead) players[i].move();
    }

    // Generuj i wyślij pakiety
    gen_packet();

    // Co ~1 sekundę (60 ticków): aktualizuj Redis
    if (frame % 60 === 0) redis_update_player_count();

}, SERVER_TICK_MS);
```

---

## WebSocket — obsługa połączeń

### `upgrade()` — autoryzacja tokenu

```javascript
upgrade: (res, req, context) => {
    const token_id = req.getUrl().slice(1); // URL: "/token123" → "token123"
    if (!have_token(token_id)) {
        res.writeStatus('401 Unauthorized').end();
        return;
    }
    res.upgrade({ token_id }, /* WebSocket headers */, context);
}
```

Token musi być w `tokens{}` i nie może być wygasły (`timelive > frame`). Przy odmowie: HTTP 401, WebSocket nie jest otwierany.

### `open()` — inicjalizacja gracza

```javascript
open: (ws) => {
    const data     = ws.getUserData();
    const token_id = data.token_id;
    const id       = free_ids.pop(); // pobierz wolne ID z puli

    players[id]         = new player(id, ws, tokens[token_id]);
    players[id].skin_id = tokens[token_id].skin_id;

    // Zużyj token (jednorazowy)
    delete tokens[token_id];

    data.player    = players[id];
    player_length++;

    // Agones: przy pierwszym graczu → Allocated
    if (player_length === 1 && !is_allocated) {
        is_allocated = true;
        if (USE_AGONES) agonesSDK.allocate().catch(console.log);
    }

    // Wyślij pakiet inicjalizacyjny (typ 3): self_id + lista wszystkich graczy
    // Wyślij pakiet typ 7: lista martwych graczy
    // Wyślij dane mapy: pierwsze 10 poziomów
}
```

### `message()` — obsługa wejścia gracza

```javascript
message: (ws, message, isBinary) => {
    const data = ws.getUserData();
    const p    = data.pg.set_buffer(message);
    switch (p.g_uint8()) {
        case 0: // ruch: pl.move_x = p.g_int8()
        case 1: // zmiana skina: pl.skin_id = p.g_uint8()
        case 2: // event_use = -1 (przeskok przez kafelek)
        case 3: // respawn żądanie (wyślij pakiet z kwotą złota)
        case 4: // czat: chat_players.push({ id, msg })
        case 5: // ping
        case 8: // respawn potwierdzenie: is_dead = false
    }
}
```

### `close()` — rozłączenie gracza

```javascript
close: (ws, code, message) => {
    const pl = ws.getUserData().player;
    save_player_money(pl, pl.points - pl.account_points); // zapisz zarobione punkty

    remove_players.push(pl.id);  // powiadom innych graczy
    ranking.splice(pl.ranking_id, 1); // usuń z rankingu
    free_ids.push(pl.id);            // zwróć ID do puli
    delete players[pl.id];
    player_length--;

    // Agones: gdy serwer pusty → wróć do Ready
    if (player_length === 0 && is_allocated) {
        is_allocated = false;
        if (USE_AGONES) agonesSDK.ready().catch(console.log);
    }
}
```

---

## System graczy i botów

### Obiekt `player`

Kluczowe pola:

| Pole | Opis |
|---|---|
| `id` | Unikalny uint8 (0–254), z puli `free_ids` |
| `socket` | uWS WebSocket lub `null` (boty) |
| `x` | Pozycja kątowa na cylindrze (0–1023) |
| `y` | Pozycja pionowa (głębokość w cylindrze) |
| `move_x` | Horyzontalna delta z pakietu klienta, zerowana po każdym ticku |
| `jump_frame` | Tikki od ostatniego lądowania (do obliczania prędkości pionowej) |
| `lvl` | Aktualny segment (piętro cylindra) |
| `event` | Żywotność 0–10 (`+1` za checkpoint, `-2` za czerwony kafelek) |
| `event_use` | Maszyna stanów interakcji z kafelkami (-2=normalny, -1=aktywny, -3=uderzony) |
| `ranking_id` | Indeks w tablicy `ranking[]` (aktualizowany przy każdej zmianie punktów) |
| `byte_point` | Cache skompresowanych punktów (`to_bignum_byte()`) |
| `is_dead` | Flaga: gracz martwy, czeka na respawn |
| `account` | MongoDB ObjectId string lub `''` (gość/bot) |
| `bot` | `null` dla ludzi, obiekt `Bot` dla botów |

### Boty AI

```javascript
function bot() {
    this.move = 0;          // 0=stój, 1=lewo, 2=prawo
    this.time = 0;          // tiki do zmiany kierunku (0–99)
    this.respawn_lvl = (Math.random() * 13) | 0; // stały poziom bota (0–12)
    // + tworzy obiekt player(id, null, {...})
}
for (let i = BOT_COUNT; i--;) bots.push(new bot()); // 37 botów przy starcie
```

Boty nie zwracają ID do `free_ids` — zajmują je na stałe przez cały czas życia serwera. Rozłożone na różnych poziomach (0–12) cylindra, żeby mapa wyglądała żywo dla nowych graczy.

---

## Generowanie mapy (proceduralnie)

```javascript
// Cylinder: 128 kafelków × N poziomów
// Typy: 0=pustka, 1=bezpieczna platforma, 2=śmiertelna platforma

function gen_lvl() {
    for (let l = 100; l--;) {
        const id = levels_sav + l;

        // Checkpoint: id = 10n² (0, 10, 40, 90, 160...)
        if (!(Math.sqrt(id / 10) % 1)) {
            levels[id] = new Uint8Array(128).fill(1); // pełny pierścień
            levels[id][0]  = levels[id][1]  = levels[id][2]  = 0; // przejście 1
            levels[id][42] = levels[id][43] = levels[id][44] = 0; // przejście 2
            levels[id][84] = levels[id][85] = levels[id][86] = 0; // przejście 3
            continue;
        }

        // Normalny poziom: losowe platformy (trudność rośnie z głębokością)
        const badCount = ((id / 40) | 0) + 4;  // śmiertelne grupy
        const norCount = ((id / 20) | 0) + 20; // bezpieczne grupy
        // ...generuj grupy kafelków z wrap-around (&= 0b1111111)
    }
    levels_sav += 100;
}

for (let i = 25; i--;) gen_lvl(); // pre-generate 2500 poziomów przed startem
```

---

## Fizyka gracza (`move()`)

```
Co tick dla każdego żywego gracza:

1. Kolizje z innymi graczami (segmenty lvl-1 i lvl)
   → wymiana prędkości move_x
   → separacja graczy (rozsuń na odległość PLAYER_RADIUS×2)
   → this.target = other (do systemu zabójstw)

2. Grawitacja
   vecy = 4 - jump_frame × GRAVITY(0.1)
   if (vecy < -10) vecy = -10  // cap prędkości opadania
   this.y += vecy

3. Kolizja z kafelkami
   col = Math.abs((this.y - 8) >> 4)  // warstwa pionowa
   tile_index = this.x >> 3            // kafelek kątowy (0–127)
   if levels[lvl][tile_index] == 1 → lądowanie (jump_frame=0)
   if levels[lvl][tile_index] == 2 → trafienie w czerwony

4. Zmiana poziomu
   Nowe lvl = Math.abs((this.y) >> 7)
   → aktualizuj segment_player[]
   → przy checkpoincie: saved_points, respawn_lvl, event++

5. Wysyłka danych mapy (jeśli gracz zbliżył się do przodu)
   if (lvl > send_lvl - 5) → wyślij kolejne 10 poziomów (pakiet typ 4)
```

---

## Optymalizacje wydajności

### Mapa przestrzenna (`segment_player`)

```javascript
// Zamiast O(n²) par kolizji:
// Sprawdzamy tylko gracze w segmentach (lvl-1) i (lvl)
for (let z = this.lvl - 1; z <= this.lvl; z++) {
    for (let i = segment_player[z].length; i--;) { /* ... */ }
}
// 52 obiekty × 2 segmenty × ~2 graczy/segment = ~208 porównań
// vs 52² = 2704 bez optymalizacji → ~13× szybciej
```

### Detekcja kolizji bez pierwiastka

```javascript
function is_colid(ax, ay, ar, bx, by, br) {
    const dx = ax - bx, dy = ay - by, r = ar + br;
    return dx * dx + dy * dy <= r * r; // sqrt() nie potrzebny
}
```

### Kompresja punktów do 1 bajtu

```javascript
function to_bignum_byte(points) {
    if (points > 66000000) return 255;
    if (points > 1000000)  return points / 100000 + 189;
    if (points > 100000)   return (points - 100000) / 10000 + 100;
    return points / 1000;
}
// 4 miliony punktów → 1 bajt w pakiecie rankingu
```

### Ranking — bubble-sort jeden krok

```javascript
this.add_points = function(amount) {
    this.points += amount;
    // Sprawdź czy skompresowany byte zmienił się (unikaj wysyłki przy małych zmianach)
    // Przesuń w górę rankingu tylko gdy zaszła zmiana (jeden krok bubble-sort)
    while (above && above.points < this.points) {
        // swap ranking[this.ranking_id] ↔ ranking[this.ranking_id - 1]
    }
};
```
