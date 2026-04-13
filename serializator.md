# Protokoł binarny — `binary.js` + `mother.js`

---

## 1. Mapowanie typów — pola obiektów → metody binary.js

### 1a. Pakiety wychodzące z `mother.js` do klienta

#### Type 0 — odpowiedź join (token + adres serwera gry)
Budowany przez `handleJoinGame()` w `mother.js`.

| Pole | Wartość przykładowa | Metoda `packet_set` | Rozmiar |
|------|--------------------|--------------------|---------|
| `token` | `3482901234` | `ps.s_uint32(token)` | 4B |
| `port` | `30542` | `ps.s_uint16(port)` | 2B |
| `ip` | `"34.89.123.45"` | `ps.s_string(ip)` | 1B + NB |

Łącznie: **~20B** (ip ≈ 13 znaków ASCII)

---

#### Type 1 — dane konta gracza
Budowany przez `send_account(ws, user)` w `mother.js`.

| Pole | Typ JS | Metoda `packet_set` | Rozmiar |
|------|--------|--------------------|----|
| `user.email` | `string` | `ps.s_string16(user.email)` | 1B len + N×2B |
| `user.points` | `number` | `ps.s_uint32(user.points)` | 4B |
| `user.total_points` | `number` | `ps.s_uint32(user.total_points)` | 4B |
| `user.name` | `string` | `ps.s_string16(user.name)` | 1B len + N×2B |
| `user.skin` | `number[]` | `ps.s_int8_arr(user.skin, user.skin.length)` | 2B len + NB |
| `user.acc_data` | `string[]` | `ps.s_string_arr(user.acc_data, ...)` | 2B len + … |

Łącznie: **~200–400B** (zależnie od długości email/nicku/liczby skinów)

---

#### Type 2 — lista serwerów gier
Budowany przez `buildGamesPacket()` w `mother.js` z danymi z Redis.

| Pole | Źródło w Redis | Metoda `packet_set` | Rozmiar |
|------|---------------|--------------------|----|
| `games.length` | — | `lps.s_length8(games.length)` | 1B |
| `g.id` | `game_ids SET` | `lps.s_uint32(g.id)` | 4B |
| `g.g_players_len` | `game:{id} HASH` | `lps.s_uint8(parseInt(g.g_players_len) \|\| 0)` | 1B |
| `g.g_players_lim` | `game:{id} HASH` | `lps.s_uint8(parseInt(g.g_players_lim) \|\| 0)` | 1B |
| `g.serv_loc` | `game:{id} HASH` | `lps.s_string(g.serv_loc \|\| '')` | 1B + NB |
| `g.serv_name` | `game:{id} HASH` | `lps.s_string(g.serv_name \|\| ...)` | 1B + NB |

Na serwer: ~10B. Przy 5 serwerach: **1 + 5×10 = ~51B**

---

#### Type 3 — ceny i kolory skinów
Budowany w bloku `open` connection w `mother.js`.

| Pole | Wartość | Metoda `packet_set` | Rozmiar |
|------|---------|--------------------|----|
| `SKIN_COSTS` (23 elementy) | `[0, 500, 1200, ...]` | `ps.s_int32_arr(SKIN_COSTS, SKIN_COSTS.length)` | 2B + 23×4B = 94B |
| `SKIN_LIGHTS` (23 elementy) | `[0x00d4ff, ...]` | `ps.s_int32_arr(SKIN_LIGHTS, SKIN_LIGHTS.length)` | 2B + 23×4B = 94B |

Łącznie: **190B** (stały rozmiar)

---

#### Type 4 — serwer pełny
Brak danych — sam bajt typu jest sygnałem.

| Pole | Metoda | Rozmiar |
|------|--------|---------|
| — | `ps.new_type(4)` | 1B |

---

### 1b. Pakiety przychodzące do `mother.js` od klienta

Format wejściowy: `[count: 1B] [type: 1B] [data...]`
Odczyt: `p.g_int8()` (skip count) → `switch(p.g_int8())` (type)

#### Case 0 — `handleJoinGame`

| Pole | Metoda `packet_get` | Rozmiar | Uwagi |
|------|--------------------|----|------|
| `gameId` | `p.g_uint32()` | 4B | ID serwera gry z listy |
| `name` | `p.g_string16()` | 1B + N×2B | Nick sesji (max 9 znaków) |
| `skinId` | `p.g_uint8()` | 1B | Wybrany skin (0–22) |
| `accountId` | `p.g_string()` | 1B + NB | ObjectId lub `""` dla gościa |

#### Case 1 — `handleFetchAccount`

| Pole | Metoda `packet_get` | Rozmiar |
|------|--------------------|----|
| `accountId` | `p.g_string()` | 1B + 24B (ObjectId hex) |

#### Case 2 — `handleBuySkin`

| Pole | Metoda `packet_get` | Rozmiar |
|------|--------------------|----|
| `accountId` | `p.g_string()` | 1B + 24B |
| `buyId` | `p.g_uint8()` | 1B |

#### Case 3/4 — `handleChangeName`

| Pole | Metoda `packet_get` | Rozmiar |
|------|--------------------|----|
| `accountId` | `p.g_string()` | 1B + 24B |
| `name` | `p.g_string16()` | 1B + N×2B |

#### Case 5 — `handleReconnect`

| Pole | Metoda `packet_get` | Rozmiar | Uwagi |
|------|--------------------|----|------|
| `gameId` | `p.g_uint32()` | 4B | |
| `playerId` | `p.g_uint32()` | 4B | Odczytany ale **ignorowany** (TODO) |
| `accountId` | `p.g_string()` | 1B + 24B | |

---

## 2. Architektura pakietu

### 2.1 Struktura nagłówka i ładunku

```
┌───────────────────────────────────────────────────────────────────────┐
│                       Pakiet WebSocket                                │
├──────────┬──────────┬──────────────────┬──────────┬──────────────────┤
│  count   │  type_0  │    data_0...     │  type_1  │    data_1...     │
│  1 bajt  │  1 bajt  │  N bajtów        │  1 bajt  │  M bajtów        │
│ (uint8)  │ (uint8)  │                  │ (uint8)  │                  │
└──────────┴──────────┴──────────────────┴──────────┴──────────────────┘
   header    └──────────────── payload (może zawierać wiele komend) ──┘
```

- **Bajt 0 (`count`)** — ile komend zawiera ten pakiet. `packet_set` inicjalizuje `index=1` i inkrementuje `int8[0]` przy każdym `new_type()`.
- **Każda komenda:** `[type: 1B] [data...]` bez separatora końcowego.
- Jeden pakiet WebSocket może zawierać **wiele komend naraz** — oszczędność na narzucie WebSocket frame headers.

### 2.2 Porządek bajtów (Endianness)

**Big-Endian** — starszy bajt zapisywany jako pierwszy.

Dowód z `binary.js`:

```js
// s_int16 — ręczna implementacja big-endian
this.s_int16 = function(val) {
    this.int8[this.index]   = val >> 8;    // ← starszy bajt PIERWSZY
    this.int8[this.index+1] = val & 0xff;  // ← młodszy bajt drugi
    this.index += 2;
}

// DataView bez flagi littleEndian = domyślnie Big-Endian
this.DV.setInt32(this.index, val);          // Big-Endian
this.DV.setFloat32(this.index, val);        // Big-Endian
this.d.getInt32(this.index-4);              // Big-Endian
```

Przykład — liczba `30542` (port serwera) zapisana jako `uint16`:
```
30542 = 0x774E
Bajt [0] = 0x77  (starszy)
Bajt [1] = 0x4E  (młodszy)
```

### 2.3 Length-prefixing

Protokół używa **wyłącznie length-prefixing** — brak terminatorów (null-byte itp.).

| Typ danych | Prefix długości | Maks. rozmiar |
|-----------|----------------|---------------|
| `string` (ASCII) | `uint8` — 1B | 255 znaków |
| `string16` (UTF-16) | `uint8` — 1B | 255 znaków × 2B = 510B |
| Tablice (`int8_arr`, `int32_arr`, ...) | `uint16` — 2B (big-endian) | 65 535 elementów |

---

## 3. Logika serializacji (Object → Binary)

### 3.1 Normalny tryb — `get_buf()`

```
1. new packet_set(size)
   └─ Alokuje ArrayBuffer(size), index = 1 (byte[0] zarezerwowany na count)

2. new_type(n)
   └─ int8[0]++              (inkrementuj count)
   └─ int8[index] = n        (zapisz typ)
   └─ index++

3. s_uint32(val)
   └─ DV.setInt32(index, val) (big-endian, 4 bajty)
   └─ index += 4

4. s_string16(val)
   └─ int8[index] = val.length  (długość w znakach, 1 bajt)
   └─ index++
   └─ for każdy znak: DV.setInt16(index, charCode), index += 2

5. get_buf()
   └─ buffor.slice(0, index)   (przytnij do faktycznej długości)
   └─ index = 1, int8[0] = 0   (reset do ponownego użycia)
   └─ zwraca ArrayBuffer gotowy do ws.send()
```

### 3.2 Tryb dual-buffer — `end_global()` / `get_uniq_buf()`

Mechanizm pozwala zbudować wspólny prefix pakietu raz, a następnie doklejać dane per-odbiorca N razy bez realokacji:

```
┌─────────────────────────────────────────────────────┐
│  [count][type][globalne dane wspólne dla wszystkich] │ ← end_global() zapisuje tutaj checkpoint
└────────────┬────────────────────────────────────────┘
             │
             ├── [per-player dane gracza A] → get_uniq_buf() → ws_A.send()
             │   (cofa wskaźnik do checkpointu)
             ├── [per-player dane gracza B] → get_uniq_buf() → ws_B.send()
             │   (cofa wskaźnik do checkpointu)
             └── [per-player dane gracza C] → get_uniq_buf() → ws_C.send()
```

```js
// W child.js (serwer gry)
p.end_global();                           // zapisz checkpoint po globalnych danych
for (const player of humanPlayers) {
    writePerPlayerData(player, p);         // dopisz dane specyficzne dla tego gracza
    player.socket.send(p.get_uniq_buf()); // wyślij i cofnij wskaźnik do checkpointu
}
```

### 3.3 Obsługa tablic — `s_int8_arr(ptr, siz)`

```
Zapis tablicy [3, 7, 12] (3 elementy):

Bajt 0: 0x00  ┐ uint16 big-endian = 3 (liczba elementów)
Bajt 1: 0x03  ┘
Bajt 2: 0x03     element [2] (iteracja wstecz: u--)
Bajt 3: 0x07     element [1]
Bajt 4: 0x0C     element [0]
```

Uwaga: pętla w `s_int8_arr` iteruje **od końca** (`for (var u = siz; u--)`), ale odbiorca (`g_int8_arr`) też iteruje od końca — symetrycznie, więc kolejność w tablicy jest zachowana.

---

## 4. Logika deserializacji (Binary → Object)

### 4.1 Przepływ odczytu

```
1. set_buffer(packet.data)
   └─ DataView = new DataView(ArrayBuffer)
   └─ index = 0  (reset na początek)

2. g_length8()  [= g_uint8()]
   └─ odczytaj bajt[0] = liczba komend
   └─ index = 1

3. for każdej komendy:
   └─ g_uint8() → typ komendy, index++
   └─ switch(typ) → czytaj odpowiednie pola sekwencyjnie

4. Każde g_*() przesuwa wskaźnik o odpowiednią liczbę bajtów:
   g_uint8()  → index += 1
   g_uint16() → index += 2
   g_uint32() → index += 4
   g_float()  → index += 4
   g_string() → index += 1 (len) + len×1
   g_string16()→ index += 1 (len) + len×2
```

### 4.2 Warunki zatrzymania

Brak jawnego terminatora lub flagi stopu. Zatrzymanie jest **strukturalne** — wynika z bajtu `count`:

```js
for (let i = p.g_length8(); i--;) {  // czytaj dokładnie `count` razy
    switch (p.g_uint8()) {
        case X: /* czytaj znane pola */ break;
    }
}
// po pętli: wskaźnik jest dokładnie za ostatnim bajtem ostatniej komendy
```

### 4.3 Odczyt tablic (g_int8_arr)

```js
this.g_int8_arr = function() {
    var tab = [];
    var l = this.g_uint16();          // czytaj 2B = liczba elementów
    for (var i = l; i--;)             // iteruj wstecz (tab[l-1], tab[l-2], ..., tab[0])
        tab[i] = this.g_uint8();      // każdy element = 1B
    return tab;
}
```

Wynikowa tablica ma poprawną kolejność pomimo iteracji wstecz — `i--` wypełnia od ostatniego indeksu do 0.

---

## 5. Bezpieczeństwo i punkty krytyczne

### 5.1 Brak sprawdzania granic bufora przy odczycie

`packet_get` nie sprawdza czy `index` nie przekroczył rozmiaru bufora. `DataView` rzuci `RangeError` przy przekroczeniu granic.

```js
// g_uint32 — brak ochrony
this.g_uint32 = function() {
    this.index += 4;
    return this.d.getUint32(this.index - 4);  // RangeError jeśli (index-4) >= buffer.byteLength
}
```

**Skutek:** Złośliwie skrócony pakiet od klienta spowoduje wyjątek. W `mother.js` jest to obsługiwane przez `try/catch` w handlerach, ale bez logowania — cicha utrata żądania:

```js
// mother.js — handleJoinGame
try {
    gameId    = p.g_uint32();
    name      = p.g_string16();
    // ...
} catch (e) { /* puste — błąd parsowania = pomiń całe żądanie */ }
```

**Ryzyko:** DoS przez wysyłanie tysięcy celowo skróconych pakietów. `try/catch` bez rate-limitingu daje pełny dostęp do tej ścieżki.

---

### 5.2 Silent overflow przy zapisie — `packet_set`

`packet_set` alokuje bufor o stałym rozmiarze. Zapis poza granicę:

```js
// Uint8Array — zapis poza granicę jest CICHO IGNOROWANY (nie rzuca wyjątku)
this.int8[this.index] = val;  // jeśli index >= buffor.byteLength → nic się nie dzieje

// DataView — zapis poza granicę RZUCA RangeError
this.DV.setInt32(this.index, val);  // jeśli index+4 > buffor.byteLength → RangeError
```

Dwie różne zachowania dla tego samego bufora — niespójność. Możliwe jest **ciche ucięcie danych** bez żadnego błędu jeśli bufor (1000B w `ps`) okaże się za mały dla dużego pakietu.

---

### 5.3 Przepełnienie długości stringa (`s_string`)

`s_string` zapisuje długość jako `uint8` (1 bajt, max 255). Jeśli string ma > 255 znaków:

```js
this.s_string = function(val) {
    var sl = val.length;          // np. 300
    this.int8[this.index] = sl;   // 300 & 0xFF = 44 → zapisze 44 zamiast 300!
    this.index++;
    for (var i = 0; i < sl; i++) {  // ale pętla zapisze 300 znaków!
        this.int8[this.index] = val.charCodeAt(i);
        this.index++;
    }
}
```

**Skutek:** Odbiorca odczyta długość = 44, przeczyta 44 bajty, a pozostałe 256 bajtów stringa zostanie zinterpretowane jako następna komenda — **korupcja całego pakietu**.

`s_string16` ma ten sam problem (length jako `uint8`).

---

### 5.4 Brak walidacji zawartości stringów (XSS)

Nicki graczy i wiadomości czatu są przesyłane bez sanityzacji. Jeśli frontend renderuje je jako `innerHTML` zamiast `textContent` — możliwy XSS.

---

### 5.5 `playerId` odczytany ale nieużywany w reconnect

```js
// handleReconnect — mother.js
gameId    = p.g_uint32();
p.g_uint32();   // playerId — odczytany tylko po to żeby przesunąć wskaźnik (TODO)
accountId = new ObjectId(p.g_string());
```

Jeśli klient wyśle sfałszowany `playerId`, serwer go zignoruje — bez skutków. Ale sugeruje niekompletną implementację reconnect.

---

### 5.6 Globalny `ps` współdzielony

```js
const ps = new packet_set(1000);  // jeden globalny bufor w mother.js
```

Node.js jest jednowątkowy, więc nie ma race condition. Ale `buildGamesPacket()` jest `async` — słusznie tworzy **lokalny** `lps` zamiast używać globalnego `ps`:

```js
async function buildGamesPacket() {
    const lps = new packet_set(10000);  // lokalny — bezpieczne wielokrotne wywołania async
    // ...
}
```

Gdyby `buildGamesPacket` używała globalnego `ps` i oczekiwała na `await redis.sMembers()` — inny handler mógłby nadpisać `ps` w tym czasie.

---

## Podsumowanie techniczne

| Właściwość | Wartość |
|------------|---------|
| **Endianness** | Big-Endian (DataView default + ręczna implementacja s_int16) |
| **Nagłówek pakietu** | 1 bajt `count` — liczba komend w pakiecie |
| **Framing** | Length-prefixing (brak terminatorów) |
| **String ASCII** | 1B długość + N×1B znaków (max 255 znaków) |
| **String UTF-16** | 1B długość + N×2B znaków (max 255 znaków = 510B) |
| **Tablice** | 2B długość uint16 + N×elementy |
| **Float** | IEEE 754 float32, 4B, big-endian |
| **Mechanizm dual-buffer** | `end_global()` / `get_uniq_buf()` — fork pakietu bez realokacji |
| **Główne ryzyko** | Silent overflow `s_string > 255 znaków` korupcja pakietu |
| **Obsługa błędów** | `try/catch` bez logowania w handlerach — cichy drop złośliwych pakietów |

---

# Uzasadnienie wyboru własnego serializatora binarnego

---

## Problem, który trzeba było rozwiązać

Serwer gry (`child.js`) wysyła dane o pozycjach wszystkich graczy **co 16 milisekund**
(60 razy na sekundę). Przy założeniu 15 graczy + 37 botów = **52 obiekty ruchu na tick**.

Każdy obiekt to 4 pola: `id`, `x`, `y`, `event_use`.

Pytanie projektowe brzmiało: **w jakim formacie te dane przesłać?**

---

## Dlaczego nie JSON?

JSON jest domyślnym wyborem w aplikacjach webowych. Sprawdźmy jednak jak wyglądałby
jeden pakiet pozycji dla 3 graczy w JSON-ie versus w protokole binarnym z tej gry.

### JSON — jak wyglądałby pakiet

```json
[
  {"id":5,"x":256.0,"y":-400.0,"event_use":-2},
  {"id":12,"x":288.0,"y":-416.0,"event_use":-3},
  {"id":1,"x":252.0,"y":-384.0,"event_use":-1}
]
```

**Rozmiar:** ~105 bajtów (jako UTF-8 string)

**Dlaczego JSON jest tak duży?** Bo JSON to format tekstowy — każda wartość musi być
otoczona kontekstem czytelnym dla człowieka:
- Nazwy pól (`"id"`, `"x"`, `"y"`, `"event_use"`) powtarzają się przy **każdym** obiekcie.
  Sama nazwa `"event_use"` to 11 znaków = 11 bajtów, i pojawia się 3 razy = 33 bajty
  tylko na nazwę jednego pola.
- Liczba `256.0` to 5 znaków tekstowych (5 bajtów), choć jako float32 zajmuje dokładnie 4 bajty.
- Separatory (`{`, `}`, `[`, `]`, `:`, `,`, spacje) to dodatkowe bajty bez żadnej wartości
  informacyjnej dla odbiorcy — służą wyłącznie parserowi tekstu.

Odbiorca (frontend) i tak **z góry wie** jakie pola i w jakiej kolejności przychodzą —
ta wiedza jest zakodowana w funkcji deserializującej. Nazwy pól w JSON-ie są więc
całkowicie redundantne: płacimy za nie pasmem sieciowym przy każdym ticku.

### Własny format binarny — ten sam pakiet

```
03                        ← liczba graczy: 1 bajt (uint8)
05                        ← id=5: 1 bajt (int8)
43 80 00 00               ← x=256.0: 4 bajty (float32 big-endian)
C3 C8 00 00               ← y=-400.0: 4 bajty (float32 big-endian)
FE                        ← event_use=-2: 1 bajt (int8)
--- (razem 10 bajtów na gracza)
0C 43 90 00 00 C3 D0 00 00 FD   ← gracz id=12
01 43 7C 00 00 C3 C0 00 00 FF   ← gracz id=1
```

**Rozmiar:** 31 bajtów

**Dlaczego format binarny jest tak mały?** Bo każda decyzja projektowa eliminuje
redundancję:

- **Brak nazw pól.** Obie strony (serwer i klient) uzgodniły z góry, że bajty idą
  w kolejności: `id → x → y → event_use`. Nie ma potrzeby tego powtarzać w każdej
  wiadomości — to wiedza zakodowana raz w kodzie, nie przesyłana co 16ms.

- **Typy dobrane do zakresu danych, nie do wygody.**
  - `id` gracza mieści się w zakresie 0–254 → wystarczy `int8` (1 bajt).
    W JSON-ie liczba `12` to 2 znaki (2 bajty), a `254` to 3 znaki (3 bajty).
  - `x` i `y` to pozycje zmiennoprzecinkowe → `float32` (4 bajty).
    `float64` (domyślny typ w JavaScript) dałby podwójną precyzję, której gra nie potrzebuje,
    za podwójną cenę (8 bajtów zamiast 4). `float32` daje precyzję do ~7 cyfr
    dziesiętnych — wystarczającą dla pozycji gracza na planszy.
  - `event_use` to liczba z zakresu -3..N (kilka wartości) → wystarczy `int8` (1 bajt).

- **Liczba elementów na początku, nie separator na końcu.**
  Zamiast `]` zamykającego tablicę (który wymaga przeczytania całości żeby wiedzieć
  że tablica się skończyła), bajt `03` na początku mówi od razu: "czytaj dokładnie
  3 obiekty". Odbiorca wie kiedy skończyć bez szukania separatora.

- **Brak konwersji tekst ↔ liczba.**
  JSON wymaga zamiany ciągu znaków `"256.0"` na liczbę przy każdym odczycie.
  Binarny format przechowuje już gotowe bity reprezentacji IEEE 754 —
  `DataView.getFloat32()` to jedno wywołanie bez żadnego parsowania.

### Porównanie dla pełnej gry (52 graczy/botów, co tick)

| Format | Rozmiar jednego pakietu pozycji | Dane/sekundę (60 tick/s) | Dane/minutę |
|--------|-------------------------------|--------------------------|-------------|
| JSON | ~1 820 bajtów | ~109 KB/s | ~6.5 MB |
| Własny binarny | ~521 bajtów | ~31 KB/s | ~1.9 MB |
| **Oszczędność** | **3.5× mniej** | **3.5× mniej** | **3.5× mniej** |

I to tylko dla jednego rodzaju pakietu. W każdym ticku idą też pakiety rankingu,
zdarzeń, czatu itd. — efekt kumuluje się.

Przy 15 podłączonych graczach serwer wysyła **15 różnych wersji pakietu pozycji**
(każdy gracz widzi innych — patrz mechanizm dual-buffer). Przy JSON-ie koszt
serializacji (`JSON.stringify`) byłby wywoływany 15 razy na tick = 900 razy na sekundę.
Własny format serializuje dane globalne **raz**, a dopiero część per-gracza osobno.

---

## Dlaczego nie gotowe biblioteki binarne?

Skoro JSON jest za duży, można by sięgnąć po gotowe binarne serializatory.
Poniżej analiza najpopularniejszych alternatyw.

### MessagePack

MessagePack to binarny odpowiednik JSON — serializuje te same struktury (mapy, tablice,
stringi) ale w mniejszej formie. Dla obiektu `{id:5, x:256.0, y:-400.0, event_use:-2}`:

```
Bajty MessagePack:
84              ← mapa 4-elementowa
a2 69 64        ← klucz "id" (3 bajty: typ + 2 znaki)
05              ← wartość 5
a1 78           ← klucz "x" (2 bajty)
ca 43800000     ← float32 256.0 (5 bajtów: typ + 4 bajty)
a1 79           ← klucz "y"
ca c3c80000     ← float32
aa 65 76 65 6e 74 5f 75 73 65  ← klucz "event_use" (11 bajtów!)
ff              ← wartość -1
```

**Rozmiar jednego obiektu gracza: ~35 bajtów**

W własnym formacie: **10 bajtów** (id=1B + x=4B + y=4B + event=1B).

MessagePack wciąż przesyła **nazwy pól** przy każdym obiekcie. W protokole tej gry
kolejność pól jest z góry znana obu stronom — nazwy pól są **redundantne**.

### Protocol Buffers (Protobuf) — Google

Protobuf eliminuje nazwy pól (używa numerów) i jest bardzo wydajny. Wymagałby jednak:

1. Napisania pliku `.proto` ze schematem
2. Wygenerowania kodu JS przez kompilator `protoc`
3. Dodania biblioteki `protobufjs` (~150KB) do projektu frontendu
4. Nauki składni `.proto` i jej utrzymania przy każdej zmianie protokołu

Dla gry pisanej od zera, gdzie protokół jest projektowany równolegle z kodem,
narzut narzędziowy Protobuf jest **nieproporcjonalnie duży** względem korzyści.
Własny serializer w `binary.js` ma **302 linie kodu** i zero zależności zewnętrznych.

### FlatBuffers — Google

FlatBuffers pozwala na odczyt danych bez deserializacji (zero-copy). Jest szybszy niż
Protobuf, ale jeszcze bardziej rozbudowany narzędziowo. Ten sam problem co Protobuf —
overkill dla projektu tej skali.

### Podsumowanie porównania alternatyw

| Serializator | Rozmiar dla 52 graczy | Zależności | Narzut narzędziowy | Kontrola nad layoutem |
|-------------|----------------------|------------|--------------------|-----------------------|
| JSON | ~1820 B | brak | brak | brak |
| MessagePack | ~700 B | npm: msgpack | mały | częściowa |
| Protobuf | ~530 B | npm: protobufjs + kompilator | duży | przez schemat |
| FlatBuffers | ~520 B | npm: flatbuffers + kompilator | bardzo duży | przez schemat |
| **Własny binarny** | **~521 B** | **brak** | **brak** | **pełna** |

Własny format osiąga **identyczny rozmiar** co Protobuf/FlatBuffers, ale **bez żadnych
zależności i bez narzędzi zewnętrznych**.

---

## Konkretne powody projektowe

### 1. Pełna kontrola nad layoutem bajtów

Własny serializer pozwala na **precyzyjne decyzje** niemożliwe w gotowych bibliotekach:

```javascript
// Dual-buffer — globalne dane serializowane RAZ, per-player doklejane N razy
p.end_global();           // zapisz checkpoint
for (const player of humanPlayers) {
    writePerPlayerData(player, p);
    player.socket.send(p.get_uniq_buf()); // global + per-player, resetuje do checkpointu
}
```

Żadna gotowa biblioteka nie oferuje takiego mechanizmu "widelca" serializacji.

### 2. Jeden kod działa po obu stronach

`binary.js` jest załadowany zarówno w Node.js (backend) jak i w przeglądarce (frontend).
Nie wymaga transpilacji, bundlowania ani żadnych adaptacji:

```javascript
// Na backendzie (Node.js):
const { packet_set, packet_get } = require('./binary.js');

// Na frontendzie (przeglądarka):
// ten sam plik, zero modyfikacji
const p = new packet_get();
```

Gotowe biblioteki binarne często mają oddzielne wersje dla Node i przeglądarki,
albo wymagają konfiguracji bundlera (webpack, rollup).

### 3. Typy danych dopasowane do domeny gry

Protokół zawiera dokładnie te typy których gra potrzebuje:

- `float32` — dla pozycji X/Y graczy (precyzja wystarczająca, połowa rozmiaru float64)
- `int8` — dla ID graczy (0–254, 1 bajt zamiast 4)
- `string16` — dla nicków z obsługą UTF-16 (polskie znaki, emoji)
- `string` (ASCII) — dla adresów IP i lokalizacji gdzie Unicode jest zbędny

Żaden gotowy serializer nie pozwoli wybrać `float32` zamiast `float64` dla konkretnego
pola bez pisania własnych transformerów — co i tak oznacza pisanie własnego kodu.

### 4. Zero parsowania przy odbiorze

`packet_get` czyta dane **sekwencyjnie** przesuwając wskaźnik:

```javascript
this.g_float = function() {
    this.index += 4;
    return this.d.getFloat32(this.index - 4);  // bezpośredni odczyt z bufora
}
```

Nie ma etapu "parsowania struktury" — dane są od razu gotowe. JSON wymaga parsowania
całego tekstu do drzewa obiektów zanim uzyska się pierwszą wartość.

### 5. Brak overhead'u schematów i wersjonowania

Protobuf i FlatBuffers wymagają utrzymania pliku schematu `.proto`/`.fbs` zsynchronizowanego
z kodem. Przy iteracyjnym projektowaniu protokołu (dodawanie nowych typów pakietów)
każda zmiana wymaga: edycji schematu → regeneracji kodu → aktualizacji obu stron.

W `binary.js` dodanie nowego typu pakietu to dopisanie jednej funkcji wysyłającej
na backendzie i jednego `case` w switch na frontendzie.

---

## Kiedy ten wybór byłby zły?

Własny serializer ma też wady — warto je uczciwie przyznać:

- **Brak samodokumentacji** — format jest niejawny, wymaga osobnej dokumentacji
  (jak ta którą piszemy). Protobuf ma schemat który _jest_ dokumentacją.
- **Brak walidacji typów** — żadna biblioteka nie sprawdzi czy wysłałeś `int8` zamiast `uint8`.
  Błędy objawiają się jako "dziwne wartości" zamiast wyjątku.
- **Trudniejsze debugowanie** — `console.log(packet)` wypisuje surowe bajty, nie czytelne pole.
- **Brak interoperabilności** — inny serwis nie odczyta tych danych bez znajomości `binary.js`.

Dla gry wieloosobowej z jednym klientem (przeglądarka) i jednym serwerem (Node.js)
— te wady są do przyjęcia. Gdyby protokół miał obsługiwać zewnętrzne API, mobile SDK
lub multiple języki programowania — Protobuf byłby lepszym wyborem.

---

## Podsumowanie

Własny serializer binarny w `binary.js` jest uzasadnionym wyborem inżynierskim
z następujących powodów:

| Kryterium | Uzasadnienie |
|-----------|-------------|
| **Wydajność** | 3.5× mniejsze pakiety niż JSON przy tym samym zestawie danych |
| **Rozmiar kodu** | 302 linie, zero zależności zewnętrznych |
| **Kontrola** | Dual-buffer niemożliwy w gotowych bibliotekach |
| **Przenośność** | Ten sam plik działa w Node.js i przeglądarce bez modyfikacji |
| **Dopasowanie do domeny** | Typy (float32, int8, string16) dobrane pod konkretne dane gry |
| **Prostota utrzymania** | Dodanie nowego pakietu = dopisanie funkcji, bez regeneracji schematu |

Alternatywy (Protobuf, FlatBuffers) osiągają podobny rozmiar danych, ale wprowadzają
narzut narzędziowy i zależności nieproporcjonalny do skali projektu.
MessagePack jest prostszy, ale wciąż 2× większy od własnego formatu przez redundantne
nazwy pól — co przy 60 tickach na sekundę dla 15 graczy ma realny wpływ na pasmo.
