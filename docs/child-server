# Child Server — Dokumentacja Techniczna

## 1. Cel i architektura

`apps/child-gameserver/main.js` to stanowy serwer gry czasu rzeczywistego. Określenie "stanowy" jest kluczowe — oznacza, że serwer przechowuje w pamięci kompletny stan rozgrywki: pozycje wszystkich graczy i botów, punkty, mapę poziomów, tokeny autoryzacyjne. W przeciwieństwie do bezstanowych serwisów HTTP (gdzie każde żądanie jest niezależne), tutaj jedna instancja procesu zarządza jedną konkretną sesją gry od jej początku aż do końca.

Każda instancja `apps/child-gameserver/main.js` obsługuje do 15 (można to zmienić) ludzkich graczy i 37 botów AI. 

Serwer działa jako **Agones GameServer** w Kubernetes. Agones to system do zarządzania serwerami gier na K8s, stworzony przez Google i Ubisoft. Normalny Kubernetes świetnie radzi sobie ze skalowaniem bezstanowych serwerow HTTP, ale serwery gier są stanowe — nie można „zabić" poda w którym trwa rozgrywka. Agones rozwiązuje ten problem przez cykl życia: serwer sygnalizuje kiedy jest gotowy, kiedy ma przydzielonych graczy i kiedy może być zamknięty.

### Świat gry — cylindryczna mapa

Plansza ma kształt cylindra. Cylinder jest „zawinięty" w poziomie: jeśli gracz biegnie cały czas w prawo, w końcu wróci do miejsca startu. W pionie cylinder nie ma sufitu ani dna — gracz spada w dół pod wpływem grawitacji, lądując na generowanych warstwach platform (bezpiecznych zielonych i śmiertelnych czerwonych). Każda warstwa zajmuje 16 jednostek Y, a mapa rozrasta się w miarę opadania (`gen_lvl` dogenerowuje nowe poziomy).

### Miejsce w systemie

```
Internet
  └─► ws://NODE_IP:AGONES_PORT/<TOKEN>
        │
        ▼
  Child (Agones GameServer)
    │
    ├─ uWebSockets.js  → WebSocket server pisany w C++ z bindingami Node.js.
    │                    5–10× szybszy od standardowej biblioteki 'ws'.
    │                    Kluczowe przy 50+ połączeniach.
    │
    ├─ Agones SDK      → Komunikacja z Agones sidecar kontenerem w tym samym podzie.
    │                    Raportuje stany: Ready/Allocated/Shutdown.
    │                    Heartbeat co 2s — bez niego Agones uzna pod za martwy po ~30s.
    │
    ├─ Redis pub/sub   → Szyna komunikacyjna z mother-lobby.
    │                    Child zapisuje swoje dane (port, IP, gracze).
    │                    Mother czyta i pokazuje serwery w lobby.
    │                    Brak bezpośredniego adresowania — serwery child i mother nie znają swoich adresów.
    │
    ├─ MongoDB         → Trwały zapis punktów graczy po każdej sesji.
    │                    Tylko przy rozłączeniu ($inc — nie nadpisuje, dodaje).
    │
    └─ shared/binary.js → Własny protokół binarny.
                          Pakiet binarny 3–10× mniejszy niż JSON dla tych samych danych.
                          Przy 62.5 pakietach/s na 15 graczy różnica to setki KB/s.
```

### Stany Agones i przejścia

Agones definiuje stany przez które przechodzi każdy serwer gry. Zrozumienie tych stanów jest kluczowe, bo determinują kiedy autoskaler może usunąć pod i kiedy lobby może do niego wysyłać graczy.

```
[Starting]
    │
    │  connectAgones() pobiera port i IP, wywołuje agonesSDK.ready()
    │  Od tego momentu lobby widzi serwer i może wysyłać do niego graczy.
    ▼
[Ready] ←─────────────────────────────────────────┐
    │                                               │
    │  Pierwszy gracz dołącza → open()              │
    │  agonesSDK.allocate() wywoływane              │
    │  Serwer "zarejestrowany" dla tej sesji        │
    ▼                                               │
[Allocated]                                         │
    │                                               │
    │  Ostatni gracz wychodzi → close()             │
    │  agonesSDK.ready() wywoływane                 │
    └───────────────────────────────────────────────┘
    │
    │  SIGTERM od Kubernetes lub serwer sam wywoła shutdown
    ▼
[Shutdown]
```

Kluczowa różnica między `Ready` a `Allocated`: w stanie `Ready` autoskaler Agones może pod usunąć jeśli jest zbyt wiele pustych serwerów (oszczędność kosztów chmury). W stanie `Allocated` serwer jest chroniony — nawet jeśli klaster jest przeciążony, Agones nie ruszy poda z aktywną sesją rozgrywki.

---

## 2. Zależności

Każda zależność została wybrana z konkretnego powodu. Poniżej wyjaśnienie nie tylko co robi, ale dlaczego akurat to rozwiązanie, a nie inne.

### `uWebSockets.js` — v20.30.0

Standardowa biblioteka `ws` w Node.js jest wolna, bo jest napisana w czystym JavaScript. `uWebSockets.js` to implementacja w C++ z bindingami dla Node.js — benchmarki pokazują 5–10× wyższą przepustowość. W grze real-time z 15 graczami, każdy wysyłający i odbierający ~62 pakietów na sekundę, każda milisekunda opóźnienia jest widoczna. Kompresja `SHARED_COMPRESSOR` (jeden kontekst dla wszystkich połączeń zamiast osobnego na każde) zmniejsza zużycie pamięci kosztem minimalnie mniejszego współczynnika kompresji — dobry kompromis przy 15 połączeniach.

Używane API: `uWS.App()`, `.ws('/*', {upgrade, open, message, close})`, `.listen(port, cb)`, `ws.send(buffer, true)` (tryb binarny), `ws.getBufferedAmount()`.

### `@google-cloud/agones-sdk` — ^1.56.0

SDK do komunikacji z Agones — systemem zarządzania serwerami gier na Kubernetes. Bez Agones normalny K8s nie wie, że pod ma aktywnych graczy i może go zabić w środku rozgrywki. SDK komunikuje się przez gRPC z sidecar kontenerem Agones działającym obok naszego poda.

Używane API: `.connect()` (nawiąż połączenie z sidecarem), `.getGameServer()` (pobierz port zewnętrzny i IP węzła), `.ready()` (sygnalizuj gotowość), `.allocate()` (serwer zajęty), `.health()` (heartbeat co 2s).

### `redis` — ^5.11.0

Klient Redis dla Node.js. Redis pełni rolę szyny komunikacyjnej — child zapisuje swoje dane, mother je czyta, i odwrotnie. Żaden z serwerów nie zna adresu sieciowego drugiego — komunikują się wyłącznie przez Redis. To ułatwia skalowanie: można mieć 10 serwerów child i 3 serwery mother, wszystkie gadają przez jeden Redis.

Ważna specyfika: po wywołaniu `SUBSCRIBE` klient Redis wchodzi w tryb subskrybenta i nie może już wykonywać innych komend. Dlatego potrzebne są dwa osobne połączenia TCP.

Używane API: `createClient({url})`, `.connect()`, `.hSet()`, `.expire()`, `.sAdd()`, `.sRem()`, `.del()`, `.publish()`, `.subscribe()`.

### `mongodb` — ^7.1.0

Baza danych nierelacyjna do trwałego przechowywania profili graczy (punkty, skiny, historia). Używamy wyłącznie przy rozłączeniu gracza — zapis punktów `$inc`. MongoDB zamiast SQL bo dokumenty są naturalne dla obiektów gracza i nie potrzebujemy transakcji ani joinów. `$inc` zamiast `$set` bo jest atomowe — jeśli dwóch graczy z różnych serwerów jednocześnie zdobędzie punkty na tym samym koncie, `$inc` je sumuje bez utraty danych, `$set` by jeden z nich utracił.

### `shared/binary.js`

Własny moduł protokołu binarnego. Istnieje bo żadna zewnętrzna biblioteka nie oferuje dokładnie takiego interfejsu serializacji jaki jest potrzebny — pisanie małych, bardzo zoptymalizowanych pakietów z mieszanką int8, uint32, string16 i tablic. Protokół binarny zamiast JSON: `{"id":5,"x":512.3,"y":-1024.7}` to 30 bajtów tekstu, a `[05][00 00 FF 3F][00 00 80 C4]` to 9 bajtów binarnych — ponad 3× mniej danych na każdy pakiet.

### Instalacja

```bash
npm install                        # instaluje zależności z package.json
npm install @google-cloud/agones-sdk
```

`uWebSockets.js` nie jest w rejestrze npm — instalowany bezpośrednio z GitHub przez wpis w `package.json`:
```json
"uWebSockets.js": "github:uNetworking/uWebSockets.js#v20.30.0"
```
Dlatego `apt-get install git` jest potrzebne w Dockerfile — npm potrzebuje gita do sklonowania repozytorium podczas `npm install`.

---

## 3. Stałe konfiguracyjne

Wszystkie stałe są zebrane na początku pliku, żeby zmiana parametrów gry (np. limit graczy, fizyka) nie wymagała przeszukiwania kilku tysięcy linii kodu.

| Stała | Wartość | Szczegóły |
|---|---|---|
| `COUNTRY` | `"EU"` | Kod regionu zapisywany do Redis jako `serv_loc`. Gracze będą mogli filtrować serwery po regionie — niższy ping dla graczy z UE. Inne możliwe wartości: `'US'`, `'ASIA'`, `'BR'`. |
| `SERVER_NAME` | `"EU-Phantom"` | Losowa z 20 słów w puli, generowana raz przy starcie. Gracze zapamiętują "EU-Phantom" lepiej niż "Server-7f3a". Generowanie: `SERVER_NAME_WORDS[Math.floor(Math.random() * 20)]`. |
| `SERVER_PORT` | `5000` | Port wewnętrzny poda na którym nasłuchuje uWS. Klienci nigdy nie łączą się pod ten port bezpośrednio — używają `AGONES_PORT` (zewnętrzny z zakresu 7000–8000). |
| `MAX_PLAYERS` | `15` | Limit graczy ludzkich. Lobby sprawdza `g_players_len < g_players_lim` i nie kieruje graczy na pełny serwer. Boty nie wliczają się do tego limitu. |
| `SERVER_TICK_MS` | `16` | Czas jednego kroku symulacji (działania gry) w milisekundach. `1000 / 16 ≈ 62.5` kroków na sekundę. Wartość 16ms jest zbliżona do odświeżania monitora 60Hz (16.67ms) — klienci zawsze mają świeże dane. |
| `BOT_COUNT` | `37` | Liczba botów AI tworzonych przy starcie serwera. Boty zapewniają aktywność mapy zanim dołączą gracze. Liczba dobrana empirycznie — wystarczająco dużo żeby mapa "żyła", wystarczająco mało żeby fizyka była szybka. |
| `MAX_FREE_IDS` | `255` | Maksymalna liczba obiektów graczy (ludzkich + botów). Wartość 255 wynika z użycia uint8 w protokole binarnym — ID mieści się w 1 bajcie. Pula `free_ids[]` inicjalizowana przy starcie: `for (let i=254; i>=0; i--) free_ids.push(i)`. |
| `GRAVITY` | `0.1` | Zmniejszenie prędkości pionowej co tick. Formuła: `v = 4 - jump_frame × 0.1`. Wartość 0.1 daje przyjemny łuk skoku — nie za szybki, nie za wolny. Ziemska grawitacja 9.8 m/s² byłaby absurdalnie szybka w skali tej gry. |
| `PLAYER_RADIUS` | `11` | Promień kołowego hitboxa każdego gracza w jednostkach gry. Kolizja zachodzi gdy odległość między środkami ≤ 11+11=22 jednostki. Koło zamiast prostokąta — naturalniejsze dla modelu postaci (jest okrągła) i tańsze obliczeniowo. |

### Dlaczego grawitacja 0.1, a nie więcej?

Zanim zmienisz `GRAVITY`, warto zrozumieć efekt: prędkość Y w górę zaczyna się od 4 jednostek na tick i maleje o 0.1 każdy tick.

```
jump_frame=0:   v = 4 - 0×0.1  = +4.0   ← start skoku, gracz unosi się w górę
jump_frame=20:  v = 4 - 20×0.1 = +2.0   ← spowalniasz, łuk skoku
jump_frame=40:  v = 4 - 40×0.1 = 0.0    ← szczyt łuku, gracz przez chwilę "wisi"
jump_frame=80:  v = 4 - 80×0.1 = -4.0   ← opada z powrotem
jump_frame=140: cap na -10              ← maksymalna prędkość opadania
```

Cap na -10 jest krytyczny — bez niego gracz po bardzo długim locie opadałby z prędkością -50, -100 jednostek na tick i "przelatywałby przez" platformy (tunnel effect). Kafelek ma 16 jednostek wysokości, więc cap -10 gwarantuje że gracz nigdy nie przeskoczy kafelka w jednym ticku.

---

## 4. Zmienne środowiskowe

Adresy Redisa, MongoDB czy numer portu nie są wpisane w kodzie — serwer odczytuje je z zmiennych środowiskowych (`process.env.*`) w momencie startu. Dzięki temu dokładnie ten sam plik `main.js` uruchamia się na laptopie dewelopera (z lokalnym Redisem i MongoDB) oraz w klastrze Kubernetes (z CosmosDB i wewnętrznym Redisem) — różni się tylko to, co Kubernetes wstrzykuje do kontenera przez `env` w manifeście poda.

| Zmienna | Wymagana | Wartość produkcyjna | Fallback lokalny |
|---|---|---|---|
| `REDIS_URL` | Produkcja | `redis://redis:6379` — `redis` to nazwa K8s Service z pliku `prz-redis.yaml` | `redis://localhost:6379` |
| `MONGO_URL` | Produkcja | Pełny connection string Azure CosmosDB z K8s Secret `cosmos-db-secret` (hasło w repozytorium nie istnieje) | `mongodb://localhost:27017` |
| `USE_AGONES` | Produkcja | `"true"` (string, nie boolean — `process.env` zawsze zwraca string) | brak → `IS_LOCAL = true` |
| `PORT` | Opcjonalna | Zwykle nie ustawiana — Agones dostarcza port przez SDK | `argv[2]` lub `5000` |
| `PUBLIC_GAME_IP` | Opcjonalna | Ręczne nadpisanie IP dla dev/debug bez K8s | `localhost` gdy `IS_LOCAL=true` |

Wartość `IS_LOCAL` jest obliczana jako `process.env.USE_AGONES !== 'true'` i używana w wielu miejscach do pominięcia wywołań Agones SDK. Nie ustawia się jej bezpośrednio — wynika z `USE_AGONES`.

---

## 5. Sekwencja inicjalizacji

Kolejność kroków inicjalizacji jest nieprzypadkowa i każde przestawienie powoduje błąd. Poniższy diagram pokazuje co i dlaczego musi być przed czym.

```
Uruchomienie procesu
  │
  ├─ connectAgones()
  │    │
  │    │  Dlaczego to pierwsze? Bo musimy poznać AGONES_PORT i AGONES_IP
  │    │  zanim zarejestrujemy serwer w Redis. Gdybyśmy rejestrowali wcześniej,
  │    │  lobby dostałoby port=5000 i IP=127.0.0.1 — adresy które są wewnętrzne
  │    │  i nieosiągalne z zewnątrz. Gracze nie mogliby się połączyć.
  │    │
  │    ├─ [USE_AGONES=false] → pomiń cały blok, tylko redis_connect()
  │    │
  │    ├─ agonesSDK.connect()
  │    │    Nawiązuje gRPC do sidecar kontenera Agones działającego obok naszego poda.
  │    │    Bez tego SDK nie wie z jakim pod rozmawia.
  │    │
  │    ├─ agonesSDK.getGameServer()
  │    │    Pobiera obiekt GameServer z Kubernetes API. Interesują nas:
  │    │    gs.status.portsList[0].port → np. 30542 (zewnętrzny port NodePort)
  │    │    gs.status.address           → np. "34.89.123.45" (IP węzła K8s)
  │    │    Notka: pole zmieniło nazwę między wersjami — stąd portsList || ports.
  │    │
  │    ├─ agonesSDK.ready()
  │    │    Zmienia stan GameServera z Starting na Ready.
  │    │    Dopiero teraz lobby może wysyłać graczy na ten serwer.
  │    │    Wywołanie przed getGameServer() = lobby widzi serwer z błędnymi danymi.
  │    │
  │    ├─ setInterval(agonesSDK.health, 2000ms)
  │    │    Heartbeat co 2 sekundy. Agones uzna pod za martwy jeśli przez ~30s
  │    │    nie dostanie sygnału życia → pod restartowalny, gracze wylatują.
  │    │    try/catch wewnątrz: jeden błąd nie zatrzymuje watchdoga.
  │    │
  │    └─ redis_connect()
  │         Dopiero tutaj, gdy znamy port i IP.
  │         ├─ Tworzy redis_pub i redis_sub (dwa połączenia TCP)
  │         ├─ Łączy z MongoDB → db_users
  │         ├─ hSet('game:{id}', dane serwera z prawdziwym portem i IP)
  │         ├─ expire('game:{id}', 5) → dead-man's switch
  │         ├─ sAdd('game_ids', game_id) → lobby wie że serwer istnieje
  │         ├─ publish('lobby_update', '1') → lobby odświeża UI od razu
  │         └─ subscribe('join:{game_id}', handler) → gotowi na tokeny graczy
  │
  ├─ for (25×) gen_lvl()
  │    Generuje 2500 poziomów mapy zanim serwer przyjmie graczy.
  │    Dlaczego 2500? To zapas na długą sesję. Gracz opada ~1 poziom na kilka sekund.
  │    Gdy gracz zbliża się do końca wygenerowanych poziomów, gen_lvl() wywołuje się
  │    dynamicznie i dodaje kolejne 100 poziomów.
  │
  ├─ for (BOT_COUNT=37) new bot()
  │    Boty tworzone po mapie — potrzebują random_pos() który korzysta z poziomów.
  │
  ├─ init_server_websocket(SERVER_PORT)
  │    uWS.App().ws('/*', {...}).listen(5000, ...)
  │    Od tej chwili możliwe są połączenia WebSocket.
  │
  └─ setInterval(gameLoop, 16ms)
       Pętla gry startuje. Od tej chwili fizyka, boty i pakiety działają co 16ms.
```


## 6. Specyfikacja API

### `connectAgones()` — `async`

Łączy się z Agones SDK, pobiera publiczny port i IP węzła K8s (nie poda — pod ma prywatne IP 10.x.x.x nieosiągalne z internetu), sygnalizuje gotowość serwera i uruchamia heartbeat.

Dlaczego kompatybilność `portsList || ports`? Agones zmienił nazwę pola między wersjami SDK. `portsList` to nowe API (protobuf), `ports` to stare (deprecated). Użycie `||` zapewnia działanie na obu wersjach klastra, bo nie zawsze możesz kontrolować wersję Agones w chmurze.

```javascript
const gs = await agonesSDK.getGameServer();

// Kompatybilność z różnymi wersjami Agones SDK:
const allocatedPorts = gs.status.portsList || gs.status.ports;
if (allocatedPorts && allocatedPorts.length > 0) {
    AGONES_PORT = allocatedPorts[0].port;  // np. 30542 — zewnętrzny port NodePort
}
// gs.status.address = IP węzła K8s, np. "34.89.123.45"
// To IP maszyny wirtualnej w chmurze, nie poda.
// Pod ma prywatne IP (10.x.x.x) niedostępne z internetu.
AGONES_IP = gs.status.address;

await agonesSDK.ready();
// Dopiero tu — po pobraniu prawdziwego portu i IP.
// Gdybyśmy wywołali ready() przed getGameServer(), lobby dostałoby w Redis
// port=5000 (wewnętrzny) i IP=127.0.0.1 — adresy nieprzydatne dla klientów.

health_interval = setInterval(() => {
    try { agonesSDK.health(); } catch (_) {}
    // try/catch: jeden błąd SDK nie zatrzymuje watchdoga.
    // _ to konwencja "błąd mnie nie interesuje".
    // Jeden pominięty heartbeat nie zabija serwera — Agones toleruje kilka braków.
}, 2000);
```

---

### `redis_connect()` — `async`

Inicjalizuje połączenia z Redisem i MongoDB, rejestruje serwer jako dostępny i subskrybuje kanał na którym Mother będzie wysyłać tokeny graczy.

**Dlaczego dwa klienty Redis?**

Protokół Redis ma fundamentalne ograniczenie: gdy klient wywoła `SUBSCRIBE`, wchodzi w tryb subskrybenta i od tej chwili może wyłącznie odbierać wiadomości. Żadnych `hSet`, `expire`, `publish`, `sAdd` — dostanie błąd. Jedynym rozwiązaniem jest drugie połączenie TCP dla operacji zapisu.

```javascript
redis_pub = createClient({ url: REDIS_URL });  // do zapisu i publishowania
redis_sub = createClient({ url: REDIS_URL });  // TYLKO do subscribe

// Rejestracja handlerów błędów jest OBOWIĄZKOWA.
// Bez nich: błąd połączenia Redis = "unhandled error event" = crash całego procesu Node.js!
// Z nimi: błąd jest zalogowany, klient automatycznie próbuje się ponownie połączyć.
redis_pub.on('error', err => console.error('Redis pub error:', err));
redis_sub.on('error', err => console.error('Redis sub error:', err));
```

**Co zapisujemy do Redis przy rejestracji:**

```javascript
// Wszystkie wartości jako string — Redis hSet wymaga string, nie number.
await redis_pub.hSet('game:3482901234', {
    g_port:        "30542",        // zewnętrzny port — klienci się tu łączą
    g_players_len: "0",            // aktualizowany co ~1s; lobby wyświetla "0/15 graczy"
    g_players_lim: "15",           // lobby sprawdza len < lim przed wysłaniem gracza
    serv_ip:       "34.89.123.45", // IP węzła — klienci łączą się pod ten adres
    serv_loc:      "EU",           // do filtrowania w lobby po regionie
    serv_name:     "EU-Phantom",   // czytelna nazwa wyświetlana w UI lobby
});

// expire() natychmiast po hSet — dead-man's switch.
// Jeśli serwer crashnie, klucz wygaśnie sam po 5 sekundach.
// redis_update_player_count() odnawia TTL co ~1s dopóki serwer żyje.
await redis_pub.expire('game:3482901234', 5);

// sAdd dodaje ID do globalnego setu aktywnych gier.
// Lobby pobiera go przez sMembers('game_ids') i iteruje przez wszystkie ID.
// Dlaczego set zamiast np. KEYS 'game:*'? KEYS skanuje całą bazę = O(n) po wszystkich kluczach.
// sMembers('game_ids') = O(k) gdzie k to liczba aktywnych serwerów (kilkanaście, nie tysiące).
await redis_pub.sAdd('game_ids', '3482901234');

// publish natychmiast informuje lobby że pojawił się nowy serwer.
// Bez tego lobby odświeżałoby listę dopiero po następnym cyklu (nawet kilka sekund).
await redis_pub.publish('lobby_update', '1');
```

**Subskrypcja tokenów graczy:**

```javascript
// Każdy serwer subskrybuje SWÓJ kanał — 'join:3482901234', nie wspólny.
// Mother wie który serwer wybrał gracz i publikuje na właściwy kanał.
await redis_sub.subscribe('join:3482901234', (message) => {
    // message to string JSON: '{"token":987654321,"name":"Kacper","skin_id":3,"account":"507f..."}'
    try {
        const data = JSON.parse(message);
        // JSON.parse może rzucić SyntaxError jeśli Mother wyśle błędny JSON.
        // try/catch zapobiega crashowi serwera z powodu jednej złej wiadomości.

        tokens[data.token] = {
            token:    data.token,
            name:     data.name,
            skin_id:  data.skin_id,
            account:  data.account,  // MongoDB ObjectId lub '' dla gości
            timelive: frame + 10000, // token ważny 10000×16ms = 160s od tej chwili
            // 160 sekund to hojny bufor — klient musi tylko nawiązać WebSocket,
            // co na normalnym łączu trwa ułamki sekund.
        };
    } catch (e) {
        console.error('Błąd parsowania join message:', e);
    }
});
```

---

### `redis_cleanup()` — `async`

Usuwa serwer z Redis natychmiast — bez czekania na TTL. Wywoływana przy SIGTERM (graceful shutdown) i gdy ostatni gracz wychodzi z serwera.

Dlaczego `del` zamiast czekania na TTL? Przy normalnym zamknięciu chcemy żeby serwer zniknął z lobby natychmiast, nie za 5 sekund — gracz nie powinien próbować dołączyć na właśnie zamykający się serwer.

```javascript
async function redis_cleanup() {
    if (!redis_pub) return;
    // Jeśli Redis nigdy się nie połączył (błąd startowy), nie ma co czyścić.
    // Bez tego sprawdzenia: redis_pub.del() na undefined = TypeError, crash.

    try {
        await redis_pub.del('game:3482901234');
        // Usuwa cały hash natychmiast. Lobby przy następnym hGetAll dostanie {}.

        await redis_pub.sRem('game_ids', '3482901234');
        // Usuwa ID z setu aktywnych. Bez tego lobby wciąż iteruje przez stare ID,
        // robi hGetAll, dostaje {}, i musi sprawdzić if (!data.g_port) continue.
        // To zaśmieca set martwymi ID do restartu Redis.

        await redis_pub.publish('lobby_update', '1');
        // Natychmiastowe powiadomienie lobby — UI odświeży się od razu,
        // nie dopiero przy kolejnym cyklicznym odświeżeniu.

    } catch (e) {
        console.error('Błąd redis_cleanup:', e);
        // Jeśli Redis był niedostępny — logujemy i idziemy dalej.
        // Serwer i tak się zamyka, retry nie ma sensu.
    }
}
```

---

### `redis_update_player_count()`

Heartbeat Redis — co ~1 sekundę aktualizuje liczbę graczy i odnawia TTL klucza. To jednocześnie mechanizm synchronizacji z lobby.

Dlaczego nie `await` w środku? Funkcja jest wywoływana z `setInterval` pętli gry. Gdyby czekała na Redis, blokowałaby pętlę gry na czas odpowiedzi sieciowej (~1–5ms). To małe wartości, ale przy 62.5 wywołaniach na sekundę mogłoby zakłócić timing ticków. Zamiast tego: `fire-and-forget` z `.then()` i `.catch()`.

```javascript
function redis_update_player_count() {
    if (!redis_pub || is_shutting_down) return;
    // !redis_pub: Redis niepołączony — nie ma gdzie zapisywać
    // is_shutting_down: SIGTERM w trakcie — redis_cleanup() czyści, nie odtwarzamy

    redis_pub.hSet('game:3482901234', 'g_players_len', player_length.toString())
        // Aktualizujemy TYLKO jedno pole — resztę (IP, port, limit) raz zapisujemy w redis_connect.
        .then(() => redis_pub.expire('game:3482901234', 5))
        // expire() dopiero po hSet — nie ma sensu odnawiać TTL jeśli hSet się nie powiódł.
        // 5 sekund × 1 odświeżenie/sekundę = 5× bezpieczny bufor na wypadek chwilowej niedostępności Redis.
        .then(() => redis_pub.publish('lobby_update', '1'))
        // Lobby dowiaduje się o zmianie liczby graczy i odświeża UI w czasie rzeczywistym.
        .catch(console.error);
}
// Wywoływane w game loop: if (frame % 60 === 0) redis_update_player_count()
// 60 ticków × 16ms = 960ms ≈ 1 sekunda
```

---

### `save_player_money(token_or_account, money)`

Zapisuje punkty zarobione w sesji do MongoDB. Wywoływana przy rozłączeniu gracza i przy jego śmierci (zapis "checkpoint").

Dlaczego `$inc` zamiast `$set`? Gracz może grać jednocześnie na dwóch serwerach (np. przez dwa konta lub dwa okna przeglądarki). Jeśli oba serwery zapiszą `$set: {points: 1500}`, jeden zapis nadpisze drugi i gracz straci punkty z drugiej sesji. `$inc` atomowo dodaje wartość — oba zapisy są zsumowane.

```javascript
function save_player_money(token_or_account, money) {
    if (money <= 0 || !db_users) return;
    // money <= 0: gracz nie zarobił nic w tej sesji (dołączył i od razu wyszedł).
    // !db_users: MongoDB nie połączyło się przy starcie — nie próbujemy zapisać.

    let accountStr = '';
    if (typeof token_or_account === 'object' && token_or_account !== null) {
        accountStr = token_or_account.account || '';
        // Przekazano obiekt gracza (player) — wyciągamy .account
    } else {
        accountStr = token_or_account || '';
        // Przekazano bezpośrednio string (ObjectId)
    }

    if (!accountStr) return;
    // Pusty string = gracz-gość (nie zalogowany) lub bot.
    // Goście nie mają konta w MongoDB — nie ma gdzie zapisać.
    // Bots też mają account='' — nigdy nie zapisujemy botów.

    try {
        db_users.updateOne(
            { _id: new ObjectId(accountStr) },
            // new ObjectId() OBOWIĄZKOWE. MongoDB przechowuje _id jako BSON ObjectId (12 bajtów),
            // nie jako string. Gdybyś napisał {_id: accountStr} (string),
            // MongoDB szukałoby dokumentu gdzie _id jest STRINGIEM — nie znajdzie nic!
            // new ObjectId("507f...") konwertuje 24-znakowy hex string → binarny ObjectId.

            { $inc: { points: money, total_points: money } }
            // points:       bieżące saldo, można wydać w sklepie skinów.
            // total_points: łączny dorobek lifetime, nigdy nie maleje, do rankingów.
            // Oba pola rosną o tę samą kwotę money.
        ).catch(console.error);
    } catch (e) {
        console.error('save_player_money error:', e);
        // new ObjectId() rzuca wyjątek dla nieprawidłowego stringa (np. za krótki, nie-hex).
        // Łapiemy tu zamiast crashować serwer z powodu złego ObjectId.
    }
}
```

Wywołanie przy rozłączeniu w `close()`:
```javascript
save_player_money(pl, pl.points - pl.account_points);
// pl.account_points: zapisane przy połączeniu (ile miał PRZED sesją), np. 5000
// pl.points:         stan po sesji, np. 8500
// Różnica 3500 = tyle faktycznie zarobił w tej sesji → dodajemy tylko przyrost
```

---

### `gen_id()` — zwraca `number` (uint32, 0–4 294 967 295)

Generator losowego uint32 używanego jako unikalny identyfikator tej instancji serwera gry. Tworzony raz przy starcie: `const game_id = gen_id()`.

Dlaczego `Uint32Array`? `Math.random()` zwraca float. Mnożenie przez `0xffffffff` daje float z ułamkami. `Uint32Array` automatycznie obcina część ułamkową i clampuje do zakresu 0–4 294 967 295. To elegantsze i szybsze niż `Math.floor()`.

```javascript
const gen_id = function() {
    this[0] = Math.random() * 0xffffffff;
    // 0xffffffff = 4 294 967 295 = 2³²−1 = maksymalna wartość uint32
    // Uint32Array[0] automatycznie konwertuje float → uint32 przy przypisaniu
    return this[0];
}.bind(new Uint32Array(1));
// .bind() tworzy nową funkcję gdzie this = podany obiekt (tablica 1-elementowa).
// new Uint32Array(1) tworzona RAZ przy module load, nie przy każdym wywołaniu.
// Oszczędzamy alokację tablicy co wywołanie — mikrooptymalizacja.
```

---

### `gen_lvl()`

Generuje proceduralnie kolejne 100 poziomów cylindrycznej mapy. Wywołana 25× przy starcie (2500 poziomów) i dynamicznie gdy gracze zbliżą się do końca wygenerowanej mapy.

Dlaczego proceduralne generowanie zamiast gotowej mapy? Mapa jest (praktycznie) nieskończona — gracz może grać bez końca, coraz głębiej. Przechowywanie z góry zdefiniowanych 100 000 poziomów zajęłoby gigabajty pamięci. Generowanie on-demand przy każdym wywołaniu `gen_lvl()` zużywa tylko tyle pamięci ile aktualnie potrzeba.

**Checkpointy — co to i jak działają:**

Checkpoint to specjalny poziom — pełna platforma dookoła cylindra z trzema wąskimi otworami. Gracz musi trafić w jeden z otworów żeby przejść dalej. Przejście przez checkpoint nagradza gracza (+1 event/życie) i ustawia `respawn_lvl` — po śmierci gracz respawnuje od ostatniego checkpointu, nie od początku.

```javascript
// Warunek checkpointu: sqrt(id/10) jest liczbą całkowitą
// Równoważnie: id = 10n², czyli id ∈ {0, 10, 40, 90, 160, 250, 360...}
if (!(Math.sqrt(id / 10) % 1)) {
    // % 1 daje część ułamkową liczby: 3.7 % 1 = 0.7, 3.0 % 1 = 0.0
    // ! (NOT) odwraca: !0.0 = true (brak ułamka = liczba całkowita = checkpoint)

    levels[id] = new Uint8Array(128).fill(1);  // pełna platforma dookoła
    levels[id][0] = levels[id][1] = levels[id][2] = 0;     // otwór 1
    levels[id][42] = levels[id][43] = levels[id][44] = 0;  // otwór 2 (~1/3 cylindra)
    levels[id][84] = levels[id][85] = levels[id][86] = 0;  // otwór 3 (~2/3 cylindra)
    // 9 otwartych na 128 = 7% otwartości. Trzeba celować!
    continue;
}
```

Checkpointy rozsuwają się geometrycznie — im głębiej, tym rzadziej:
```
id=0:   checkpoint   (na samym początku, tutorial)
id=10:  checkpoint   (po 10 poziomach)
id=40:  checkpoint   (po kolejnych 30)
id=90:  checkpoint   (po kolejnych 50)
id=160: checkpoint   (po kolejnych 70)
id=250: checkpoint   (po kolejnych 90)
```

**Normalny poziom — jak rośnie trudność:**

```javascript
levels[id] = new Uint8Array(128);  // zaczynamy od pustej mapy (same zera)

// Śmiertelne platformy (typ 2, czerwone):
const badCount = ((id / 40) | 0) + 4;
// id=0:   (0|0)+4 = 4 grupy czerwonych
// id=200: (5|0)+4 = 9 grup czerwonych
// id=400: (10)+4 = 14 grup czerwonych
// Każda grupa ma 2–4 kafelki. | 0 = szybkie Math.floor dla >=0.

// Bezpieczne platformy (typ 1, zielone):
const norCount = ((id / 20) | 0) + 20;
// id=0:   (0)+20 = 20 grup zielonych
// id=200: (10)+20 = 30 grup zielonych
// Każda grupa ma 3–8 kafelków. Zielone nie nadpisują czerwonych.

// Wrap-around przy generowaniu grup:
for (let oo = len; oo--;) {
    levels[id][pos++] = 2;
    pos &= 0b1111111;  // & 127 = modulo 128 (cylinder jest okrągły)
    // Gdy pos wyjdzie za 127, wraca do 0. Grupy mogą "opasać" cylinder.
}
```

Dlaczego norCount rośnie szybciej niż badCount? Gdyby oba rosły w tym samym tempie, mapa stałaby się niemożliwa — zbyt mało miejsca do stania. Więcej zielonych platform przy więcej czerwonych = wyższa trudność, ale nadal grywalność.

---

### `is_colid(ax, ay, ar, bx, by, br)` — zwraca `boolean`

Sprawdza czy dwa kołowe hitboxy na siebie nachodzą. Używana co tick dla każdej pary graczy w sąsiednich segmentach mapy.

Kluczowa optymalizacja: unikamy `sqrt()`. Dwa okręgi kolidują gdy `√(dx²+dy²) ≤ r1+r2`. Podnosząc obie strony do kwadratu (obie są nieujemne, więc wynik poprawny): `dx²+dy² ≤ (r1+r2)²`. `sqrt()` to jedna z najwolniejszych operacji matematycznych — przy dziesiątkach tysięcy wywołań na sekundę różnica jest mierzalna.

```javascript
function is_colid(ax, ay, ar, bx, by, br) {
    const dx = ax - bx;
    const dy = ay - by;
    const r  = ar + br;
    return dx * dx + dy * dy <= r * r;
}

// Przykład — kolizja:
// Gracz A: x=100, y=50, r=11
// Gracz B: x=118, y=50, r=11
// dx=100-118=-18, dy=0
// dx²+dy² = 324+0 = 324
// (11+11)² = 484
// 324 ≤ 484 → true (nachodzą o 22-18=4 jednostki)

// Przykład — brak kolizji:
// Gracz B: x=130, y=50
// dx=-30, dy=0 → dx²=900 > 484 → false
```

---

### `random_pos()` — zwraca `number` (0–1023)

Generuje bezpieczną pozycję X spawnu. "Bezpieczna" oznacza: nie nad dziurą w checkpoincie. Gdyby gracz spawnował nad dziurą, od razu by przez nią wpadł i zginął — frustrujące.

Strefy wykluczone odpowiadają pozycjom dziur w checkpointach (kafelki 0–2, 42–44, 84–86 z małym zapasem bezpieczeństwa): indeksy kafelków 0–3, 41–46, 83–88.

```javascript
function random_pos() {
    let r   = (Math.random() * 0x3ff) | 0;  // float 0–1022 → int przez | 0
    r      &= 0x3ff;                          // maska 10-bitowa (ostrożność)
    const ind = r >> 3;                       // indeks kafelka: pozycja/8

    if (ind < 4 || (ind >= 41 && ind <= 46) || (ind >= 83 && ind <= 88)) {
        return random_pos();  // trafiliśmy w strefę wykluczoną — spróbuj ponownie
    }
    return r;
}
// Strefy wykluczone to ~17/128 ≈ 13% cylindra.
// Prawdopodobieństwo 5 trafień z rzędu: 0.13^5 ≈ 0.000038% → stack overflow niemożliwy.
```

---

### `rnd(minv, maxv)` — zwraca liczbę całkowitą z `[minv, maxv)`

Funkcja pomocnicza do generowania losowych liczb całkowitych w podanym zakresie. Używana wszędzie tam gdzie potrzebna jest losowość z kontrolowanym zakresem: długość grup kafelków, czas trwania zachowania bota, długość nazwy w `getName()`.

```javascript
function rnd(minv, maxv) {
    if (maxv < minv) return 0;
    // Guard: nieprawidłowy zakres zamiast NaN lub ujemnej wartości.

    return (((Math.random() * 0xffffff) | 0) % (maxv - minv)) + minv;
    // Math.random() * 0xffffff → float 0–16 777 214
    // | 0 → obcięcie do liczby całkowitej (szybsze niż Math.floor dla >=0)
    // % (maxv-minv) → redukcja do zakresu 0..(maxv-minv-1)
    // + minv → przesunięcie do [minv, maxv)
}
// rnd(3, 8) → jedna z {3, 4, 5, 6, 7}  (maxv=8 nie jest zwracane)
// rnd(0, 3) → jedna z {0, 1, 2}
```

---

### `to_bignum_byte(points)` — zwraca `number` (0–255)

Kompresja surowej liczby punktów do 1 bajtu dla protokołu binarnego rankingu. Musimy zmieścić liczby do 66 milionów w jednym bajcie — 0–255. Rozwiązanie: skala logarytmiczna.

Dlaczego precyzja może maleć dla wysokich wyników? W rankingu ważna jest kolejność, nie dokładna wartość. Gracza z 5 000 000 vs 5 100 000 punktów rozróżnienie do 100 000 to wystarczające. Gdybyśmy chcieli liniowej precyzji dla 66M, jeden bajt by nie wystarczył — potrzebowalibyśmy 4 bajtów (uint32). To 4× więcej danych w każdym pakiecie rankingu.

| Zakres punktów | Wynik (byte) | Formuła | Co oznacza zmiana o 1 jednostkę |
|---|---|---|---|
| 0 – 100 000 | 0 – 100 | `points / 1000` | 1 000 punktów |
| 100 001 – 1 000 000 | 100 – ~190 | `(points - 100000) / 10000 + 100` | 10 000 punktów |
| 1 000 001 – 66 000 000 | ~199 – 255 | `points / 100000 + 189` | 100 000 punktów |
| > 66 000 000 | 255 | saturacja | — |

```javascript
// Przykłady:
to_bignum_byte(0)        → 0       // dopiero co zaczął
to_bignum_byte(50000)    → 50      // 50 000 punktów
to_bignum_byte(100000)   → 100     // granica pierwszego zakresu
to_bignum_byte(550000)   → 145     // (450000/10000)+100 = 45+100
to_bignum_byte(5000000)  → 239     // 5000000/100000+189 = 50+189
to_bignum_byte(70000000) → 255     // saturacja — nie można wyżej
```

Zmiana `byte_point` wyzwala wysyłkę pakietu rankingu. Dla niskich punktów to co ~1000 zdobytych punktów, dla wysokich co ~100 000 — na szczycie rankingu UI nie drgota przy każdym zabitym wrogu.

---

### `getName(minlength, maxlength)` — zwraca `string`

Generator nazw botów. Dlaczego nie po prostu `"Bot_1"`, `"Bot_2"`? Gracze są bardziej immersive gdy oponenci mają naturalne nazwy. "Karim zabił cię" brzmi inaczej niż "Bot_7 zabił cię".

Zasada fonetyczna: naprzemienne samogłoski i spółgłoski, max 2 spółgłoski z rzędu przed wymuszeniem samogłoski. Dlaczego 2 a nie 3? Dwie spółgłoski z rzędu są normalne w języku angielskim: `"st"` w "Storm", `"tr"` w "Track". Trzy z rzędu są trudne do wymówienia: `"strk"`, `"bctf"`. Czytelnicy na pierwszy rzut oka rozpoznają imię jako naturalne.

TODO: dopracować.

```javascript
const vocals = 'aeiouyhaeiouaeiou';  // powtórzenia = ważone prawdopodobieństwo
// 'a' pojawia się 3 razy → 3/17 ≈ 17.6% szans na 'a' (popularna samogłoska)
// 'y','h' po raz jeden → 1/17 ≈ 5.9% (rzadsze)

const cons = 'bcdfghjklmnpqrstvwxzbcdfgjklmnprstvwbcdfgjklmnprst';
// b,c,d,f... powtarzają się 3 razy (popularne spółgłoski)
// q,x,z raz (egzotyczne — dają nazwy jak "Qaxtor", rzadko losowane)

// Algorytm:
// consnum = 0 (licznik kolejnych spółgłosek)
// Gdy consnum === 2 → pool = tylko samogłoski (wymuś samogłoskę)
// Gdy consnum < 2   → pool = samogłoski + spółgłoski (losowo)
// Po wylosowaniu spółgłoski: consnum++
// Po wylosowaniu samogłoski: consnum = 0 (reset)

// Przykładowe wyniki: "Karim", "Belvox", "Trauna", "Stikar", "Ovimel"
```

---

### `add_player_seg(player, level)` i `rmv_player_seg(player, level)`

Zarządzanie mapą przestrzenną `segment_player[]`. To kluczowa optymalizacja detekcji kolizji — bez niej przy 52 obiektach mielibyśmy 52² = 2704 porównań co tick.

Idea: gracze na poziomie 5 cylindra fizycznie nie mogą kolidować z graczami na poziomie 50 — są zbyt daleko. Zamiast sprawdzać wszystkich ze wszystkimi, dzielimy graczy na "segmenty" według ich `lvl` i sprawdzamy tylko sąsiednie segmenty `(lvl-1)` i `(lvl)`. Maksymalna prędkość opadania to -10 j/tick, a jeden segment to ~128 jednostek wysokości — gracz nie może "przeskoczyć" segmentu w jednym ticku, więc sprawdzanie dalszych segmentów byłoby stratą czasu.

```
Bez segmentacji: 52 obiekty × 52 = 2704 porównań/tick × 62.5 Hz = 169 000/s
Z segmentacją:   52 × ~4 sąsiadów = 208 porównań/tick × 62.5 Hz = 13 000/s → 13× szybciej
```

Wywołania w cyklu życia gracza:
```
open():   add_player_seg(pl, 0)         ← gracz startuje na poziomie 0
move():   gdy pl.lvl się zwiększa:
            rmv_player_seg(pl, stary)
            add_player_seg(pl, nowy)
close():  rmv_player_seg(pl, pl.lvl)   ← usuń przy rozłączeniu
case 8:   add_player_seg(pl, 0)        ← respawn — z powrotem na poziom 0
```

---

## 7. Konstruktor gracza — `player(id, socket, tok)`

Gracze ludzcy i boty używają tego samego konstruktora. Różnią się tylko dwoma polami: `socket` (null dla botów — nie wysyłają/odbierają pakietów) i `bot` (null dla ludzi — brak logiki AI). Dzięki temu cała fizyka, kolizje i renderowanie działa identycznie dla obu.

| Pole | Typ | Wartość startowa | Znaczenie i kiedy się zmienia |
|---|---|---|---|
| `id` | uint8 (0–254) | `free_ids.pop()` | Klucz w `players{}` i w każdym pakiecie. Zwracany do `free_ids` przy rozłączeniu. |
| `socket` | uWS\|null | WebSocket (lub `null` dla bota) | null → pomijane przy `ws.send()` i `save_player_money()` |
| `name` | string | `tok.name` | Nick gracza z tokena wysłanego przez Mother |
| `account` | string | `tok.account \|\| ''` | MongoDB ObjectId lub '' (gość/bot). Pusty string → punkty nie zapisywane. |
| `x` | 0–1023 | `random_pos()` | Pozycja kątowa na cylindrze. Po każdej zmianie: `&= 0x3ff` (wrap). |
| `y` | number | `0` | Pionowa pozycja. Rośnie gdy gracz opada. Ujemna = powyżej startu (po skoku). |
| `move_x` | int8 | `0` | Delta X z pakietu `case 0`. Zerowana w `move()` lub po wymianie w kolizji. |
| `lvl` | number | `0` | Bieżący segment mapy. Rośnie gdy gracz opada głębiej. Indeksuje `segment_player[]`. |
| `send_lvl` | number | `10` | Do którego poziomu wysłano mapę klientowi. Gdy `lvl > send_lvl - 5` → wyślij 10 kolejnych przez pakiet typ 4. |
| `respawn_lvl` | number | `0` | Numer checkpointu przez który przeszedł: `Math.sqrt(lvl/10) \| 0`. Przy śmierci: teleport na poziom `respawn_lvl²×10`. |
| `ranking_id` | number | `ranking.length - 1` | Indeks w tablicy `ranking[]`. Nowy gracz trafia na koniec (0 punktów). Zmienia się w `add_points()`. |
| `points` | number | `0` | Suma punktów w bieżącej sesji. Resetowana przy respawnie (ale odzyskiwana z saved+kill). |
| `kill_points` | number | `0` | Punkty za zabójstwa. Trwałe — nie tracone przy śmierci, zawsze odzyskiwane przy respawnie. |
| `byte_point` | uint8 | `0` | Cache `to_bignum_byte(points)`. Aktualizowany tylko gdy wartość się zmienia — unikamy przeliczania co tick. |
| `saved_points` | number | `0` | Snapshot punktów przy ostatnim checkpoincie. Przy respawnie: `add_points(saved + kill)`. |
| `account_points` | number | `0` | Ile punktów miał gracz przy dołączeniu. `points - account_points` = przyrost sesji zapisywany do MongoDB. |
| `jump_frame` | number | `0` | Ticki od ostatniego lądowania. Prędkość Y = `4 - jump_frame × 0.1`. |
| `event` | 0–10 | `1` | "Żywotność". +1 za checkpoint i zabójstwo, -2 za czerwony kafelek. Gdy ≤0 i gracz uderzy w czerwony → śmierć. |
| `event_use` | number | `-2` | Maszyna stanów kafelkowa. `-2`=normalny, `-1`=aktywuje event (przeskakuje kafelek), `≥0`=ID warstwy ostatniego lądowania. |
| `event_send` | bool | `false` | Gdy true: wyślij zaktualizowane `event` klientowi przez pakiet typ 11. |
| `is_dead` | bool | `false` | Gdy true: `move()` pomijana, klient widzi ekran śmierci. Wraca do false przy pakiecie respawn. |
| `send_points` | number\|bool | `false` | Nagroda do wysłania przez pakiet typ 12. `-1` po wysłaniu (sentinel). |
| `target` | player\|null | `null` | Ostatni gracz z którym była kolizja fizyczna. Kill attribution: jeśli `this` umrze, `target` dostaje punkty. |
| `bot` | Bot\|null | `null` | Referencja do obiektu AI. `null` dla graczy ludzkich. |
| `skin_id` | uint8 | `tok.skin_id` | Wybrany skin (0–22). Może zmienić się przy respawnie (gracz wybiera nowy w ekranie śmierci). |

### `this.add_points(amount)` — krok po kroku

Dodaje punkty i utrzymuje posortowaną tablicę rankingu algorytmem bubble-sort (jeden krok w górę). Dlaczego bubble-sort zamiast `Array.sort()`? Sortujemy po JEDNEJ zmianie — gracz zarobił punkty i musi wskoczyć o kilka pozycji. `sort()` = O(n log n) za każdą zmianę. Bubble-sort jeden krok = O(n) w najgorszym, O(1) gdy awans o 1 pozycję.

```
Scenariusz: ranking = [Ana(100), Bob(80), Kacper(50)], Kacper.ranking_id = 2
Wywołanie: Kacper.add_points(1000)

Krok 1: Kacper.points = 50 + 1000 = 1050

Krok 2: Sprawdź czy to_bignum_byte zmieniło się.
  Stare: to_bignum_byte(50)   = 0    (50/1000 = 0.05 → 0)
  Nowe:  to_bignum_byte(1050) = 1    (1050/1000 = 1.05 → 1)
  Zmiana! → byte_point = 1, send_rank_pos = true (wyślij pozycję temu graczowi)
  Kacper.ranking_id (2) < 6 → send_ranking = true (wyślij nowy ranking wszystkim)

Krok 3: Bubble-sort w górę.
  above = ranking[2-1] = Bob(80)
  Kacper.points(1050) > Bob.points(80)? TAK →
    Bob.ranking_id++ (2→3... właściwie ranking ma 3 elementy, ale logika zadziała)
    Zamień: ranking[2] = Bob, ranking[1] = Kacper
    Kacper.ranking_id-- (2→1)
  above = ranking[1-1] = Ana(100)
  Kacper.points(1050) > Ana.points(100)? TAK →
    Ana.ranking_id++ (0→1)
    Zamień: ranking[1] = Ana, ranking[0] = Kacper
    Kacper.ranking_id-- (1→0)
  above = ranking[-1] = undefined → pętla kończy

Wynik: ranking = [Kacper(1050), Ana(100), Bob(80)]
       Kacper.ranking_id = 0 (pierwsze miejsce)
```

### `this.move()` — fizyka jednego ticka

Trzy etapy w ustalonej kolejności. Zmiana kolejności powoduje błędy (np. kolizje sprawdzane po zmianie pozycji przez grawitację dają inne wyniki).

```
ETAP 1: KOLIZJE Z INNYMI GRACZAMI

Iteruj po segmentach (this.lvl - 1) i (this.lvl):
  Dlaczego dwa segmenty? Gracz może stać na granicy segmentów.
  Dlaczego nie więcej? Max prędkość Y = -10j/tick, segment = ~128j → niemożliwe przeskoczenie.

  Dla każdego other ≠ this w segmencie:
    if is_colid(other.x, other.y, 11, this.x, this.y, 11):

      // Wymiana prędkości (uproszczona fizyka zderzenia):
      other.x += this.move_x    // other przejmuje ruch "this"
      this.x  += other.move_x   // this przejmuje ruch "other"
      this.move_x = other.move_x = 0  // zeruj po wymianie
      // Analogia: dwie kule bilardowe wymieniają prędkości przy zderzeniu.

      // Separacja (rozsuń gracza poza obszar kolizji):
      dist = Math.sqrt(dx² + dy²) || 1
      // Tu używamy sqrt! Ale tylko przy faktycznej kolizji (rzadko).
      // is_colid() sprawdzamy bez sqrt (często), separację z sqrt (rzadko).
      ux = dx/dist, uy = dy/dist  // wektor jednostkowy od "this" do "other"
      other.x = this.x + 22*ux   // umieść "other" w odległości 22j od "this"
      other.y = this.y + 22*uy   // (22 = PLAYER_RADIUS×2 = minimalna odległość)

      this.target = other  // kill attribution — jeśli "this" umrze, "other" dostanie punkty
      other.target = this

ETAP 2: GRAWITACJA

this.move_x = 0       // ruch zastosowany lub wymieniony — zresetuj na następny tick
this.jump_frame++     // rośnie co tick; przy lądowaniu resetowane do 0

vecy = 4 - this.jump_frame * 0.1
if (vecy < -10) vecy = -10  // cap prędkości opadania
this.y += vecy

ETAP 3: KOLIZJA Z KAFELKAMI

col = Math.abs((this.y - 8) >> 4)  // rząd siatki (odejmij 8 = "stopy" gracza)
if (!(col % 8)):  // sprawdź tylko co 8 rzędów (co 128j Y) — optymalizacja

  tileTop  = (this.x + 6) >> 3  // kafelek pod prawą krawędzią (x+6)
  tileDown = (this.x - 6) >> 3  // kafelek pod lewą krawędzią (x-6)
  tileMid  =  this.x      >> 3  // kafelek pod środkiem
  // Trzy punkty detekcji — gracz ma promień 11j, kafelek ma 8j szerokości.
  // Bez trzech punktów: gracz "wpadałby" między kafelki.

  idn = (col / 8) | 0  // numer poziomu mapy

  if levels[idn] istnieje i którykolwiek z trzech punktów na niezerowym kafelku:
    if typ === 2 (śmiertelny/czerwony):
      if this.event > 0:
        event -= 2, odsuń gracza, event_send = true
      else:
        gracz ginie → is_dead = true, killed_players.push(this.id)
        jeśli this.target: target.add_points(1000) + target.event++
    if typ === 1 (bezpieczny/zielony):
      this.jump_frame = 0   // lądowanie — reset grawitacji
      aktualizuj lvl → add_player_seg / rmv_player_seg jeśli zmiana
      aktualizuj respawn_lvl i saved_points przy checkpoincie
```

---

## 8. Cykl życia połączenia WebSocket

### `upgrade()` — decyzja PRZED handshake

`upgrade()` to hook wywoływany gdy klient wysyła żądanie HTTP Upgrade (przejście z HTTP na WebSocket). Jest to moment zanim połączenie WebSocket zostanie otwarte — możemy je odrzucić bez tworzenia jakiegokolwiek stanu po stronie serwera.

Dlaczego walidacja tutaj a nie w `open()`? W `upgrade()` odrzucamy zanim serwer alokuje pamięć na obiekt gracza, zanim uWS tworzy struktury WebSocket, zanim wysyłamy jakiekolwiek dane. Tańsze o kilka operacji, ale ważniejsze architektonicznie — klient dostaje czyste HTTP 401, a nie otwarte połączenie które zaraz zostaje zamknięte.

```javascript
upgrade: (res, req, context) => {
    const token_id = req.getUrl().slice(1);
    // URL to np. "/987654321" → slice(1) usuwa wiodący '/' → "987654321"

    if (!have_token(token_id)) {
        res.writeStatus('401 Unauthorized').end();
        // Klient dostaje HTTP 401 Unauthorized.
        // WebSocket NIE jest otwierany — nie ma żadnego obiektu po stronie serwera.
        return;
    }

    res.upgrade(
        { token_id: token_id },
        // Dane przekazywane do getUserData() w open/message/close.
        // To jedyne miejsce gdzie możemy dołączyć dane do połączenia.
        req.getHeader('sec-websocket-key'),
        req.getHeader('sec-websocket-protocol'),
        req.getHeader('sec-websocket-extensions'),
        context
        // Te 4 nagłówki są wymagane przez protokół WebSocket (RFC 6455) do handshake.
    );
}
```

### `open()` — inicjalizacja gracza

```javascript
open: (ws) => {
    const data     = ws.getUserData();    // pobierz dane ustawione w upgrade()
    const token_id = data.token_id;       // "987654321"

    if (ranking.length < 6) send_ranking = true;
    // Nowy gracz zmienia liczebność rankingu → wszystkim wyślij zaktualizowany top 6.

    const id = free_ids.pop();
    // Pobierz wolne ID z puli LIFO (stos). free_ids jest zapełniany przy starcie od 254 do 0,
    // więc pop() daje najpierw 0, potem 1, potem 2... aż zostaną zwrócone przez close().

    players[id] = new player(id, ws, tokens[token_id]);
    players[id].skin_id = tokens[token_id].skin_id;

    // ZNISZCZ TOKEN — jednorazowość:
    tokens[token_id] = null;
    delete tokens[token_id];
    // Null + delete = podwójne zabezpieczenie.
    // Samo null: have_token() sprawdza czy wartość jest truthy → null = falsy → odrzuci.
    // Delete: usuwa klucz z obiektu → jeszcze bezpieczniej, brak "widma" w tokens{}.

    data.player = players[id];   // przypisz gracza do danych socketu
    player_length++;             // liczymy tylko ludzi, nie boty

    if (shutdown_timer) {
        clearTimeout(shutdown_timer);  // gracz wrócił przed upłynięciem timera zamknięcia
        shutdown_timer = null;
        // Scenariusz: ostatni gracz wychodzi → serwer startuje timer 10s → nowy gracz dołącza
        // → anulujemy timer → serwer nie zamknie się w środku nowej sesji.
    }

    if (player_length === 1 && !is_allocated) {
        is_allocated = true;
        if (USE_AGONES) agonesSDK.allocate().catch(console.log);
        // Pierwszy gracz → przejście Ready → Allocated.
        // Bez allocate() autoskaler mógłby usunąć pod z aktywnym graczem.
        // !is_allocated guard: nie wywołujemy allocate() drugi raz (idempotentne, ale zbędne).
    }

    add_player_seg(players[id], 0);  // gracz startuje na segmencie 0

    // Pakiet powitalny: trzy typy sklejone w jednym ws.send
    p.new_type(3);  // własne ID + pełna lista graczy
    p.s_uint8(id);  // "twoje ID to X"
    p.s_length8(Object.keys(players).length);
    for (const i in players) {
        p.s_uint8(pl.id);        // ID każdego gracza (ludzki + boty)
        p.s_string16(pl.name);   // nick
        p.s_uint8(pl.skin_id);   // skin
    }

    p.new_type(7);  // lista aktualnie martwych graczy
    // Klient musi wiedzieć kto jest martwy żeby nie renderować ich avatarów.

    p.new_type(9);  // top 6 rankingu
    ws.send(Buffer.from(p.get_buf()), true);
    // true = tryb binarny (nie UTF-8 tekst). Bez true: uWS wyśle dane jako string → błędne bajty.

    p.new_type(4);  // dane mapy: 10 poziomów × 128 bajtów = 1280B
    ws.send(Buffer.from(p.get_buf()), true);
    // Osobny ws.send bo mapa jest duża. Nie mieszamy z pakietem powitalnym.

    joined_players.push(players[id]);
    // W następnym ticku gen_packet() wyśle pakiet typ 1 do INNYCH graczy:
    // "pojawił się nowy gracz o ID=X, imieniu Y, skinie Z".

    data.pg = new packet_get();
    // Parser pakietów przychodzących. KAŻDE połączenie ma własną instancję
    // bo packet_get jest stanowe — przechowuje wewnętrzny offset odczytu.
    // Gdyby była globalna: gracz A ustawia offset=5, serwer odbiera wiadomość od B,
    // B resetuje offset=0 → A czyta od złego miejsca → błędne dane.
}
```

### `message()` — typy pakietów od klienta

```javascript
message: (ws, message, isBinary) => {
    const data = ws.getUserData();
    const pl   = data.player;
    if (!pl) return;
    // Guard: wiadomość może dotrzeć zanim open() skończyło działać (race condition).
    // Bez tego: data.player = null → TypeError przy dostępie do pl.x.

    const p = data.pg.set_buffer(message);
    // set_buffer resetuje wewnętrzny offset do 0 i ustawia bufor na odebraną wiadomość.
    // Każde wywołanie message() to osobna wiadomość — zawsze zaczynamy od początku.

    switch (p.g_uint8()) {
    // g_uint8() czyta pierwszy bajt = typ pakietu, przesuwa offset o 1.
    // switch zamiast if/else: V8 kompiluje do tablicy skoków (O(1)), a nie liniowego sprawdzania.
```

| Typ (byte) | Bajty wiadomości | Akcja serwera |
|---|---|---|
| `0` — ruch | `[0x00][dx: int8]` | `pl.x += dx; pl.x &= 0x3ff; pl.move_x = dx` — natychmiastowe zastosowanie ruchu |
| `1` — czat | `[0x01][len: uint16 BE][tekst: UTF-8]` | `pl.chat = text; chat_players.uniq_push(pl)` — wyślij w następnym ticku |
| `2` — event | `[0x02]` — brak danych | `pl.event--; pl.event_use = -1` — guard: `pl.event > 0 && pl.event_use !== -1` |
| `8` — respawn | `[0x08][ads: int8][skin_id: uint8]` | Reset gracza, teleport do checkpointu, opcjonalny bonus 2500 pkt za reklamę |

**Przykład: ruch (typ 0)**

```
Bajty od klienta: [0x00] [0xF4]
0x00 = typ 0
0xF4 = 244 jako uint8, ale czytany jako int8 = -12
       (int8: wartości 128–255 to ujemne: 256 - 244 = 12 → -12)
→ gracz poruszył się 12 jednostek w lewo
→ pl.x += -12; pl.x &= 0x3ff
```

**Przykład: respawn (typ 8)**

```
Bajty: [0x08] [0x01] [0x05]
0x08 = typ 8 (respawn)
0x01 = ads=1 (oglądał reklamę → dostanie bonus 2500 punktów startowych)
0x05 = skin_id=5 (zmienił skin w ekranie śmierci)
```

### `close()` — cleanup przy rozłączeniu

Wywoływany przy każdym zamknięciu WebSocket — normalnym (gracz wyszedł), nieoczekiwanym (internet padł), timeout. Kod traktuje wszystkie przypadki identycznie.

```javascript
close: (ws, code, message) => {
    // code: kod zamknięcia WebSocket — 1000=normalne, 1006=zerwane połączenie itp.
    // Nie używamy go — cleanup działa tak samo niezależnie od przyczyny.
    const pl = data.player;
    if (!pl) return;  // rozłączenie przed zakończeniem open() — nic do sprzątania

    player_length--;

    // Zapisz punkty zarobione od ostatniego zapisu:
    save_player_money(pl, pl.points - pl.account_points);
    // pl.account_points = ile miał przy dołączeniu (np. 5000)
    // pl.points = stan teraz (np. 8500)
    // Różnica 3500 = przyrost tej sesji

    // Usuń z rankingu i przesuń graczy poniżej o jedną pozycję w górę:
    for (let y = pl.ranking_id + 1; y < ranking.length; y++) ranking[y].ranking_id--;
    ranking.splice(pl.ranking_id, 1);
    // Bez aktualizacji ranking_id: po splice() tablica jest krótka o 1 element,
    // ale obiekty graczy mają stare ranking_id → niezgodność index/wartość.

    remove_players.push(pl.id);       // inni gracze dowiedzą się w następnym ticku
    rmv_player_seg(pl, pl.lvl);       // usuń z mapy kolizji

    free_ids.push(pl.id);             // ID wraca do puli — może użyć nowy gracz
    delete players[pl.id];            // usuń z głównej mapy
    data.player = null;               // brak referencji → GC może zwolnić pamięć gracza

    // Serwer opustoszał:
    if (player_length === 0 && is_allocated) {
        is_allocated = false;
        redis_update_player_count();  // natychmiast zaktualizuj "0 graczy" w Redis
        if (USE_AGONES) agonesSDK.ready().catch(console.error);
        // Allocated → Ready.
        // Autoskaler może teraz:
        // (a) usunąć pod jeśli jest zbyt wiele pustych serwerów (skalowanie w dół)
        // (b) przydzielić nową sesję gry bez tworzenia nowego poda (szybsze)
    }
}
```

---

## 9. Protokół binarny — typy pakietów

Serwer produkuje pakiety co 16ms dla każdego gracza z osobna. Bufor `p = new packet_set(5000)` jest współdzielony i reużywany — nie alokujemy 5KB pamięci co tick.

Pakiet składa się z dwóch części które są ze sobą sklejane:
- **Część globalna** (`p.end_global()`): zdarzenia wspólne dla wszystkich — join, leave, kill, chat, ranking.
- **Część per-player** (`p.get_uniq_buf()`): pozycje graczy widocznych przez ten konkretny pryzmat widzenia i indywidualne dane tego gracza.

### Pakiety wychodzące (serwer → klient)

| Typ | Kiedy wysyłany | Zawartość |
|---|---|---|
| `1` | co tick, gdy `joined_players.length > 0` | Gracze którzy dołączyli w tym ticku: ID, imię (string16), skin |
| `2` | co tick, gdy `remove_players.length > 0` | ID graczy którzy wyszli w tym ticku |
| `3` | raz, do nowego gracza w `open()` | Własne ID nowego gracza + pełna lista wszystkich: ID/imię/skin |
| `4` | w `open()` i gdy `pl.lvl > pl.send_lvl - 5` | 10 kolejnych poziomów mapy: 10 × `Uint8Array[128]` = 1280B |
| `5` | gdy gracz zginie | ID zabitych graczy w tym ticku |
| `6` | przy respawnie | ID odżywionych graczy w tym ticku |
| `7` | raz, do nowego gracza w `open()` | ID aktualnie martwych graczy (żeby nie renderować ich avatarów) |
| `8` | przy checkpoincie, kill, event | Zdarzenia gameplayowe — szczegóły w kodzie gen_packet() |
| `9` | gdy `send_ranking === true` | Top 6: ID + skompresowane punkty (`byte_point`) |
| `10` | gdy `pl.send_rank_pos === true` | Własna pozycja w rankingu dla danego gracza |
| `11` | gdy `pl.event_send === true` | Aktualna wartość `event` (żyć/energii) dla danego gracza |
| `12` | po śmierci, gdy `pl.send_points > 0` | Nagroda punktowa — ile monet trafia na konto |
| `13` | gdy `players_cheange_skin.length > 0` | ID i nowy skin graczy którzy zmienili wygląd |

Dlaczego tyle osobnych typów zamiast jednego dużego? Separacja odpowiedzialności. Klient wie co robić z każdym typem niezależnie od pozostałych. Typ 3 może być wysłany tylko raz przy dołączeniu i nie koliduje z typem 1 wysyłanym co tick. Parsowanie jest prostsze — klient czyta bajt typu i wywołuje odpowiedni handler.

### Backpressure — ochrona przed wolnymi klientami

Jeśli klient ma słabe łącze lub wolny komputer, pakiety zaczynają się piętrzyć w buforze wysyłki. Bez kontroli: bufor rośnie bez ograniczeń, pamięć serwera się wyczerpuje, serwer crashuje. Z kontrolą: pomijamy tick dla wolnego klienta zamiast gromadzić dane.

```javascript
// W gen_packet(), dla każdego gracza:
if (pl.socket.getBufferedAmount() < 256 * 1024) {
    pl.socket.send(p.get_uniq_buf(), true);
    // Bufor poniżej 256KB → wysyłaj normalnie
} else {
    p.clear_uniq_buf();
    // Bufor powyżej 256KB → klient jest zbyt wolny → pomiń ten tick dla niego.
    // Klient straci aktualizację pozycji, ale NIE zostanie rozłączony.
    // Gdy bufor się opróżni, wróci do normalnego działania.
}
// maxBackpressure: 1024 * 1024 (1MB) → gdy bufor przekroczy 1MB,
// uWS automatycznie rozłącza klienta (twardy limit).
// Nasze 256KB to "miękki limit" — reagujemy wcześniej.
```

### Pakiety przychodzące (klient → serwer)

| Typ (byte) | Struktura binarna | Walidacja i uwagi |
|---|---|---|
| `0` — ruch | `[0x00][dx: int8]` | Brak walidacji zakresu — każda wartość int8 akceptowana |
| `1` — czat | `[0x01][len: uint16 big-endian][tekst: UTF-8]` | `uniq_push` zapobiega duplikatom jeśli gracz wyśle 2 wiadomości w jednym ticku |
| `2` — event | `[0x02]` (brak danych) | Guard: `pl.event > 0 && pl.event_use !== -1` chroni przed exploitem |
| `8` — respawn | `[0x08][ads: int8][skin_id: uint8]` | Guard: `pl.is_dead === true` — nie można respawnować żywego gracza |

---

## 10. Główna pętla gry

Serce całego serwera. `setInterval(fn, 16)` wywołuje funkcję co 16ms — jeden krok symulacji gry, zwany "tickiem". Kolejność kroków w każdym ticku jest ściśle określona: najpierw AI, potem fizyka, na końcu pakiety. Zmiana kolejności powoduje błędy (np. wysyłanie pakietów ze starymi pozycjami zanim fizyka je zaktualizuje).

```javascript
game_loop_interval = setInterval(function () {

    // ── KROK 1: licznik ticków ─────────────────────────────────────────
    frame++;
    // frame = globalny zegar gry. Cały timing oparty na frame % N zamiast Date.now().
    // Dlaczego? Date.now() to syscall — wolniejszy niż inkrementacja zmiennej.
    // Przy 62.5 wywołaniach na sekundę przez wiele godzin różnica jest mierzalna.
    // frame jest Number (float64) → max bezpieczna precyzja = 2^53.
    // Przy 62.5 tick/s: przepełnienie po ~4.5 miliarda lat. Bezpieczne.

    // ── KROK 2: czyszczenie wygasłych tokenów (co ~160s) ───────────────
    if (!(frame % 10000)) {
        // !(x % 10000): true gdy x jest wielokrotnością 10000, czyli co 10000 ticków.
        // 10000 × 16ms = 160 sekund między czyszczeniami.
        // Dlaczego nie co tick? Iteracja po tokens{} jest O(k) gdzie k=liczba tokenów.
        // Tokeny nie muszą wygasać co do milisekundy — co 2–3 minuty wystarczy.
        for (const i in tokens) {
            if (tokens[i] && tokens[i].timelive < frame) {
                tokens[i] = null; delete tokens[i];
                // Token ważny przez 10000 ticków od utworzenia.
                // Gracz nie połączył się w ciągu 160 sekund → usuń token.
            }
        }
    }

    // ── KROK 3: AI botów ─────────────────────────────────────────────
    for (let i = bots.length; i--;) {
        const b = bots[i];
        if (b.move === 1 && b.time > 0) {
            b.player.x -= (Math.random() * 4) | 0;  // 0–3 j w lewo
        } else if (b.move === 2 && b.time > 0) {
            b.player.x += (Math.random() * 4) | 0;  // 0–3 j w prawo
        } else if (b.time < 0) {
            b.time = (Math.random() * 100) | 0;  // nowy czas: 0–99 ticków (0–1.6s)
            b.move = (Math.random() * 3)   | 0;  // nowy kierunek: 0/1/2
        }
        b.player.x &= 0x3ff;  // wrap cylindra
        b.time--;
    }
    // Boty PRZED graczami — jeśli bot poruszy się na gracza, kolizja w kroku 4 to obsłuży.

    // ── KROK 4: fizyka graczy ─────────────────────────────────────────
    for (const i in players) {
        const pl = players[i];
        if (!pl.is_dead) pl.move();
        // Martwi gracze (is_dead=true) nie mają fizyki — czekają na respawn.
        // Boty też są w players{} — move() obsługuje ich fizykę identycznie jak graczy.
    }

    // ── KROK 5: pakiety ──────────────────────────────────────────────
    gen_packet();
    // Przetwarza kolejki zdarzeń (joined_players, remove_players, killed_players itp.)
    // Buduje pakiet per-gracz i wysyła przez ws.send.

    // ── KROK 6: Redis heartbeat ──────────────────────────────────────
    if (frame % 60 === 0) redis_update_player_count();
    // 60 × 16ms = 960ms ≈ 1 sekunda między heartbeatami.

}, 16);
```

**Timing zdarzeń cyklicznych:**

| Zdarzenie | Co ile ticków | Co ile ms | Uwagi |
|---|---|---|---|
| Fizyka + pakiety | 1 | 16ms | Każdy tick bez wyjątku |
| Redis heartbeat | 60 | 960ms | Aktualizuje `g_players_len` i odnawia TTL |
| Czyszczenie tokenów | 10 000 | 160 000ms (~2.7 min) | Usuwa nieużyte tokeny dołączenia |

---

## 11. Bot AI

Boty to gracze z `bot !== null` i `socket = null`. Mają identyczną fizykę jak ludzie — grawitacja, kolizje z kafelkami, kolizje z graczami działają tak samo. Jedyna różnica to brak wysyłania/odbierania pakietów i brak zapisu do MongoDB.

Dlaczego boty są potrzebne? Gra wieloosobowa jest nudna na pustym serwerze. Pierwszy gracz który dołącza na zupełnie pusty serwer widziałby tylko siebie — małe szanse że zostanie. 37 botów zapewnia że zawsze jest z kim grać od momentu startu serwera.

**Automat stanów bota:**

```
Każdy bot ma:
  b.move:  kierunek (0=stój, 1=lewo, 2=prawo)
  b.time:  countdown do zmiany zachowania; maleje o 1 co tick

Przejścia:
  b.time < 0 → wylosuj nowe b.time (0–99) i b.move (0/1/2) → zacznij nowe zachowanie
  b.time >= 0 → kontynuuj bieżące zachowanie, b.time--

Przykładowa sekwencja bota:
  tick 0:   b.time=-1 (startup) → nowe: b.time=73, b.move=2 (prawo)
  tick 1:   b.player.x += 2 (losowe 0-3), b.time=72
  tick 2:   b.player.x += 0, b.time=71
  ...
  tick 73:  b.player.x += 3, b.time=0
  tick 74:  b.time=0-1=-1... właściwie: b.time-- → b.time=-1 → nowe zachowanie
  tick 75:  nowe: b.time=12, b.move=0 (stój)
  tick 76-87: x bez zmian, b.time maleje 12→0
  tick 88:  b.time=-1 → nowe: b.time=45, b.move=1 (lewo)
```

Ruch bota co tick: `(Math.random() * 4) | 0` → 0, 1, 2 lub 3 jednostki (nigdy 4, bo `[0,4)` i `| 0` obcina). Ruch nieregularny — boty nie poruszają się w jednym tempie, co wygląda naturalniej.

---

## 12. Obsługa SIGTERM

Kubernetes wysyła SIGTERM przed zabiciem poda — to grzeczna prośba o zakończenie. Pod ma `terminationGracePeriodSeconds: 15` — 15 sekund na sprzątanie zanim K8s wyśle SIGKILL (natychmiastowe zabicie). Te 15 sekund musimy wykorzystać na usunięcie serwera z lobby.

```javascript
process.on('SIGTERM', () => {

    is_shutting_down = true;
    // OBOWIĄZKOWE jako pierwsze — dlaczego?
    // redis_update_player_count() wywołuje się co ~1s w pętli gry.
    // Bez flagi: cleanup usuwa klucz 'game:3482901234', ale już 960ms później
    // redis_update_player_count() by go odtworzyła przez hSet!
    // Serwer byłby widoczny w lobby jeszcze przez 5 sekund po "skasowaniu".
    // is_shutting_down = true blokuje redis_update_player_count().

    redis_cleanup()
        .then(() => setTimeout(() => process.exit(0), 1000))
        // Dlaczego setTimeout 1000ms zamiast natychmiastowego process.exit?
        // Redis publish('lobby_update', '1') jest asynchroniczny — wiadomość idzie przez sieć.
        // Bez czekania: process.exit() może się wykonać ZANIM wiadomość dotrze do Mother.
        // Mother nie wiedziałaby o znikaniu serwera i pokazywałaby go w lobby przez kilka sekund.
        // 1 sekunda = wielokrotny zapas na sieciowe opóźnienie Redis (typowo 1–5ms).
        .catch(console.error);
});
```

**Timeline całego SIGTERM:**

```
t=0ms:    K8s wysyła SIGTERM
t=0ms:    is_shutting_down = true
t=0ms:    redis_cleanup() startuje asynchronicznie
t=1–5ms:  del('game:3482901234') — klucz natychmiast znika
t=2–8ms:  sRem('game_ids', '3482901234') — ID usuwa się ze setu
t=3–10ms: publish('lobby_update', '1') — Mother odbiera, odświeża UI
t=10ms:   redis_cleanup() resolve → setTimeout(exit, 1000) zarejestrowane
t=1010ms: process.exit(0) — zakończenie procesu
t=1010ms: Node.js cleanup: clearInterval (pętla gry), zamknięcie połączeń uWS
```

Cały proces trwa ~1 sekundę, co mieści się w 15-sekundowym oknie K8s.

---

## 13. TL Redis

Mechanizm automatycznego usuwania z lobby serwera który padł niespodziewanie — crash (np. błąd pamięci), SIGKILL, restart węzła K8s bez SIGTERM.

Idea jest prosta: klucz w Redis ma ustawiony czas życia (TTL = 5 sekund). Dopóki serwer żyje, co sekundę odnawia ten czas. Gdy serwer pada, odnowienie przestaje przychodzić i po 5 sekundach Redis sam usuwa klucz.

```
Normalny heartbeat (serwer żyje):
  t=0s:    expire('game:3482901234', 5)  ← odnów TTL do t+5s
  t=0.96s: expire(...)                   ← odnów (TTL znowu 5s od teraz)
  t=1.92s: expire(...)
  ...
  TTL nigdy nie dobiega do 0.

Crash serwera:
  t=0s:    crash (OOM, segfault, kill -9)
  t=0s:    pętla gry zatrzymana — brak kolejnych expire()
  t=5s:    Redis automatycznie usuwa klucz (TTL wygasł)
  t=5–10s: Lobby przy następnym odświeżeniu:
             sMembers('game_ids') → ['3482901234', ...]  ← ID nadal w secie!
             hGetAll('game:3482901234') → {}              ← klucz wygasł → pusty obiekt
             if (!data || !data.g_port) continue          ← lobby pomija serwer

  Wynik: serwer znika z UI lobby w ciągu 5–15 sekund od crashu.
```

Dlaczego TTL = 5 sekund a nie 1 sekunda? Heartbeat co ~960ms (60 ticków × 16ms). TTL 5s to bufor 5× — jeśli jeden lub dwa heartbeaty się spóźnią (chwilowa niedostępność Redis, duże obciążenie serwera), klucz nie wygaśnie przedwcześnie.

**Znane ograniczenie:** Wpis w `game_ids` SET nie ma TTL. Przy SIGKILL lub crashu bez SIGTERM `sRem` nie zostaje wywołane — martwe ID pozostaje w secie do restartu Redis lub do następnego graceful shutdown. To nie jest błąd krytyczny: lobby wykonuje `hGetAll` i dostaje `{}` → skip. Zbędna operacja Redis, ale bez konsekwencji dla graczy.

---

## 14. Konfiguracja 

### Docker

```dockerfile
FROM node:20-bullseye-slim
WORKDIR /app

RUN apt-get update && apt-get install -y git
# git jest wymagany przez npm podczas instalacji uWebSockets.js z GitHub.
# uWS nie jest w rejestrze npm — npm clone-uje repozytorium przez git.
# Bez git: npm install kończy się błędem "git: command not found".

COPY apps/child-gameserver/package.json .
RUN npm install
RUN npm install @google-cloud/agones-sdk
RUN npm install redis

COPY apps/shared/ shared/
# Kopiowanie do /app/shared/ — z tej ścieżki main.js importuje binary.js.
# Ścieżka './shared/binary.js' działa w Dockerze, '../shared/binary.js' lokalnie.
# Mechanizm wykrywania w kodzie:
#   const bin = require(fs.existsSync('./shared/binary.js')
#       ? './shared/binary.js'    // Docker
#       : '../shared/binary.js'); // lokalnie

COPY apps/child-gameserver/main.js .
EXPOSE 5000
CMD ["node", "main.js"]
```

### Agones Fleet (K8s)

```yaml
# gitops/base/prz-agones.yaml
spec:
  replicas: 2  # minimum 2 serwery w stanie Ready — żeby lobby zawsze miało gdzie wysłać gracza
  template:
    spec:
      ports:
      - name: default
        containerPort: 5000   # port wewnętrzny poda — uWS nasłuchuje tutaj
        protocol: TCP
        # Agones przydziela ZEWNĘTRZNY port NodePort z puli 7000–8000.
        # Ten zewnętrzny port jest zapisywany do Redis jako g_port.
        # Klienci łączą się: ws://IP_WĘZŁA:PORT_ZEWNĘTRZNY/<TOKEN>
      template:
        spec:
          restartPolicy: Never
          # Pod NIE restartuje się po zakończeniu — Agones zarządza cyklem życia.
          # Normalny K8s restart = strata stanu gry. Agones zamiast tego tworzy nowy pod.
          terminationGracePeriodSeconds: 15
          # K8s czeka 15s po SIGTERM zanim wyśle SIGKILL.
          # Nasz cleanup (redis_cleanup + setTimeout 1s) trwa ~1s — 14s zapasu.
          containers:
          - name: child
            env:
            - name: REDIS_URL
              value: "redis://redis:6379"
              # 'redis' to nazwa K8s Service dla Redis (z prz-redis.yaml).
              # Wewnątrz klastra serwisy są rozwiązywalne po nazwie przez DNS.
            - name: MONGO_URL
              valueFrom:
                secretKeyRef:
                  name: cosmos-db-secret
                  key: MONGO_URL
              # Hasło CosmosDB nie jest w repozytorium — K8s Secret.
              # secretKeyRef: zamiast hardcode = bezpieczeństwo.
            - name: USE_AGONES
              value: "true"
```

---

## 15. Przykłady

### Lokalne uruchomienie (bez K8s)

```bash
# Upewnij się że Redis i MongoDB działają lokalnie:
# redis-server (osobny terminal)
# mongod --dbpath ./data/db (osobny terminal)

node main.js 5001
# argv[2] = "5001" → SERVER_PORT = 5001
# USE_AGONES = undefined ≠ 'true' → IS_LOCAL = true, Agones pomijane
# AGONES_IP = 'localhost', AGONES_PORT = 5001
# Serwer rejestruje się w Redis: hSet('game:XXXXX', {g_port:"5001", serv_ip:"localhost", ...})
```

Gracz łączy się przez `ws://localhost:5001/<TOKEN>`.
```

### Flow: dołączenie gracza (end-to-end)

Cały przepływ od kliknięcia "Dołącz" w lobby do aktywnej gry:

```
1. MOTHER (lobby) — gracz kliknie "Dołącz":
   redis.publish('join:3482901234', JSON.stringify({
       token:   987654321,      // losowy uint32 — jednorazowy bilet wstępu
       name:    "Kacper",
       skin_id: 3,
       account: "507f1f77bcf86cd799439011"  // lub '' dla gości
   }))

2. CHILD (redis_sub callback, ~1–5ms opóźnienia Redis):
   tokens[987654321] = {
       name:     "Kacper",
       skin_id:  3,
       account:  "507f1f77bcf86cd799439011",
       timelive: frame + 10000  // ważny przez 160 sekund
   }

3. MOTHER — wysyła klientowi przez WebSocket:
   [typ 0: token=987654321, port=30542, ip="34.89.123.45"]
   // 50ms setTimeout w Mother — bufor na latencję Redis + przetworzenie przez Child

4. KLIENT — otwiera WebSocket:
   new WebSocket('ws://34.89.123.45:30542/987654321')
   // HTTP GET /987654321 HTTP/1.1 + Upgrade: websocket

5. CHILD — upgrade():
   have_token("987654321") → tokens["987654321"] jest truthy → akceptuj
   res.upgrade({token_id: "987654321"}, ...)

6. CHILD — open():
   id = free_ids.pop() = np. 42
   players[42] = new player(42, ws, tokens["987654321"])
   tokens["987654321"] = null; delete tokens["987654321"]  // zużyty — jednorazowy
   player_length++  (np. 1 → pierwszy gracz)
   agonesSDK.allocate()  → Ready → Allocated
   ws.send([typ3: id=42, lista graczy] + [typ7: martwi] + [typ9: ranking])
   ws.send([typ4: 10 poziomów mapy])
   joined_players.push(players[42])

7. Następny tick pętli gry — gen_packet():
   Wysyła do WSZYSTKICH innych graczy:
   [typ1: count=1, id=42, name="Kacper", skin=3]
   → klienty innych graczy renderują nowego awatara
```

### Flow: respawn po śmierci

```
1. Gracz ginie (kolizja z czerwonym kafelkiem przy event=0):
   pl.is_dead = true
   killed_players.push(pl.id)
   → inni gracze dostają pakiet typ5: "gracz 42 umarł" → ukrywają avatar

2. Gracz widzi ekran śmierci, klika "Zagraj ponownie" (z reklamą):
   Klient → serwer: [0x08][0x01][0x05]
   //               typ8  ads=1  skin=5

3. CHILD — case 8 w message():
   guard: pl.is_dead === true ✓ (bez tego exploiter mógłby resetować pozycję żywego gracza)

   pl.is_dead = false
   respawned_players.push(pl.id)
   → inni gracze dostają pakiet typ6: "gracz 42 ożył" → renderują avatar z powrotem

   pl.x = random_pos()   // bezpieczna pozycja, nie nad dziurą w checkpoincie
   pl.y = -(0² × 10 × 16) × 8 + 30 = 30
   // respawn_lvl=0 (gracz nie przeszedł żadnego checkpointu) → y=30, tuż nad startem
   // Gdyby respawn_lvl=2: y = -(4×10×16)×8+30 = -5090 → wysoko, długi lot = kara

   if (pl.skin_id !== 5):  // zmienił skin
       players_cheange_skin.push(pl)   → inni dostaną pakiet typ13
       pl.skin_id = 5

   // Reset rankingu na koniec (0 punktów → ostatnie miejsce):
   for (y = pl.ranking_id+1; y < ranking.length; y++) ranking[y].ranking_id--
   ranking.splice(pl.ranking_id, 1)
   pl.ranking_id = ranking.push(pl) - 1

   pl.points = 2500            // bonus za reklamę (ads===true sprawdza int8 jako boolean)
   pl.add_points(saved_points + kill_points)
   // Odzyska punkty z ostatniego checkpointu + zabójstwa (trwałe)
   // Przykład: saved=1000, kill=500 → add_points(1500) → pl.points = 4000

   pl.lvl = 0; pl.jump_frame = 0; pl.event_use = -2
   add_player_seg(pl, 0)      // z powrotem do segmentu 0
```

### Zapis punktów przy rozłączeniu

```javascript
// Scenariusz: gracz miał 5000 punktów przy dołączeniu, zarobił 3500 w sesji

// W open() (przy połączeniu):
players[42].account_points = 0;  // nowe pole, do zaktualizowania gdy pobierzemy z DB
// (aktualnie account_points=0 zawsze przy starcie — nie pobieramy z MongoDB przy dołączeniu)

// W close() (przy rozłączeniu):
save_player_money(pl, pl.points - pl.account_points);
save_player_money(pl, 3500 - 0);  // zapisz 3500 jako przyrost sesji

// W MongoDB:
// Przed: { _id: ObjectId("507f..."), points: 5000, total_points: 12000 }
// Po:    { _id: ObjectId("507f..."), points: 8500, total_points: 15500 }
// $inc: { points: +3500, total_points: +3500 }
```

 
