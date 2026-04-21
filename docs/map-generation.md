# Map Generation — Proceduralny Generator Mapy

## 1. Cel i Architektura

Mapa gry to długi, cylindryczny tunel, po którym gracz zjeżdża coraz głębiej. Tunel ma stałą szerokość (128 kolumn kafelków zawiniętych w okrąg) i w zasadzie nieskończoną głębokość — generator tworzy kolejne „piętra" w miarę potrzeb, zamiast przygotowywać całą mapę z góry.

**Dlaczego generujemy mapę zamiast ją zapisywać:**

- **Każda sesja inna** — żaden gracz nie uczy się mapy na pamięć, bo układ kolców i platform losuje się od nowa przy każdym starcie serwera.
- **Zero kosztów pamięciowych z góry** — nie trzymamy na dysku gotowej mapy na setki tysięcy poziomów; serwer dolicza je „w locie".
- **Skalowanie z trudnością** — im głębiej gracz schodzi, tym więcej kolców generator dokłada do poziomu. Liczba ta rośnie wprost z numerem poziomu.

**Uproszczony przepływ (bez szczegółów implementacyjnych):**

1. **Start serwera** — generator od razu przygotowuje 2500 poziomów w zapasie. Tyle w praktyce nigdy się nie skończy w pojedynczej rozgrywce.
2. **Klient łączy się z serwerem** — dostaje pierwsze 10 poziomów od razu, zanim zacznie grać.
3. **Gracz zjeżdża w dół** — co kilka poziomów serwer dosyła mu kolejne 10. Klient nigdy nie widzi całej mapy, tylko „plaster" wokół siebie.
4. **Gracz dogania koniec wygenerowanej mapy** — serwer sam, w tle, dogenerowuje kolejne 100 poziomów. Dla gracza jest to niezauważalne.

Wszystko powyższe dzieje się w ramach jednego procesu serwerowego (Child) — jedna instancja Child = jedna mapa = maksymalnie 15 graczy na tej samej mapie.

### Jak wygląda jeden „poziom"

Każdy poziom to pojedynczy pierścień o 128 kafelkach. Można go wyobrazić sobie jak taśmę podłogową: każda z 128 kolumn ma jeden kafelek — albo pustą przestrzeń, po której gracz spada, albo platformę, na której może stanąć, albo kolce, które zabijają. Ponieważ cylinder jest okrągły, kolumna numer 127 sąsiaduje z kolumną 0 — gracz biegnąc w jedną stronę wraca na to samo miejsce.

```
Jeden poziom (128 kafelków, "rozwinięty" z cylindra):

   kolumna 0  1  2  3  ...                           127
            ┌──┬──┬──┬──┬──────────────────────────┬──┐
            │ 1│ 1│ 0│ 2│  ...                     │ 1│   ← np. platforma-platforma-dziura-kolec...
            └──┴──┴──┴──┴──────────────────────────┴──┘
                                                       ↘ wraca do kolumny 0 (cylinder)

Znaczenie bajtów:
  0 → puste (powietrze — gracz spada)
  1 → platforma (zielona, bezpieczna)
  2 → kolce (czerwone, zabijają)

Cała mapa = tablica takich pierścieni, ustawionych jeden pod drugim:
  levels[0]   → pierwszy poziom (start gracza)
  levels[1]   → kolejny poziom w dół
  levels[2]   → jeszcze niżej
  ...
  levels[N]   → bardzo głęboko
```

---

## 2. Kluczowa Logika i Przepływ

### Kiedy generator się uruchamia

Generator `gen_lvl()` tworzy za jednym razem 100 nowych poziomów i dopisuje je do globalnej tablicy `levels[]`. Wywoływany jest w **dwóch momentach**:

```javascript
// apps/child-gameserver/main.js

// 1) Zaraz po starcie serwera — generator uruchamia się 25 razy z rzędu
//    (25 × 100 poziomów = 2500 poziomów "na zapas").
//    Dzięki temu klient, który zaraz się połączy, od razu ma z czego czerpać.
for (let i = 25; i--;) gen_lvl();


// 2) W trakcie gry — tylko wtedy, gdy zapas prawie się kończy.
//    send_lvl = nr poziomu, do którego gracz już dostał dane
//    levels_sav = ile poziomów wygenerowano na serwerze
//    Gdy różnica zejdzie poniżej 10 — dogeneruj 100 nowych.
if (this.send_lvl > levels_sav - 10) gen_lvl();
```

Ważne: generator nie ma żadnego „ziarna losowego" (seed). Znaczy to, że po restarcie serwera mapa wygląda zupełnie inaczej — gracz nigdy nie zobaczy dwa razy tego samego układu kolców.

### Co dokładnie robi `gen_lvl()`

Funkcja generuje 100 poziomów w pętli. Dla każdego poziomu decyduje: **to jest checkpoint czy zwykły poziom?**

- **Checkpoint** pojawia się co pewien czas (na poziomach 0, 10, 40, 90, 160, 250 itd. — formuła `id = 10·n²`). Checkpoint wygląda jak pełna, lita ściana z trzema wąskimi dziurami — gracz musi w jedną z nich trafić, żeby móc spaść dalej. Checkpointy są swego rodzaju „bramkami" zatrzymującymi zbyt szybkich graczy.
- **Zwykły poziom** to losowy układ grup platform i grup kolców. Im głębszy poziom, tym więcej kolców — trudność rośnie liniowo z `id`. Na każdym zwykłym poziomie generator wymusza dodatkowo **2 dziury po 3 kafelki**, żeby gwarancyjnie dało się przez niego spaść (gdyby losowanie wygenerowało pełną obręcz platform, gracz by utknął).


```javascript
// apps/child-gameserver/main.js
function gen_lvl() {
    for (let l = 100; l--;) {
        const id = levels_sav + l;  // absolutny indeks poziomu

        // ─── CHECKPOINT DETECTION ───
        // Checkpoint gdy sqrt(id/10) jest liczbą całkowitą, czyli id ∈ {0, 10, 40, 90, 160, 250, …}
        if (!(Math.sqrt(id / 10) % 1)) {
            // PEŁNY PIERŚCIEŃ platform — wypełnij 128 kafelków "1"
            levels[id] = new Uint8Array(128).fill(1);

            // Wybij 3 przejścia po 3 kafelki każde (równomiernie dookoła cylindra, co ~42 kolumny)
            levels[id][0]  = levels[id][1]  = levels[id][2]  = 0; // przejście 1
            levels[id][42] = levels[id][43] = levels[id][44] = 0; // przejście 2
            levels[id][84] = levels[id][85] = levels[id][86] = 0; // przejście 3
            continue;
        }

        // NORMALNY POZIOM — zaczynamy od pustej tablicy
        levels[id] = new Uint8Array(128);  // wszystko 0 (powietrze)

        // Liczba grup kolców (typ 2) — rośnie z głębokością
        const badCount = ((id / 40) | 0) + 4;
        // id=0 → 4, id=40 → 5, id=200 → 9

        // Liczba grup bezpiecznych platform (typ 1) — rośnie szybciej niż kolce
        const norCount = ((id / 20) | 0) + 20;
        // id=0 → 20, id=100 → 25, id=200 → 30

        // ── Grupy kolców ── (każda grupa ma własny losowy start, bez wymuszonego odstępu)
        for (let o = badCount; o--;) {
            let pos = (Math.random() * 127) | 0;              // start 0–126
            const len = ((Math.random() * 3) | 0) + 2;        // długość: 2, 3 lub 4 kafelki
            for (let oo = len; oo--;) {
                levels[id][pos++] = 2;
                pos &= 0b1111111;                             // & 127 = wrap-around cylindra
            }
        }

        // ── Grupy bezpiecznych platform ── (nie nadpisują kolców)
        for (let o = norCount; o--;) {
            let pos = (Math.random() * 127) | 0;
            const len = ((Math.random() * 6) | 0) + 3;        // długość: 3–8 kafelków
            for (let oo = len; oo--;) {
                if (!levels[id][pos]) {
                    // UWAGA: pos++ jest WEWNĄTRZ if. Jeśli trafimy na kolec (levels[id][pos] = 2),
                    // pos nie przesuwa się — dalsze iteracje pętli "kręcą w miejscu" (no-op).
                    levels[id][pos++] = 1;
                    pos &= 0b1111111;
                }
            }
        }

        // ── Wymuszone 2 dziury po 3 kafelki ── gwaranacja że da się spaść
        for (let o = 2; o--;) {
            let pos = (Math.random() * 127) | 0;
            for (let oo = 3; oo--;) {
                levels[id][pos++] = 0;
                pos &= 0b1111111;
            }
        }
    }
    levels_sav += 100;
    console.log("level gen = " + levels_sav);
}
```

---

## 3. Przykłady z kodu (implementacja)

### Checkpointy — dokładna formuła

Checkpoint pojawia się przy poziomach gdzie `id = 10n²` (n ≥ 0):

| id | sqrt(id/10) | Checkpoint? | Pełny pierścień? |
|---|---|---|---|
| 0 | 0.0 (= 0) | tak | tak |
| 10 | 1.0 (= 1) | tak | tak |
| 40 | 2.0 (= 2) | tak | tak |
| 90 | 3.0 (= 3) | tak | tak |
| 160 | 4.0 (= 4) | tak | tak |
| 5 | 0.707 | nie | nie |
| 30 | 1.732 | nie | nie |

```javascript
// Checkpoint = poziom gdzie gracze muszą "spaść przez dziurę"
// Trzy dziury na stałych pozycjach: 0-2, 42-44, 84-86
// Rozmieszczenie co ~42 kolumny = równomierne na cylindrze (128/3 ≈ 42.7)
```

### Funkcja `rnd()`

```javascript
// apps/child-gameserver/main.js
function rnd(minv, maxv) {
    if (maxv < minv) return 0; // zabezpieczenie przed NaN przy odwróconym zakresie
    return (((Math.random() * 0xffffff) | 0) % (maxv - minv)) + minv;
    // 0xffffff = 16777215 (duża liczba → dobra rozdzielczość)
    // | 0 = Math.floor (szybszy dla nieujemnych)
    // % (maxv-minv) = zakres
    // + minv = przesuń o minimum
}
```

### Jak mapa trafia do przeglądarki gracza

Wysłanie całej mapy naraz byłoby nieefektywne — 2500 poziomów × 128 bajtów = ponad 300 KB, z czego gracz zobaczy może 100 poziomów zanim zginie. Dlatego serwer stosuje **streaming**: wysyła mapę kawałkami po 10 poziomów, dokładnie wtedy, gdy gracz zbliża się do końca swojego „widoku".

Każdy gracz ma własny licznik `send_lvl` — mówi on, „do którego poziomu klient już dostał dane". Gdy gracz podczas opadania zbliża się do końca tego zakresu, serwer wysyła mu kolejną paczkę 10 poziomów i zwiększa licznik o 10.

**Warunki, które uruchamiają wysyłkę** (w funkcji `move()` każdego gracza wywoływanej co klatkę gry):

```javascript
// apps/child-gameserver/main.js
if (this.lvl > this.send_lvl - 5) {
    // WARUNEK 1: gracz znajduje się < 5 poziomów od końca swojego "widoku mapy".
    // 5 poziomów buforu chroni przed lagiem sieciowym — zanim pakiet doleci,
    // gracz nie zdąży opaść poniżej tego co już ma narysowane.

    if (this.send_lvl > levels_sav - 10) gen_lvl();
    // WARUNEK 2 (przed wysyłką): jeśli generator nie nadąża — dogeneruj 100 poziomów.

    if (!this.bot) {
        // WARUNEK 3: boty nie mają socketu → nie wysyłamy im nic.
        p.new_type(4);                                    // komenda typu 4 = dane mapy
        p.s_length8(10);                                  // w tej paczce jest 10 poziomów
        for (let i = 10; i--;) {
            p.s_int8_arr(levels[this.send_lvl + i], 128); // każdy poziom = 128 bajtów
        }
        this.send_lvl += 10;                              // przesuń wskaźnik "wysłano do"
        this.socket.send(Buffer.from(p.get_buf()), true); // natychmiastowa wysyłka (TCP)
    }
}
```

Pakiet mapy jest wysyłany **natychmiast** (przez funkcję `get_buf()`), a nie razem ze wspólną paczką zawierającą pozycje graczy, która leci co 16 milisekund. Dane mapy są krytyczne — bez nich klient po prostu nie ma czego narysować — więc mają priorytet.

### Jak przeglądarka (frontend) rozpakowuje ten pakiet

Po stronie klienta, w pliku [index.html](cloud-game/apps/mother-lobby/public/index.html), znajduje się funkcja `hgm` („handle game message"), która obsługuje każdy pakiet przychodzący od serwera gry. Jest to ogólny handler: potrafi rozpakować pakiet zawierający wiele komend naraz, ponieważ inne pakiety (np. `gen_packet` z pozycjami graczy wysyłany co 16 ms) łączą w sobie kilka rzeczy — listę graczy, ich pozycje, eventy. Dlatego `hgm` najpierw czyta z pierwszego bajtu licznik komend i potem w pętli parsuje każdą po kolei.

W przypadku pakietu mapy licznik ma wartość 1, bo serwer wysyła go samodzielnie (patrz poprzednia sekcja — `get_buf()` nie łączy mapy z innymi komendami). Pętla wykona się więc tylko raz, trafiając od razu do `case 4`:

```javascript
// apps/mother-lobby/public/index.html — hgm(), case 4
case 4: {
    for (let ix = p.g_length8(); ix--;) {
        levels[levelsReceived + ix] = p.g_int8_arr();
        // g_length8() = 1 bajt (liczba poziomów, tu zawsze 10)
        // g_int8_arr() czyta 2 bajty długości (uint16, tu 128) + 128 bajtów danych
        // Rezultat: tablica 128 uint8 zapisana pod levels[levelsReceived + ix]
    }
    if (!levelsReceived) {
        // Pierwszy pakiet mapy w ogóle — jeśli ringi 3D już są gotowe,
        // załaduj je teraz; w przeciwnym razie czekaj na flagę ringDataReady.
        if (ringDataReady) {
            for (let k = 0; k < 5; k++) loadRing(ringGroups[k], k);
            ringDataReady = false;
        } else {
            ringDataReady = true;
        }
    }
    levelsReceived += 10;   // frontendowy odpowiednik send_lvl
    break;
}
```

**Dlaczego serwer i klient się zgadzają bez dodatkowej pracy:** obie strony używają identycznej pętli `for (let i = 10; i--;)`, która odlicza od 9 do 0. Serwer w tej kolejności zapisuje poziomy do bufora, a klient w tej samej kolejności je odczytuje — przez to poziom, który po stronie serwera miał numer `send_lvl+9`, ląduje u klienta pod `levels[levelsReceived+9]`. Nie trzeba nic odwracać ani sortować; wystarczy, że obie strony zgadzają się co do kierunku pętli.

### Losowa pozycja startowa gracza

```javascript
// apps/child-gameserver/main.js
function random_pos() {
    let r = (Math.random() * 0x3ff) | 0;  // 0x3ff = 1023 → r ∈ [0, 1022]
    r &= 0x3ff;                           // maska defensywna (już jesteśmy w zakresie)
    const ind = r >> 3;                   // indeks kafelka (r/8), 8 jednostek szerokości = 1 kafelek

    if (ind < 4 || (ind >= 41 && ind <= 46) || (ind >= 83 && ind <= 88)) {
        return random_pos();  // trafiliśmy w strefę przy dziurze checkpointu — losuj jeszcze raz
    }
    return r;
}
// Zakazane strefy odpowiadają przejściom w checkpoincie (dziury 0–2, 42–44, 84–86)
// z marginesem bezpieczeństwa — gracz nie startuje nad przepaścią.
```

---

## 4. Zależności i protokoły

### Globalny stan mapy

```javascript
// apps/child-gameserver/main.js
let levels     = [];   // levels[id] = Uint8Array[128]
let levels_sav = 0;    // ile poziomów wygenerowano (rośnie o 100 co gen_lvl())

// Przy starcie serwera: 25 wywołań gen_lvl() → levels_sav = 2500
for (let i = 25; i--;) gen_lvl();
```

### Pakiet danych mapy — jak wygląda „na drucie"

Każdy pakiet wysyłany po WebSocketach jest jednym ciągłym blokiem bajtów. Pierwszy bajt to zawsze **licznik komend** w pakiecie (serwer może np. w jednym pakiecie wysłać listę graczy + dane mapy). Dla pakietu zawierającego tylko dane mapy ten licznik wynosi 1. Dalej są kolejno: numer komendy (4 = mapa), liczba poziomów w paczce (10) i wreszcie same dane poziomów:

```
┌─────────┬──────────────────────────────────────────────────────────┐
│ Bajt 0  │ licznik komend w pakiecie (int8[0]) — tu 1               │
│ Bajt 1  │ typ komendy = 4 (dane mapy)                              │
│ Bajt 2  │ liczba poziomów w paczce = 10 (s_length8 zapisuje 1 B)   │
├─────────┼──────────────────────────────────────────────────────────┤
│ 3..132  │ poziom [send_lvl+9]                                      │
│         │   ├─ 2 B (uint16 BE): długość = 128                      │
│         │   └─ 128 B: kafelki (0=puste, 1=platforma, 2=kolce)      │
│ 133..262│ poziom [send_lvl+8]   (kolejne 130 B)                    │
│ ...     │ ...                                                      │
│1173..1302│ poziom [send_lvl+0]  (ostatnie 130 B)                   │
└─────────┴──────────────────────────────────────────────────────────┘

Razem: 1 (licznik) + 1 (typ) + 1 (s_length8) + 10 × (2 + 128) = 1303 bajty
```

Frontend odczytuje pakiet w dokładnie takiej samej kolejności, w jakiej serwer go zapisał. Funkcja `g_length8()` odczytuje jeden bajt (liczbę poziomów), a następnie dziesięć razy wywołuje `g_int8_arr()`, która sama odczytuje dwubajtowy prefiks z długością (zawsze 128) i dalej 128 bajtów danych. Dane trafiają do tablicy `levels[]` po stronie przeglądarki pod te same indeksy, pod którymi były na serwerze.

### Przepływ per gracz (który poziom kiedy)

```
send_lvl startuje na 10 (gracz dostaje pierwsze 10 przy połączeniu)
lvl rośnie gdy gracz opada głębiej na cylindrze
lvl > send_lvl - 5 → wyślij kolejne 10 poziomów → send_lvl += 10
```

---

## 5. Konfiguracja 

Generator mapy nie ma osobnych zmiennych środowiskowych. Parametry są zakodowane w algorytmie:

| Parametr | Wartość | Lokalizacja |
|---|---|---|
| Szerokość mapy | 128 kolumn | `new Uint8Array(128)` |
| Liczba `gen_lvl()` przy starcie | 25 (→ 2500 poziomów zapasu) | `for (let i = 25; i--;) gen_lvl()` |
| Rozmiar paczki generowania | 100 poziomów | pętla `for (let l = 100; l--;)` w `gen_lvl()` |
| Rozmiar paczki wysyłania | 10 poziomów | `p.s_length8(10)` |
| Bufor wyprzedzenia gracza | 5 poziomów | warunek `lvl > send_lvl - 5` |
| Bufor wyprzedzenia generatora | 10 poziomów | warunek `send_lvl > levels_sav - 10` |
| Liczba dziur w checkpoincie | 3 (indeksy 0, 42, 84) | hardcoded |
| Rozmiar dziury w checkpoincie | 3 kafelki | hardcoded |
| Liczba wymuszonych dziur poziomu | 2 | pętla `for (let o = 2; o--;)` |
| Bazowe grupy kolców | `(id/40) | 0 + 4` | skalowanie z głębokością |
| Długość grupy kolców | 2, 3 lub 4 kafelki | `(Math.random()*3) | 0) + 2` |
| Bazowe grupy platform | `(id/20) | 0 + 20` | skalowanie z głębokością |
| Długość grupy platformy | 3–8 kafelków | `(Math.random()*6) | 0) + 3` |

**Ograniczenie:** Generator nie ma ziarna losowego (seed) — każde uruchomienie serwera tworzy inną mapę. Nie ma możliwości odtworzenia konkretnej mapy.
