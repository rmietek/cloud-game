# Ranking System — System Rankingu

## 1. Cel i architektura

System rankingu śledzi w czasie rzeczywistym pozycje wszystkich graczy na jednym serwerze gry — zarówno ludzi, jak i botów. Pozycje są utrzymywane w globalnej tablicy `ranking[]`, stale posortowanej od lidera (indeks 0) do gracza z najmniejszą liczbą punktów. Po każdym przyroście punktów gracz jest przesuwany w górę rankingu metodą bąbelkową (bubble sort), dopóki nie znajdzie właściwego miejsca. Punkty są kompresowane do jednego bajtu (`byte_point`), dzięki czemu cały leaderboard mieści się w kilkunastu bajtach pakietu binarnego.

### Komponenty

```
ranking[]         — globalna tablica graczy, posortowana malejąco względem punktów
                    ranking[0] = lider (najwięcej punktów)
                    ranking[N] = ostatnie miejsce (najmniej punktów)

player.ranking_id — indeks danego gracza w tablicy ranking[]
                    aktualizowany za każdym razem, gdy gracz zmienia pozycję

send_ranking      — globalna flaga: ustawiana na true, gdy zmieni się top 6
                    powoduje wysłanie pakietu typu 9 w następnym ticku

player.byte_point — punkty skompresowane do jednego bajtu (0–255)
                    używane w pakietach leaderboardu zamiast pełnej wartości
```

---

## 2. Kluczowa logika i przepływ

### Inicjalizacja rankingu

Nowy gracz jest zawsze dodawany na koniec tablicy rankingowej, czyli na ostatnie miejsce. Awansuje dopiero wtedy, gdy zdobędzie pierwsze punkty.

```javascript
// apps/child-gameserver/main.js
this.ranking_id = ranking.push(this) - 1;
// ranking.push(this) zwraca nową długość tablicy
// odjęcie 1 daje indeks właśnie dodanego elementu (ostatni w tablicy)
```

### `add_points(amount)` — bubble sort w górę rankingu

Funkcja jest wywoływana za każdym razem, gdy gracz zdobywa punkty — za zabójstwo, przejście do głębszej sekcji lub checkpoint. Po dodaniu punktów funkcja sprawdza, czy skompresowana wartość (`byte_point`) faktycznie się zmieniła i tylko wtedy ustawia flagę ponownego wysłania. Następnie w pętli przesuwa gracza w górę rankingu tak długo, jak długo gracz tuż nad nim ma mniej punktów.

```javascript
// apps/child-gameserver/main.js
this.add_points = function (amount) {
    this.points += amount;

    const oldByte = this.byte_point;
    const newByte = to_bignum_byte(this.points);
    // jeśli skompresowana wartość się nie zmieniła, nie ma potrzeby wysyłać aktualizacji

    if (oldByte !== newByte) {
        this.send_rank_pos = true;   // gracz zobaczy swoją nową pozycję (pakiet typu 10)
        this.byte_point    = newByte;

        if (this.ranking_id < 6) send_ranking = true;
        // jeśli gracz jest w top 6, leaderboard się zmienił — wyślij go wszystkim (pakiet typu 9)
    }

    let above = ranking[this.ranking_id - 1];
    // sąsiad o jedną pozycję wyżej; undefined gdy gracz jest już liderem

    while (above && above.points < this.points) {
        // dopóki ktoś wyżej ma mniej punktów — zamień ich miejscami

        if (this.ranking_id - 1 < 6) send_ranking = true;
        // zamiana odbywa się w obrębie top 6 — trzeba odświeżyć leaderboard

        ranking[this.ranking_id - 1].ranking_id++;   // sąsiad spada o jedno miejsce
        ranking[this.ranking_id]     = ranking[this.ranking_id - 1];
        ranking[this.ranking_id - 1] = this;         // swap w tablicy
        this.ranking_id--;                           // aktualny gracz awansuje

        above = ranking[this.ranking_id - 1];        // sprawdź kolejnego sąsiada wyżej
    }
};
```

Pętla `while` oznacza, że gracz może w jednym wywołaniu awansować o dowolnie wiele pozycji — np. jeśli zdobył dużo punktów za przejście do głębszej sekcji, od razu znajdzie się we właściwym miejscu. W typowej sytuacji, gdy przyrost punktów jest niewielki, pętla wykona zero lub jedno przejście.

### `to_bignum_byte(points)` — kompresja punktów do jednego bajtu

Leaderboard jest wysyłany do klienta wiele razy na sekundę. Pełna wartość punktów zajmuje 4 bajty (uint32), ale klient nie potrzebuje dokładnych liczb — wystarczy przybliżona skala do narysowania paska postępu. Funkcja redukuje punkty do zakresu 0–255 (jeden bajt), używając trzech przedziałów o malejącej dokładności: mała precyzja dla dużych wartości, gdzie i tak nikt nie zauważy różnicy paru tysięcy punktów.

```javascript
// apps/child-gameserver/main.js
function to_bignum_byte(points) {
    if (points > 66000000) return 255;
    // saturacja — powyżej 66 mln wszystko pokazywane jest jako maksimum

    if (points > 1000000)  return points / 100000 + 189;
    // zakres 1 mln – 66 mln → bajt ~199–255 (co 100 tys. punktów = +1)

    if (points > 100000)   return (points - 100000) / 10000 + 100;
    // zakres 100 tys. – 1 mln → bajt 100–189 (co 10 tys. punktów = +1)

    return points / 1000;
    // zakres 0 – 100 tys. → bajt 0–100 (co 1 tys. punktów = +1)
}
```

Funkcja zwraca wartości zmiennoprzecinkowe — dopiero przy zapisie przez `s_int8` są one obcinane do całkowitego bajtu.

---

## 3. Przykłady z kodu (implementacja)

### Wysyłanie leaderboardu (pakiet typu 9) — część globalna

Leaderboard jest wysyłany do wszystkich graczy naraz jako część „globalna" pakietu, tylko wtedy gdy flaga `send_ranking` jest ustawiona. Dzięki temu przy stabilnym rankingu pakiet nie jest wysyłany co tick.

```javascript
// apps/child-gameserver/main.js
if (send_ranking) {
    p.new_type(9);
    const l = ranking.length < 6 ? ranking.length : 6;
    // wysyłamy maksymalnie 6 graczy (tyle pokazuje UI)

    p.s_length8(l);
    for (let i = l; i--;) {
        p.s_int8(ranking[i].id);          // ID gracza na pozycji i
        p.s_int8(ranking[i].byte_point);  // jego skompresowane punkty
    }
    send_ranking = false;   // zresetuj flagę do następnej zmiany
}
```

### Wysyłanie własnej pozycji (pakiet typu 10) — część per-gracz

Każdy gracz dostaje dodatkowo informację o swojej aktualnej pozycji — ale tylko wtedy, gdy ta się zmieniła. Dzięki temu gracze spoza top 6 też wiedzą, na którym są miejscu.

```javascript
// apps/child-gameserver/main.js
if (pl.send_rank_pos) {
    p.new_type(10);
    p.s_int8(pl.ranking_id);  // pozycja w tablicy ranking[] (0 = lider)
    p.s_int8(pl.byte_point);  // skompresowane punkty
    pl.send_rank_pos = false;
}
```

### Inicjalny leaderboard przy dołączeniu gracza

Gdy nowy gracz dołącza do serwera, dostaje aktualny top 6 od razu w pakiecie powitalnym — niezależnie od flagi `send_ranking`.

```javascript
// apps/child-gameserver/main.js
p.new_type(9);
const rankLen = ranking.length < 6 ? ranking.length : 6;
p.s_length8(rankLen);
for (let i = rankLen; i--;) {
    p.s_int8(ranking[i].id);
    p.s_int8(ranking[i].byte_point);
}
ws.send(Buffer.from(p.get_buf()), true);
```

### Punkty za przejście do głębszej sekcji

Nagroda za awans rośnie wraz z numerem sekcji — im głębiej gracz zejdzie, tym więcej punktów dostaje za pokonanie każdego kolejnego poziomu.

```javascript
// apps/child-gameserver/main.js
const rl = Math.sqrt(idn / 10) | 0;  // numer sekcji: 0, 1, 2, 3...
this.add_points(50 * (rl + 1));
// sekcja 0 (poziomy 0–9):    50 × 1 =  50 pkt
// sekcja 1 (poziomy 10–39):  50 × 2 = 100 pkt
// sekcja 2 (poziomy 40–89):  50 × 3 = 150 pkt
// sekcja 3 (poziomy 90–159): 50 × 4 = 200 pkt
```

### Punkty za zabójstwo

```javascript
// apps/child-gameserver/main.js
this.target.add_points(1000);
// zabójca dostaje 1000 punktów za każdego wyeliminowanego gracza
```

---

## 4. Zależności i protokoły

### Przepływ rankingu

```
1. Gracz zdobywa punkty          → add_points(amount)
2. Bubble sort w górę rankingu   → while (above.points < this.points) swap
3. Jeśli zmiana dotyczy top 6    → send_ranking = true
4. Jeśli zmienił się byte_point  → pl.send_rank_pos = true
5. W następnym ticku gen_packet():
     część globalna    → pakiet typu 9  (leaderboard, gdy send_ranking)
     część per-gracz   → pakiet typu 10 (własna pozycja, gdy send_rank_pos)
```

### Struktura pakietów rankingu

```
Pakiet typu 9 (leaderboard, część globalna):
  [1 bajt] liczba wpisów (0–6)
  dla każdego wpisu:
    [1 bajt] ID gracza
    [1 bajt] byte_point
  Maksymalny rozmiar: 1 + 6×2 = 13 bajtów

Pakiet typu 10 (własna pozycja, część per-gracz):
  [1 bajt] ranking_id (indeks w tablicy ranking[])
  [1 bajt] byte_point
  Rozmiar: 2 bajty
```

### Pola gracza związane z rankingiem

| Pole | Typ | Opis |
|---|---|---|
| `ranking_id` | number | Indeks gracza w tablicy `ranking[]` |
| `points` | number | Bieżące punkty — używane do porównań w bubble sort |
| `byte_point` | number | Skompresowane punkty (0–255), cache dla pakietów |
| `send_rank_pos` | bool | Flaga: wyślij pakiet typu 10 w następnym ticku |

---

## 5. Konfiguracja

System rankingu nie ma żadnych parametrów konfigurowalnych z zewnątrz — wszystkie wartości są zaszyte w kodzie `apps/child-gameserver/main.js`.

| Parametr | Wartość | Miejsce w kodzie |
|---|---|---|
| Rozmiar leaderboardu | 6 graczy | `ranking.length < 6 ? ranking.length : 6` |
| Punkty za zabójstwo | 1000 | `this.target.add_points(1000)` |
| Punkty za awans sekcji | `50 × (sekcja + 1)` | `this.add_points(50 * (rl + 1))` |
| Próg zakresu 1 → 2 | 100 000 | `to_bignum_byte` |
| Próg zakresu 2 → 3 | 1 000 000 | `to_bignum_byte` |
| Saturacja | 66 000 000 | `if (points > 66000000) return 255` |

Powyżej 66 mln punktów wszyscy gracze dostają `byte_point = 255` — nie da się ich już rozróżnić w pakiecie. Pełna liczba punktów wciąż jest zapisywana w polu `points` i w MongoDB, więc informacja nie ginie, ale leaderboard przestaje pokazywać różnice między czołówką. W praktyce osiągnięcie takiej liczby punktów w jednej sesji jest mało prawdopodobne.
