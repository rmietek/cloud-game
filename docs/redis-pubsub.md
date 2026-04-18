# Redis Pub/Sub — Komunikacja Między Serwerami

## 1. Rola Redisa w Projekcie

Redis pełni w tym systemie rolę **magistrali komunikacyjnej** (event bus) łączącej dwa niezależne procesy: serwer lobby (`mother.js`) i serwery gry (`child.js`). Żaden z tych procesów nie zna bezpośredniego adresu sieciowego drugiego — cała komunikacja przebiega przez Redis.

Redis realizuje w tej architekturze **trzy zadania jednocześnie**:

1. **Rejestr serwerów gry** — przechowuje listę aktywnych instancji Child wraz z ich adresem, portem i bieżącą liczbą graczy.
2. **Service Discovery** — Mother odnajduje dostępne serwery gry przez Redis zamiast korzystać z hardkodowanych adresów. To kluczowe przy dynamicznym skalowaniu Agones.
3. **Event Bus** — Pub/Sub synchronizuje stan lobby i autoryzuje graczy bez bezpośrednich połączeń TCP między procesami.

Redis działa jako **baza danych wyłącznie w pamięci RAM** — operacje są błyskawiczne, ale dane znikają po restarcie. W tym projekcie jest to celowe i akceptowalne: każdy Child rejestruje się ponownie przy starcie, więc stan odtwarza się automatycznie.

**Deployment:** `redis:7-alpine` jako K8s `Deployment` z wyłączoną persystencją (`--save ""`), dostępny tylko wewnątrz klastra jako `ClusterIP` na porcie 6379.

### Schemat ogólny — kiedy, co i w którą stronę

Poniżej każde zdarzenie w systemie pokazane jako osobny blok z wyraźnym kierunkiem przepływu danych.

---

#### Zdarzenie 1 — Child uruchamia się (`[START]`)

Child zapisuje swoje dane do Redis i ogłasza się lobby.

```
child.js                        REDIS                       mother.js
   │                              │                              │
   │── hSet('game:{id}', {...}) ──►│  zapisz dane serwera        │
   │── expire('game:{id}', 5)   ──►│  ustaw TTL 5s               │
   │── sAdd('game_ids', id)     ──►│  dodaj do listy             │
   │── publish('lobby_update')  ──►│──────────────────────────► │
   │                              │   (sygnał: odśwież lobby)   │── odczytuje listę i
   │                              │                              │   wysyła do klientów
```

---

#### Zdarzenie 2 — Heartbeat co ~1 sekundę (`[HEARTBEAT]`)

Child aktualizuje liczbę graczy i odnawia swój czas życia w Redis.

```
child.js                        REDIS                       mother.js
   │                              │                              │
   │── hSet('game:{id}',          │                              │
   │        'g_players_len', n) ──►│  zaktualizuj liczbę graczy  │
   │── expire('game:{id}', 5)   ──►│  odnów TTL (dead-man switch)│
   │── publish('lobby_update')  ──►│──────────────────────────► │
   │                              │   (sygnał: odśwież lobby)   │── wysyła świeżą listę
   │                              │                              │   do klientów
```

> Jeśli Child crashnie — `expire()` przestaje być wywoływane. Po 5 sekundach Redis sam usuwa klucz `game:{id}`. Mother przy kolejnym odczycie nie znajdzie danych i pomija serwer — **bez żadnej interwencji ręcznej**.

---

#### Zdarzenie 3 — Child zamyka się (`[SIGTERM]`)

Child usuwa swoje dane natychmiast (bez czekania na TTL) i powiadamia lobby.

```
child.js                        REDIS                       mother.js
   │                              │                              │
   │── sRem('game_ids', id)     ──►│  usuń z listy               │
   │── del('game:{id}')         ──►│  usuń dane natychmiast      │
   │── publish('lobby_update')  ──►│──────────────────────────► │
   │                              │   (sygnał: odśwież lobby)   │── usuwa serwer z listy
   │                              │                              │   wysyłanej klientom
```

---

#### Zdarzenie 4 — Mother buduje listę gier dla klientów (`[LOBBY]`)

Mother odczytuje dane wszystkich aktywnych serwerów i wysyła je jako pakiet binarny.

```
child.js                        REDIS                       mother.js
   │                              │                              │
   │                              │◄── sMembers('game_ids')   ───│  pobierz listę ID
   │                              │──────────────────────────► │
   │                              │                              │
   │                              │◄── hGetAll('game:{id_1}') ───│  pobierz dane serwera 1
   │                              │──────────────────────────► │
   │                              │◄── hGetAll('game:{id_2}') ───│  pobierz dane serwera 2
   │                              │──────────────────────────► │
   │                              │         ...                  │── wyślij pakiet binarny
   │                              │                              │   typ 2 do klientów WS
```

---

#### Zdarzenie 5 — Gracz klika "Dołącz" (`[JOIN]`)

Mother wysyła token przez Redis do konkretnego Child; Child zapamiętuje go i czeka na połączenie gracza.

```
child.js                        REDIS                       mother.js
   │                              │                              │
   │                              │◄── publish('join:{id}',   ───│  wyślij token + dane gracza
   │                              │    {token, name, skin...})   │  do konkretnego serwera
   │                              │                              │
   │◄── callback subscribe ───────│                              │
   │    tokens[token] = {...}     │                              │
   │    (token czeka na gracza)   │                              │
```

---

#### Zdarzenie 6 — Gracz wraca po rozłączeniu (`[RECONNECT]`)

Mother sprawdza czy serwer, do którego gracz chce wrócić, nadal działa.

```
child.js                        REDIS                       mother.js
   │                              │                              │
   │                              │◄── exists('game:{id}')    ───│  czy serwer jeszcze żyje?
   │                              │──────────────────────────► │
   │                              │   1 = żyje / 0 = padł       │── jeśli 1: wyślij token
   │                              │                              │   jeśli 0: odrzuć reconnect
```

---

## 2. Struktura Danych w Redis

Projekt używa trzech typów struktur. Wszystkie wartości liczbowe przechowywane są jako stringi — Redis nie rozróżnia typów w HASH.

### HASH `game:{game_id}` — dane konkretnego serwera gry

Jeden HASH per instancja Child. Klucz zawiera losowy 32-bitowy identyfikator serwera.

```
HASH game:3847291650  →  {
    g_port:        "30542"         ← zewnętrzny port WebSocket (przydzielony przez Agones)
    g_players_len: "3"             ← aktualna liczba graczy (aktualizowana co ~1s)
    g_players_lim: "15"            ← maksymalny limit graczy
    serv_ip:       "34.89.123.45"  ← publiczne IP węzła K8s
    serv_loc:      "EU"            ← kod regionu serwera
    serv_name:     "EU-Phantom"    ← czytelna nazwa serwera w lobby
    TTL: 5s                        ← dead-man's switch, odnawiany co ~1s
}
```

### SET `game_ids` — rejestr aktywnych serwerów

Nieuporządkowany zbiór wszystkich aktywnych identyfikatorów gier. Kolejność elementów jest **losowa** — nie należy zakładać żadnego sortowania.

```
SET game_ids  →  { "3847291650", "1234567890", "9182736450" }
TTL: brak — zarządzany ręcznie przez sAdd/sRem
```

### Kanały Pub/Sub

```
'lobby_update'    ← Child publikuje, Mother subskrybuje
'join:{game_id}'  ← Mother publikuje, konkretny Child subskrybuje
```

Tabela zależności — kto pisze, kto czyta:

| Klucz / Kanał | Typ | Kto zapisuje | Kto czyta |
|---|---|---|---|
| `game:{id}` | HASH | Child (`hSet`, `expire`) | Mother (`hGetAll`) |
| `game_ids` | SET | Child (`sAdd`, `sRem`) | Mother (`sMembers`) |
| `lobby_update` | PUB/SUB | Child (`publish '1'`) | Mother (→ `broadcast_games()`) |
| `join:{game_id}` | PUB/SUB | Mother (`publish JSON`) | Child (→ `tokens[]`) |

---

## 3. Wzorzec Dwóch Klientów Redis

Protokół Redis nakłada fundamentalne ograniczenie: po wywołaniu `subscribe()` klient **wchodzi w tryb subscriber** i nie może wykonywać żadnych innych komend — żadnego `hGetAll`, `sMembers`, `publish`, `del`, ani `expire`. Próba ich wywołania skutkuje błędem protokołu.

Ponieważ każdy serwer musi jednocześnie subskrybować kanał i wykonywać operacje na danych, konieczne jest utrzymanie **dwóch osobnych połączeń TCP**:

**`child.js`:**
```javascript
// apps/child-gameserver/main.js
redis_pub = createClient({ url: REDIS_URL }); // hSet, expire, sAdd, sRem, del, publish
redis_sub = createClient({ url: REDIS_URL }); // WYŁĄCZNIE subscribe
await redis_pub.connect();
await redis_sub.connect();
```

**`mother.js`:**
```javascript
// apps/mother-lobby/main.js
redis     = createClient({ url: REDIS_URL }); // hGetAll, sMembers, exists, publish
redisSub  = createClient({ url: REDIS_URL }); // WYŁĄCZNIE subscribe
await redis.connect();
await redisSub.connect();
```

---

## 4. Cykl Życia Serwera Gry w Redis

### Faza 1: Rejestracja (`redis_connect`)

Child wywołuje `redis_connect()` po pomyślnej inicjalizacji Agones. Operacje wykonywane są w ściśle określonej kolejności — każda zależy od poprzedniej.

```javascript
// apps/child-gameserver/main.js
async function redis_connect() {
    // 1. Nawiąż połączenia (patrz sekcja 3 — dwa klienty)
    redis_pub = createClient({ url: REDIS_URL });
    redis_sub = createClient({ url: REDIS_URL });
    await redis_pub.connect();
    await redis_sub.connect();

    // 2. Zapisz pełny profil serwera
    await redis_pub.hSet(`game:${game_id}`, {
        g_port:        String(AGONES_PORT),   // zewnętrzny port Agones (np. 30542)
        g_players_len: String(player_length), // 0 przy starcie
        g_players_lim: String(MAX_PLAYERS),   // stały limit 15
        serv_ip:       AGONES_IP,             // publiczne IP węzła K8s
        serv_loc:      COUNTRY,               // np. "EU"
        serv_name:     SERVER_NAME,           // np. "EU-Phantom"
    });

    // 3. Uruchom dead-man's switch — klucz wygaśnie po 5s bez odnowienia
    await redis_pub.expire(`game:${game_id}`, 5);

    // 4. Zarejestruj serwer w globalnym rejestrze
    await redis_pub.sAdd('game_ids', String(game_id));

    // 5. Powiadom lobby o nowym serwerze
    await redis_pub.publish('lobby_update', '1');

    // 6. Zacznij nasłuchiwać na tokeny dołączenia gracza
    await redis_sub.subscribe(`join:${game_id}`, (message) => {
        const data = JSON.parse(message);
        tokens[data.token] = {
            name:     data.name,
            skin_id:  data.skin_id,
            account:  data.account,
            timelive: frame + 10000, // token ważny ~160s (10000 × 16ms)
        };
    });
}
```

### Faza 2: Heartbeat (`redis_update_player_count`)

Co 60 taktów gry (~1 sekunda przy 16ms/takt) Child wysyła trzy operacje atomowo: aktualizuje liczbę graczy, odnawia TTL klucza i sygnalizuje lobby o zmianie.

```javascript
// apps/child-gameserver/main.js
// Wywoływana co 60 taktów z głównej pętli gry
async function redis_update_player_count() {
    if (is_shutting_down) return; // flaga zapobiega race condition przy zamykaniu

    // Łańcuch .then() zamiast await — nie blokuje pętli gry (fire-and-forget)
    redis_pub.hSet(`game:${game_id}`, 'g_players_len', String(player_length))
        .then(() => redis_pub.expire(`game:${game_id}`, 5)) // odnów TTL
        .then(() => redis_pub.publish('lobby_update', '1')) // odśwież lobby
        .catch(console.error);
}
```

Jeśli Child crashnie bez SIGTERM, `expire()` przestaje być wywoływane. Po upływie 5 sekund Redis automatycznie usuwa klucz `game:{id}`. Mother przy następnym `buildGamesPacket()` nie znajdzie danych dla tego ID (hGetAll zwróci `{}`) i pominie je. Serwer znika z lobby bez żadnej interwencji.

> **Uwaga na is_shutting_down:** bez tej flagi, gdyby `redis_cleanup()` usunął klucz, kolejny wywołanie `redis_update_player_count()` odtworzyłby go przez `hSet` — race condition, który sprawiłby, że martwy serwer pojawia się ponownie w lobby.

### Faza 3: Shutdown (`redis_cleanup`)

Wywoływana z handlera SIGTERM. Usuwa dane natychmiast (bez czekania na TTL), a następnie publikuje sygnał, by lobby natychmiast zaktualizowało listę.

```javascript
// apps/child-gameserver/main.js
async function redis_cleanup() {
    await redis_pub.sRem('game_ids', String(game_id)); // usuń z rejestru
    await redis_pub.del(`game:${game_id}`);            // usuń dane serwera (nie czekaj na TTL)
    await redis_pub.publish('lobby_update', '1');       // powiadom lobby o zniknięciu
    // Następnie: setTimeout 1000ms → process.exit(0)
    // 1s czekania zapewnia dostarczenie lobby_update do Mother przed zamknięciem procesu
}
```

---

## 5. Kanały Pub/Sub — Szczegóły

### Kanał `lobby_update` — Child → Mother

Child publikuje wartość `'1'` w trzech sytuacjach: przy rejestracji (`redis_connect`), przy każdym heartbeat'cie (`redis_update_player_count`) i przy zamknięciu (`redis_cleanup`).

Treść wiadomości jest celowo pozbawiona danych — to czysty **sygnał** (wzorzec *"Notification without payload"*). Mother po odebraniu samo odpytuje Redis o aktualny stan.

```javascript
// apps/mother-lobby/main.js
async function connectRedis() {
    // ...inicjalizacja klientów...
    await redisSub.subscribe('lobby_update', async () => {
        if (c_man) await c_man.broadcast_games();
        // c_man null check: ClientManager może być null w oknie startowym (startup race)
        // broadcast_games() → buildGamesPacket() → app.publish('lobby', buf, true)
        // app.publish rozsyła pakiet binarny (typ 2) do WSZYSTKICH klientów w lobby
    });
}
```

Łańcuch wywołań po odebraniu sygnału `'1'`:
```
child.js → redis_pub.publish('lobby_update', '1')
    │
    ▼ (Redis broker)
mother.js — redisSub callback
    └── c_man.broadcast_games()
          └── buildGamesPacket()
                ├── redis.sMembers('game_ids')     → lista ID
                ├── redis.hGetAll('game:id1')      → dane serwera
                ├── redis.hGetAll('game:id2')      → dane serwera
                └── buduje pakiet binarny typ 2
          └── app.publish('lobby', buf, true)      → wszyscy klienci WS
```

### Kanał `join:{game_id}` — Mother → Child

Kiedy gracz wybierze serwer z listy i kliknie "Dołącz", Mother generuje jednorazowy token i publikuje go na kanale dedykowanym danemu serwerowi. Kanał `join:{game_id}` jest **per-instancja** — każdy Child subskrybuje wyłącznie kanał ze swoim własnym `game_id`, więc wiadomość dotrze tylko do właściwego serwera.

```javascript
// apps/mother-lobby/main.js : linia 1247
await redis.publish(`join:${gameId}`, JSON.stringify({
    token,                                             // uint32 — jednorazowy klucz autoryzacyjny
    name,                                              // nick gracza (max 9 znaków)
    skin_id:  skinId,                                  // wybrany skin (0–22)
    account:  accountId ? accountId.toString() : '',   // MongoDB ObjectId lub '' dla gości
}));
// Dane serializowane jako JSON bo Redis pub/sub przesyła wyłącznie stringi.
// Po wysłaniu: setTimeout(50ms) → wysłanie tokena do klienta WS
// 50ms to bufor bezpieczeństwa na latencję Redis (~1–5ms) + przetworzenie przez Child
```

Child odbiera token i zapamiętuje go w słowniku `tokens{}` w pamięci RAM:
```javascript
// apps/child-gameserver/main.js — callback subskrypcji join:{game_id}
const data = JSON.parse(message);
tokens[data.token] = {
    name:     data.name,
    skin_id:  data.skin_id,
    account:  data.account,
    timelive: frame + 10000, // ~160s (10000 × 16ms) — token wygaśnie po tym czasie
};
```

---

## 6. Odczyt Listy Serwerów przez Mother

`buildGamesPacket()` pobiera listę aktywnych serwerów i buduje pakiet binarny rozsyłany do wszystkich klientów lobby. Wywoływana jest w trzech przypadkach: po odebraniu `lobby_update`, po podłączeniu nowego klienta do lobby oraz gdy klient jawnie poprosi o odświeżenie (type 6).

```javascript
// apps/mother-lobby/main.js
async function buildGamesPacket() {
    const ids = await redis.sMembers('game_ids'); // pobierz wszystkie aktywne ID
    const ps  = new packet_set(512);
    ps.new_type(2);
    ps.s_uint8(ids.length);

    for (const id of ids) {
        const data = await redis.hGetAll(`game:${id}`);
        if (!data || !data.g_port) continue;
        // Serwer mógł wygasnąć między sMembers() a hGetAll() — pomijamy.
        ps.s_uint32(parseInt(id));
        ps.s_uint8(parseInt(data.g_players_len));
        ps.s_uint8(parseInt(data.g_players_lim));
        ps.s_string(data.serv_loc);
        ps.s_string(data.serv_name);
        // Uwaga: serv_ip i g_port celowo pomijane — klient nie potrzebuje
        // adresu serwera dopóki nie prosi o dołączenie.
    }
    return Buffer.from(ps.get_buf());
}
```

Sprawdzenie aktywności serwera przy reconnect gracza:
```javascript
// apps/mother-lobby/main.js : linia 1488
redis.exists(`game:${gameId}`).then(exists => {
    if (!exists) return null; // klucz wygasł → serwer martwy → brak reconnect
    return db_users.findOneAndUpdate(...);
});
// exists() zwraca 1 (klucz istnieje) lub 0 (wygasł / nigdy nie istniał)
```

---

## 7. Słownik Komend Redis

Pełna tabela komend używanych w projekcie z opisem zachowania i lokalizacją w kodzie.

### Komendy HASH

| Komenda | Zachowanie | Zwraca |
|---|---|---|
| `hSet(key, obj)` | Tworzy lub nadpisuje podane pola; pozostałe pola HASH bez zmian | Liczba nowych pól |
| `hSet(key, field, val)` | Aktualizuje jedno pole | 0 (update) lub 1 (insert) |
| `hGetAll(key)` | Zwraca wszystkie pola jako obiekt JS | `{}` jeśli klucz nie istnieje (nie `null`) |

#### `hSet(klucz, obiekt)` — pełna rejestracja serwera

```javascript
// child.js — redis_connect()
await redis_pub.hSet(`game:${game_id}`, {
    g_port:        AGONES_PORT.toString(),
    g_players_len: "0",
    g_players_lim: MAX_PLAYERS.toString(),
    serv_ip:       AGONES_IP,
    serv_loc:      COUNTRY,
    serv_name:     SERVER_NAME,
});
```

#### `hSet(klucz, pole, wartość)` — aktualizacja pojedynczego pola

```javascript
// child.js — redis_update_player_count() co ~1s
redis_pub.hSet(`game:${game_id}`, 'g_players_len', player_length.toString())
    .then(() => redis_pub.expire(`game:${game_id}`, 5))
    .then(() => redis_pub.publish('lobby_update', '1'))
    .catch(console.error);
```

#### `hGetAll(klucz)` — odczyt pełnego profilu serwera

```javascript
// mother.js — buildGamesPacket()
const g = await redis.hGetAll(`game:${id}`);
// g = { g_port: "30542", g_players_len: "5", g_players_lim: "15", ... }
// Jeśli klucz nie istnieje: g = {} → g.g_port === undefined → skip
```

---

### Komendy SET

| Komenda | Zachowanie | Zwraca |
|---|---|---|
| `sAdd(key, val)` | Dodaje element; ignoruje duplikaty (no-op) | Liczba dodanych elementów |
| `sMembers(key)` | Zwraca wszystkie elementy jako tablicę; kolejność losowa | `[]` jeśli zbiór pusty |
| `sRem(key, val)` | Usuwa element; brak elementu = no-op | Liczba usuniętych elementów |

#### `sAdd` — zarejestruj serwer w globalnym rejestrze

```javascript
// child.js — redis_connect(), po zapisaniu HASH
await redis_pub.sAdd('game_ids', game_id.toString());
```

#### `sMembers` — pobierz listę aktywnych serwerów

```javascript
// mother.js — buildGamesPacket()
const ids = await redis.sMembers('game_ids');
// ["3847291650", "1029384756", "9182736450"] ← kolejność losowa przy każdym wywołaniu
```

#### `sRem` — wyrejestruj serwer przy zamknięciu

```javascript
// child.js — redis_cleanup()
await redis_pub.sRem('game_ids', game_id.toString());
```

---

### Komendy Ogólne

| Komenda | Zachowanie | Zwraca |
|---|---|---|
| `del(key)` | Usuwa klucz dowolnego typu natychmiast | Liczba usuniętych kluczy |
| `expire(key, secs)` | Ustawia TTL; klucz znika automatycznie po N sekundach | 1 (ustawiono) lub 0 (klucz nie istnieje) |
| `exists(key)` | Sprawdza obecność klucza | 1 (istnieje) lub 0 (nie ma / wygasł) |
| `publish(ch, msg)` | Fire-and-forget; brak kolejkowania; utrata jeśli nikt nie słucha | Liczba odbiorców |
| `subscribe(ch, cb)` | Blokuje klienta dla innych komend; dlatego wymagany drugi klient | — |

#### `del` — usuń serwer bez czekania na TTL

```javascript
// child.js — redis_cleanup()
await redis_pub.del(`game:${game_id}`);
// Natychmiastowe usunięcie — lobby nie widzi serwera już przy następnym hGetAll
```

#### `expire` — dead-man's switch

```javascript
// child.js — redis_connect() (pierwsze ustawienie)
await redis_pub.expire(`game:${game_id}`, 5);

// child.js — heartbeat (odnowienie co ~1s)
.then(() => redis_pub.expire(`game:${game_id}`, 5));
```

#### `exists` — weryfikacja przy reconnect

```javascript
// mother.js — handleReconnect()
redis.exists(`game:${gameId}`).then(exists => {
    if (!exists) return null; // serwer martwy
    return db_users.findOneAndUpdate(...);
});
```

#### `publish` — wysyłanie sygnałów i danych

```javascript
// child.js — sygnał zmiany stanu (lobby_update)
await redis_pub.publish('lobby_update', '1');
// Treść '1' jest umowna — sam fakt odebrania wiadomości wystarcza.

// mother.js — dane gracza do konkretnego Child (join:{id})
await redis.publish(`join:${gameId}`, JSON.stringify({
    token, name,
    skin_id: skinId,
    account: accountId ? accountId.toString() : '',
}));
```

#### `subscribe` — nasłuchiwanie na kanale (wymaga dedykowanego klienta)

```javascript
// child.js — redis_sub (osobny klient)
await redis_sub.subscribe(`join:${game_id}`, (message) => {
    const { token, name, skin_id, account } = JSON.parse(message);
    tokens[token] = { name, skin_id, account, timelive: frame + 10000 };
});
```

---

## 8. Konfiguracja Wdrożeniowa

### Deployment Redis w K8s

```yaml
# gitops/base/prz-redis.yaml
apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
      - name: redis
        image: redis:7-alpine
        command: ["redis-server", "--save", ""]
        # --save "" = wyłącz persystencję RDB i AOF
        # Redis jako ephemeral message bus — utrata danych przy restarcie akceptowalna.
        # Child i Mother rejestrują się ponownie przy każdym własnym starcie.
---
kind: Service
spec:
  type: ClusterIP   # dostępny TYLKO wewnątrz klastra K8s — żaden zewnętrzny ruch
  ports:
  - port: 6379
```

### Zmienne środowiskowe

| Zmienna | Wartość | Gdzie używana |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379` | `mother.js` i `child.js` |

Nazwa hosta `redis` pochodzi z nazwy K8s Service — automatycznie rozwiązywana przez DNS klastra na ClusterIP serwisu.

---

## 9. Znane Ograniczenia

### Pojedynczy punkt awarii

Redis nie ma repliki ani trybu Sentinel. Restart instancji Redis powoduje utratę wszystkich aktywnych wpisów `game:{id}` i `game_ids`. Child serwery które były zarejestrowane przed restartem nie odtworzą się automatycznie (nie mają mechanizmu ponownej rejestracji bez własnego restartu). Wynik: tymczasowy brak serwerów w lobby do czasu restartu podów Child.

**Rozwiązanie (nieimplementowane):** Redis Sentinel (HA z failover) lub Redis Cluster (sharding + replikacja).

### Race condition `sMembers` + `hGetAll`

Między pobraniem listy ID przez `sMembers` a pobraniem danych konkretnego serwera przez `hGetAll` może minąć kilka milisekund. Jeśli w tym czasie TTL klucza `game:{id}` wygaśnie, `hGetAll` zwróci `{}`. **Obsłużone** przez warunek `if (!data || !data.g_port) continue` — martwy serwer jest po cichu pomijany.

### `game_ids` SET bez TTL

Przy `SIGKILL` (zamiast `SIGTERM`) funkcja `redis_cleanup()` nigdy nie zostaje wywołana, przez co `sRem` nie usuwa ID z setu. Wpis w `game_ids` pozostaje do restartu Redisa lub ręcznego usunięcia. Martwy `game:{id}` wygaśnie po 5s (dead-man's switch), więc `hGetAll` zwróci `{}` → Mother pomija ten serwer. **Skutek praktyczny:** minimalne — martwe ID pozostaje w secie, ale jest transparentnie ignorowane przy każdym odczycie.
