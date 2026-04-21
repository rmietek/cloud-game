# Mother Server — Serwer Lobby

## 1. Cel i architektura

Mother to serwer lobby — punkt wejścia dla każdego gracza. Odpowiada za logowanie i rejestrację kont, pokazanie listy dostępnych serwerów gry oraz przekazanie gracza do wybranego serwera. Działa jako Deployment Kubernetes z automatycznym skalowaniem od 1 do 10 replik (HPA). Wystawia dwa interfejsy sieciowe: serwer HTTP Express na porcie 9876 obsługujący REST API (logowanie, rejestracja, zakup skinów) i serwowanie plików statycznych gry, oraz serwer WebSocket oparty na uWebSockets.js na porcie 3001 obsługujący lobby w czasie rzeczywistym — odpowiada za wysyłanie listy dostępnych serwerów, obsługę dołączania gracza do wybranego serwera oraz aktualizacje liczby graczy na serwerach w czasie rzeczywistym.

### Miejsce w systemie

```
Klient (przeglądarka)
  ├─ HTTP  :9876  → Express
  │                  ├─ POST /auth/register  — rejestracja konta
  │                  ├─ POST /auth/login     — logowanie
  │                  └─ GET  /              — pliki statyczne gry (HTML, JS, obrazki)
  │
  └─ WS    :3001  → uWS ClientManager
                     ├─ lista serwerów gry (typ 2)
                     ├─ dołączanie do gry (typ 0)
                     ├─ dane konta gracza (typ 1)
                     └─ zakup skinów, zmiana nicku, reconnect

Mother łączy się z:
  ├─ MongoDB  → konta graczy, punkty, skiny (kolekcja 'users')
  ├─ Redis    → lista aktywnych serwerów gry, tokeny dołączenia
  └─ shared/binary.js → wspólna biblioteka binarnego protokołu pakietów
```

### Struktura kodu (`apps/mother-lobby/main.js`)

```
main.js
  │
  ├─ Konfiguracja i stałe
  │    ├─ CONFIG                — porty, URL baz danych, rundy szyfrowania bcrypt
  │    ├─ SKIN_COSTS[23]        — ceny skinów (0–800 000 punktów)
  │    ├─ SKIN_LIGHTS[23]       — kolory świateł skinów (RGB hex)
  │    └─ gen_id()              — generuje losowy token uint32 (używany przy join)
  │
  ├─ Inicjalizacja połączeń
  │    ├─ connectDatabase()     — łączy z MongoDB
  │    └─ connectRedis()        — dwa klienty: redis (zapis/odczyt) + redisSub (nasłuchiwanie)
  │
  ├─ Budowanie pakietów
  │    ├─ buildGamesPacket()    — czyta listę serwerów z Redis → pakiet binarny typ 2
  │    └─ send_account()        — wysyła dane konta gracza przez WS → pakiet binarny typ 1
  │
  ├─ setupExpressApp()          — serwer HTTP: rejestracja, logowanie, pliki statyczne
  │
  └─ ClientManager(port)        — serwer WebSocket lobby (port 3001)
       ├─ handleJoinGame()      — gracz dołącza do serwera gry (typ pakietu 0)
       ├─ handleFetchAccount()  — pobierz dane konta po zalogowaniu (typ pakietu 1)
       ├─ handleBuySkin()       — zakup skina za punkty (typ pakietu 2)
       ├─ handleChangeName()    — zmiana nicku gracza (typ pakietu 3)
       └─ handleReconnect()     — odświeżenie danych po zerwaniu połączenia WS (typ pakietu 5)
```

---

## 2. Konfiguracja

Wszystkie stałe konfiguracyjne zebrane są w jednym obiekcie `CONFIG`. Adresy baz danych pobierane są ze zmiennych środowiskowych — w środowisku lokalnym używane są wartości domyślne wskazujące na `localhost`.

```javascript
const CONFIG = {
    HTTP_PORT:     9876,   // port serwera Express — logowanie, rejestracja, pliki statyczne
    CLIENT_PORT:   3001,   // port serwera WebSocket — lobby graczy
    MONGO_URL:     process.env.MONGO_URL || 'mongodb://localhost:27017',
    REDIS_URL:     process.env.REDIS_URL || 'redis://localhost:6379',
    BCRYPT_ROUNDS: 10,     // koszt hashowania hasła — 2^10 = 1024 iteracje, ~100ms na operację
};
```

| Zmienna | Lokalnie (domyślnie) | W K8s | Opis |
|---|---|---|---|
| `MONGO_URL` | `mongodb://localhost:27017` | z K8s Secret `cosmos-db-secret` | adres bazy MongoDB / CosmosDB |
| `REDIS_URL` | `redis://localhost:6379` | `redis://redis:6379` | adres serwisu Redis |

---

## 3. Sekwencja inicjalizacji

Żeby Mother mogła obsługiwać graczy, muszą działać trzy rzeczy naraz: baza danych (logowanie), Redis (lista gier) i WebSocket (połączenia graczy). Serwer uruchamia je w tej kolejności — następny krok zaczyna się dopiero gdy poprzedni się powiedzie:

```
1. MongoDB  →  bez tego gracz nie może się zalogować ani zarejestrować
2. Redis    →  bez tego nie ma listy gier i nie można dołączyć do rozgrywki
3. HTTP     →  serwuje stronę główną i obsługuje /auth/login, /auth/register
4. WebSocket lobby  →  przyjmuje połączenia graczy (lista gier, dołączanie)
```

```javascript
connectDatabase()        // krok 1: połącz z MongoDB
    .then(connectRedis)  // krok 2: połącz z Redis, zasubskrybuj 'lobby_update'
    .then(function () {
        setupExpressApp();                             // krok 3: uruchom serwer HTTP — logowanie, rejestracja
        c_man = new ClientManager(CONFIG.CLIENT_PORT); // krok 4: uruchom WebSocket
    })
    .catch(function (err) {
        console.error('Startup error:', err);
        process.exit(1);  // błąd na którymkolwiek etapie → Kubernetes restartuje pod
    });
```

Jeśli którykolwiek krok się nie powiedzie (np. brak połączenia z MongoDB), serwer wywołuje `process.exit(1)` — Kubernetes widzi błąd i automatycznie uruchamia pod od nowa. Dzięki temu serwer nigdy nie startuje w niekompletnym stanie.

---

## 4. Specyfikacja API

### `connectDatabase()`

Łączy się z MongoDB i przygotowuje kolekcję `users` do pracy.

Pole `email` w bazie danych pełni obecnie rolę nazwy użytkownika — gracz wpisuje w nie dowolną nazwę, nie musi to być prawdziwy adres email. Nazwa pola jest jednak nieprzypadkowa: w planach jest dodanie weryfikacji konta przez link aktywacyjny wysyłany na email, a to wymaga żeby pole już teraz nazywało się `email`. Gdyby pole nazywało się `username`, późniejsze dodanie tej funkcji wymagałoby przepisania schematu bazy i migracji wszystkich istniejących kont.

Po połączeniu funkcja tworzy unikalny indeks na tym polu — MongoDB dzięki temu automatycznie odrzuci rejestrację jeśli ktoś próbuje założyć konto na już zajętą nazwę. Jeśli indeks już istnieje (serwer był wcześniej uruchomiony), MongoDB go pomija — operację można więc bezpiecznie wywołać przy każdym starcie.

```javascript
// apps/mother-lobby/main.js 
async function connectDatabase() {
    const client = await MongoClient.connect(CONFIG.MONGO_URL);
    db_users = client.db('gra').collection('users');
    await db_users.createIndex({ email: 1 }, { unique: true });
}
```

Po zakończeniu `db_users` wskazuje na kolekcję i jest dostępna globalnie — każde kolejne zapytanie do bazy (logowanie, rejestracja, zakup skina) korzysta z tego samego połączenia.

---

### `connectRedis()`

Redis wymaga dwóch osobnych połączeń, bo klient który wywołał `SUBSCRIBE` może tylko nasłuchiwać — nie może już wysyłać żadnych innych komend. Dlatego Mother tworzy dwa klienty:

- `redis` — do normalnej pracy: pobieranie listy gier, zapis tokenów, odczyt danych serwera
- `redisSub` — tylko do nasłuchiwania kanału `lobby_update`

```javascript
// apps/mother-lobby/main.js 
async function connectRedis() {
    await redis.connect();
    await redisSub.connect();
    await redisSub.subscribe('lobby_update', () => {
        if (c_man) c_man.broadcast_games().catch(console.error);
    });
}
```

Kanał `lobby_update` służy do informowania Mother o zmianach na serwerach gry. Gdy Child dołącza nowego gracza lub ktoś się rozłącza, publikuje sygnał na ten kanał. Mother odbiera go i od razu wysyła przez WebSocket zaktualizowaną listę gier do wszystkich graczy siedzących w lobby.

Warunek `if (c_man)` chroni przed błędem przy starcie serwera: subskrypcja jest aktywna od razu po połączeniu z Redis, ale WebSocket lobby (`c_man`) uruchamia się dopiero chwilę później. Gdyby Child wysłał sygnał dokładnie w tej przerwie, wywołanie `c_man.broadcast_games()` skończyłoby się błędem na `null`. Sprawdzenie `if (c_man)` sprawia że taki sygnał jest po prostu ignorowany.

---

### `buildGamesPacket()`

Buduje binarny pakiet z listą wszystkich aktywnych serwerów gry, który Mother wysyła do klientów w lobby (w przeglądarce). Klient na podstawie tego pakietu rysuje listę serwerów — gracz widzi nazwę serwera, region i ile miejsc wolnych zostało.

Funkcja działa w dwóch krokach:

**Krok 1 — pobierz dane z Redis:**
```
redis.sMembers('game_ids')        → lista ID wszystkich aktywnych serwerów, np. ["3847291650", "1122334455"]
redis.hGetAll('game:3847291650')  → dane jednego serwera: port, IP, liczba graczy, limit, region, nazwa
```
Jeśli między pobraniem listy ID a pobraniem danych serwer zniknie z Redis (wygasł TTL), `hGetAll` zwróci pusty obiekt. Warunek `if (g && g.g_port)` pomija takie serwery — do pakietu trafiają tylko te które naprawdę działają.

**Krok 2 — zbuduj pakiet binarny:**

```javascript
// apps/mother-lobby/main.js 
async function buildGamesPacket() {
    const ids   = await redis.sMembers('game_ids');
    const games = [];
    for (const id of ids) {
        const g = await redis.hGetAll(`game:${id}`);
        if (g && g.g_port) games.push({ id: parseInt(id), ...g });
    }
    const lps = new packet_set(1000);  // lokalny bufor, nie globalny ps
    lps.new_type(2);
    lps.s_length8(games.length);
    for (const g of games) {
        lps.s_uint32(g.id);
        lps.s_uint8(parseInt(g.g_players_len) || 0);
        lps.s_uint8(parseInt(g.g_players_lim) || 0);
        lps.s_string(g.serv_loc  || '');
        lps.s_string(g.serv_name || g.serv_loc || 'Server');
    }
    return Buffer.from(lps.get_buf());
}
```

Funkcja tworzy własny lokalny bufor `lps` zamiast korzystać ze współdzielonego globalnego `ps`. Globalny bufor jest używany przez inne operacje (np. `send_account()`) i mógłby zostać nadpisany w trakcie budowania pakietu — `lps` eliminuje ten problem, bo istnieje tylko przez czas trwania jednego wywołania.

**Format pakietu typu 2 (lista serwerów):**

Pakiet zaczyna się nagłówkiem, po którym następuje blok danych dla każdego serwera — powtórzony tyle razy ile jest serwerów:

```
[type: uint8 = 2] [count: uint8]
  dla każdego serwera (count razy):
    [id: uint32]  [players_len: uint8]  [players_lim: uint8] [serv_loc: string]  [serv_name: string]
```

| Pole | Typ | Wartość / przykład |
|---|---|---|
| type | uint8 | `2` — typ pakietu, klient wie że to lista serwerów |
| count | uint8 | liczba serwerów, np. `3` |
| id | uint32 | ID serwera, np. `3847291650` — klient odsyła je przy dołączaniu |
| players_len | uint8 | ilu graczy jest teraz na serwerze, np. `7` |
| players_lim | uint8 | maksymalna liczba graczy, np. `15` |
| serv_loc | string | kod regionu, np. `"EU"` |
| serv_name | string | nazwa wyświetlana w lobby, np. `"EU-Phantom"` |

---

### `send_account(ws, user)`

Wysyła do przeglądarki gracza pakiet z danymi jego konta (typ 1). Klient po odebraniu tego pakietu aktualizuje wyświetlane informacje: nazwę użytkownika, punkty, posiadane skiny. Funkcja jest wywoływana w trzech sytuacjach: po zalogowaniu, po zakupie skina i po zmianie nicku — zawsze gdy dane konta mogły się zmienić.

```javascript
// apps/mother-lobby/main.js 
function send_account(ws, user) {
    ps.new_type(1);
    ps.s_string16(user.email);                            // nazwa użytkownika (login), w przyszlosci będzie to adres e-mail
    ps.s_uint32(user.points);                             // punkty dostępne do wydania w sklepie
    ps.s_uint32(user.total_points);                       // suma wszystkich zarobionych punktów (ranking)
    ps.s_string16(user.name);                             // nick wyświetlany w grze
    ps.s_int8_arr(user.skin, user.skin.length);           // lista ID zakupionych skinów
    ps.s_string_arr(user.acc_data, user.acc_data.length); // dodatkowe dane konta
    ws.send(ps.get_buf(), true);
}
```

**Format pakietu typu 1 (dane konta):**

```
[type: uint8 = 1] [email: string16]  [points: uint32]  [total_points: uint32] [name: string16]   [skin[]: int8[]]  [acc_data[]: string[]]
```

| Pole | Typ | Opis |
|---|---|---|
| type | uint8 | `1` — klient wie że to dane konta |
| email | string16 | nazwa użytkownika (login), string z 2-bajtowy |
| points | uint32 | aktualne punkty — waluta sklepu ze skinami |
| total_points | uint32 | suma wszystkich zarobionych punktów, nigdy nie maleje — używana w rankingu |
| name | string16 | nazwa gracza zapisana na koncie — wyświetlana w panelu konta jako "NAZWA GRACZA" i zmieniana przez handleChangeName(). Nie jest to nick w grze: przy dołączaniu do serwera gracz wpisuje nick osobno w polu tekstowym, i to on jest widoczny innym graczom w rozgrywce. `name` z konta służy wyłącznie do wyświetlania w panelu lobby. |
| skin[] | int8[] | lista ID skinów kupionych przez gracza |
| acc_data[] | string[] | dodatkowe dane konta |

---

### `setupExpressApp()`

Konfiguruje i uruchamia serwer HTTP Express na porcie 9876. Obsługuje rejestrację, logowanie oraz serwowanie plików statycznych gry (HTML, JS, obrazki).

---

#### `POST /auth/register` — rejestracja nowego konta

Przyjmuje nazwę użytkownika i hasło, tworzy nowe konto w MongoDB i zwraca jego ID. Hasło jest hashowane przez bcrypt przed zapisem — nigdy nie jest przechowywane w postaci jawnej.

**Ciało żądania (JSON):**

| Pole | Opis |
|---|---|
| `email` | Nazwa użytkownika — unikalny login. Pole nosi nazwę `email`, ale obecnie pełni rolę zwykłej nazwy użytkownika: gracz może wpisać dowolny ciąg znaków. Nazwa pola jest celowo zachowana z myślą o przyszłej weryfikacji konta przez link aktywacyjny. |
| `password` | Hasło, minimum 4 znaki |

**Odpowiedź przy sukcesie:** `200 { id: "ObjectId" }` — ID konta używane przez klienta do autoryzacji przy dołączaniu do gry.

**Odpowiedź przy błędzie:**

| Kod | Kiedy |
|---|---|
| `400` | Brak nazwy użytkownika lub hasła, albo hasło krótsze niż 4 znaki |
| `409` | Nazwa użytkownika już zajęta (MongoDB duplikat na unikalnym indeksie) |
| `500` | Nieoczekiwany błąd serwera |

Nowe konto otrzymuje domyślne wartości:

```javascript
// apps/mother-lobby/main.js
{
    email,                        // nazwa email/użytkownika podana przy rejestracji
    password_hash: hash,          // bcrypt hash hasła — nigdy plaintext
    points:       10000000,       // 10 000 000 startowych punktów — każdy nowy gracz dostaje je za darmo, żeby mógł od razu wypróbować sklep ze skinami
    total_points: 10000000,       // łącznie zarobione (tyle samo co points na starcie)
    name:         'User' + ((Math.random() * 0xffffff) | 0),  // losowa nazwa konta np. "User8472931"
    last_login:   new Date(),     // data rejestracji
    skin:         [],             // brak zakupionych skinów — skiny 1–5 są darmowe (SKIN_COSTS = 0)
    acc_data:     [],
}
```

#### `POST /auth/login` — logowanie

Weryfikuje dane logowania i zwraca ID konta. Hasło jest porównywane z hashem w bazie przez bcrypt — serwer nigdy nie przechowuje hasła jawnie.

**Ciało żądania (JSON):**

| Pole | Opis |
|---|---|
| `email` | Nazwa użytkownika (login) |
| `password` | Hasło w postaci jawnej — bcrypt.compare() porównuje je z hashem w bazie |

**Odpowiedź przy sukcesie:** `200 { id: "ObjectId" }` — klient zapisuje ID w `localStorage` i używa go przy dołączaniu do gry.

**Odpowiedź przy błędzie:**

| Kod | Kiedy |
|---|---|
| `400` | Brak nazwy użytkownika lub hasła w żądaniu |
| `401` | Nieprawidłowa nazwa użytkownika lub hasło |
| `500` | Nieoczekiwany błąd serwera |

Zarówno dla nieistniejącej nazwy użytkownika jak i złego hasła serwer zwraca ten sam komunikat: `"Nieprawidłowa nazwa użytkownika lub haslo."`. Gdyby komunikaty się różniły, atakujący mógłby sprawdzać które nazwy są zarejestrowane wysyłając kolejne próby — jednolity komunikat to uniemożliwia.

#### `GET /lang` — detekcja kraju gracza *(work in progress)*

Endpoint do wykrywania kraju na podstawie adresu IP. Czyta nagłówek `cf-ipcountry` ustawiany automatycznie przez Cloudflare i zwraca dwuliterowy kod kraju, np. `"PL"` lub `"DE"`.

**Aktualnie nie działa** — infrastruktura nie korzysta z Cloudflare, ruch trafia bezpośrednio na Azure LoadBalancer. Nagłówek `cf-ipcountry` jest nieobecny, więc endpoint zawsze zwraca `undefined`. Zadziała dopiero po postawieniu Cloudflare przed LoadBalancerem jako reverse proxy (ale to w przyszłości).

#### Pliki statyczne

Gdy gracz otwiera przeglądarkę i wchodzi na adres gry, Express serwuje całą aplikację kliencką z katalogu `public/`. Przeglądarka pobiera kolejno HTML, JavaScript, modele 3D, dźwięki i obrazki — wszystko przez ten sam serwer HTTP na porcie 9876.

| Ścieżka URL | Źródło | Co zawiera |
|---|---|---|
| `GET /` | `public/index.html` | Główna strona gry — HTML lobby, cała logika klienta |
| `GET /js/*` | `public/js/` | JavaScript klienta: logika lobby, `binary.js` (protokół binarny), renderer gry |
| `GET /obj/*` | `public/obj/` | Modele 3D postaci i obiektów (`.obj`, `.mtl`) |
| `GET /mp3/*` | `public/mp3/` | Efekty dźwiękowe i muzyka |
| `GET /img/*` | `public/img/` | Tekstury, ikony, elementy interfejsu |
| `GET /site/*` | `public/site/` | Style CSS, fonty |

---

### `ClientManager(port)` — WebSocket Lobby

Konstruktor tworzący serwer WebSocket na podanym porcie.

#### Cykl życia połączenia

Uruchamia serwer WebSocket na porcie 3001 i obsługuje wszystkich graczy przebywających w lobby. Każde połączenie przechodzi przez trzy etapy: otwarcie, wymiana wiadomości, zamknięcie.

```
open(ws)
  ├─ ws.subscribe('lobby')           → dołącz do grupy broadcast
  ├─ buildGamesPacket() → ws.send()  → wyślij listę serwerów [type 2]
  └─ ps.new_type(3) → ws.send()      → wyślij dane skinów [type 3]

message(ws, message)
  └─ switch(type):
      case 0: handleJoinGame(p, ws)      // dołącz do serwera gry
      case 1: handleFetchAccount(p, ws)  // pobierz dane konta
      case 2: handleBuySkin(p, ws)       // kup skin
      case 3: handleChangeName(p, ws)    // zmień nick
      case 4: handleChangeName(p, ws)    // (alias case 3, TODO: osobna logika)
      case 5: handleReconnect(p, ws)     // reconnect po zerwaniu połączenia
      case 6: buildGamesPacket()         // ręczne odświeżenie listy serwerów

close(ws)
  └─ (brak stanu per-klient — uWS automatycznie usuwa z grupy 'lobby')
```

**Otwarcie (`open`)** — gdy przeglądarka gracza nawiązuje połączenie WS:
1. Klient jest zapisywany do grupy broadcast `'lobby'` — dzięki temu `broadcast_games()` może wysłać aktualizację do wszystkich naraz jednym wywołaniem
2. Natychmiast wysyłana jest lista aktywnych serwerów gry (pakiet typ 2) — gracz od razu widzi dostępne serwery
3. Natychmiast wysyłane są dane sklepu ze skinami (pakiet typ 3) — ceny i kolory świateł wszystkich 23 skinów

**Wiadomość (`message`)** — gdy gracz wysyła pakiet przez WebSocket, pierwszy bajt określa typ akcji:

| Typ | Handler | Co robi |
|---|---|---|
| `0` | `handleJoinGame()` | Gracz chce dołączyć do wybranego serwera gry — generuje token i odsyła IP:port |
| `1` | `handleFetchAccount()` | Pobiera dane konta z MongoDB i wysyła pakiet typ 1 (po zalogowaniu) |
| `2` | `handleBuySkin()` | Zakup skina — odejmuje punkty, zapisuje w bazie, odsyła zaktualizowane konto |
| `3` | `handleChangeName()` | Zmiana nazwy konta widocznej w panelu lobby |
| `4` | `handleChangeName()` | Alias dla typu 3 — ta sama logika, zarezerwowane na przyszłość |
| `5` | `handleReconnect()` | Reconnect po zerwaniu połączenia WS podczas gry — odsyła dane konta bez ponownego logowania |
| `6` | `buildGamesPacket()` | Ręczne odświeżenie listy serwerów na żądanie klienta |

**Zamknięcie (`close`)** — gdy gracz opuszcza lobby lub traci połączenie. Serwer nie przechowuje żadnego stanu per-klient w pamięci, więc nie ma nic do sprzątania — uWS automatycznie usuwa klienta z grupy `'lobby'`. 


#### `broadcast_games()` → `Promise<void>`

Wysyła aktualną listę gier do **wszystkich** klientów lobby.

```javascript
// apps/mother-lobby/main.js 
this.broadcast_games = async function () {
    const buf = await buildGamesPacket();
    self.app.publish('lobby', buf, true);
    // Jeden call → uWS wewnętrznie iteruje wszystkich subskrybentów 'lobby'
    // Wydajniejsze niż: for (client of clients) { client.send(buf) }
};
```

---

### `handleJoinGame(p, ws)` — dołączanie do gry

Obsługuje żądanie gracza dołączenia do wybranego serwera gry. W wyniku tej funkcji klient otrzymuje jednorazowy token oraz adres IP i port serwera gry, z którym może się bezpośrednio połączyć.

**Pakiet wejściowy od klienta [przegladarki] (typ 0):**

| Pole | Typ | Opis |
|---|---|---|
| gameId | uint32 | ID serwera gry wybranego przez gracza z listy |
| name | string16 | Nick gracza widoczny w grze — maksymalnie 9 znaków |
| skinId | uint8 | ID wybranego skina (0–22) |
| accountId | string | MongoDB ObjectId zalogowanego konta, lub `""` dla gości |

**Przebieg:**

**1. Walidacja nicku** — nick wyswietlany w grze nie może być pusty ani dłuższy niż 9 znaków. Przekroczenie limitu = żądanie odrzucone bez odpowiedzi.

**2. Sprawdzenie serwera w Redis** — `redis.hGetAll('game:{gameId}')` pobiera dane serwera. Jeśli serwer nie istnieje lub jest pełny (`g_players_len >= g_players_lim`), żądanie jest odrzucane.

**3. Weryfikacja skina** — skiny 1–5 są darmowe i nie wymagają sprawdzania bazy. Skin 0 oraz 6–22 są płatne — Mother odpytuje MongoDB czy gracz faktycznie posiada wybrany skin (`db_users.findOne({ _id: accountId, skin: skinId })`). Zapobiega to używaniu skinów których gracz nie kupił.

**4. Generowanie tokenu** — `gen_id()` generuje losowy `uint32`. Token jest jednorazowy i ważny przez ~160 sekund od publikacji.

**5. Publikacja do Redis** — Mother wysyła token przez kanał `join:{gameId}`. Child subskrybuje ten kanał i zapamiętuje token: `tokens[token] = { name, skin_id, account }`. Od tego momentu serwer gry jest gotowy przyjąć połączenie z tym tokenem.

**6. Odpowiedź do klienta po 50ms** — opóźnienie daje czas na dostarczenie tokenu przez Redis do Child (~1–5ms) i jego przetworzenie. Bez opóźnienia klient mógłby połączyć się z Child zanim token zostanie zarejestrowany i dostałby HTTP 401.

```javascript
setTimeout(() => {
    ws.send(clientPacket, true);  // typ 0: token + port + IP serwera gry
}, 50);
```

**Pakiet odpowiedzi do klienta (typ 0):**

Po 50ms klient otrzymuje wszystko czego potrzebuje żeby połączyć się bezpośrednio z serwerem gry:

| Pole | Typ | Opis |
|---|---|---|
| type | uint8 | `0` — klient rozpoznaje że to odpowiedź na żądanie dołączenia |
| token | uint32 | jednorazowy token autoryzacyjny — klient używa go jako ścieżki URL: `ws://IP:PORT/TOKEN` |
| port | uint16 | port NodePort przydzielony przez Agones — z zakresu 7000–8000 |
| ip | string | publiczne IP węzła AKS — bezpośredni adres serwera gry, z pominięciem LoadBalancera |

Po odebraniu pakietu przeglądarka zamyka połączenie z Mother i otwiera nowe WebSocket bezpośrednio z serwerem gry: `ws://{ip}:{port}/{token}`.

---

### `handleFetchAccount(p, ws)` — pobieranie danych konta

Wywoływana gdy gracz zaloguje się i wysyła swoje ID konta przez WebSocket (typ 1). Pobiera pełne dane konta z MongoDB i odsyła je klientowi pakietem typ 1, żeby przeglądarka mogła wyświetlić punkty, skiny i nazwę.

**Pakiet wejściowy od klienta (typ 1):**

| Pole | Typ | Opis |
|---|---|---|
| accountId | string | MongoDB ObjectId konta zapisane w `localStorage` po zalogowaniu |

Funkcja używa `findOneAndUpdate` — w jednej atomowej operacji bazy danych jednocześnie pobiera dokument gracza i aktualizuje pole `last_login` na aktualny czas. Dzięki temu nie są potrzebne dwa osobne zapytania (`findOne` + `updateOne`).

```javascript
db_users.findOneAndUpdate(
    { _id: accountId },
    { $currentDate: { last_login: true } },  // ustaw last_login = teraz
    { returnDocument: 'after' }              // zwróć dokument PO aktualizacji
).then(function (result) {
    if (result) send_account(ws, result);    // wyślij dane konta do klienta
});
```

Opcja `returnDocument: 'after'` powoduje że MongoDB zwraca dokument już z nową datą logowania — klient dostaje aktualny stan, a nie stary snapshot sprzed aktualizacji.

---

### `handleBuySkin(p, ws)` — zakup skina

Obsługuje zakup skina przez gracza. Walidacja, odjęcie punktów i dodanie skina do kolekcji dzieje się w jednej atomowej operacji MongoDB — nie ma możliwości zakupienia skina bez wystarczających punktów ani kupienia tego samego skina dwa razy.

**Pakiet wejściowy od klienta (typ 2):**

| Pole | Typ | Opis |
|---|---|---|
| accountId | string | MongoDB ObjectId konta gracza |
| buyId | uint8 | ID skina do zakupu (0–22) |

```javascript
// apps/mother-lobby/main.js
db_users.findOneAndUpdate(
    {
        _id:    accountId,
        skin:   { $ne: buyId },              // warunek: gracz jeszcze nie ma tego skina
        points: { $gt: SKIN_COSTS[buyId] },  // warunek: gracz ma wystarczająco punktów
    },
    {
        $inc:  { points: -SKIN_COSTS[buyId] }, // odejmij cenę skina od salda
        $push: { skin: buyId },                // dodaj skin do listy kupionych
    },
    { returnDocument: 'after' }                // zwróć dokument po zmianie
)
```

Warunki filtra (`$ne`, `$gt`) i aktualizacja (`$inc`, `$push`) wykonują się atomowo — MongoDB albo robi wszystko naraz, albo nic. Gdyby zamiast tego użyć osobnych `findOne` i `updateOne`, dwa równoległe kliknięcia "kup" mogłyby obydwa przejść walidację punktów jednocześnie i obydwa wykonać zakup — gracz miałby duplikat skina i ujemne saldo. Atomowa operacja to wyklucza.

Jeśli warunki nie są spełnione (za mało punktów lub skin już kupiony), MongoDB nie wprowadza żadnych zmian i zwraca `null` — serwer po prostu nie wysyła odpowiedzi. Jeśli zakup się powiódł, odsyła zaktualizowane dane konta przez `send_account()`.

---

### `handleChangeName(p, ws)` — zmiana nazwy konta

Zmienia nazwę konta gracza widoczną w panelu lobby. Gracz klika ikonę ⌨ przy nazwie, wpisuje nową i zatwierdza — przeglądarka wysyła pakiet typ 3.

**Pakiet wejściowy od klienta (typ 3 lub 4):**

| Pole | Typ | Opis |
|---|---|---|
| accountId | string | MongoDB ObjectId konta gracza |
| name | string16 | Nowa nazwa — musi mieć 1–19 znaków |

Serwer sprawdza tylko długość nazwy: pusta lub dłuższa niż 19 znaków jest odrzucana. Treść nazwy nie jest filtrowana — moderacja treści (obraźliwe słowa itp.) nie jest zaimplementowana po stronie serwera. Jeśli walidacja przejdzie, serwer aktualizuje pole `name` w MongoDB i odsyła zaktualizowane dane konta przez `send_account()`.

---

### `handleReconnect(p, ws)` — reconnect po zerwaniu połączenia WS z Mother [w trakcie poprawy]

Wywoływana gdy gracz jest w trakcie gry i traci połączenie WebSocket z Mother (nie z serwerem gry). Przeglądarka reaguje na błąd połączenia (`onerror`) i automatycznie nawiązuje nowe połączenie z Mother. Ważne: tylko `onerror` wyzwala auto-reconnect — czyste zamknięcie (`onclose`) go nie wyzwala. Ponieważ `gameToken` jest wciąż ustawiony w pamięci przeglądarki (zmienna w js, nie localStorage), `pollForAuth` wysyła typ 5 zamiast typ 1.

**Pakiet wejściowy od klienta (typ 5):**

| Pole | Typ | Opis |
|---|---|---|
| gameId | uint32 | ID serwera gry z którym gracz jest połączony |
| gameToken | uint32 | Token sesji gry — odczytywany przez serwer, ale ignorowany |
| accountId | string | MongoDB ObjectId konta gracza |

Serwer sprawdza `redis.exists('game:{gameId}')` — czy serwer gry wciąż jest aktywny w Redis:

- **Serwer gry wciąż działa** (`exists = 1`) — Mother pobiera dane konta z MongoDB i odsyła je pakietem typ 1. Przeglądarka odświeża panel konta (punkty, skiny, nazwa). Połączenie z Child WebSocket jest osobnym połączeniem TCP — nie jest zarządzane przez Mother i może wciąż działać niezależnie.
- **Serwer gry już nie istnieje** (`exists = 0`) — klucz `game:{gameId}` wygasł w Redis (serwer przestał wysyłać heartbeat, uległ awarii lub zakończył sesję). Mother nie wysyła żadnej odpowiedzi — klient pozostaje w lobby i musi wybrać nowy serwer z listy.

> **Ważne:** `handleReconnect` odświeża tylko dane konta w lobby — nie re-nawiązuje połączenia z Child ani nie przenosi gracza z powrotem do gry. To co gracz widzi po reconnect zależy od stanu jego połączenia z Child, którym Mother nie zarządza.

> **Do dopracowania:** Obecna implementacja jest szkieletowa — serwer ignoruje `gameToken`, nie weryfikuje czy gracz faktycznie był na danym serwerze i nie podejmuje żadnej próby przywrócenia sesji. Docelowo reconnect powinien automatycznie ponownie wprowadzić gracza do gry bez konieczności ręcznego wyboru serwera z listy.

---

## 5. Dane skinów

W grze jest 23 skiny (indeksy 0–22). Każdy ma przypisaną cenę w punktach i kolor światła emitowanego przez postać. Dane te są zakodowane w dwóch tablicach po stronie serwera i wysyłane do każdego klienta przy otwarciu połączenia WS (pakiet typ 3).

### `SKIN_COSTS[23]` — ceny skinów

Tablica 23 cen — indeks tablicy odpowiada ID skina. Skiny 1–5 mają cenę `0` i są dostępne dla wszystkich bez zakupu. Skin 0 jest płatny mimo że wygląda jak domyślny. Skiny 6–22 to skiny premium, których ceny rosną od 8 000 do 800 000 punktów.

```javascript
// apps/mother-lobby/main.js
const SKIN_COSTS = [
    5000,   0,      0,      0,      0,      0,      // skin 0 (płatny), skiny 1–5 (darmowe)
    8000,   15000,  10000,  18000,  25000,  35000,  // skiny 6–11
    50000,  70000,  90000,  120000, 100000, 160000, // skiny 12–17
    200000, 280000, 400000, 550000, 800000,         // skiny 18–22
];
```

### `SKIN_LIGHTS[23]` — kolory świateł skinów

Każdy skin emituje światło w kolorze przypisanym do jego indeksu. Kolor zapisany jest jako 24-bitowa wartość RGB w formacie hex (np. `0xff0000` = czerwony, `0x00f1ff` = cyjan). Klient używa tych wartości do renderowania poświaty wokół postaci w grze.

```javascript
// apps/mother-lobby/main.js 
const SKIN_LIGHTS = [
    0xffffff, 0xff,     0xff00,   0xff9b00, 0x616161, 0x00f1ff,  // skiny 0–5
    0xf9ff00, 0xff00e9, 0xff0000, 0x330002, 0xa44aee, 0x4bc6ff,  // skiny 6–11
    0xefa94d, 0x86ff5f, 0x504eeb, 0x6a6a6a, 0xccca23, 0x8c55c8,  // skiny 12–17
    0xa28b63, 0xfa3936, 0x4d6cfd, 0xeaaa93, 0xa9a9a9,            // skiny 18–22
];
```

Obie tablice wysyłane są razem w pakiecie typ 3 zaraz po otwarciu połączenia WS — klient otrzymuje je przed wyświetleniem sklepu, dzięki czemu może od razu pokazać aktualne ceny i podgląd kolorów bez żadnego dodatkowego zapytania.

---

## 6. Obsługa błędów

Błędy dzielą się na dwie kategorie: krytyczne (przy starcie) i nieblokujące (podczas działania).

**Błędy krytyczne przy starcie** — serwer wywołuje `process.exit(1)`, Kubernetes widzi błąd i restartuje pod:

| Błąd | Kiedy |
|---|---|
| `ECONNREFUSED` — brak połączenia z MongoDB | `connectDatabase()` nie może nawiązać połączenia |
| `ECONNREFUSED` — brak połączenia z Redis | `connectRedis()` nie może nawiązać połączenia |
| `EADDRINUSE` — port zajęty | inny proces używa już portu 9876 lub 3001 |

**Błędy podczas działania** — serwer kontynuuje pracę, błąd jest logowany lub ignorowany:

| Błąd | Gdzie | Jak obsługiwany |
|---|---|---|
| MongoDB duplikat (kod 11000) | `POST /auth/register` | HTTP 409 z komunikatem `"Ta nazwa użytkownika jest już zajęta."` |
| Nieprawidłowy MongoDB ObjectId | handlery WS (join, fetch, buy, rename) | `try/catch → return` — żądanie odrzucane bez odpowiedzi |
| `ws.send()` gdy klient już się rozłączył | `handleJoinGame` (setTimeout 50ms) | `try { ws.send() } catch (_) {}` — błąd  ignorowany |
| Błąd Redis podczas działania | zapytania r/w, pub/sub | `console.error` — biblioteka `redis` próbuje reconnect automatycznie |

---

## 7. Zależności zewnętrzne

| Moduł | Wersja | Do czego służy |
|---|---|---|
| `uWebSockets.js` | v20.30.0 | Serwer WebSocket lobby — obsługuje połączenia graczy, broadcast do grup (`app.publish`), subskrypcje per-klient (`ws.subscribe`). Wydajniejsza alternatywa dla `ws` — napisana w C++. |
| `express` | standard | Serwer HTTP — obsługuje `/auth/login`, `/auth/register`, `/lang` oraz serwowanie plików statycznych gry z katalogu `public/`. |
| `bcrypt` | ^6.0.0 | Hashowanie haseł przy rejestracji (`hash`) i weryfikacja przy logowaniu (`compare`). Koszt `10` rund oznacza ~100ms na operację — wystarczająco wolno żeby utrudnić brute-force. |
| `mongodb` | ^7.1.0 | Dostęp do CosmosDB (MongoDB API) — rejestracja, logowanie, zakup skinów, zmiana nazwy. Głównie `findOneAndUpdate` (atomowe operacje) i `insertOne`. |
| `redis` | ^5.11.0 | Dwa klienty: `redis` do operacji r/w (lista gier, tokeny, dane serwerów) i `redisSub` wyłącznie do `SUBSCRIBE`. Używane komendy: `hGetAll`, `sMembers`, `exists`, `publish`, `subscribe`. |
| `shared/binary.js` | lokalna | Wspólna biblioteka (opracowanie własne) protokołu binarnego — `packet_set` serializuje dane do bufora bajtowego, `packet_get` deserializuje przychodzące pakiety. Używana też przez serwer gry Child i przeglądarkę. |

### Redis — kanały pub/sub

| Kanał | Kierunek | Cel |
|---|---|---|
| `lobby_update` | Child → Mother | Powiadom o zmianie listy gier (nowy serwer, zmiana graczy, zamknięcie) |
| `join:{game_id}` | Mother → Child | Prześlij token gracza do konkretnego serwera |

### Redis — struktura danych (zapisywana przez apps/child-gameserver/main.js)

| Klucz | Typ | Zawartość |
|---|---|---|
| `game_ids` | SET | ID wszystkich aktywnych serwerów gier |
| `game:{id}` | HASH | `g_port`, `g_players_len`, `g_players_lim`, `serv_ip`, `serv_loc`, `serv_name` |

---


## 8. Edge cases i ograniczenia

**Race condition przy zakupie skina** — gracz kliknie "kup" dwa razy szybko, wysyłając dwa równoległe żądania. Gdyby użyć osobnych `findOne` + `updateOne`, oba mogłyby przejść walidację punktów jednocześnie — gracz wydałby punkty dwa razy i dostał duplikat skina. Atomowe `findOneAndUpdate` z filtrami `$ne` (nie masz tego skina) i `$gt` (masz punkty) eliminuje ten problem.

**Klient rozłącza się podczas oczekiwania na token** — `handleJoinGame` wysyła odpowiedź po 50ms przez `setTimeout`. W tym czasie klient może się rozłączyć. Wywołanie `ws.send()` na zamkniętym połączeniu rzuca wyjątek — dlatego jest opakowane w `try { ws.send() } catch (_) {}`.

**Sygnał `lobby_update` przed uruchomieniem WebSocket** — Redis subskrybuje `lobby_update` w kroku 2 inicjalizacji, a `ClientManager` (`c_man`) startuje w kroku 4. Jeśli Child wyśle sygnał między tymi krokami, callback próbowałby wywołać `c_man.broadcast_games()` na `null`. Warunek `if (c_man)` chroni przed tym — sygnał jest wtedy pomijany.

**Globalny bufor `ps` vs lokalny `lps`** — `send_account()` używa współdzielonego globalnego bufora `ps`, ale jest bezpieczna bo jest synchroniczna (Node.js nie przerwie jej w połowie). `buildGamesPacket()` jest asynchroniczna (`await`) — gdyby używała `ps`, inne wywołanie mogłoby nadpisać bufor w trakcie jej działania. Dlatego używa lokalnego `lps`.

**Limity walidacji:**

| Co | Limit | Gdzie walidowane |
|---|---|---|
| Nick w grze | max 9 znaków | `handleJoinGame` — przekroczenie = żądanie odrzucone bez odpowiedzi |
| Nazwa konta | max 19 znaków | `handleChangeName` — przekroczenie = żądanie odrzucone bez odpowiedzi |
| Hasło | min 4 znaki | `POST /auth/register` — HTTP 400 |
| Kolizja tokenu | uint32 = ~4 mld wartości | przy < 1000 tokenów jednocześnie ryzyko kolizji jest pomijalnie małe |

---

## 10. Konfiguracja wdrożeniowa

### Docker (`docker/mother.Dockerfile`)

```dockerfile
FROM node:20-bullseye-slim
WORKDIR /app
RUN apt-get update && apt-get install -y git
COPY apps/mother-lobby/package.json .
RUN npm install
RUN npm install @google-cloud/agones-sdk
RUN npm install redis
COPY apps/shared/ shared/
COPY apps/mother-lobby/main.js .
COPY apps/mother-lobby/public/ public/
EXPOSE 9876 3001 3002
CMD ["node", "main.js"]
```

**Dlaczego poszczególne linie wyglądają tak, a nie inaczej:**

- `node:20-bullseye-slim` — oficjalny obraz Node.js 20 oparty na Debianie Bullseye w wersji minimalnej (`slim`). Mniejszy obraz = szybszy pull.
- `apt-get install git` — `npm install` dla niektórych paczek (np. z zależnościami natywnych bindingów) potrafi wymagać `git` do pobrania zależności z repozytoriów. Instalowane profilaktycznie.
- `npm install @google-cloud/agones-sdk` i `npm install redis` osobno — te paczki nie są w `package.json`, więc `npm install` ich nie zainstaluje. Dołączane ręcznie jako osobne `RUN`.
- `COPY apps/shared/ shared/` — biblioteka `binary.js` współdzielona między Mother i Child. Trafia do `/app/shared/` i jest dołączana przez `require('../shared/binary.js')`.
- `EXPOSE 9876 3001 3002` — deklaracja portów, na których nasłuchuje kontener. Porty 9876 (HTTP) i 3001 (WS lobby) są aktywne. Port 3002 jest zarezerwowany, ale nieużywany w obecnej implementacji (w tej chwili).
- `CMD ["node", "main.js"]` — uruchomienie serwera bezpośrednio przez Node.js (nie przez `npm start`), co zapewnia poprawne przekazywanie sygnałów systemowych (SIGTERM) przy zamknięciu poda przez Kubernetes.

---

### K8s Deployment (`gitops/base/prz-mother.yaml`)

```yaml
spec:
  containers:
  - name: mother
    resources:
      requests: { cpu: "100m", memory: "128Mi" }
      limits:   { cpu: "500m", memory: "256Mi" }
    env:
    - name: REDIS_URL
      value: "redis://redis:6379"
    - name: MONGO_URL
      valueFrom:
        secretKeyRef:
          name: cosmos-db-secret
          key: MONGO_URL
```

**`resources.requests` i `resources.limits` — różnica:**

- `requests` to minimum, które Kubernetes **gwarantuje** podowi przy przydzielaniu węzła. Na podstawie sumy `requests` wszystkich podów scheduler decyduje, czy dany węzeł ma wolne miejsce.
- `limits` kontener nie może zużyć więcej niż ta wartość. Przekroczenie limitu CPU powoduje throttling (spowolnienie), przekroczenie limitu pamięci — OOM Kill (kontener jest zabijany i restartowany).
- Obecne wartości (`100m` CPU = 0,1 rdzenia, `128Mi` RAM) oznaczają, że Mother jest lekkim procesem — Node.js z prostą logiką lobby zużywa tyle w typowym obciążeniu.

**Dlaczego `REDIS_URL` jest wpisany na sztywno, a `MONGO_URL` pochodzi z Sekretu:**

- `REDIS_URL: "redis://redis:6379"` — Redis działa w tym samym klastrze K8s jako Deployment o nazwie `redis`. Adres DNS (`redis:6379`) jest stały i przewidywalny — nie ma potrzeby jego ukrywania.
- `MONGO_URL` zawiera **hasło do bazy danych** (connection string CosmosDB z loginem i hasłem). Przechowywanie go w `env.value` byłoby jawnym tekstem w YAML-u, który trafia do repozytorium GitOps. Kubernetes Secret (`cosmos-db-secret`) przechowuje go zaszyfrowanego i montuje jako zmienną środowiskową dopiero w momencie uruchomienia poda.

---

### HPA (`gitops/base/mother-hpa.yaml`)

```yaml
spec:
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        averageUtilization: 10
```

HPA (Horizontal Pod Autoscaler) automatycznie zwiększa lub zmniejsza liczbę replik poda Mother w zależności od obciążenia CPU.

- `minReplicas: 1` — nawet przy zerowym ruchu zawsze działa co najmniej jeden pod.
- `maxReplicas: 10` — górny limit zabezpiecza przed niekontrolowanym rozrastaniem się przy ataku DDoS lub błędzie.
- `averageUtilization: 10` — próg; jeśli średnie zużycie CPU przekroczy 10%, HPA dodaje replikę. 
- Scale-down ma wbudowane opóźnienie (~5 minut stabilizacji) — Kubernetes nie usuwa replik natychmiast po spadku ruchu.



---

### Service LoadBalancer (`gitops/base/prz-mother.yaml`)

```yaml
kind: Service
spec:
  type: LoadBalancer
  ports:
  - port: 80
    targetPort: 9876   # HTTP (auth API, pliki statyczne)
  - port: 3001
    targetPort: 3001   # WebSocket lobby
```

`type: LoadBalancer` oznacza, że AKS automatycznie tworzy Azure Load Balancer i przydziela mu publiczny adres IP. Cały ruch przychodzący z internetu trafia najpierw do LB, który rozdziela go algorytmem round-robin między dostępne repliki poda Mother.

- Port 80 → 9876: klienci łączą się na standardowym porcie HTTP (80), ale wewnątrz kontenera Express nasłuchuje na 9876. Mapowanie odbywa się w Service — z zewnątrz widzimy port 80, wewnątrz pod widzi 9876.
- Port 3001 → 3001: WebSocket lobby używa tego samego portu wewnątrz i na zewnątrz.

WebSocket to długotrwałe połączenie TCP — po jego zestawieniu przez LB nie jest ponownie routowane. Klient zostaje przypisany do tej samej repliki do momentu rozłączenia. Przy reconnect może trafić na inną replikę — jest to bezpieczne, bo cały stan lobby (lista gier, tokeny) żyje w Redis, nie w pamięci poda.
