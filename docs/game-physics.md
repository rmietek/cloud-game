# Game physics — Fizyka gry

## 1. Cel i architektura

Cała fizyka gry obliczana jest **wyłącznie na serwerze** (Child) — przeglądarka gracza tylko wysyła naciśnięte klawisze i rysuje to, co dostaje od serwera. Dzięki temu gracze nie mogą oszukiwać modyfikując kod w swojej przeglądarce.

**Tick (takt gry)** — co 16 milisekund serwer wywołuje funkcję `move()` dla każdego gracza. To ~62 razy na sekundę. Jeden tick to jedna "klatka" fizyki: w tym czasie gracz może przesunąć się maksymalnie 10 jednostek w pionie (grawitacja) i kilka jednostek w poziomie (ruch), wykryć kolizje z kafelkami i z innymi graczami.

Pojedynczy tick oblicza po kolei:
1. **Kolizje gracz-gracz** — czy w pobliżu jest inny gracz, który nas odepchnie
2. **Grawitację** — nowa prędkość pionowa zależna od czasu w powietrzu
3. **Kolizje z kafelkami** — czy stopy gracza trafiły w platformę (zielona) lub kolce (czerwone)
4. **Awans na nowy segment** — jeśli spadł niżej, przyznaj punkty i ewentualnie checkpoint
5. **Wysyłkę danych mapy** — jeśli gracz zbliża się do końca posiadanych danych, wyślij kolejne 10 segmentów

Mapa to **długi, cylindryczny tunel**: oś X zapętla się po 1024 jednostkach (gracz wychodząc prawą krawędzią pojawia się po lewej), oś Y to głębokość — start gry to Y ≈ 0, a im głębiej, tym bardziej ujemne Y. Gracz spada, a serwer generuje i dosyła kolejne segmenty na bieżąco.

### Wizualizacja przestrzeni

Kolizja z kafelkami opiera się na wartości bezwzględnej `|Y|`, więc numer segmentu to `|Y| ÷ 128`.

```
← 1024 jednostek (zapętlone) →
┌────────────────────┐  Y ≈ 0       (start gry, góra)
│  segment 0 (lvl=0) │  |Y| = 0..128
├────────────────────┤  Y = -128
│  segment 1 (lvl=1) │  |Y| = 128..256
├────────────────────┤  Y = -256
│  segment 2 (lvl=2) │  |Y| = 256..384
│        ...         │
│  (nowe generowane) │  Y = -(N×128)
└────────────────────┘  ↓ bez końca
```

**Kafelek** — najmniejsza jednostka mapy, 8×16 jednostek. Każdy segment ma jeden rząd 128 kafelków (128 × 8 = 1024 jednostek szerokości, 16 jednostek wysokości) — reszta 128-jednostkowej wysokości segmentu to pusta przestrzeń, przez którą gracz swobodnie spada. Trzy typy:
- `0` — pusty (gracz przechodzi przez)
- `1` — platforma (zielona, gracz ląduje)
- `2` — kolce (czerwone, zadają obrażenia)

**Segment (`lvl`)** — jeden "poziom" mapy, 128 jednostek wysokości. Serwer generuje segmenty z wyprzedzeniem i wysyła klientowi kolejne 10 segmentów gdy gracz zbliży się do końca pobranych danych. `lvl` to numer segmentu w którym aktualnie jest gracz — używany do obliczania punktów i checkpointów.

### Jak fizyka korzysta z mapy

Fizyka **nie generuje** mapy (to robi [map-generation.md](map-generation.md)) — tylko z niej czyta. Wygenerowane segmenty leżą w globalnej tablicy `levels[]`: `levels[idn]` to `Uint8Array` o długości 128 (jedna linia kafelków dla segmentu nr `idn`, każdy bajt to 0/1/2).

Żeby sprawdzić kolizję z kafelkiem, kod `move()` przekształca pozycję gracza na indeks w `levels[]`:
- Z pozycji Y liczy numer segmentu: `idn = Math.abs((y - 8) >> 4) / 8`
- Z pozycji X liczy numer kafelka w segmencie: `tile = x >> 3` (zakres 0–127)
- Odczyt: `levels[idn][tile]` → wartość `0`, `1` lub `2`

Wysyłka do klienta jest inicjowana **wewnątrz** `move()` — kiedy gracz awansuje na nowy segment (`idn > lvl`) i zostało mu mniej niż 5 segmentów buforu, serwer pakuje kolejne 10 segmentów w pakiet typu 4 i wysyła przez socket (kod w §3 "Wysyłanie danych mapy z wyprzedzeniem"). Gracz dostaje więc dane "na zapas" — zanim doleci do nich, już są wyrenderowane w przeglądarce.

---

## 2. Kluczowa Logika i Przepływ

### Grawitacja i skok

Grawitacja i skok są obsługiwane przez jedną zmienną `jump_frame` — licznik taktów które upłynęły od momentu gdy gracz oderwał się od podłoża. Co takt `jump_frame` rośnie o 1, a prędkość pionowa (`vecy`) jest wyliczana ze wzoru `4 - jump_frame × 0.1`. Na początku skoku (`jump_frame = 0`) `vecy = 4` — gracz pędzi w górę (Y rośnie). Z każdym taktem `vecy` maleje: przy `jump_frame = 40` wynosi zero (szczyt skoku), potem staje się ujemne — gracz zaczyna opadać (Y maleje, staje się coraz bardziej ujemne = głębiej w cylindrze).

```
jump_frame:    0   →   40   →   80   →   140+
vecy:         +4   →    0   →   -4   →   -10 
ruch:        skok  →  szczyt → opadanie → max. prędkość opadania
```

```javascript
// apps/child-gameserver/main.js — w move():
let vecy = 4 - this.jump_frame * GRAVITY;  // GRAVITY = 0.1
if (vecy < -10) vecy = -10;               // ograniczenie: nie szybciej niż 10 jednostek/takt
this.y += vecy;                           // vecy dodatnie → y rośnie → skok w górę
                                          // vecy ujemne  → y maleje → opadanie w głąb cylindra
```

Lądowanie na platformie resetuje `jump_frame = 0` — przy następnym takcie `vecy` znowu wynosi 4, co daje natychmiastowy pełny skok. Naciśnięcie skoku w powietrzu jest ignorowane (serwer sprawdza czy `jump_frame` odpowiada momentowi naciśnięcia).

### Kolizja z kafelkami — detekcja

Detekcja działa w trzech krokach: **gdzie jest gracz → kiedy sprawdzać → co sprawdzać**.

**Krok 1 — gdzie jest gracz na mapie**

Wszystko co gracz widzi na mapie — zielone platformy, czerwone kolce, puste przestrzenie — to **kafelki**. Mapa to siatka takich kafelków, każdy ma przypisaną wartość: `0` = puste miejsce (gracz przelatuje przez), `1` = zielona platforma (gracz ląduje), `2` = czerwone kolce (gracz traci życie). Kafelek ma 16 jednostek wysokości i 8 jednostek szerokości.

Jeden **segment** to jedna pozioma linia 128 kafelków obok siebie — `levels[idn]` to tablica 128 wartości (0/1/2). Między segmentami jest 128 jednostek pustej przestrzeni w którą gracz spada. Segmenty są numerowane od góry: segment 0, segment 1, segment 2...

```
← 128 kafelków × 8 jednostek = 1024 jednostek szerokości →

Y≈0    ┌────┬────┬────┬────┬──...──┬────┐  ← levels[0]: jedna linia kafelków
       │ 0  │ 1  │ 0  │ 2  │       │ 1  │    (0=puste, 1=platforma, 2=kolce)
       └────┴────┴────┴────┴──...──┴────┘

       │                                 │
       │    128 jednostek pustej         │  ← gracz tutaj spada swobodnie
       │    przestrzeni (brak kafelków)  │
       │                                 │

Y=-128 ┌────┬────┬────┬────┬──...──┬────┐  ← levels[1]: kolejna linia kafelków
       │ 1  │ 1  │ 0  │ 0  │       │ 0  │
       └────┴────┴────┴────┴──...──┴────┘

       │    128 jednostek pustej przestrzeni  │

Y=-256 ┌────┬────┬────┬────┬──...──┬────┐  ← levels[2]
       │ ...                            │
```

Żeby wiedzieć który kafelek z tablicy `levels[]` sprawdzić, kod musi przeliczyć pozycję Y gracza (np. `y = 350`) na numer segmentu. Robi to w dwóch krokach:

1. **Y → numer rzędu (`col`)**: dzieli Y przez 16 (tyle jednostek ma jeden rząd kafelków w pionie). Wynik mówi: "gracz jest w Nth rzędzie licząc od góry mapy".
2. **numer rzędu → numer segmentu (`idn`)**: dzieli `col` przez 8 (tyle rzędów ma jeden segment). Wynik to indeks do tablicy `levels[]` — `levels[idn]` to 128 kafelków tworzących jeden poziomy pas mapy.

```
gracz na y = -350 (segment 2, głębiej w cylindrze):

krok 1:  col = |(-350 - 8) ÷ 16| = |-358 ÷ 16| = 22  →  gracz jest w rzędzie nr 22
                                                           (Math.abs bo Y jest ujemne;
                                                            odejmujemy 8 bo środek gracza
                                                            jest 8 jednostek nad stopami)

krok 2:  idn = 22 ÷ 8 = 2            →  rząd 22 należy do segmentu nr 2
                                          → sprawdzamy kafelki z levels[2]
```

**Krok 2 — kiedy sprawdzać**

Kafelki istnieją tylko na konkretnych wysokościach — co 128 jednostek (każdy segment ma jeden rząd kafelków na swojej górnej krawędzi). Między tymi wysokościami nie ma żadnych platform ani kolców, więc sprawdzanie kolizji w innych miejscach byłoby zbędne.

`col % 8 === 0` to właśnie test: "czy gracz jest teraz na wysokości rzędu kafelków?" — `col` zmienia się wraz z pozycją Y gracza, a wielokrotności 8 odpowiadają dokładnie tym wysokościom gdzie kafelki mogą istnieć. Gdy gracz spada i mija kolejną wysokość z kafelkami, warunek staje się prawdziwy i dopiero wtedy sprawdzamy kolizję.

**Krok 3 — co sprawdzać (3 punkty kontrolne)**

Kafelek ma szerokość 8 jednostek, a gracz ma promień 11 jednostek (szerokość 22). Gracz jest więc szerszy niż kafelek — może stać nogą na kafelku który jest z boku, podczas gdy jego środek jest nad pustą przestrzenią. Gdyby sprawdzać tylko środek gracza, taka sytuacja nie byłaby wykryta i gracz "spadałby przez" kafelek na którym stoi jednym bokiem.

Dlatego kod sprawdza trzy punkty wzdłuż podstawy gracza: lewy bok, środek i prawy bok. Kolizja zachodzi jeśli **którykolwiek** z nich trafia w kafelek:

```
         lx    cx    rx        ← 3 sprawdzane punkty
          ↓     ↓     ↓
    ──────────────────────     ← podstawa gracza (szerokość 22 jednostki)

   [ pusty ][ platforma ]      ← kafelki (każdy 8 jednostek szerokości)

   cx i lx = pusty → brak kolizji przez środek i lewą stronę
   rx = platforma  → KOLIZJA — gracz ląduje
```

```javascript
// apps/child-gameserver/main.js — w move():

const col = Math.abs((this.y - 8) >> 4); // numer rzędu: (Y-8) ÷ 16
                                          // -8: środek gracza jest 8 jednostek nad stopami

if (!(col % 8)) {  // sprawdzaj tylko gdy col jest wielokrotnością 8 (co 128 jednostek)

    const tileTop  = (this.x + 6) >> 3;  // indeks kafelka pod PRAWĄ krawędzią gracza
    const tileDown = (this.x - 6) >> 3;  // indeks kafelka pod LEWĄ krawędzią gracza
    const tileMid  =  this.x      >> 3;  // indeks kafelka pod ŚRODKIEM gracza
    // >> 3 = X ÷ 8 = numer kolumny kafelka (mapa ma 128 kolumn, X od 0 do 1023)

    const idn = (col / 8) | 0;  // numer segmentu: col ÷ 8 = który levels[] sprawdzić

    if (idn >= this.lvl && levels[idn] &&
        (levels[idn][tileMid] || levels[idn][tileTop] || levels[idn][tileDown])) {
        // kolizja jeśli KTÓRYKOLWIEK z trzech punktów trafi niezerowy kafelek (1 lub 2)
        // idn >= this.lvl: ignoruj platformy wyżej — gracz już przez nie przeszedł

        const isHazard = levels[idn][tileMid]  === 2 ||
                         levels[idn][tileTop]  === 2 ||
                         levels[idn][tileDown] === 2;
        // WAŻNE: sprawdzamy każdy punkt osobno z === 2, nie przez OR na wartościach.
        // Gdyby: tileMid=1 (platforma), tileTop=2 (kolce) → tileMid||tileTop = 1 → nie wykryłoby kolców.

        if (isHazard) { /* kolce — patrz niżej */ }
        else          { /* platforma — patrz niżej */ }
    }
}
```

### Kolizja z platformą (typ 1)

Gracz dotknął zielonej platformy — ląduje. Cały efekt lądowania to trzy resetowania:

- `jump_frame = 0` — resetuje licznik fizyki. Przy następnym takcie `vecy = 4 - 0×0.1 = 4`, czyli gracz jest gotowy do pełnego skoku. Bez tego resetu gracz nadal "spadałby" (jump_frame wysokie → vecy ujemne → y maleje) nawet stojąc na platformie.
- `target = null` — czyści informację o tym, kto nas zepchnął. Gdybyśmy teraz wpadli w kolce, nikt nie dostałby punktów za zabójstwo.
- `event_use = -2` (tylko gdy było `-3`) — jeśli poprzednio gracz odbił się od kolców (stan `-3` = "właśnie uderzony"), to wylądowanie na platformie oznacza że sytuacja wróciła do normy. Stan `-3` blokuje kolejne uderzenia kolców — trzeba go wyczyścić żeby gracz mógł znowu oberwać.

```javascript
// Lądowanie na zielonej platformie (isHazard = false):
if (this.event_use === -3) this.event_use = -2;  // wyjdź ze stanu "właśnie uderzony" — odblokuj kolce
this.target     = null;  // nikt nas nie zepchnął — reset zabójcy
this.jump_frame = 0;     // stoimy na ziemi — reset fizyki, gotowi do skoku
```

### Kolizja z kolcami (typ 2)

Kolce (`event` = liczba żyć, zakres 0–10) mają dwa warianty zależnie od tego ile żyć gracz ma w momencie kontaktu.

**Wariant 1 — gracz ma jeszcze życia (`event > 0`) — odbicie:**

Gracz traci 2 życia i "odbija się" od kolców w górę. Samo odjęcie żyć to tylko część — reszta kodu zapobiega temu żeby kolce triggerowały wielokrotnie w tym samym miejscu:

- `this.y += 8` — przesuń gracza 8 jednostek w górę natychmiast. Kolce są sprawdzane co takt, a gracz porusza się powoli — bez przesunięcia przez kilka kolejnych taktów gracz byłby na tej samej wysokości i kolce odejmowałyby życia w kółko.
- `event_use = -3` — dodatkowe zabezpieczenie: stan "właśnie uderzony" blokuje ponowny trigger nawet jeśli `y += 8` nie wystarczyło. Resetowany dopiero gdy gracz wyląduje na zielonej platformie.
- `event -= 2` + clamp do 0 — odejmij 2 życia; wynik nie może być ujemny (gracz z 1 życiem po uderzeniu ma 0, nie -1).
- `event_send = true` — wyślij klientowi zaktualizowaną liczbę żyć; klient na tej podstawie renderuje efekt wizualny uderzenia.
- `target = null` — to uderzenie w kolce "samo z siebie", nie przez zepchnięcie — nikt nie dostanie punktów za zabójstwo.
- `jump_frame = 0` — reset fizyki, gracz "odbija się" od kolców jak od platformy.

```javascript
// Uderzenie w czerwone kolce, gracz jeszcze żyje (event > 0):
this.y         += 8;    // odsuń w górę — zapobiegaj wielokrotnemu triggerowi w tym samym takcie
this.event_use  = -3;   // stan "właśnie uderzony" — blokuje kolejne uderzenia aż do lądowania
this.event     -= 2;    // odejmij 2 życia
if (this.event < 0) this.event = 0;  // clamp — nie schodzi poniżej 0
this.event_send = true; // wyślij klientowi nową liczbę żyć
this.target     = null; // brak zabójcy — reset
this.jump_frame = 0;    // odbicie od kolców — reset fizyki
```

**Wariant 2 — gracz ginie (`event = 0`):**

Śmierć przebiega w trzech etapach: nagroda dla zabójcy → usunięcie z mapy → obsługa śmierci gracza ludzkiego.

**Etap 1 — nagroda dla zabójcy** (tylko jeśli ktoś nas zepchnął):

`target` wskazuje gracza który nas zepchnął na te kolce. Jeśli jest ustawiony, dostaje nagrodę. Nagroda jest podwójna: `kill_points` to zapamiętana wartość do późniejszego zapisu w bazie, `add_points` to natychmiastowa aktualizacja rankingu. Życie zabójcy rośnie o 1, ale nie przekracza 10.

**Etap 2 — usunięcie z mapy przestrzennej:**

`rmv_player_seg` usuwa gracza z siatki segmentów. Kolizje gracz–gracz są sprawdzane tylko w obrębie pobliskich segmentów — bez tego usunięcia martwy gracz nadal blokowałby innych.

**Etap 3 — obsługa śmierci** (tylko gracze ludzcy, nie boty):

Boty mają własny respawn (natychmiast, bez ekranu śmierci). Dla człowieka: `is_dead = true` wstrzymuje `move()` — socket pozostaje otwarty, gracz widzi ekran śmierci i czeka na pakiet respawn. Punkty zarobione od ostatniego checkpointu są zapisywane do bazy i wysyłane klientowi. `return` przerywa `move()` natychmiast — dalsza fizyka dla martwego gracza nie ma sensu.

```javascript
// Gracz wpadł w kolce bez żyć (event = 0):

// Etap 1: nagroda dla zabójcy
if (this.target) {
    this.target.kill_points += 1000;          // zapamiętaj do zapisu w DB
    this.target.add_points(1000);             // dodaj do rankingu natychmiast
    this.target.event_send = true;
    if (this.target.event <= 10) this.target.event++;  // +1 życie, max 10
}

// Etap 2: usuń z mapy przestrzennej — martwy gracz nie blokuje kolizji
rmv_player_seg(this, this.lvl);

// Etap 3: obsługa śmierci — tylko dla gracza ludzkiego (boty mają własny respawn)
if (!this.bot) {
    this.is_dead = true;             // wstrzymaj move() — gracz czeka na ekranie śmierci
    this.send_points = this.points - this.account_points;  // złoto zarobione od ostatniego checkpointu
    save_player_money(this, this.points - this.account_points);  // zapis do CosmosDB
    this.account_points = this.saved_points + this.kill_points;  // punkt odniesienia dla następnego zapisu
    killed_players.push(this.id);    // gen_packet() wyśle pakiet type 5 (śmierć) do wszystkich
    return;                          // przerwij move() — dalsza fizyka bezsensowna
}
```

### Kolizja gracz-gracz

Kiedy dwóch graczy się zetknie, kod robi trzy rzeczy: przekazuje pęd poziomy z jednego na drugiego (jak zderzenie kul bilardowych), rozsuwa ich żeby się nie nakładali, i zapamiętuje kto z kim walczył (gdy któryś później wpadnie w kolce, drugi dostanie punkty za zabójstwo).

Optymalizacja: zamiast sprawdzać kolizje każdy z każdym (O(n²) przy 50 graczach to 2500 porównań co tick), kod przegląda tylko graczy z sąsiednich segmentów — bieżącego i poprzedniego. Gracz spada maksymalnie 10 jednostek na tick, a segment ma 128 jednostek wysokości, więc nigdy nie "przeskoczy" przez cały segment między tickami — dalsze segmenty to gwarantowany brak kolizji.

```javascript
// apps/child-gameserver/main.js — w move():
for (let z = this.lvl - 1; z <= this.lvl; z++) {
    if (!segment_player[z]) continue;            // segment pusty — pomiń

    for (let i = segment_player[z].length; i--;) {
        const other = segment_player[z][i];
        if (other === this) continue;            // nie koliduj sam ze sobą
        if (!is_colid(other.x, other.y, PLAYER_RADIUS,
                      this.x, this.y, PLAYER_RADIUS)) continue;

        // 1. Wymiana prędkości poziomych (oba zachowują swój pęd, ale w drugiego)
        other.x += this.move_x;
        this.x  += other.move_x;
        this.move_x  = 0;
        other.move_x = 0;
        other.x &= 0x3ff;  // wrap-around cylindra
        this.x  &= 0x3ff;

        // 2. Zapamiętaj przeciwnika dla systemu zabójstw
        this.target  = other;
        other.target = this;

        // 3. Separacja — rozsuń graczy tak żeby ich środki były dokładnie
        //    w odległości 2×PLAYER_RADIUS (czyli ciała się stykają, ale nie nachodzą)
        const diameter = PLAYER_RADIUS + PLAYER_RADIUS;  // 22 jednostki
        const dx = other.x - this.x;
        const dy = other.y - this.y;
        const dist = Math.sqrt(dx*dx + dy*dy) || 1;      // || 1 = ochrona przed dzieleniem przez 0
        const ux = dx / dist;                             // wektor jednostkowy X
        const uy = dy / dist;                             // wektor jednostkowy Y

        other.x = this.x + diameter * ux;                // przesuwamy TYLKO "other"
        other.y = this.y + diameter * uy;                // "this" zostaje, "other" odskakuje
        other.x &= 0x3ff;
        this.x  &= 0x3ff;
    }
}
```

### Detekcja kolizji (bez sqrt)

Funkcja `is_colid` sprawdza czy dwa okręgi na siebie zachodzą. Standardowy wzór to "czy odległość między środkami jest mniejsza niż suma promieni" — ale pierwiastek kwadratowy jest drogi. Zamiast tego porównujemy **kwadraty** odległości i promieni — wynik jest ten sam, a obliczenie ~30% szybsze.

```javascript
// apps/child-gameserver/main.js
function is_colid(ax, ay, ar, bx, by, br) {
    const dx = ax - bx;
    const dy = ay - by;
    const r  = ar + br;
    return dx*dx + dy*dy <= r*r;
    // lewa strona: kwadrat odległości między środkami
    // prawa strona: kwadrat sumy promieni — maksymalna odległość dla kolizji
}
```

---

## 3. Przykłady z  kodu (implementacja)

### Zaawansowanie na głębszy poziom + punkty

Gdy gracz spadnie do nowego segmentu (`idn > lvl`), serwer: przepina go do nowej komórki w siatce `segment_player`, przyznaje punkty za pokonany segment, i jeśli wszedł w nową **sekcję** (grupę segmentów) — aktualizuje checkpoint respawnu i dodaje życie. Sekcja rośnie wolniej niż segmenty (pierwiastek z `idn/10`), więc gracz dostaje nowy checkpoint co kilkadziesiąt segmentów, a nie co jeden.

```javascript
// apps/child-gameserver/main.js — w move(), po detekcji kolizji kafelków:
if (idn > this.lvl) {
    rmv_player_seg(this, this.lvl);  // wyjmij ze starego segmentu
    add_player_seg(this, idn);        // wstaw do nowego
    this.lvl = idn;

    const rl = Math.sqrt(idn / 10) | 0;  // numer sekcji
    // idn=0..9   → rl=0
    // idn=10..39 → rl=1
    // idn=40..89 → rl=2
    this.add_points(50 * (rl + 1));
    // sekcja 0 → 50 pkt, sekcja 1 → 100 pkt, sekcja 2 → 150 pkt

    if (this.respawn_lvl !== rl) {   // wszedł w nową sekcję → checkpoint
        this.saved_points = this.points - this.kill_points;
        this.respawn_lvl  = rl;
        if (this.event < 10) { this.event++; this.event_send = true; }
    }
}
```

### Wysyłanie danych mapy z wyprzedzeniem

Serwer nie wysyła od razu całej mapy — posyła po 10 segmentów, gdy gracz zbliży się do końca posiadanych danych. `send_lvl` to wskaźnik "do którego segmentu klient już dostał dane". Gdy `lvl > send_lvl - 5` (graczowi zostało mniej niż 5 segmentów buforu) — czas na kolejną paczkę. Dodatkowo, jeśli generator sam ma mało zapasu (`levels_sav - 10`), wywoływany jest `gen_lvl()` żeby dogenerować. Dzięki temu dane docierają na czas mimo opóźnień sieci.

```javascript
// apps/child-gameserver/main.js — w move(), po awansie na nowy segment:
if (this.lvl > this.send_lvl - 5) {
    if (this.send_lvl > levels_sav - 10) gen_lvl();  // mało zapasu → dogeneruj

    if (!this.bot) {                                  // boty nie mają socketów
        p.new_type(4);                                // pakiet typu 4 = dane mapy
        p.s_length8(10);                              // 10 segmentów w paczce
        for (let i = 10; i--;) {
            p.s_int8_arr(levels[this.send_lvl + i], 128);  // 128 kafelków per segment
        }
        this.send_lvl += 10;
        this.socket.send(Buffer.from(p.get_buf()), true);
    }
}
// Rozmiar pakietu: 3 bajty nagłówka (counter + type + length)
//                  + 10 × (2 bajty prefix BE + 128 bajtów danych) = 1303 bajty
```

### Respawn po śmierci

Gdy gracz po śmierci naciśnie "ZAGRAJ PONOWNIE NA TYM POZIOMIE", klient wysyła pakiet typu 8 z informacją: czy obejrzał reklamę (`ads` - to jest w TODO) i jaki skin wybrał. Serwer teleportuje gracza na wysokość proporcjonalną do kwadratu `respawn_lvl` (im więcej śmierci, tym z wyższa spada — dodatkowa kara), przyznaje 2500 pkt bonusu za reklamę lub 0, odzyskuje punkty z ostatniego checkpointu (`saved_points`) i z zabójstw (`kill_points`), resetuje stan fizyki i dodaje gracza z powrotem do siatki segmentów.

```javascript
// apps/child-gameserver/main.js — w message(), case 8:
if (pl.is_dead) {                        // ochrona przed podwójnym respawnem
    pl.is_dead = false;
    respawned_players.push(pl.id);       // inni dostaną pakiet typu 6 (ożywienie)

    pl.x = random_pos();                 // losowa pozycja X (0..1023)
    pl.y = -((Math.pow(pl.respawn_lvl, 2) * 10) << 4) * 8 + 30;
    // respawn_lvl=0: y =  30         (tuż nad startem)
    // respawn_lvl=2: y = -5090        (spada z wysoka — kara za kolejne śmierci)

    if (pl.skin_id !== skin_id) {        // gracz zmienił skin po śmierci
        players_cheange_skin.push(pl);   // pakiet typu 13 → inni zobaczą zmianę
        pl.skin_id = skin_id;
    }

    // Reset pozycji w rankingu (gracz spada na koniec)
    for (let y = pl.ranking_id + 1; y < ranking.length; y++) ranking[y].ranking_id--;
    ranking.splice(pl.ranking_id, 1);
    pl.ranking_id = ranking.push(pl) - 1;

    pl.points = (ads === true) ? 2500 : 0;              // bonus za reklamę
    pl.add_points(pl.saved_points + pl.kill_points);    // odzyskaj checkpoint + kille

    pl.lvl        = 0;
    pl.event_use  = -2;
    pl.jump_frame = 0;
    add_player_seg(pl, pl.lvl);          // z powrotem do siatki segmentów
}
```

---

## 4. Zależności i Protokoły

### Pakiety z serwera do klienta związane z fizyką

| Typ | Zawartość | Kiedy |
|---|---|---|
| 0 | pozycje: `[count][id x y event_use]×count` | co takt (per-player) |
| 5 | zabici: `[count][id]×count` | gdy ktoś ginie |
| 6 | odrodzeni: `[count][id]×count` | po respawnie |
| 11 | event (życia): `[value: 0-10]` | gdy zmienia się event |
| 12 | nagroda za śmierć: `[uint32 amount]` | po śmierci |

### Pakiety od klienta do serwera

| Typ | Zawartość | Akcja serwera |
|---|---|---|
| 0 | ruch `[dx: int8]` | `pl.x += dx; pl.x &= 0x3ff` |
| 1 | skok `[]` | `pl.jump_frame = frame; pl.vecy = 4` |
| 8 | respawn `[ads: int8][skin_id: uint8]` | teleport + reset punktów |

### Partycja przestrzenna (segment_player)

```javascript
// Tablica indeksowana numerem segmentu (lvl)
// segment_player[5] = [pl_a, pl_b, pl_c] — gracze w segmencie 5
// Kolizje: sprawdzaj tylko segmenty (lvl-2) do (lvl+2) zamiast wszystkich
// O(n²) → ~O(n) dla równomiernie rozłożonych graczy
```

---

## 5. Konfiguracja Wdrożeniowa

Fizyka nie ma osobnej konfiguracji wdrożeniowej — wszystkie stałe są hardcoded w `apps/child-gameserver/main.js`:

| Stała | Wartość | Opis |
|---|---|---|
| `GRAVITY` | `0.1` | Przyspieszenie grawitacyjne (jednostek/takt²) |
| `PLAYER_RADIUS` | `11` | Promień gracza (jednostki) do kolizji |
| `SERVER_TICK_MS` | `16` | Interwał takta (~62.5/s) |
| `MAX_PLAYERS` | `15` | Maks. ludzkich graczy |
| `BOT_COUNT` | `37` | Liczba botów AI |

Zmiana tych wartości wymaga przebudowania obrazu Docker i wdrożenia przez CI/CD pipeline.
