# Redis Pub/Sub — Komunikacja Między Serwerami

## 1. Rola Redisa w Projekcie

Redis pełni w tym systemie rolę **magistrali komunikacyjnej** łączącej dwa niezależne procesy: serwer lobby (`apps/mother-lobby/main.js`) i serwery gry (`apps/child-gameserver/main.js`). Procesy te nie łączą się ze sobą bezpośrednio — nie znają swoich adresów sieciowych i nie muszą ich znać, bo całą wymianę danych pośredniczy Redis.

Redis realizuje w tej architekturze **trzy zadania jednocześnie**:

1. **Rejestr serwerów gry** — przechowuje listę aktywnych instancji Child wraz z ich adresem, portem i bieżącą liczbą graczy.
2. **Pośrednik adresów** — Mother nie zna adresów serwerów gry z góry. Każdy Child przy starcie wpisuje swoje IP i port do Redis (`hSet` na kluczu `game:{id}`), a Mother odczytuje je (`hGetAll`) w momencie gdy gracz prosi o dołączenie do konkretnej gry.
3. **Kanał komunikacyjny** — Pub/Sub służy do powiadamiania lobby o zmianach stanu gry (nowy serwer wystartował, liczba graczy się zmieniła, serwer się zamknął) oraz do przekazywania tokenów dołączenia bezpośrednio do konkretnego serwera.

### Wzorzec Pub/Sub

Pub/Sub (publish/subscribe) to wzorzec komunikacji, w którym nadawca i odbiorca nie wiedzą o sobie nawzajem — nie ma między nimi bezpośredniego połączenia. Zamiast tego obaj korzystają z pośrednika (brokera), którym w tym projekcie jest Redis.

- **Publisher** wysyła wiadomość na nazwany **kanał** i natychmiast o niej zapomina — nie wie kto słucha ani czy ktokolwiek ją odbierze.
- **Subscriber** rejestruje się na kanale z callbackiem — Redis wywołuje go automatycznie za każdym razem gdy pojawi się nowa wiadomość.

```
Publisher                  Redis (broker)             Subscriber
   │                            │                          │
   │── publish('kanał', msg) ──►│                          │
   │                            │── callback(msg) ────────►│
   │                            │   (natychmiast,          │
   │                            │    do każdego            │
   │                            │    subskrybenta)         │
```

W tym projekcie wzorzec jest używany dwukierunkowo: Child → Mother (kanał `lobby_update`) oraz Mother → Child (kanał `join:{game_id}`).

---

Redis trzyma wszystkie dane wyłącznie w pamięci RAM. Jeśli kontener Redis zostanie zrestartowany, wszystkie dane przepadają. W tym projekcie nie jest to problemem — każdy Child zapisuje swoje dane przy starcie i odnawia je co ~1 sekundę przez heartbeat, więc po restarcie Redisa lista serwerów odtwarza się sama w ciągu kilku sekund.

**Deployment:** `redis:7-alpine` jako K8s `Deployment` z wyłączonym zapisem danych na dysk (`--save ""`), dostępny tylko wewnątrz klastra na porcie 6379.

### Schemat ogólny — które komendy Redis są wywoływane i kiedy

Poniżej każde zdarzenie w systemie pokazane jako osobny blok z wyraźnym kierunkiem przepływu danych.

---

#### Zdarzenie 1 — Child uruchamia się (`[START]`)

Child zapisuje swoje dane do Redis i ogłasza się lobby.

```
apps/child-gameserver/main.js                 REDIS                apps/mother-lobby/main.js
                │                               │                             │
                │── hSet('game:{id}', {...}) ──►│  zapisz dane serwera        │
                │── expire('game:{id}', 5)   ──►│  ustaw TTL 5s               │
                │── sAdd('game_ids', id)     ──►│  dodaj do listy             │
                │── publish('lobby_update')  ──►│──────────────────────────►  │
                │                               │   (sygnał: odśwież lobby)   │── odczytuje listę i
                │                               │                                wysyła do klientów
```

---

#### Zdarzenie 2 — Heartbeat co ~1 sekundę (`[HEARTBEAT]`)

Child aktualizuje liczbę graczy i odnawia swój czas życia w Redis.

```
apps/child-gameserver/main.js                 REDIS                 apps/mother-lobby/main.js
                │                               │                              │
                │── hSet('game:{id}',           │                              │
                │        'g_players_len', n) ──►│  zaktualizuj liczbę graczy   │
                │── expire('game:{id}', 5)   ──►│  odnów TTL                   │
                │── publish('lobby_update')  ──►│──────────────────────────►   │
                │                               │   (sygnał: odśwież lobby)    │── wysyła świeżą listę
                │                               │                              │   do klientów
```

> Jeśli Child crashnie — `expire()` przestaje być wywoływane. Po 5 sekundach Redis sam usuwa klucz `game:{id}`. Mother przy kolejnym odczycie nie znajdzie danych i pomija serwer — **bez żadnej interwencji ręcznej**.

---

#### Zdarzenie 3 — Child zamyka się (`[SIGTERM]`)

SIGTERM to sygnał systemowy wysyłany przez Kubernetes do kontenera gdy chce go zamknąć — np. przy skalowaniu w dół, aktualizacji lub ręcznym usunięciu poda. W przeciwieństwie do SIGKILL daje procesowi czas na sprzątanie. Child obsługuje ten sygnał i przed zamknięciem usuwa swoje dane z Redis oraz powiadamia lobby.

```
apps/child-gameserver/main.js                 REDIS                apps/mother-lobby/main.js
                │                               │                             │
                │── sRem('game_ids', id)     ──►│  usuń z listy               │
                │── del('game:{id}')         ──►│  usuń dane natychmiast      │
                │── publish('lobby_update')  ──►│──────────────────────────►  │
                │                               │   (sygnał: odśwież lobby)   │── usuwa serwer z listy
                │                               │                             │   wysyłanej klientom
```

---

#### Zdarzenie 4 — Mother buduje listę gier dla klientów (`[LOBBY]`)

Mother odczytuje dane wszystkich aktywnych serwerów i wysyła je jako pakiet binarny. Dzieje się to w dwoch sytuacjach: po odebraniu sygnału `lobby_update` od dowolnego Child gdy nowy klient podłącza się do lobby.

Child nie bierze tu udziału — Mother czyta dane bezpośrednio z Redis. Jeśli któryś serwer zdążył wygasnąć między pobraniem listy ID a pobraniem jego danych, Mother po prostu go pomija (`hGetAll` zwróci pusty obiekt).

```
apps/child-gameserver/main.js             REDIS                 apps/mother-lobby/main.js
             │                              │                              │
             │                              │◄── sMembers('game_ids')   ───│  pobierz listę ID
             │                              │──────────────────────────►   │
             │                              │                              │
             │                              │◄── hGetAll('game:{id_1}') ───│  pobierz dane serwera 1
             │                              │──────────────────────────►   │
             │                              │◄── hGetAll('game:{id_2}') ───│  pobierz dane serwera 2
             │                              │──────────────────────────►   │
             │                              │         ...                  │── wyślij pakiet binarny
             │                              │                              │   typ 2 do klientów WS
```

---

#### Zdarzenie 5 — Gracz klika "Dołącz" (`[JOIN]`)

Gdy gracz wybierze serwer z listy i kliknie "Dołącz", Mother generuje jednorazowy losowy token (uint32) i przesyła go przez Redis do konkretnego Child. Child zapamiętuje token w pamięci RAM i czeka aż gracz się połączy. Po 50ms (bufor na czas dostarczenia wiadomości przez Redis) Mother odsyła ten sam token do klienta wraz z adresem IP i portem serwera. Klient następnie otwiera osobne połączenie WebSocket bezpośrednio z Child, podając token w URL — Child weryfikuje go i wpuszcza gracza do gry. Token jest jednorazowy — po użyciu zostaje natychmiast usunięty.

```
apps/child-gameserver/main.js                REDIS                 apps/mother-lobby/main.js
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

Gdy połączenie WebSocket z Mother zerwie się w trakcie gry (np. chwilowy błąd sieci), `onerror` wywołuje ponownie `connectToMother()`. Dzięki temu po przywróceniu połączenia klient wie, że był w grze i może zażądać odświeżenia danych zamiast zaczynać od zera.

```
apps/child-gameserver/main.js                REDIS                 apps/mother-lobby/main.js
                │                              │                              │
                │                              │◄── exists('game:{id}')    ───│  czy serwer jeszcze żyje?
                │                              │──────────────────────────►   │
                │                              │   1 = żyje / 0 = padł        │
                │                              │                              │── jeśli 1: pobierz dane konta
                │                              │                              │   z MongoDB → wyślij do klienta
                │                              │                              │── jeśli 0: brak odpowiedzi
                │                              │                              │   (klient wybiera nowy serwer)
```

---

## 2. Struktura Danych w Redis

Projekt używa trzech typów struktur. Wszystkie wartości liczbowe przechowywane są jako stringi — Redis nie rozróżnia typów w HASH.

### HASH `game:{game_id}` — dane konkretnego serwera gry

Jeden HASH per instancja Child. Klucz zawiera losowy 32-bitowy identyfikator serwera (`game_id = gen_id()`).

```
HASH game:3847291650  →  {
    g_port:        "30542"         ← AGONES_PORT — port NodePort przydzielony przez Agones
                                     (klient łączy się: ws://IP:30542/TOKEN)
    g_players_len: "3"             ← player_length — aktualizowane co ~1s w heartbeat
                                     (tylko to pole zmienia się po starcie)
    g_players_lim: "15"            ← MAX_PLAYERS = 15 (stała w main.js)
                                     (Mother blokuje join gdy len >= lim)
    serv_ip:       "34.89.123.45"  ← AGONES_IP — publiczne IP węzła K8s
                                     (pobierane z gs.status.address od Agones SDK)
    serv_loc:      "EU"            ← COUNTRY = "EU" (hardcoded w main.js - serwer Child)
                                     (używane do filtrowania serwerów w lobby)
    serv_name:     "EU-Phantom"    ← COUNTRY + "-" + losowe słowo z SERVER_NAME_WORDS[]
                                     (generowane raz przy starcie, np. "EU-Apex")
}
TTL: 5s  ← ustawiany przez expire() co ~1s — jeśli Child crashnie, klucz sam wygasa
```

### SET `game_ids` — rejestr aktywnych serwerów

Redis SET to nieuporządkowany zbiór unikalnych wartości — każdy element może wystąpić tylko raz, kolejność jest losowa. W tym projekcie `game_ids` pełni rolę spisu treści: przechowuje ID wszystkich aktywnych instancji Child.

Mother nie zna adresów serwerów z góry — żeby odczytać dane dowolnego serwera (`hGetAll('game:{id}')`), musi najpierw wiedzieć jakie ID istnieją. Właśnie po to jest ten zbiór: Mother wywołuje `sMembers('game_ids')`, dostaje listę wszystkich ID, a następnie dla każdego pobiera pełne dane.

Cykl życia elementu w zbiorze:
- Child przy starcie dodaje swoje ID (`sAdd`) — od tej chwili jest widoczny w lobby
- Child przy zamknięciu przez SIGTERM usuwa swoje ID (`sRem`) — natychmiastowe zniknięcie z lobby
- Jeśli Child crashnie bez SIGTERM — ID zostaje w zbiorze, ale klucz `game:{id}` wygasa po 5s. Mother przy próbie `hGetAll` dostanie pusty obiekt i po prostu pominie ten serwer. Osierocone ID nie powoduje żadnego błędu — jest nieszkodliwe.

```
SET game_ids  →  { "3847291650", "1234567890", "9182736450" }
                        ↑               ↑               ↑
                   child A aktywny  child B aktywny  child C aktywny
```

### Kanały Pub/Sub

W projekcie działają dokładnie dwa kanały Pub/Sub.

**`lobby_update`** — Child → Mother

Kanał rozgłoszeniowy. Każdy Child publikuje na nim sygnał `"1"` (dosłownie jeden bajt) zawsze gdy coś się zmienia: przy starcie, co sekundę w heartbeat i przy zamknięciu. Wiadomość nie niesie żadnych danych — jest tylko sygnałem "coś się zmieniło, odśwież listę". Każda działająca replika Mother subskrybuje ten kanał i po otrzymaniu sygnału natychmiast odczytuje aktualny stan z Redis (`sMembers` + `hGetAll`) i rozsyła zaktualizowaną listę serwerów do wszystkich podłączonych klientów lobby.

**`join:{game_id}`** — Mother → konkretny Child

Kanał dedykowany dla jednej instancji Child. Każdy Child przy starcie subskrybuje kanał o nazwie zawierającej swoje własne `game_id` — np. `join:3847291650`. Dzięki temu tylko ten jeden Child odbiera wiadomości przeznaczone dla niego. Gdy gracz chce dołączyć do gry, Mother publikuje na tym kanale JSON z jednorazowym tokenem i danymi gracza (`{token, name, skin_id, account}`). Child odbiera wiadomość przez callback i zapisuje token w pamięci RAM (`tokens[token] = {...}`), żeby móc zweryfikować gracza gdy ten za chwilę połączy się przez WebSocket.

---

Tabela podsumowująca wszystkie struktury danych i kanały:

| Nazwa | Typ Redis | Kto publikuje | Kto subskrybuje | Co przechowuje / po co istnieje |
|---|---|---|---|---|
| `game:{id}` | HASH (słownik pól) | Child zapisuje przy starcie, co ~1s nadpisuje tylko liczbę graczy, przy zamknięciu usuwa cały klucz | Mother odczytuje gdy gracz prosi o dołączenie do gry oraz gdy buduje listę serwerów dla lobby | IP i port serwera, aktualna i maksymalna liczba graczy, region, nazwa — komplet danych potrzebnych klientowi do połączenia |
| `game_ids` | SET (zbiór unikalnych wartości) | Child dodaje swoje ID przy starcie, usuwa przy zamknięciu | Mother odczytuje wszystkie ID naraz gdy buduje listę serwerów | Spis aktywnych serwerów — bez tego zbioru Mother nie wiedziałaby jakie klucze `game:{id}` w ogóle istnieją |
| `lobby_update` | Kanał PUB/SUB | Child publikuje sygnał przy starcie, co ~1s i przy zamknięciu | Wszystkie repliki Mother nasłuchują i po odebraniu sygnału odświeżają listę serwerów rozsyłaną do klientów | Powiadomienie lobby o każdej zmianie — nowy serwer, zmiana liczby graczy, zamknięcie serwera |
| `join:{game_id}` | Kanał PUB/SUB | Mother publikuje gdy gracz kliknie "Dołącz" — wysyła token i dane gracza | Tylko ten Child który subskrybuje kanał ze swoim własnym ID — zapisuje token w pamięci i czeka na połączenie gracza | Przekazanie tokenu dołączenia do konkretnego serwera gry bez wiedzy pozostałych serwerów |

---

## 3. Wzorzec Dwóch Klientów Redis

Protokół Redis nakłada fundamentalne ograniczenie: po wywołaniu `subscribe()` klient **wchodzi w tryb subscriber** i nie może wykonywać żadnych innych komend — żadnego `hGetAll`, `sMembers`, `publish`, `del`, ani `expire`. Próba ich wywołania skutkuje błędem protokołu.

Ponieważ każdy serwer musi jednocześnie subskrybować kanał i wykonywać operacje na danych, konieczne jest utrzymanie **dwóch osobnych połączeń TCP**:

**`Serwer właściwej rozgrywki Child`:**
```javascript
// apps/child-gameserver/main.js
redis_pub = createClient({ url: REDIS_URL }); // hSet, expire, sAdd, sRem, del, publish
redis_sub = createClient({ url: REDIS_URL }); // WYŁĄCZNIE subscribe
await redis_pub.connect();
await redis_sub.connect();
```

**`Serwer centralny Mother`:**
```javascript
// apps/mother-lobby/main.js
redis     = createClient({ url: REDIS_URL }); // hGetAll, sMembers, exists, publish
redisSub  = createClient({ url: REDIS_URL }); // WYŁĄCZNIE subscribe
await redis.connect();
await redisSub.connect();
```

---

## 4. Cykl Życia Serwera Gry w Redis

### Faza 1: Rejestracja  (`redis_connect`) — Child ogłasza się w Redis przy starcie

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

    // 3. Klucz wygaśnie po 5s bez odnowienia
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

### Faza 2: Heartbeat — utrzymanie aktywności serwera w Redis

Co 60 taktów gry (czyli co ~1 sekundę, bo jeden takt trwa 16ms) Child wykonuje trzy operacje na Redis: nadpisuje aktualną liczbę graczy, odnawia TTL klucza o kolejne 5 sekund i publikuje sygnał do lobby żeby odświeżyło listę serwerów.

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

> **Dlaczego flaga `is_shutting_down`?** Heartbeat i cleanup działają jednocześnie — heartbeat co sekundę nadpisuje dane serwera przez `hSet`, a cleanup próbuje te dane usunąć. Bez flagi mogłoby dojść do sytuacji, w której cleanup usuwa klucz `game:{id}`, ale heartbeat za chwilę go odtwarza. Serwer który właśnie się zamyka znów pojawiłby się w lobby. Flaga `is_shutting_down = true` blokuje heartbeat zanim cleanup zacznie działać — dzięki temu klucz jest usuwany raz i nie wraca.

### Faza 3: Zamknięcie — Child usuwa się z Redis przed wyłączeniem

Gdy Kubernetes wysyła SIGTERM, Child wywołuje `redis_cleanup()` zanim zakończy proces. Zamiast czekać aż klucz sam wygaśnie po 5 sekundach, Child aktywnie usuwa swoje dane z Redis i natychmiast powiadamia lobby — serwer znika z listy w ciągu milisekund, nie sekund.

```javascript
// apps/child-gameserver/main.js
async function redis_cleanup() {
    await redis_pub.sRem('game_ids', String(game_id));  // usuń z rejestru
    await redis_pub.del(`game:${game_id}`);             // usuń dane serwera (nie czekaj na TTL)
    await redis_pub.publish('lobby_update', '1');       // powiadom lobby o zniknięciu
    // Następnie: setTimeout 1000ms → process.exit(0)
    // 1s czekania zapewnia dostarczenie lobby_update do Mother przed zamknięciem procesu
}
```

---

## 5. Kanały Pub/Sub — jak przebiega komunikacja między Child a Mother

### Kanał `lobby_update` — (Child → Mother) Child powiadamia Mother o zmianie stanu serwera

Child wysyła na ten kanał sygnał `'1'` zawsze gdy jego stan się zmienia — przy starcie, co ~1 sekundę w heartbeat i przy zamknięciu. Sama wartość wiadomości nie ma znaczenia — liczy się fakt jej pojawienia się, który mówi Mother: dane w Redis się zmieniły, odśwież listę serwerów dla klientów.

Treść wiadomości jest celowo pozbawiona danych — to czysty **sygnał**. Mother po odebraniu samo odpytuje Redis o aktualny stan.

```javascript
// apps/mother-lobby/main.js
async function connectRedis() {
    // ...inicjalizacja klientów...
    await redisSub.subscribe('lobby_update', async () => {
        if (c_man) await c_man.broadcast_games();
        // c_man null check: ClientManager może być null w oknie startowym (startup race)
        // broadcast_games() → buildGamesPacket() → app.publish('lobby', buf, true)
        // buildGamesPacket() czyta aktualny stan z Redis (sMembers + hGetAll) i buduje
        // binarny pakiet typ 2 z listą wszystkich aktywnych serwerów gry
        // app.publish rozsyła ten pakiet do WSZYSTKICH klientów subskrybujących temat 'lobby'
    });
}
```

Łańcuch wywołań po odebraniu sygnału `'1'` od serwera Child:
```
apps/child-gameserver/main.js → redis_pub.publish('lobby_update', '1')
    │
    ▼ (Redis broker)
apps/mother-lobby/main.js — redisSub callback
    └── c_man.broadcast_games()
          └── buildGamesPacket()
                ├── redis.sMembers('game_ids')     → lista ID
                ├── redis.hGetAll('game:id1')      → dane serwera 1
                ├── redis.hGetAll('game:id2')      → dane serwera 2 ...
                └── buduje pakiet binarny typ 2
          └── app.publish('lobby', buf, true)      → wszyscy gracze w lobby (przeglądarka, przez WebSocket)
```

### Kanał `join:{game_id}` — (Mother → Child) Mother przekazuje token dołączenia do konkretnego serwera gry

Kiedy gracz wybierze serwer z listy i kliknie "Dołącz do gry", Mother generuje jednorazowy token i publikuje go na kanale dedykowanym danemu serwerowi. Kanał `join:{game_id}` jest **per-instancja** — każdy Child subskrybuje wyłącznie kanał ze swoim własnym `game_id`, więc wiadomość dotrze tylko do właściwego serwera.

```javascript
// apps/mother-lobby/main.js 
await redis.publish(`join:${gameId}`, JSON.stringify({
    token,                                             // uint32 — jednorazowy klucz autoryzacyjny
    name,                                              // nick gracza (max 9 znaków)
    skin_id:  skinId,                                  // wybrany skin (0–22)
    account:  accountId ? accountId.toString() : '',   // MongoDB ObjectId lub '' dla gości (bez konta w grze)
}));
// Dane serializowane jako JSON bo Redis pub/sub przesyła wyłącznie stringi.
// Mother czeka 50ms zanim wyśle token do klienta — w tym czasie Redis dostarcza
// wiadomość do Child, a Child rejestruje token w pamięci. Bez tego opóźnienia
// klient mógłby połączyć się z Child zanim token tam dotrze i dostać 401.
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

`buildGamesPacket()` odczytuje aktualny stan serwerów z Redis i buduje binarny pakiet typ 2 zawierający listę wszystkich aktywnych serwerów — dla każdego: ID, nazwę, region, aktualną i maksymalną liczbę graczy. Gotowy pakiet jest wysyłany przez WebSocket do wszystkich graczy aktualnie przeglądających lobby w przeglądarce. Funkcja wywoływana jest w trzech sytuacjach: gdy Child opublikuje `lobby_update` (czyli przy starcie serwera, co ~1s gdy zmienia się liczba graczy, lub przy zamknięciu serwera), gdy gracz wejdzie na stronę i przeglądarka automatycznie otworzy połączenie WebSocket z Mother (`connectToMother()`) — lista serwerów jest wysyłana natychmiast w handlerze `open()`, żeby gracz od razu widział dostępne serwery bez czekania na kolejny `lobby_update` oraz gdy gracz jawnie poprosi o odświeżenie listy (pakiet typ 6).

```javascript
// apps/mother-lobby/main.js
async function buildGamesPacket() {
    const ids = await redis.sMembers('game_ids');
    // Pobierz zbiór wszystkich aktywnych ID serwerów gry z Redis.
    // Każde ID to losowy uint32 wygenerowany przez Child przy starcie.

    const ps = new packet_set(512);
    ps.new_type(2);       // Typ pakietu 2 = lista serwerów (lobby)
    ps.s_uint8(ids.length); // Liczba serwerów w pakiecie

    for (const id of ids) {
        const data = await redis.hGetAll(`game:${id}`);
        if (!data || !data.g_port) continue;
        // Serwer mógł crashnąć między sMembers() a hGetAll() i jego klucz wygasł
        // gdy hGetAll zwróci pusty obiekt, pomijamy go.

        ps.s_uint32(parseInt(id));                   // ID serwera — klient odsyła je przy "Dołącz"
        ps.s_uint8(parseInt(data.g_players_len));    // Aktualna liczba graczy
        ps.s_uint8(parseInt(data.g_players_lim));    // Maksymalna liczba graczy
        ps.s_string(data.serv_loc);                  // Region: "EU", "US" itp.
        ps.s_string(data.serv_name);                 // Nazwa wyświetlana w lobby: "EU-Phantom"
        // serv_ip i g_port celowo pominięte — klient dostanie adres serwera dopiero
        // po wybraniu gry i kliknięciu "Dołącz", razem z tokenem w pakiecie typ 0.
    }
    return Buffer.from(ps.get_buf());
}
```

Sprawdzenie aktywności serwera przy reconnect gracza:
```javascript
// apps/mother-lobby/main.js  
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

#### `hSet(klucz, obiekt)` — Child rejestruje się w Redis przy starcie

Wywoływane jednorazowo w `redis_connect()`. Zapisuje kompletny profil serwera — od tej chwili Mother może go odczytać i pokazać graczom w lobby.

```javascript
await redis_pub.hSet(`game:${game_id}`, {
    g_port:        AGONES_PORT.toString(), // port przydzielony przez Agones (klient łączy się pod ten port)
    g_players_len: "0",                    // przy starcie serwer jest pusty
    g_players_lim: MAX_PLAYERS.toString(), // stały limit = 15 graczy
    serv_ip:       AGONES_IP,              // publiczne IP węzła K8s (pobrane od Agones SDK)
    serv_loc:      COUNTRY,               // region hardcoded: "EU"
    serv_name:     SERVER_NAME,           // losowa nazwa: "EU-Phantom", "EU-Sigma" itp.
});
```

#### `hSet(klucz, pole, wartość)` — heartbeat: aktualizacja liczby graczy co ~1 sekundę

Wywoływane co 60 taktów gry (~1s) w `redis_update_player_count()`. Nadpisuje tylko jedno pole — resztę danych (IP, port, nazwa) pozostawia bez zmian. Trzy operacje tworzą łańcuch: najpierw zaktualizuj liczbę graczy, potem odnów TTL żeby serwer nie wygasł, na końcu powiadom lobby żeby odświeżyło listę.

```javascript
redis_pub.hSet(`game:${game_id}`, 'g_players_len', player_length.toString())
    // nadpisz aktualną liczbę graczy — tylko to pole się zmienia co sekundę
    .then(() => redis_pub.expire(`game:${game_id}`, 5))
    // odnów TTL o kolejne 5s — to jest dead-man's switch; jeśli Child przestanie
    // odnawiać (crash), klucz wygaśnie sam i serwer zniknie z lobby
    .then(() => redis_pub.publish('lobby_update', '1'))
    // powiadom Mother żeby natychmiast przesłała świeżą listę serwerów do klientów
    .catch(console.error);
```

#### `hGetAll(klucz)` — Mother odczytuje pełne dane serwera

Wywoływane przez Mother w `buildGamesPacket()` dla każdego ID z listy `game_ids`. Zwraca wszystkie pola HASH jako obiekt. Jeśli serwer zdążył wygasnąć, Redis zwraca pusty obiekt — brak pola `g_port` jest sygnałem do pominięcia tego serwera.

```javascript
const g = await redis.hGetAll(`game:${id}`);
// serwer aktywny:  g = { g_port: "30542", g_players_len: "5", g_players_lim: "15", serv_ip: "34.89.1.2", ... }
// serwer wygasły:  g = {}  →  g.g_port === undefined  →  pomiń, nie dodawaj do pakietu
```

---

### Komendy SET

| Komenda | Zachowanie | Zwraca |
|---|---|---|
| `sAdd(key, val)` | Dodaje element; ignoruje duplikaty (no-op) | Liczba dodanych elementów |
| `sMembers(key)` | Zwraca wszystkie elementy jako tablicę; kolejność losowa | `[]` jeśli zbiór pusty |
| `sRem(key, val)` | Usuwa element; brak elementu = no-op | Liczba usuniętych elementów |

#### `sAdd` — Child dodaje swoje ID do globalnej listy aktywnych serwerów

Wywoływane raz przy starcie, po zapisaniu HASH. Od tej chwili Mother widzi ten serwer przy wywołaniu `sMembers('game_ids')` i może go uwzględnić w liście wysyłanej do graczy w lobby.

```javascript
await redis_pub.sAdd('game_ids', game_id.toString());
```

#### `sMembers` — Mother pobiera listę wszystkich aktywnych serwerów

Pierwszy krok w `buildGamesPacket()`. Zwraca wszystkie ID naraz jako tablicę — Mother iteruje po nich i dla każdego wywołuje `hGetAll`. Kolejność elementów jest losowa przy każdym wywołaniu, co nie ma znaczenia bo lista i tak jest przebudowywana od zera.

```javascript
const ids = await redis.sMembers('game_ids');
// np. ["3847291650", "1029384756", "9182736450"] — kolejność losowa
```

#### `sRem` — Child usuwa swoje ID z listy aktywnych serwerów przy zamknięciu

Wywoływane w `redis_cleanup()` po odebraniu SIGTERM, razem z `del('game:{id}')`. Po tej operacji Mother przy kolejnym `sMembers` nie znajdzie już tego ID i nie dołączy serwera do pakietu wysyłanego do lobby. Przy crashu bez SIGTERM `sRem` nie jest wywoływane — ID zostaje w zbiorze, ale jest nieszkodliwe bo odpowiadający klucz HASH wygaśnie przez dead-man's switch.

```javascript
await redis_pub.sRem('game_ids', game_id.toString());
```

---

### Komendy ogólne

| Komenda | Zachowanie | Zwraca |
|---|---|---|
| `del(key)` | Usuwa klucz dowolnego typu natychmiast | Liczba usuniętych kluczy |
| `expire(key, secs)` | Ustawia TTL; klucz znika automatycznie po N sekundach | 1 (ustawiono) lub 0 (klucz nie istnieje) |
| `exists(key)` | Sprawdza obecność klucza | 1 (istnieje) lub 0 (nie ma / wygasł) |
| `publish(ch, msg)` | Fire-and-forget; brak kolejkowania; utrata jeśli nikt nie słucha | Liczba odbiorców |
| `subscribe(ch, cb)` | Blokuje klienta dla innych komend; dlatego wymagany drugi klient | — |

#### `del` — Child natychmiast usuwa swoje dane z Redis przy zamknięciu

Wywoływane w `redis_cleanup()` razem z `sRem`. Zamiast czekać aż klucz sam wygaśnie po maksymalnie 5 sekundach, Child aktywnie go usuwa — dzięki temu Mother nie pokazuje zamkniętego serwera graczom nawet przez ułamek sekundy po zamknięciu.

```javascript
await redis_pub.del(`game:${game_id}`);
```

#### `expire` — mechanizm automatycznego usuwania martwych serwerów

`expire` ustawia czas życia klucza w Redis. Jeśli klucz nie zostanie odnowiony przed upływem tego czasu, Redis usuwa go automatycznie. Child ustawia TTL na 5 sekund przy starcie, a następnie odnawia go co ~1 sekundę w heartbeat — dopóki proces działa, klucz nigdy nie wygaśnie. Jeśli Child crashnie i heartbeat przestanie działać, klucz wygaśnie po maksymalnie 5 sekundach i serwer sam zniknie z lobby bez żadnej interwencji.

```javascript
// przy starcie — pierwsze ustawienie TTL
await redis_pub.expire(`game:${game_id}`, 5);

// w heartbeat co ~1s — odnowienie TTL o kolejne 5 sekund
.then(() => redis_pub.expire(`game:${game_id}`, 5));
```

#### `exists` — Mother sprawdza czy serwer nadal działa przy reconnect

Wywoływane w `handleReconnect()` gdy połączenie WebSocket z Mother zerwie się podczas gry. Zamiast ślepo pobierać dane konta, Mother najpierw sprawdza czy serwer gry w ogóle jeszcze istnieje w Redis. Jeśli klucz wygasł (serwer padł lub się zamknął) — Mother nic nie odpowiada i gracz zostaje w lobby. Jeśli klucz istnieje — serwer żyje, Mother pobiera świeże dane konta z MongoDB i odsyła je klientowi.

```javascript
redis.exists(`game:${gameId}`).then(exists => {
    if (!exists) return null;             // serwer już nie istnieje — brak odpowiedzi do klienta
    return db_users.findOneAndUpdate(...); // serwer żyje — pobierz dane konta i odeślij
});
```

#### `publish` — wysyłanie wiadomości na kanał

Używane na dwa różne sposoby w zależności od kierunku komunikacji:

**Child → Mother** (`lobby_update`): Child publikuje wartość `'1'` jako sygnał że coś się zmieniło. Sama treść nie ma znaczenia — Mother reaguje na sam fakt pojawienia się wiadomości i odczytuje aktualny stan z Redis.

```javascript
await redis_pub.publish('lobby_update', '1');
```

**Mother → Child** (`join:{id}`): Mother publikuje JSON z danymi gracza na kanał konkretnego Child. Treść ma tu znaczenie — Child odczytuje token, nick, skin i ID konta żeby wiedzieć kogo wpuścić do gry.

```javascript
await redis.publish(`join:${gameId}`, JSON.stringify({
    token,                                        // jednorazowy uint32 — gracz podaje go w URL
    name,                                         // nick wyświetlany w grze
    skin_id: skinId,                              // ID skina gracza
    account: accountId ? accountId.toString() : '', // ID konta MongoDB (pusty string = gość)
}));
```

#### `subscribe` — nasłuchiwanie na kanale

Po wywołaniu `subscribe` klient Redis przechodzi w tryb nasłuchiwania i nie może już wykonywać innych komend — dlatego zarówno Child jak i Mother używają osobnego klienta (`redis_sub`) wyłącznie do subskrypcji. Callback jest wywoływany automatycznie przez bibliotekę za każdym razem gdy Redis dostarczy nową wiadomość na kanale.

```javascript
// Child subskrybuje swój własny kanał — tylko ten Child odbierze wiadomości adresowane do niego
await redis_sub.subscribe(`join:${game_id}`, (message) => {
    const { token, name, skin_id, account } = JSON.parse(message);
    tokens[token] = {
        name,
        skin_id,
        account,
        timelive: frame + 10000, // token ważny przez ~160s (10000 ticków × 16ms)
    };
    // od tej chwili gracz może połączyć się przez WebSocket podając ten token w URL
});
```

---

## 8. Konfiguracja Wdrożeniowa

### Deployment Redis w K8s

Redis działa jako pojedynczy pod w klastrze Kubernetes, dostępny wyłącznie wewnątrz klastra — żaden ruch z zewnątrz nie dociera bezpośrednio do Redisa. Zapis danych na dysk jest wyłączony celowo: Redis pełni tu rolę szyny komunikacyjnej, a nie bazy danych — utrata danych przy restarcie poda jest akceptowalna, bo Child automatycznie odtwarza swoje dane w Redis przy następnym heartbeat (~1s po tym jak Redis wróci do działania) — rejestracja jest ciągłym procesem, nie jednorazową krokiem przy starcie.

```yaml
# gitops/base/prz-redis.yaml
containers:
- name: redis
  image: redis:7-alpine
  command: ["redis-server", "--save", ""]
  # --save "" wyłącza zapis na dysk (RDB i AOF) — Redis trzyma dane tylko w RAM

---
kind: Service
spec:
  type: ClusterIP   # widoczny tylko wewnątrz klastra K8s, niedostępny z internetu
  ports:
  - port: 6379
```

### Jak Child i Mother łączą się z Redisem

Obie aplikacje używają zmiennej środowiskowej `REDIS_URL` ustawionej na `redis://redis:6379`. Nazwa hosta `redis` to nazwa K8s Service — Kubernetes automatycznie rozwiązuje ją przez wewnętrzny DNS klastra na adres IP poda z Redisem. Dzięki temu ani Child ani Mother nie muszą znać rzeczywistego IP Redisa — wystarczy stała nazwa serwisu.

| Zmienna | Wartość | Kto używa |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379` | `apps/mother-lobby/main.js` i `apps/child-gameserver/main.js` |

---

## 9. Znane Ograniczenia
 
### Race condition `sMembers` + `hGetAll`

Między pobraniem listy ID przez `sMembers` a pobraniem danych konkretnego serwera przez `hGetAll` może minąć kilka milisekund. Jeśli w tym czasie TTL klucza `game:{id}` wygaśnie, `hGetAll` zwróci `{}`. **Obsłużone** przez warunek `if (!data || !data.g_port) continue` — martwy serwer jest po pomijany.

### `game_ids` SET bez TTL

Gdy Kubernetes zabija pod sygnałem SIGKILL zamiast SIGTERM (np. przy przekroczeniu limitu czasu grace period), `redis_cleanup()` nie ma szansy się wykonać. W efekcie ID serwera zostaje w zbiorze `game_ids`, ale klucz `game:{id}` wygaśnie sam po maksymalnie 5 sekundach. Przy kolejnym odczycie Mother wywoła `hGetAll` na tym ID, dostanie pusty obiekt i go pominie — martwe ID w zbiorze nie powoduje żadnego błędu ani widocznego problemu dla graczy ale dalej znajduje się w redis.
