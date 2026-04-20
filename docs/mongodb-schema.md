# MongoDB Schema — Schemat Bazy Danych

## 1. Cel i architektura

Baza danych przechowuje konta graczy: dane uwierzytelniające, statystyki, zakupione skiny i metadane. Działa jako Azure CosmosDB z API kompatybilnym z MongoDB (wersja 6.0). Korzystają z niej dwa serwery: Mother, który obsługuje rejestrację, logowanie, zakup skinów i zmianę nicku, oraz Child, który zapisuje punkty gracza po zakończeniu sesji.

### Połączenie z bazą

`connectDatabase()` jest wywoływana raz przy starcie serwera Mother. Nawiązuje połączenie, wskazuje bazę `gra` i kolekcję `users`, po czym tworzy indeks na polu `email`. Indeks spełnia dwie role: gwarantuje unikalność adresów email (próba rejestracji zduplikowanego emaila kończy się błędem MongoDB `E11000`) oraz przyspiesza logowanie — `findOne({ email })` działa w O(log n) zamiast O(n). Połączenie jest przechowywane globalnie w zmiennej `db_users` i reużywane przy każdym zapytaniu.

```javascript
// apps/mother-lobby/main.js 
async function connectDatabase() {
    const client = await MongoClient.connect(CONFIG.MONGO_URL);
    // MongoClient.connect() — statyczna metoda, łączy i zwraca klienta
    // CONFIG.MONGO_URL — connection string z zmiennej środowiskowej MONGO_URL

    const db = client.db('gra');
    // wybierz bazę 'gra' — tworzona automatycznie jeśli nie istnieje

    db_users = db.collection('users');
    // globalna referencja do kolekcji — reużywana przy każdym zapytaniu

    await db_users.createIndex({ email: 1 }, { unique: true });
    // unikalny indeks na email: szybkie findOne() + odrzucenie duplikatów (E11000)
    // bezpieczne do wywołania wielokrotnie — jeśli indeks istnieje, MongoDB go pomija
}
```

---

## 2. Kluczowa Logika i Przepływ

### Schemat dokumentu użytkownika

Każde konto gracza to jeden dokument w kolekcji `users`. Pola dzielą się na trzy grupy: dane uwierzytelniające (`email`, `password_hash`), waluta i statystyki (`points`, `total_points`) oraz wygląd postaci i dodatkowe dane (`skin`, `acc_data`). Wartości `points` i `total_points` zaczynają od 10 000 000 — nowy gracz może od razu kupić kilka tanich skinów. Nick (`name`) jest generowany automatycznie przy rejestracji jako `"User" + losowa liczba` i może być zmieniony przez gracza (max 19 znaków).

```javascript
// Kolekcja: users (db: gra)
{
    _id:           ObjectId,       // automatyczny MongoDB ID (24-znakowy hex)
    email:         String,         // unikalny (unique index), pełni rolę nazwy użytkownika — format nie jest weryfikowany
    password_hash: String,         // bcrypt hash hasła (10 rounds, ~100ms) — nigdy plaintext
    name:          String,         // nick gracza, domyślnie "User<liczba>", max 19 znaków
    points:        Number,         // waluta — wydawalna na skiny; nowe konto: 10 000 000
    total_points:  Number,         // łączny wynik z całego życia (tylko do rankingów); nowe konto: 10 000 000
    skin:          Array<Number>,  // lista zakupionych skinów (np. [3, 7, 12]); na start: []
    acc_data:      Array<String>,  // dodatkowe dane konta (rozszerzenia); na start: []
    last_login:    Date,           // timestamp ostatniego logowania — aktualizowany przy każdym połączeniu
}
```

### Różnica `points` vs `total_points`

Oba pola są zawsze zapisywane razem przez `save_player_money()`. Różnica: `points` można wydać w sklepie (skiny odejmują punkty przez `$inc points: -cena`), dlatego `points` może maleć — `total_points` nigdy nie maleje.

**`points`** — waluta gracza w sklepie. Można ją wydać na skiny (`$inc points: -cena`). Przy respawnie nie resetuje się do zera — gracz odzyskuje tyle, ile miał przy ostatnim checkpoincie plus punkty za zabójstwa (`saved_points + kill_points`).

**`total_points`** — suma wszystkich punktów zarobionych na koncie od rejestracji, nigdy nie maleje. Rośnie o dokładnie tę samą kwotę co `points` — oba pola są zawsze zapisywane razem jednym `$inc`. Różnica między nimi pojawia się dopiero gdy gracz wyda `points` w sklepie: `points` maleje, `total_points` zostaje. Przeznaczony do rankingów globalnych.

**Kiedy i co jest zapisywane** — `save_player_money()` jest wywoływana dwukrotnie: przy śmierci gracza oraz przy rozłączeniu. Za każdym razem nie nadpisuje całego pola `points`, tylko dodaje różnicę — ile gracz zarobił od poprzedniego zapisu:
```
delta = pl.points - pl.account_points   // ile zarobił od poprzedniego save
$inc: { points: delta, total_points: delta }
```

**`kill_points`** i **`saved_points`** — zmienne lokalne w Child, nie istnieją w MongoDB. `kill_points` to punkty za zabójstwa innych graczy (+1000 za zabójstwo) — nie są kasowane po śmierci, żeby gracz nie tracił nagrody za walkę. `saved_points` to punkt odniesienia dla respawnu, aktualizowany przy każdym przejściu do głębszej sekcji (`saved_points = pl.points - kill_points`). Przy respawnie: `pl.points = saved_points + kill_points`.

---

## 3. Przykłady z kodu (implementacja)

### Rejestracja

Klient wysyła `email` (pełniący rolę nazwy użytkownika) i `password`. Nick (`name`) jest generowany automatycznie przez serwer — gracz może go zmienić później. Hasło nigdy nie trafia do bazy — jest zastępowane hashem bcrypt jeszcze przed zapisem. Nowe konto dostaje od razu 10 000 000 punktów jako starter pack. Serwer zwraca `id` nowego konta — klient zapisuje je lokalnie i używa do identyfikacji w kolejnych requestach.

```javascript
// apps/mother-lobby/main.js  
const { email, password } = req.body;
// z requestu pobieramy tylko login i hasło — nick serwer generuje sam

const hash = await bcrypt.hash(password, CONFIG.BCRYPT_ROUNDS);
// hasło jest hashowane przed zapisem (bcrypt, 10 rund, ~100ms)
// do bazy trafia wyłącznie hash — oryginalne hasło nie jest nigdzie przechowywane

const result = await db_users.insertOne({
    email,                                                       // login gracza
    password_hash: hash,                                         // hash hasła
    name:          'User' + ((Math.random() * 0xffffff) | 0),   // domyślny nick, np. "User8234521"
    points:        10000000,                                     // 10 mln punktów startowych — gracz może od razu kupić skiny
    total_points:  10000000,
    skin:          [],                                           // brak skinów na start
    acc_data:      [],
    last_login:    new Date(),                                   // data rejestracji jako pierwsze logowanie
});
// jeśli podany login jest już zajęty, MongoDB odrzuca zapis z błędem E11000

res.json({ id: result.insertedId.toString() });
// klient otrzymuje ID nowego konta jako string i zapisuje je lokalnie
```

### Logowanie

Serwer najpierw wyszukuje konto po nazwie użytkownika, a następnie porównuje podane hasło z hashem przechowywanym w bazie. Oba błędy — nieistniejący login i złe hasło — zwracają identyczny komunikat. Gdyby komunikaty się różniły, atakujący mógłby sprawdzać, które loginy są zarejestrowane. Po udanym logowaniu `last_login` jest aktualizowane w tle, bez czekania na wynik — gracz dostaje odpowiedź natychmiast.

```javascript
// apps/mother-lobby/main.js  
const user = await db_users.findOne({ email });
// szuka konta po loginie — indeks na email sprawia, że działa w O(log n)

if (!user) {
    return res.status(401).json({ error: 'Nieprawidłowa nazwa użytkownika lub haslo.' });
}

const match = await bcrypt.compare(password, user.password_hash);
// porównuje podane hasło z hashem — bcrypt oblicza hash z tą samą solą i sprawdza czy się zgadza

if (!match) {
    return res.status(401).json({ error: 'Nieprawidłowa nazwa użytkownika lub haslo.' });
    // ten sam komunikat co wyżej — atakujący nie wie, czy login istnieje czy hasło jest złe
}

db_users.updateOne({ _id: user._id }, { $currentDate: { last_login: true } });
// aktualizacja daty logowania — bez await, wykonuje się w tle

res.json({ id: user._id.toString() });
// zwraca ID konta jako string — identyczny format jak przy rejestracji
```

### Pobieranie danych konta i aktualizacja last_login

Gdy gracz otwiera ekran profilu, serwer musi pobrać jego dane z bazy i jednocześnie zaktualizować datę ostatniego logowania. Zamiast wykonywać dwie osobne operacje (`findOne` + `updateOne`), używa `findOneAndUpdate` — jednej atomowej operacji, która robi obie rzeczy naraz. Opcja `returnDocument: 'after'` powoduje, że zwrócony dokument zawiera już nową datę logowania, więc klient od razu widzi aktualny stan konta.

```javascript
// apps/mother-lobby/main.js 
db_users.findOneAndUpdate(
    { _id: accountId },                        // znajdź konto gracza
    { $currentDate: { last_login: true } },    // ustaw last_login na aktualny czas
    { returnDocument: 'after' }                // zwróć dokument po aktualizacji
).then(function (result) {
    if (result) send_account(ws, result);
    // jeśli konto istnieje — wyślij dane do klienta przez WebSocket
    // result = null gdy accountId nie pasuje do żadnego dokumentu
}).catch(console.error);
```

### Zakup skina

Gdyby zakup był realizowany jako dwie osobne operacje — najpierw sprawdzenie salda, potem odjęcie punktów — gracz mógłby wysłać dwa żądania jednocześnie i oba przeszłyby weryfikację, zanim którekolwiek zdążyłoby odjąć punkty. Aby temu zapobiec, cała operacja jest wykonywana atomowo przez `findOneAndUpdate`: MongoDB sprawdza warunki i modyfikuje dokument w jednym kroku, bez możliwości wtrącenia się innego żądania.

Jeśli gracz ma za mało punktów lub posiada już ten skin, MongoDB nie znajdzie pasującego dokumentu i nie wprowadzi żadnej zmiany. Klient nie otrzyma wtedy potwierdzenia zakupu.

```javascript
// apps/mother-lobby/main.js 
db_users.findOneAndUpdate(
    {
        _id:    accountId,
        skin:   { $ne: buyId },             // gracz jeszcze nie posiada tego skina
        points: { $gt: SKIN_COSTS[buyId] }, // gracz ma więcej punktów niż cena skina
    },
    {
        $inc:  { points: -SKIN_COSTS[buyId] }, // odejmij cenę skina od salda
        $push: { skin: buyId },                // dodaj skin do listy zakupionych
    },
    { returnDocument: 'after' }                // zwróć dokument po aktualizacji
).then(function (result) {
    if (result) send_account(ws, result);
    // zakup się powiódł — wyślij klientowi zaktualizowane dane konta
    // result = null gdy gracz ma za mało punktów, ma już ten skin lub konto nie istnieje
}).catch(console.error);
```

### Zapis punktów po sesji (Child)

Funkcja jest wywoływana przy śmierci gracza oraz przy rozłączeniu. Zamiast zapisywać całe saldo, zapisuje tylko deltę — różnicę między aktualnymi punktami a stanem z ostatniego zapisu. Gracze niezalogowani (goście) są pomijani — nie mają konta w bazie. Oba pola, `points` i `total_points`, są zwiększane o tę samą kwotę.

```javascript
// apps/child-gameserver/main.js 
function save_player_money(token_or_account, money) {
    if (money <= 0 || !db_users) return;
    // jeśli gracz nic nie zarobił lub baza jest niedostępna — pomiń

    const accountStr = (typeof token_or_account === 'object')
        ? token_or_account.account || ''   // przekazano obiekt gracza — pobierz pole .account
        : token_or_account || '';          // przekazano string bezpośrednio

    if (!accountStr) return;
    // pusty string oznacza gracza-gościa (niezalogowanego) — nie ma gdzie zapisać punktów

    try {
        db_users.updateOne(
            { _id: new ObjectId(accountStr) },
            { $inc: { points: money, total_points: money } }
            // oba pola rosną o tę samą deltę — różnicę zarobioną od ostatniego zapisu
        ).catch(console.error);
    } catch (e) {
        console.error('save_player_money error:', e);
        // new ObjectId() rzuci wyjątek dla nieprawidłowego stringa konta
    }
}
```

Funkcja jest wywoływana w dwóch miejscach. Za każdym razem jako drugi argument przekazywana jest różnica między aktualnym saldem gracza a stanem zapamiętanym przy ostatnim zapisie — czyli dokładnie tyle punktów, ile gracz zarobił od poprzedniego wywołania.

```javascript
// przy śmierci gracza 
save_player_money(this, this.points - this.account_points);

// przy rozłączeniu 
save_player_money(pl, pl.points - pl.account_points);
```

### Zmiana nicku

Serwer weryfikuje wyłącznie długość nicku — maksymalnie 19 znaków. Zawartość nie jest w żaden sposób filtrowana. Po zapisaniu nowego nicku w bazie klient natychmiast otrzymuje zaktualizowane dane konta.

```javascript
// apps/mother-lobby/main.js
if (!name || name.length >= 20) return;
// odrzuć pustą nazwę lub dłuższą niż 19 znaków

db_users.findOneAndUpdate(
    { _id: accountId },
    { $set: { name } },         // nadpisz pole name nową wartością
    { returnDocument: 'after' } // zwróć dokument już po zmianie
).then(function (result) {
    if (result) send_account(ws, result);
    // wyślij klientowi zaktualizowane dane konta z nowym nickiem
}).catch(console.error);
```

---

## 4. Zależności i Protokoły

### Pakiet danych konta (Mother → Klient, typ 1)

Funkcja `send_account` jest wywoływana po każdej operacji, która zmienia dane konta — logowaniu, zakupie skina, zmianie nicku. Serializuje dokument użytkownika do binarnego pakietu i wysyła go przez WebSocket. Klient po odebraniu pakietu typu 1 odświeża wyświetlane dane konta.

```javascript
// apps/mother-lobby/main.js 
function send_account(ws, user) {
    ps.new_type(1);                                      // typ 1 = pakiet danych konta
    ps.s_string16(user.email);                           // login gracza
    ps.s_uint32(user.points);                            // aktualne saldo punktów
    ps.s_uint32(user.total_points);                      // łączne zarobione punkty
    ps.s_string16(user.name);                            // nick wyświetlany w grze
    ps.s_int8_arr(user.skin, user.skin.length);          // lista zakupionych skinów
    ps.s_string_arr(user.acc_data, user.acc_data.length);// dodatkowe dane konta
    ws.send(ps.get_buf(), true);                         // wyślij binarnie przez WebSocket
}
```

### Indeksy MongoDB

Kolekcja `users` korzysta z dwóch indeksów. Pierwszy, na polu `_id`, MongoDB tworzy automatycznie dla każdej kolekcji. Drugi, na polu `email`, jest zakładany ręcznie przy starcie serwera — przyspiesza wyszukiwanie konta podczas logowania i uniemożliwia zarejestrowanie dwóch kont z tym samym loginem. Nazwa `email_1` jest nadawana przez MongoDB automatycznie na podstawie nazwy pola i kierunku sortowania (`1` = rosnąco).

| Nazwa | Pole | Typ | Cel |
|---|---|---|---|
| `_id_` | `_id` | unique | tworzony automatycznie przez MongoDB dla każdego dokumentu |
| `email_1` | `email` | unique | przyspiesza wyszukiwanie przy logowaniu, blokuje rejestrację zduplikowanego loginu |

---

## 5. Konfiguracja Wdrożeniowa

### CosmosDB (Azure) via Terraform

CosmosDB to usługa bazodanowa Azure z wbudowanym API kompatybilnym z MongoDB — serwer Mother łączy się z nią standardowym sterownikiem MongoDB bez żadnych zmian w kodzie. Polityka spójności `Session` oznacza, że każdy gracz zawsze widzi swoje własne dane natychmiast po zapisie, co dla tej gry w pełni wystarcza.

```hcl
# infra/terraform/cosmosdb.tf
resource "azurerm_cosmosdb_account" "main" {
  name                = var.cosmosdb_account_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  offer_type = "Standard"  # jedyny dostępny plan CosmosDB na Azure
  kind       = "MongoDB"   # tryb MongoDB — kod aplikacji nie wymaga zmian

  mongo_server_version       = var.cosmosdb_mongo_version  # np. "4.2"
  automatic_failover_enabled = false  # wyłączone — działamy w jednym regionie

  consistency_policy {
    consistency_level = "Session"
    # CosmosDB replikuje dane między węzłami, więc zapis może dotrzeć do różnych węzłów
    # z niewielkim opóźnieniem. "Session" gwarantuje, że gracz który właśnie zapisał dane
    # (np. kupił skin) od razu zobaczy aktualny wynik — jego kolejne odczyty trafią
    # do tego samego węzła. Inni gracze mogą przez chwilę widzieć starsze dane,
    # ale w tej grze każdy operuje wyłącznie na własnym koncie, więc to nie jest problem.
  }

  geo_location {
    location          = azurerm_resource_group.main.location
    failover_priority = 0      # region główny
    zone_redundant    = false  # brak redundancji stref — tańsze
  }
}
```

### Connection string w K8s Secret

Po utworzeniu CosmosDB Terraform od razu zna jego connection string i zapisuje go jako Kubernetes Secret. Dzięki temu hasło do bazy nigdy nie trafia do kodu ani do logów — serwer Mother odczytuje je przy starcie jako zmienną środowiskową `MONGO_URL`.

```hcl
# infra/terraform/cosmosdb_secret.tf
resource "kubernetes_secret" "cosmos_db" {
  metadata {
    name      = "cosmos-db-secret"  # pod tą nazwą Mother szuka Secretu
    namespace = "default"           # ten sam namespace co Mother
  }

  data = {
    MONGO_URL = azurerm_cosmosdb_account.main.primary_mongodb_connection_string
    # connection string generowany automatycznie przez Azure
    # format: mongodb://nazwa:hasło@host:port/?ssl=true&...
  }

  type = "Opaque"  # ogólny typ Secretu — K8s nie interpretuje zawartości
}
```

### Zmienne środowiskowe

| Zmienna | Wartość | Skąd |
|---|---|---|
| `MONGO_URL` | connection string CosmosDB | K8s Secret `cosmos-db-secret` |

### Ograniczenia

- **Brak soft-delete** — usunięte konto znika bezpowrotnie, nie można go odtworzyć.
- **Brak walidacji loginu** — pole `email` pełni rolę nazwy użytkownika, ale serwer nie sprawdza ani formatu, ani czy adres istnieje. Można się zarejestrować podając dowolny ciąg znaków.
- **`acc_data` bez treści** — pole jest zapisywane do bazy i wysyłane do klienta, ale żaden fragment kodu go nie wypełnia. Zarezerwowane na przyszłość (np. osiągnięcia, tytuły).
- **Brak indeksu na `skin`** — przy zakupie skina zapytanie filtruje po `{ _id, skin: { $ne: buyId } }`. MongoDB korzysta z indeksu na `_id`, ale tablicę `skin` sprawdza już bez indeksu, przeglądając ją element po elemencie. Przy krótkiej liście skinów nie stanowi to problemu.
