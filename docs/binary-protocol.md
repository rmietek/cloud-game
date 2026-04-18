# Binarny Protokół Komunikacji — Serwer Mother, Serwer Child i Przeglądarka

## 1. Cel i architektura

`apps/shared/binary.js` to własna biblioteka serializacji i deserializacji binarnej pakietów sieciowych współdzielona przez cały system: serwer Mother, serwer Child i przeglądarkę gracza. Wszystkie trzy strony używają tego samego kodu do pakowania i rozpakowywania wiadomości — logika serializacji jest zdefiniowana w jednym miejscu i wszystkie trzy strony automatycznie jej przestrzegają.

Biblioteka zastępuje JSON. W JSON każda wartość jest zapisana jako tekst z nazwami pól i separatorami (`{"x":512.3}`). W formacie binarnym ta sama wartość to 4 bajty liczby zmiennoprzecinkowej — bez nazwy pola, bez cudzysłowów, bez przecinków. Obie strony z góry wiedzą, co jest na której pozycji w pakiecie, więc nazwy pól są zbędne.

### Dlaczego nie JSON

Serwer gry działa z częstotliwością 62,5 taktów/s i wysyła aktualizacje pozycji do każdego z 15 graczy przy każdym takcie. Przy JSON rozmiar tych pakietów sprawiałby, że łącze byłoby przeciążone nawet przy umiarkowanej liczbie graczy.

```
Dane jednego gracza: id=5, x=512.3, y=-1024.7, skin=7

JSON:    {"id":5,"x":512.3,"y":-1024.7,"skin":7}   →  39 bajtów
Binarny: [05][00 00 FF 3F][00 00 80 C4][07]        →  10 bajtów
Redukcja: 4×

Pakiet listy serwerów (1 serwer):
JSON:    {"id":3482901234,"players":3,"limit":15,"loc":"EU","name":"EU-Phantom"}  →  ~70 bajtów
Binarny: uint32 + uint8 + uint8 + string("EU") + string("EU-Phantom")             →  ~20 bajtów
Redukcja: 3,5×

Ruch sieciowy przy pełnym serwerze (15 graczy + 37 botów = 52 obiekty, 62,5 taktów/s):
  Format binarny:  15 graczy × 62,5 taktów/s × 520 B/pakiet  =   487 KB/s
  Format JSON:     15 graczy × 62,5 taktów/s × 2184 B/pakiet = 2 047 KB/s
  Oszczędność: ~4× mniej danych przesyłanych przez sieć
```

### Format pakietu

Każdy pakiet może zawierać jeden lub więcej bloków danych. Bajt [0] mówi ile bloków jest w pakiecie, a dalej bloki są ułożone jeden po drugim — każdy zaczyna się od bajtu z typem, po którym idą dane tego bloku.

```
Bajt [0]:       liczba bloków w pakiecie (uint8)
                np. wartość 2 = pakiet zawiera dwa bloki

Bajt [1]:       typ pierwszego bloku (uint8)
                np. 0 = pozycje graczy, 4 = mapa, 9 = ranking
Bajt [2..N]:    dane pierwszego bloku
                (długość zależy od typu — różne typy mają różny rozmiar)

Bajt [N+1]:     typ drugiego bloku
Bajt [N+2..M]:  dane drugiego bloku
...
```

**Przykład:** pakiet wysyłany do gracza przy dołączeniu do gry zawiera 4 bloki naraz — listę graczy (typ 3), listę martwych graczy (typ 7), ranking (typ 9) i mapę (typ 4). Bajt [0] = 4, po nim idą cztery bloki z danymi.

---

## 2. Typy pakietów

### Mother ↔ Przeglądarka

**Mother → Przeglądarka:**

| Typ | Opis | Zawartość |
|---|---|---|
| 0 | Token dołączenia | `uint32 token`, `uint16 port`, `string ip` |
| 1 | Dane konta | `string16 email`, `uint32 points`, `uint32 total_points`, `string16 name`, `int8[] skins`, `string[] acc_data` |
| 2 | Lista serwerów | `uint8 count`, per serwer: `uint32 id`, `uint8 players`, `uint8 limit`, `string loc`, `string name` |
| 3 | Dane sklepu | `int32[23] SKIN_COSTS`, `int32[23] SKIN_LIGHTS` |

**Przeglądarka → Mother:**

| Typ | Opis | Zawartość |
|---|---|---|
| 0 | Dołącz do gry | `uint32 gameId`, `string16 name`, `uint8 skinId`, `string accountId` |
| 1 | Pobierz konto | `string accountId` |
| 2 | Kup skin | `uint8 skinId`, `string accountId` |
| 3/4 | Zmień nick | `string16 name`, `string accountId` |
| 5 | Reconnect | `uint32 gameId`, `uint32 gameToken`, `string accountId` |
| 6 | Odśwież gry | _(brak danych)_ |

### Child ↔ Przeglądarka

**Child → Przeglądarka:**

| Typ | Opis | Zawartość |
|---|---|---|
| 0 | Pozycje | `uint8 count`, per gracz: `int8 id`, `float x`, `float y`, `int8 event_use` |
| 1 | Nowi gracze | `uint8 count`, per gracz: `uint8 id`, `string16 name`, `uint8 skin` |
| 2 | Opuścili | `uint8 count`, per gracz: `int8 id` |
| 3 | Init (lista graczy) | `uint8 self_id`, `uint8 count`, per gracz: `uint8 id`, `string16 name`, `uint8 skin` |
| 4 | Dane mapy | `uint8 levels`, per poziom: `128 × int8` |
| 5 | Zabici | `uint8 count`, per gracz: `int8 id` |
| 6 | Odrodzeni | `uint8 count`, per gracz: `int8 id` |
| 7 | Lista martwych | `uint8 count`, per gracz: `uint8 id` |
| 8 | Czat | `uint8 count`, per wiadomość: `int8 id`, `string16 text` |
| 9 | Leaderboard | `uint8 count (max 6)`, per gracz: `int8 id`, `int8 byte_point` |
| 10 | Własna pozycja | `int8 ranking_id`, `int8 byte_point` |
| 11 | Event (życia) | `int8 value (0-10)` |
| 12 | Nagroda za śmierć | `uint32 amount` |
| 13 | Zmiana skina | `uint8 count`, per gracz: `int8 id`, `uint8 skin_id` |

**Przeglądarka → Child:**

| Typ | Opis | Zawartość |
|---|---|---|
| 0 | Ruch poziomy | `int8 dx` — delta X (ujemne = lewo, dodatnie = prawo, zakres −128 do 127) |
| 1 | Wiadomość czatu | `string16 text` — treść wiadomości (UTF-16, 2 bajty długości + bajty) |
| 2 | Użycie eventu | _(brak danych)_ — aktywuje zebrany power-up (zużywa 1 punkt eventu) |
| 8 | Respawn | `int8 ads` — czy gracz oglądał reklamę (1 = tak, bonus +2500 pkt startowych)<br>`uint8 skin_id` — wybrany skin na ten respawn |

---

## 3. Kluczowa Logika i Przepływ

### `packet_get` — Deserializacja (odczyt pakietu)

`packet_get` to klasa do odczytywania danych z binarnego bufora. Działa jak kursor przesuwający się przez bajty — każde wywołanie metody `g_*` odczytuje kolejną wartość i automatycznie przesuwa wskaźnik `index` o odpowiednią liczbę bajtów. Nie trzeba ręcznie śledzić pozycji — wystarczy wywołać metody w tej samej kolejności, w jakiej dane zostały zapisane po drugiej stronie.

```javascript
// apps/shared/binary.js
function packet_get() {
    this.d     = new DataView(new ArrayBuffer(0), 0);
    this.index = 0;

    // Załaduj nowy bufor do odczytu i zresetuj kursor na pozycję 0
    this.set_buffer = function(buf) {
        this.d     = new DataView(buf, 0);
        this.index = 0;
        return this;  // zwraca this → można łączyć: p.set_buffer(msg).g_uint8()
    };

    // Metody g_* — każda odczytuje wartość z aktualnej pozycji i przesuwa kursor
    this.g_uint8  = function() { return this.d.getUint8(this.index++); };           // 1 bajt,  0–255
    this.g_uint16 = function() { this.index += 2; return this.d.getUint16(this.index - 2); };  // 2 bajty, 0–65 535
    this.g_uint32 = function() { this.index += 4; return this.d.getUint32(this.index - 4); };  // 4 bajty, 0–4 294 967 295
    this.g_int8   = function() { return this.d.getInt8(this.index++); };            // 1 bajt,  -128–127
    this.g_int32  = function() { this.index += 4; return this.d.getInt32(this.index - 4); };   // 4 bajty, liczba ze znakiem
    this.g_float  = function() { this.index += 4; return this.d.getFloat32(this.index - 4); }; // 4 bajty, IEEE 754 (pozycje x/y)

    // g_string — tekst ASCII (tylko znaki łacińskie bez ogonków)
    // Format w buforze: [długość: 1 bajt][znak1][znak2]...[znakN]
    this.g_string = function() {
        let str = "";
        const l = this.d.getUint8(this.index++);  // najpierw odczytaj ile znaków
        for (let i = l; i--;) str += String.fromCharCode(this.d.getUint8(this.index++));
        return str;
    };

    // g_string16 — tekst UTF-16 (obsługuje polskie znaki: ą, ę, ó, ź itd.)
    // Format w buforze: [długość: 1 bajt][znak1: 2 bajty][znak2: 2 bajty]...[znakN: 2 bajty]
    // Każdy znak zajmuje 2 bajty zamiast 1 — dlatego obsługuje szerszy zakres znaków
    this.g_string16 = function() {
        let str = "";
        const l = this.d.getUint8(this.index++);
        for (let i = l; i--;) {
            str += String.fromCharCode(this.d.getUint16(this.index));
            this.index += 2;
        }
        return str;
    };
}
```

**Przykład użycia** — odczyt pakietu przychodzącego od klienta w Mother:

Kiedy klient wysyła wiadomość przez WebSocket, Mother odbiera surowy binarny bufor. Żeby wiedzieć co klient chce zrobić (dołączyć do gry? kupić skina? zmienić nick?), serwer musi odczytać typ pakietu z bajtu [1]. Dopiero wtedy przekazuje resztę bufora do odpowiedniej funkcji obsługi.

```javascript
// apps/mother-lobby/main.js 
message: function (ws, message, isBinary) {
    const p = new packet_get();
    p.set_buffer(message);   // załaduj odebraną wiadomość WS do kursora

    p.g_int8();              // bajt [0] = liczba bloków w pakiecie — Mother tego nie używa, pomijamy
    const type = p.g_int8(); // bajt [1] = typ pakietu — decyduje co klient chce zrobić

    // Kursor stoi teraz na bajcie [2] — pierwszym bajcie danych właściwych.
    // Każda funkcja handleXxx() będzie dalej wywoływać p.g_*() żeby odczytać
    // kolejne pola (np. gameId, name, skinId) w tej samej kolejności w jakiej
    // klient je zapisał po swojej stronie.
    switch (type) {
        case 0: handleJoinGame(p, ws);     break; // gracz dołącza do serwera gry
        case 1: handleFetchAccount(p, ws); break; // pobierz dane konta po zalogowaniu
        case 2: handleBuySkin(p, ws);      break; // zakup skina za punkty
        case 3:
        case 4: handleChangeName(p, ws);   break; // zmiana nicku konta
        case 5: handleReconnect(p, ws);    break; // reconnect po zerwaniu WS
    }
}
```

### `packet_set` — Serializacja (zapis pakietu)

`packet_set` to odwrotność `packet_get` — służy do budowania pakietu binarnego przed wysłaniem przez WebSocket. Alokujesz bufor o z góry określonym rozmiarze, wypełniasz go metodami `s_*` (od ang. *set*), a na końcu wywołujesz `get_buf()` żeby dostać gotowy `ArrayBuffer` do wysłania.

Bufor jest współdzielony i wielokrotnie używany — `get_buf()` resetuje wskaźnik, więc po wysłaniu pakietu można od razu zacząć budować następny bez alokowania nowej pamięci.

```javascript
// apps/shared/binary.js
function packet_set(size) {
    this.buffor = new ArrayBuffer(size);          // z góry zaalokowany bufor o stałym rozmiarze
    this.int8   = new Uint8Array(this.buffor);    // 'widok bajtowy' — do szybkiego zapisu pojedynczych bajtów
    this.DV     = new DataView(this.buffor, 0);   // DataView — do zapisu float32, int16 itp.
    this.index  = 1;   // zapis zaczyna się od bajtu [1] — bajt [0] jest zarezerwowany na licznik bloków

    // new_type(i) — rozpoczyna nowy blok danych o typie i
    // Każdy pakiet może mieć wiele bloków (np. pozycje + ranking w jednym wysłaniu).
    // Wywołaj tę metodę przed każdą grupą danych — zapisuje typ bloku i inkrementuje licznik.
    this.new_type = function(i) {
        this.int8[0]++;              // bajt [0]: zwiększ licznik bloków o 1
        this.int8[this.index] = i;   // zapisz typ bloku na aktualnej pozycji
        this.index++;                // przesuń kursor za bajt z typem
    };

    // get_buf() — zakończ pakiet i zwróć gotowy bufor do wysłania
    // Zwraca tylko faktycznie użytą część bufora (bez pustych bajtów na końcu).
    // Po wywołaniu bufor jest resetowany — gotowy do budowania następnego pakietu.
    this.get_buf = function() {
        const b = this.buffor.slice(0, this.index);  // skopiuj tylko wypełnione bajty
        this.index   = 1;    // resetuj kursor (bajt [0] zostaje nadpisany przez new_type przy następnym użyciu)
        this.int8[0] = 0;    // wyzeruj licznik bloków
        return b;
    };

    // Metody s_* — każda zapisuje wartość na aktualnej pozycji i przesuwa kursor
    this.s_uint8  = function(val) { this.int8[this.index++] = val; };                          // 1 bajt, 0–255
    this.s_uint16 = function(val) { this.DV.setUint16(this.index, val); this.index += 2; };    // 2 bajty
    this.s_uint32 = function(val) { this.DV.setUint32(this.index, val); this.index += 4; };    // 4 bajty
    this.s_int8   = function(val) { this.DV.setInt8(this.index++, val); };                     // 1 bajt, -128–127

    // s_int16 zapisywane ręcznie (big-endian: starszy bajt pierwszy)
    this.s_int16 = function(val) {
        this.int8[this.index]   = val >> 8;    // starszy bajt (np. dla val=512: 512>>8 = 2)
        this.int8[this.index+1] = val & 0xff;  // młodszy bajt (np. 512 & 0xff = 0)
        this.index += 2;
    };

    // s_float — liczba zmiennoprzecinkowa IEEE 754 (4 bajty) — używana do pozycji x/y gracza
    this.s_float = function(val) {
        this.DV.setFloat32(this.index, val);
        this.index += 4;
    };

    // s_string — tekst ASCII: najpierw 1 bajt z długością, potem bajty znaków
    this.s_string = function(val) {
        this.int8[this.index++] = val.length;  // zapisz długość
        for (let i = 0; i < val.length; i++) this.int8[this.index++] = val.charCodeAt(i);
    };
}
```

**Przykład użycia** — budowanie odpowiedzi Mother do klienta (token + port + IP serwera gry):

```javascript
// apps/mother-lobby/main.js — handleJoinGame()
ps.new_type(0);                          // nowy blok, typ 0 = odpowiedź join
ps.s_uint32(token);                      // 4 bajty: jednorazowy token do połączenia z Child
ps.s_uint16(parseInt(gameData.g_port));  // 2 bajty: port zewnętrzny Agones (7000–8000)
ps.s_string(gameData.serv_ip);           // 1 + N bajtów: publiczny IP węzła K8s

const clientPacket = Buffer.from(ps.get_buf());  // get_buf() kończy pakiet i resetuje bufor
// Buffer.from() tworzy KOPIĘ — ps jest resetowane i może być użyte do kolejnego pakietu
setTimeout(() => { ws.send(clientPacket, true); }, 50);
```


### Dodatkowa optymalizacja: dual-buffer

Przy 15 graczach serwer wysyła 15 różnych wersji pakietu pozycji (każdy widzi innych graczy). Zamiast budować każdy pakiet od zera 15 razy na takt, stosujemy mechanizm `end_global` / `get_uniq_buf`:

```
KROK 1: Serializ dane WSPÓLNE dla wszystkich (pozycje, śmierci, rankingi) → raz
KROK 2: Zaznacz checkpoint → end_global()
KROK 3: Dla każdego gracza dołącz dane PRYWATNE (jego pozycja w rankingu, jego życia)
        → get_uniq_buf() kopiuje [wspólne + prywatne]
        → automatycznie cofa do checkpointu (gotowe na następnego gracza)
KROK 4: Wyczyść bufor → p.clear()
```

Gdybyśmy używali JSON, `JSON.stringify` byłby wywoływany 15 razy na takt — 900 razy na sekundę. Nasz serializer przygotowuje część globalną raz.


### Tryb `uniq` — optymalizacja per-player

W każdym takcie (co 16ms) funkcja `gen_packet()` buduje jeden pakiet i wysyła go do każdego aktualnie podłączonego gracza (boty są pomijane — nie mają socketów). Pakiet składa się z dwóch części:

**Część globalna** — identyczna dla wszystkich graczy, budowana raz. Zawiera zdarzenia które zaszły w tym takcie na serwerze:

| Typ | Co zawiera | Kiedy wysyłany |
|---|---|---|
| 1 | nowi gracze: `[id, name, skin_id]` | gdy ktoś dołączył w tym takcie |
| 2 | gracze którzy wyszli: `[id]` | gdy ktoś się rozłączył |
| 5 | zabici gracze: `[id]` | gdy ktoś zginął |
| 6 | odrodzeni gracze: `[id]` | gdy ktoś się odrodził (respawn) |
| 8 | wiadomości czatu: `[id, message]` | gdy ktoś napisał na czacie |
| 9 | leaderboard top 6: `[id, byte_point]` | gdy ranking się zmienił |
| 13 | zmiany skinów: `[id, skin_id]` | gdy ktoś zmienił skin |

**Część per-player** — unikalna dla każdego gracza, dopisywana osobno. Serwer cofa kursor do punktu `end_global()` i nadpisuje tę część dla kolejnego gracza — dzięki temu część globalna nie jest kopiowana, tylko raz siedzi w buforze:

| Typ | Co zawiera | Kiedy wysyłany |
|---|---|---|
| 0 | pozycje widzialnych graczy: `[id, x, y, event_use]` | **zawsze**, co takt |
| 10 | nowa pozycja w rankingu: `[ranking_id, byte_point]` | gdy pozycja gracza zmieniła się w tym takcie |
| 11 | zmiana eventu (punkty życia): `[event]` wartość 0–10 | patrz opis poniżej |
| 12 | nagroda po śmierci: `[uint32 punkty]` | raz — gdy gracz zginął i serwer wyliczył nagrodę |

**Event (typ 11)** to liczba punktów życia gracza w zakresie 0–10. Gracz startuje z wartością 1. Im wyższa wartość, tym więcej uderzeń w czerwone platformy gracz może przeżyć:

- `event = 10` — pełna ochrona, gracz może przyjąć 5 uderzeń zanim zginie
- `event = 1`  — stan startowy, jedno uderzenie w czerwoną platformę i gracz ginie
- `event = 0`  — gracz ginie od następnego zetknięcia z czerwoną platformą

Zmiana eventu następuje gdy:
- gracz uderzy w **czerwoną platformę** → `−2`
- gracz **przejdzie checkpoint** → `+1` (do max 10)
- gracz **zabije innego gracza** → `+1` dla zabójcy (do max 10)
- gracz **użyje eventu** (naciśnie przycisk aktywacji) → `−1`

Typ 11 wysyłany jest zawsze gdy `event` się zmieni — klient aktualizuje na tej podstawie wyświetlane ikony serc.

Typ 0 wysyła tylko graczy z 7 sąsiednich segmentów cylindra (lvl−2 do lvl+4) — gracz na poziomie 10 nie dostaje pozycji gracza na poziomie 50. To główna optymalizacja rozmiaru pakietu przy dużej liczbie graczy na serwerze.

```
Bufor w trakcie budowania:
[ CZĘŚĆ GLOBALNA (identyczna dla wszystkich) | CZĘŚĆ PER-PLAYER (unikalna dla gracza X) ]
  ↑                                          ↑
  index=0                              global_index (checkpoint)
```

```javascript
// apps/shared/binary.js

// end_global() — wywołaj po zakończeniu budowania wspólnej części
// Zapamiętuje aktualną pozycję jako "checkpoint" — tu zacznie się część per-player
this.end_global = function() {
    this.global_index = this.index;    // zapamiętaj pozycję (koniec części globalnej)
    this.global_c     = this.int8[0];  // zapamiętaj licznik bloków w tym momencie
};

// get_uniq_buf() — wywołaj po dopisaniu części per-player dla jednego gracza
// Zwraca bufor GLOBALNY + PER-PLAYER dla tego gracza, po czym cofa kursor
// do checkpointu — gotowy na per-player następnego gracza
this.get_uniq_buf = function() {
    const b = this.buffor.slice(0, this.index);  // skopiuj: globalny + per-player tego gracza
    this.index   = this.global_index;            // cofnij do checkpointu (usuń per-player z bufora)
    this.int8[0] = this.global_c;                // przywróć licznik bloków
    return b;
};

// clear_uniq_buf() — odrzuć per-player bez wysyłania (np. klient nie nadąża z odbiorem)
// Działa jak get_uniq_buf() ale nie tworzy kopii bufora — szybsze, gdy pakiet jest pomijany
this.clear_uniq_buf = function() {
    this.index   = this.global_index;
    this.int8[0] = this.global_c;
};

// clear() — wyczyść cały bufor (globalny + per-player), zacznij od zera
// Wywołaj po obsłużeniu wszystkich graczy, na koniec każdego taktu
this.clear = function() {
    this.index   = 1;
    this.int8[0] = 0;
};
```

**Jak wygląda jeden takt w Child (`gen_packet()`):**

```javascript
// KROK 1 — zbuduj część globalną
// Zdarzenia z tego taktu: nowi gracze, zabici, czat, ranking, zmiany skinów.
// Każde zdarzenie to osobny blok new_type(). Jeśli nic się nie zmieniło — blok nie jest dodawany.
if (joined_players.length) { p.new_type(1); /* id, name, skin_id każdego */ }
if (killed_players.length) { p.new_type(5); /* id każdego zabitego      */ }
if (send_ranking)          { p.new_type(9); /* top 6: id, byte_point    */ }
// ...itd. dla typów 2, 6, 8, 13

p.end_global();
// ↑ Zapamiętaj pozycję — tu kończy się część globalna, zaczyna per-player.
// Stan bufora: [======== GLOBALNY ========|                    ]
//                                          ↑ kursor zatrzymany tutaj

// KROK 2 — dla każdego gracza osobno dopisz jego część i wyślij
for (const i in players) {
    const pl = players[i];
    if (pl.bot) continue;  // boty nie mają socketów

    // Dopisz bloki unikalne dla TEGO gracza — tylko te które go dotyczą w tym takcie:
    if (pl.send_rank_pos)    { p.new_type(10); /* nowa pozycja rankingowa */ }
    if (pl.event_send)       { p.new_type(11); /* zmiana eventu (życia)  */ }
    if (pl.send_points >= 0) { p.new_type(12); /* nagroda po śmierci     */ }
    p.new_type(0);  // pozycje widzialnych graczy — wysyłane zawsze

    // Stan bufora: [======== GLOBALNY ========|==== PER-PLAYER gracza A ====]

    if (pl.socket.getBufferedAmount() < 256 * 1024) {
        pl.socket.send(p.get_uniq_buf(), true);
        // Wysyła: GLOBALNY + PER-PLAYER gracza A.
        // Cofa kursor do checkpointu → PER-PLAYER A znika z bufora.
        // Stan bufora: [======== GLOBALNY ========|                    ]
        //                                          ↑ kursor z powrotem tu
    } else {
        p.clear_uniq_buf();
        // Przeglądarka nie nadąża (za wolne łącze) → pomiń tę klatkę dla niego.
        // Też cofa kursor — gotowy na per-player następnego gracza.
    }
    // Gracz B dostanie: [======== GLOBALNY ========|==== PER-PLAYER gracza B ====]
    // Globalna część jest w buforze TYLKO RAZ — nie jest kopiowana dla każdego gracza.
}

// KROK 3 — po obsłużeniu wszystkich graczy wyczyść cały bufor
p.clear();  // kursor wraca na pozycję 1, licznik bloków = 0 — gotowy na następny takt
```

---

## 4. Przykłady z kodu (implementacja)

### Budowanie pakietu pozycji (Child → Przeglądarka)

Poniższy fragment to część per-player z `gen_packet()` — wykonywana raz dla każdego gracza w każdym takcie gry. Pokazuje jak zbudować blok typ 0 (pozycje widzialnych graczy) z optymalizacją polegającą na rezerwacji bajtu na liczbę graczy przed iteracją.

```javascript
// apps/child-gameserver/main.js : linia ~3290

for (const i in players) {
    const pl = players[i];
    if (pl.bot) continue;  // boty nie mają socketów — pomijamy

    // Blok typ 0 — pozycje graczy widzialnych z pozycji tego gracza
    p.new_type(0);

    // TRICK: nie wiemy ile graczy będzie widocznych zanim przejdziemy przez segmenty.
    // Zamiast liczyć ich dwa razy — rezerwujemy 1 bajt na liczbę graczy,
    // zbieramy dane, a na końcu wstawiamy liczbę "wstecz" w zarezerwowane miejsce.
    let count = 0;
    const countIndex = p.index;  // zapamiętaj pozycję bajtu na count
    p.index++;                   // przesuń kursor — bajt zarezerwowany, ale jeszcze pusty

    // Iteruj przez 7 sąsiednich segmentów cylindra (lvl−2 do lvl+4)
    // Gracz widzi tylko graczy na zbliżonym poziomie — nie cały serwer.
    for (let seg = pl.lvl - 2; seg < pl.lvl + 5; seg++) {
        if (!segment_player[seg]) continue;  // ten segment jest pusty — pomiń

        count += segment_player[seg].length;
        for (const visible of segment_player[seg]) {
            p.s_int8(visible.id);          // 1 bajt:  ID gracza
            p.s_float(visible.x);          // 4 bajty: pozycja X (float32)
            p.s_float(visible.y);          // 4 bajty: pozycja Y (float32)
            p.s_int8(visible.event_use);   // 1 bajt:  stan eventu (używany przez klienta do animacji)
            // Łącznie: 10 bajtów na jednego widocznego gracza
        }
    }

    p.int8[countIndex] = count;
    // Wstaw liczbę graczy w zarezerwowane miejsce.
    // Przeglądarka odczyta najpierw count, a potem dokładnie count × 10 bajtów danych.

    // Wyślij GLOBALNY + per-player tego gracza — ale tylko jeśli klient nadąża
    if (pl.socket.getBufferedAmount() < 256 * 1024) {
        pl.socket.send(p.get_uniq_buf(), true);  // true = tryb binarny
        // Po wysłaniu kursor cofa się do checkpointu end_global() —
        // część globalna zostaje w buforze, per-player jest "usunięty"
    } else {
        p.clear_uniq_buf();
        // Przeglądarka ma > 256 KB w kolejce wysyłki — łącze nie nadąża.
        // Pomijamy tę klatkę żeby nie pogarszać opóźnienia (lag snowball effect).
        // Kursor cofa się tak samo jak po get_uniq_buf() — gotowy na następnego gracza.
    }
}

p.clear();  // koniec taktu — wyczyść cały bufor (globalny + per-player)
```

### Parsowanie pakietu od klienta (Mother)

Każda wiadomość WebSocket od klienta zaczyna się od dwóch bajtów nagłówka: liczby bloków (bajt [0]) i typu pierwszego bloku (bajt [1]). Mother odczytuje typ i na tej podstawie wywołuje odpowiednią funkcję obsługi, przekazując jej dalszą część bufora do samodzielnego odczytu.

```javascript
// apps/mother-lobby/main.js : linia 1083
message: function (ws, message, isBinary) {
    const p = new packet_get();
    p.set_buffer(message);  // załaduj odebrany bufor do kursora

    p.g_int8();             // bajt [0] = liczba bloków — Mother nie używa, pomija
    switch (p.g_int8()) {   // bajt [1] = typ pakietu — decyduje co klient chce zrobić
        // Kursor stoi teraz na bajcie [2] — pierwszym bajcie danych właściwych.
        // Każda funkcja handleXxx(p, ws) samodzielnie wywołuje p.g_*() żeby odczytać
        // kolejne pola w tej samej kolejności w jakiej klient je zapisał.

        case 0: handleJoinGame(p, ws);     break; // dołącz do serwera gry (gameId, name, skinId, accountId)
        case 1: handleFetchAccount(p, ws); break; // pobierz dane konta (accountId, name)
        case 2: handleBuySkin(p, ws);      break; // kup skina za punkty (skinId, accountId)
        case 3:
        case 4: handleChangeName(p, ws);   break; // zmień nick konta (accountId, newName) — typ 3 i 4 identyczne
        case 5: handleReconnect(p, ws);    break; // reconnect po zerwaniu WS (gameId, gameToken, accountId)
        case 6: sendGamesPacket(ws);       break; // wyślij aktualną listę gier (bez danych z bufora)
    }
}
```

## 5. Typy danych — tabela referencyjna

| Metoda zapisu | Metoda odczytu | Bajty | Zakres |
|---|---|---|---|
| `s_uint8` / `s_int8` | `g_uint8` / `g_int8` | 1 | 0–255 / -128–127 |
| `s_uint16` / `s_int16` | `g_uint16` / `g_int16` | 2 | 0–65535 / -32768–32767 |
| `s_uint32` / `s_int32` | `g_uint32` / `g_int32` | 4 | 0–4 294 967 295 / −2 147 483 648–2 147 483 647 |
| `s_float` | `g_float` | 4 | float32 (7 cyfr) |
| `s_string` | `g_string` | 1+N | ASCII, max 255 znaków |
| `s_string16` | `g_string16` | 1+N×2 | UTF-16, max 255 znaków |
| `s_int8_arr` | `g_int8_arr` | 2+N | tablica uint8 |
| `s_int32_arr` | `g_int32_arr` | 2+N×4 | tablica int32 |
| `s_string_arr` | `g_string_arr` | 2+N×(1+len) | tablica stringów ASCII |
