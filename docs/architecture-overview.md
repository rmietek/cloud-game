# Architecture Overview

## 1. Cel i architektura

System to wieloosobowa gra przeglądarkowa czasu rzeczywistego działająca na Azure Kubernetes Service.

Gracz otwiera przeglądarkę i wchodzi na adres serwera. Przeglądarka wysyła żądanie **HTTP GET** do serwera Mother, który odpowiada plikiem `index.html` wraz ze skryptami JavaScript i plikami statycznymi. Następnie gracz rejestruje się lub loguje — przeglądarka wysyła żądanie **HTTP POST** (`/auth/register` lub `/auth/login`) do Mother, który weryfikuje dane w bazie CosmosDB i zwraca identyfikator konta.

Równolegle z ładowaniem strony przeglądarka od razu otwiera połączenie **WebSocket** z serwerem lobby (Mother, port 3001) — niezależnie od tego czy użytkownik jest zalogowany. Mother natychmiast wysyła listę dostępnych serwerów gry oraz dane sklepu ze skinami, które są widoczne dla każdego. Gracz może dołączyć do gry zarówno jako zalogowany użytkownik, jak i jako gość bez konta — przeglądarka wysyła przez WebSocket żądanie dołączenia z nickiem, skinem i opcjonalnym ID konta (puste = gość). Mother generuje jednorazowy token, przekazuje go przez Redis do wybranego serwera gry (Child), a następnie odsyła przeglądarce token wraz z adresem IP i portem Child.

Przeglądarka otwiera drugie połączenie **WebSocket** bezpośrednio z serwerem Child (adres `ws://NODE_IP:PORT/TOKEN`) — połączenie z Mother pozostaje otwarte. Child weryfikuje token, przydziela graczowi ID i wysyła stan gry (listę graczy, mapę, ranking). Od tej chwili właściwa rozgrywka odbywa się binarnie przez WebSocket z Child z częstotliwością 62,5 taktów/s — bez HTTP, bez JSON.

### Diagram komponentów

```
Przeglądarka gracza
  │
  ├─ HTTP POST /auth/register|login    → Mother Express (port 9876)
  │
  ├─ WebSocket ws://LB:3001            → Mother uWS (port 3001)
  │    ├─ Pobiera listę gier (typ 2)
  │    ├─ Wysyła "join game" (typ 0 client→server)
  │    └─ Odbiera token + IP:port serwera gry
  │
  └─ WebSocket ws://NODE_IP:PORT/TOKEN → Child uWS (port 7000–8000)
       └─ Gra w czasie rzeczywistym (62.5 tick/s)

Mother (Deployment K8s, HPA 1–10 replik)
  ├─ Express HTTP :9876   → rejestracja/logowanie, pliki statyczne
  ├─ uWebSockets.js :3001 → WebSocket lobby
  ├─ Redis pub/sub        → lista serwerów, tokeny dołączenia
  └─ CosmosDB (MongoDB)   → konta graczy

Child (Agones Fleet, 1–20 GameServerów)
  ├─ uWebSockets.js :5000 → WebSocket gra
  ├─ Agones SDK           → cykl życia (Ready/Allocated/Shutdown)
  ├─ Redis pub/sub        → rejestracja serwera, odbiór tokenów
  └─ CosmosDB (MongoDB)   → zapis punktów po zakończeniu sesji

Redis (Deployment K8s, 1 replika)
  ├─ HASH game:{id}      → dane serwera gry (IP, port, gracze)
  ├─ SET  game_ids       → lista aktywnych serwerów
  └─ PUB/SUB             → lobby_update, join:{game_id}

CosmosDB (Azure Managed MongoDB API)
  └─ db=gra, collection=users → konta graczy, punkty, skiny

Azure Infrastructure
  ├─ AKS (1 węzeł standard_b2s_v2, node_public_ip_enabled=true)
  ├─ ACR (przacr.azurecr.io)
  ├─ NSG (AllowAgonesPorts: TCP 7000-8000 inbound)
  └─ CosmosDB (prz-cosmos-db)
```

### Porty i protokoły

| Komponent | Port zewnętrzny (LB) | Port wewnętrzny (kontener) | Protokół | Cel |
|---|---|---|---|---|
| Mother Express | 80 | 9876 | HTTP | Rejestracja, logowanie, pliki statyczne |
| Mother uWS | 3001 | 3001 | WebSocket | Lobby: lista gier, dołączanie, skiny |
| Child | 7000–8000 (NodePort Agones) | 5000 | WebSocket | Rozgrywka w czasie rzeczywistym |
| Redis | — (tylko wewnątrz klastra) | 6379 | TCP | Pub/Sub, dane serwerów gry |

---

## 2. Kluczowa Logika i przepływ

### Przepływ dołączania gracza

```
1. Gracz otwiera przeglądarkę → GET / → Mother serwuje index.html
2. Gracz loguje się → POST /auth/login → bcrypt.compare → zwraca _id
3. Przeglądarka otwiera WS → ws://LB:3001
4. Mother → open(): subscribe('lobby'), send binary type 2 (lista gier) + type 3 (dane sklepu)
5. Gracz klika na serwer → klient wysyła binary type 0 {gameId, name, skinId, accountId}
6. Mother handleJoinGame():
   a. redis.hGetAll('game:{gameId}') — sprawdź czy serwer istnieje i ma miejsca
   b. gen_id() → losowy uint32 = token
   c. redis.publish('join:{gameId}', JSON.stringify({token, name, skin_id, account}))
   d. setTimeout 50ms → ws.send(binary type 0 {token, port, ip})
7. Child subskrypcja 'join:{gameId}' → tokens[token] = {name, skin_id, ...}
8. Przeglądarka: ws://IP:PORT/token → Child upgrade() → have_token(token) → true
9. Child open():
   a. free_ids.pop() → nowe ID
   b. new player(id, ws, tokens[token_id]) → umieść na mapie
   c. tokens[token_id] = null + delete (jednorazowość)
   d. Wysyłka 1: type 3 (lista graczy) + type 7 (martwi) + type 9 (ranking) — jeden pakiet
   d. Wysyłka 2: type 4 (mapa) — osobny pakiet (duży, ~1280 bajtów)
   e. joined_players.push(pl) → w następnym ticku inni gracze dowiedzą się
```

### Pętla gry (takt co 16ms = 62,5 razy na sekundę)

Serwer Child działa w pętli wywoływanej co 16 milisekund — każde wywołanie to jeden „takt" gry. W każdym takcie serwer wykonuje cztery rzeczy w stałej kolejności: czyści wygasłe tokeny (rzadko), przesuwa boty, przetwarza fizykę graczy i wysyła pakiety. Dodatkowo co sekundę synchronizuje licznik graczy z Redis.

```javascript
// apps/child-gameserver/main.js
setInterval(() => {
    frame++;  // globalny licznik taktów od startu serwera — używany jako zegar gry

    // 1. Co ~160 sekund (10000 taktów): usuń wygasłe tokeny dołączenia
    //    Token = jednorazowy bilet wystawiony przez Mother; jeśli gracz nie dołączył
    //    w czasie — token jest już bezużyteczny i zajmuje pamięć
    if (!(frame % 10000)) {
        for (const i in tokens) {
            if (tokens[i].timelive < frame) { tokens[i] = null; delete tokens[i]; }
        }
    }

    // 2. Co takt: AI botów — każdy bot porusza się losowo w lewo/prawo przez losowy czas,
    //    potem zmienia kierunek lub zatrzymuje się (prosty automat stanów)
    for (bots) bot.update();

    // 3. Co takt: fizyka wszystkich żywych graczy (gracze ludzcy + boty)
    //    pl.move() wykonuje kolejno:
    //      1. kolizje z innymi graczami
    //      2. grawitacja (prędkość pionowa = 4 - jump_frame × 0.1, cap -10)
    //      3. kolizje z kafelkami platformy
    //    Martwy gracz (is_dead=true) jest pomijany — czeka na respawn
    for (players) if (!pl.is_dead) pl.move();

    // 4. Co takt: zbuduj i wyślij pakiety binarne do każdego podłączonego gracza
    //    Wysyła pozycje, zdarzenia (zabójstwa, dołączenia, czat), ranking — patrz binary-protocol.md
    gen_packet();

    // 5. Co ~1 sekundę (60 taktów × 16ms ≈ 960ms):
    //    zapisz aktualny licznik graczy do Redis → Mother odczytuje go i pokazuje w lobby
    if (!(frame % 60)) redis_update_player_count();

}, SERVER_TICK_MS /* = 16ms */);
```

### Cykl życia serwera gry — wyjście graczy i zamknięcie

Są dwa osobne scenariusze:

**Scenariusz A — ostatni gracz wychodzi (serwer opustoszał):**
```
1. Gracz rozłącza się → close():
   - zapisz zarobione punkty do MongoDB
   - usuń gracza z rankingu, mapy kolizji, puli ID
   - player_length--

2. player_length === 0 → serwer opustoszał:
   - natychmiast zaktualizuj Redis (player_length=0) → lobby od razu widzi wolne miejsce
   - agonesSDK.ready() → serwer wraca do stanu Ready (Allocated → Ready)

3. Agones FleetAutoscaler widzi serwer w stanie Ready:
   - jeśli jest zbyt wiele pustych serwerów → usuwa pod (skalowanie w dół)
   - jeśli liczba gotowych serwerów jest OK → pod pozostaje i czeka na nową sesję
```

**Scenariusz B — Kubernetes usuwa pod (np. aktualizacja, skalowanie w dół):**
```
1. K8s wysyła SIGTERM do procesu
2. is_shutting_down = true → zatrzymuje pętlę Redis (redis_update_player_count)
3. redis_cleanup():
   - usuwa game:{id} z Redis
   - publikuje 'lobby_update' → każda replika Mother odświeża listę serwerów w lobby
4. setTimeout 1000ms (bufor na propagację Redis) → process.exit(0)
```

---

## 3. Przykłady z kodu (implementacja)

### Sekwencja startu Mother

Mother musi uruchamiać swoje komponenty w ściśle określonej kolejności — każdy krok zależy od poprzedniego. Nie można uruchomić HTTP API zanim baza danych nie jest gotowa, bo rejestracja/logowanie od razu próbowałyby pisać do MongoDB.

```javascript
// apps/mother-lobby/main.js
connectDatabase()       // 1. połącz z MongoDB → ustawia db_users (kolekcja kont graczy)
    .then(connectRedis) // 2. połącz z Redis → subskrybuj 'lobby_update' od Child serwerów
    .then(function () {
        setupExpressApp();              // 3. uruchom HTTP API na porcie 9876
                                        //    (db_users już gotowe → /auth/login może działać)
        c_man = new ClientManager(CONFIG.CLIENT_PORT);
                                        // 4. uruchom WebSocket lobby na porcie 3001
                                        //    przypisanie c_man odblokowuje callback Redis —
                                        //    'lobby_update' od Child może teraz rozsyłać aktualizacje
    })
    .catch(function (err) {
        console.error('Startup error:', err);
        process.exit(1);  // błąd startu → exit(1) → Kubernetes widzi crash i restartuje pod
    });
```

### Stałe konfiguracyjne

```javascript
// apps/mother-lobby/main.js
const CONFIG = {
    HTTP_PORT:     9876,  // port Express (HTTP: logowanie, rejestracja, pliki statyczne)
    CLIENT_PORT:   3001,  // port uWS WebSocket (lobby: lista gier, dołączanie, skiny)
    BCRYPT_ROUNDS: 10,    // siła hashowania haseł: 2^10 = 1024 iteracje ≈ 100ms na hash
};

// apps/child-gameserver/main.js
const SERVER_PORT    = parseInt(process.env.PORT || process.argv[2] || 5000);
// Port przydzielany przez Agones (env PORT) lub argument CLI (lokalne testy) lub domyślnie 5000

const MAX_PLAYERS    = 15;   // max graczy na serwerze (boty nie wliczają się)
const SERVER_TICK_MS = 16;   // czas taktu w ms → 1000/16 = 62,5 taktów/s
const BOT_COUNT      = 37;   // liczba botów AI wypełniających mapę
const GRAVITY        = 0.1;  // przyspieszenie grawitacyjne odejmowane od prędkości Y co takt
const PLAYER_RADIUS  = 11;   // promień hitboxa gracza — kolizja gdy odległość ≤ 22 jednostki
```

---

## 4. Zależności i protokoły

### Zależności między modułami

#### Przegląd
```
Mother ──[Redis pub/sub]──► Child
  publish('join:{id}')        subscribe('join:{id}')

Child ──[Redis pub/sub]──► Mother
  publish('lobby_update')      subscribe('lobby_update')

Child ──[Redis HASH]──► Mother (co 1s)
  hSet('game:{id}', {...})     hGetAll('game:{id}')

Child ──[Redis SET]──► Mother
  sAdd/sRem('game_ids', ...)   sMembers('game_ids')

Child ──[MongoDB]── (zapis punktów przy każdym rozłączeniu gracza)
Mother ──[MongoDB]── (rejestracja, logowanie, zmiana nicku, zakup skinów)

Przeglądarka ──[HTTP]──► Mother Express (rejestracja, logowanie, pliki statyczne)
Przeglądarka ──[WS binary]──► Mother uWS (lobby)
Przeglądarka ──[WS binary]──► Child uWS (gra)
```


#### Szczegóły implementacji
```
Mother ──[Redis pub/sub]──► Child
  publish('join:{game_id}', {token, name, skin_id, account})
                               subscribe('join:{game_id}') → tokens[token] = {...}

Child ──[Redis pub/sub]──► Mother
  publish('lobby_update', '1')
                               subscribe('lobby_update') → broadcast_games() do klientów

Child ──[Redis HASH]──► Mother
  start:      hSet('game:{id}', {g_port, g_players_len, g_players_lim, serv_ip, ...})
  co ~1s:     hSet('game:{id}', {g_players_len: N})   ← aktualizacja licznika graczy
  zamknięcie: del('game:{id}')
                               buildGamesPacket(): hGetAll('game:{id}') dla każdego ID

Child ──[Redis SET]──► Mother
  start:      sAdd('game_ids', game_id)   ← rejestracja serwera na liście
  zamknięcie: sRem('game_ids', game_id)   ← wyrejestrowanie
                               buildGamesPacket(): sMembers('game_ids') → lista aktywnych

Child ──[MongoDB]── (zapis punktów przy każdym rozłączeniu gracza)
Mother ──[MongoDB]── (rejestracja, logowanie, zmiana nicku, zakup skinów)

Przeglądarka ──[HTTP]──► Mother Express
  GET /                → index.html + pliki statyczne
  POST /auth/register  → rejestracja konta
  POST /auth/login     → logowanie

Przeglądarka ──[WS binary]──► Mother uWS (lobby)
  → pobierz listę gier, dołącz do gry, kup skina, zmień nick

Przeglądarka ──[WS binary]──► Child uWS (gra)
  → ruch gracza, czat, użycie eventu, respawn
```

### Wspólna biblioteka binary.js

```javascript
// apps/shared/binary.js — używana przez Mother, Child i przeglądarkę
```

---

## 5. Infrastruktura i wdrożenie

### Zmienne środowiskowe → K8s Manifest → Terraform

| Zmienna env | Wartość / źródło | Komponent | Manifest |
|---|---|---|---|
| `REDIS_URL` | hardcoded `redis://redis:6379` | Mother + Child | `prz-mother.yaml`, `prz-agones.yaml` |
| `MONGO_URL` | K8s Secret `cosmos-db-secret` | Mother + Child | `prz-mother.yaml`, `prz-agones.yaml` |
| `USE_AGONES` | hardcoded `"true"` | Child | `prz-agones.yaml` |
| `PORT` | wstrzykiwany dynamicznie przez Agones (7000–8000) | Child | — |

### Zasoby infrastruktury i ich source

| Zasób | Plik źródłowy |
|---|---|
| Deployment + Service (LoadBalancer) mother | `gitops/base/prz-mother.yaml` |
| HPA mother-hpa | `gitops/base/mother-hpa.yaml` |
| Fleet prz-child-fleet + FleetAutoscaler | `gitops/base/prz-agones.yaml` |
| Deployment + Service redis | `gitops/base/prz-redis.yaml` |
| AKS cluster | `infra/terraform/aks.tf` |
| ACR (przacr.azurecr.io) + uprawnienie AcrPull | `infra/terraform/acr.tf` |
| CosmosDB (prz-cosmos-db) | `infra/terraform/cosmosdb.tf` |
| Resource group | `infra/terraform/resource_group.tf` |
| Agones (Helm release) | `infra/terraform/agones.tf` |
| ArgoCD (Helm release) | `infra/terraform/argocd.tf` |
| Secret cosmos-db-secret | `infra/terraform/cosmosdb_secret.tf` |
| Secret prz-repo-secret (dostęp ArgoCD do GitHub) | `infra/terraform/argocd_repo.tf` |
| NSG AllowAgonesPorts | `infra/terraform/nsg.tf` |

---

## 6. Porty i skalowanie K8s — Szczegóły

### Mapa portów publicznych

```
Zewnętrzny IP (Azure LoadBalancer):
  :80        → HTTP  (logowanie, rejestracja, pliki statyczne) → targetPort 9876
  :3001      → WS    (lobby: lista gier, dołączanie, skiny)

Wewnątrz klastra K8s:
  redis:6379     → Redis (stan gier, pub/sub) — ClusterIP, niedostępny z zewnątrz
  cosmos-db      → CosmosDB (MongoDB API) via Secret MONGO_URL — poza klastrem (Azure)

Zewnętrzny IP węzła (Agones NodePort):
  :7000–8000 → WS gry (Child) — klient łączy się bezpośrednio po otrzymaniu tokenu
```

Manifest K8s:
```yaml
spec:
  type: LoadBalancer        # Azure przydziela zewnętrzny IP
  selector:
    app: mother
  ports:
    - name: http
      port: 80              # port zewnętrzny (LB)
      targetPort: 9876      # port kontenera (Express)
    - name: client-ws
      port: 3001            # uWS (lobby) — ten sam zewnętrznie i wewnątrz
```

### Dlaczego WebSocket Mother da się skalować horyzontalnie

Gdyby każda replika Mother przechowywała własną kopię listy aktywnych serwerów gry w pamięci i samodzielnie ją aktualizowała, powstałby klasyczny problem spójności: gracz A podłączony do Mother-1 widzi że serwer X ma 4 graczy, gracz B podłączony do Mother-2 widzi że ten sam serwer ma 3 graczy — bo Mother-2 jeszcze nie dowiedziała się o ostatnim dołączeniu. Każda replika miałaby inny obraz świata, a gracze widzieliby niespójne dane zależnie od tego do której repliki trafili.

W tej architekturze problem nie istnieje, ponieważ żadna replika Mother nie przechowuje stanu w swojej pamięci:

**1. Lista gier żyje wyłącznie w Redis (HASH + SET), nie w pamięci poda.**
Każda replika Mother przy każdym żądaniu odczytuje dane z Redis. Nie ma "głównej" repliki — każda odpowiada identycznie na podstawie tych samych danych.

**2. Powiadomienia o zmianach trafiają do wszystkich replik przez Redis Pub/Sub.**
Gdy Child zmienia stan (gracz dołącza, wychodzi, serwer startuje lub kończy działanie), publikuje wiadomość `lobby_update` do Redis. Każda replika Mother subskrybuje ten kanał osobno — więc każda natychmiast wywołuje `broadcast_games()` i wysyła zaktualizowaną listę do swoich klientów WS.

**3. Połączenie WS klienta pozostaje na tej samej replice przez całe lobby.**
Azure Load Balancer nie przełącza klienta między replikami w trakcie trwania połączenia WebSocket. Nie ma więc potrzeby synchronizowania sesji między replikami — każda replika obsługuje niezależnie swoją pulę klientów, a Redis zapewnia spójność danych.

```
child-pod-X zmienia stan
  → redis.publish('lobby_update')
      → mother-pod-A: broadcast_games() → Klient 1, Klient 2
      → mother-pod-B: broadcast_games() → Klient 3, Klient 4
                                        (wszyscy widzą ten sam stan z Redis)
```

### Jak jeden port obsługuje wiele replik

Z zewnątrz klient zawsze łączy się na ten sam adres (np. `ws://20.10.5.123:3001`), ale każde połączenie trafia do innego poda:

1. **Każdy pod nasłuchuje na tym samym porcie** wewnątrz swojego izolowanego kontenera (Pod-A: `10.0.0.4:3001`, Pod-B: `10.0.0.5:3001`).
2. **Azure Load Balancer** (tworzony automatycznie przez AKS dla `type: LoadBalancer`) przydziela publiczny IP i kieruje ruch na NodePort węzła. Port zewnętrzny 80 jest mapowany na wewnętrzny port kontenera 9876 (Express), port 3001 jest taki sam zewnętrznie i wewnątrz (uWS). Oba trafiają pod ten sam zewnętrzny IP, ale są routowane niezależnie.
3. **kube-proxy** na węźle za pomocą reguł iptables losowo wybiera jeden z dostępnych podów Mother i przekazuje mu połączenie. Każde nowe połączenie może trafić do innego poda.

WS to długotrwałe połączenie TCP — po zestawieniu przez LB nie jest ponownie routowane. Klient siedzi na tej samej replice do rozłączenia. Przy reconnect może trafić na inną replikę — to jest OK, bo stan lobby jest w Redisie, nie w pamięci poda.

### HPA — automatyczne skalowanie Mother

```yaml
# gitops/base/mother-hpa.yaml
spec:
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        averageUtilization: 10  # próg: 10% CPU → dodaj replikę
```

HPA skaluje od 1 do 10 replik na podstawie zużycia CPU. Azure LB automatycznie dołącza nowe pody do puli bez przestojów.
