# Architektura Komunikacji i Logika Obiektów — Frontend

## Wprowadzenie

Dokumentacja opisuje integrację frontendu (`index.html`) z logiką gry i serwerami.

Frontend komunikuje się z dwoma serwerami przez WebSocket:
- **Mother Server** (port `3001`) — lobby: logowanie, lista serwerów, tokeny sesji
- **Game Server / Child** (port dynamiczny) — właściwa rozgrywka: pozycje, kolizje, punkty

Protokół sieciowy jest **binarny** (nie JSON) — wszystkie pakiety to `ArrayBuffer` odczytywane przez `PacketGet` / `PacketSet` z `binary.js`.

---

## 1. Typy pakietów przyjmowanych przez frontend

### 1.1 Pakiety z Mother Servera (lobby)

Funkcja odbierająca: `handleMotherMessage` w `index.html`.
Podpięta przez: `motherSocket.onmessage = handleMotherMessage.bind(new PacketGet())`.
`this` = instancja `PacketGet` (parser binarny) — zachowuje wskaźnik odczytu między wywołaniami.

```js
// index.html — handleMotherMessage()
function handleMotherMessage(packet) {
  const p = this.set_buffer(packet.data);
  // set_buffer: ustawia DataView na nowy ArrayBuffer i resetuje wskaźnik do 0

  for (let i = p.g_length8(); i--;) {
    // g_length8(): odczytaj 1 bajt = liczba pakietów w tej wiadomości
    switch (p.g_uint8()) {
    // g_uint8(): odczytaj 1 bajt = typ pakietu
```

| Typ | Nazwa | Co robi frontend |
|-----|-------|-----------------|
| `0` | Token sesji + port + IP gry | Zapisuje token, otwiera WebSocket do serwera gry |
| `1` | Dane zalogowanego konta | Wypełnia UI: punkty, nick, lista posiadanych skinów |
| `2` | Lista aktywnych serwerów | Przebudowuje listę serwerów w lobby |
| `3` | Ceny skinów + kolory neonowe | Ładuje tablice `skins[]` i `lightSkins[]` |
| `4` | Serwer pełny | `alert('Server is full')` |

---

#### Type 0 — Token sesji + dane połączenia z serwerem gry

| | |
|---|---|
| **Nazwa** | Token sesji + adres serwera gry |
| **Co robi** | Przekazuje jednorazowy token i adres `child.js` — frontend otwiera nowe połączenie WebSocket do serwera gry |
| **Kiedy** | Raz, po kliknięciu PLAY przez gracza |

**Struktura binarna:**
```
[count: 1B]  [type=0: 1B]  [token: 4B uint32]  [port: 2B uint16]  [ip: 1B len + NB string]
```
| Pole | Typ | Rozmiar | Opis |
|------|-----|---------|------|
| `token` | `uint32` | 4B | Jednorazowy token sesji, np. `3482901234` |
| `port` | `uint16` | 2B | Port WebSocket serwera gry, np. `30542` |
| `ip` | `string` | 1B len + N | IP serwera gry, np. `"34.89.123.45"` |

```js
// index.html — handleMotherMessage, case 0
case 0: {
  const token = p.g_uint32(); // jednorazowy uint32 token sesji
  const port  = p.g_uint16(); // port WebSocket serwera gry (0–65535)
  const ip    = p.g_string(); // IP serwera gry (np. "34.89.123.45")
  gameToken = token;          // Zapamiętaj token (flaga "jesteśmy w grze")
  hideLobby();                // Ukryj lobby przed uruchomieniem gry

  // Otwórz połączenie z serwerem gry:
  // initGame(`ws://${ip}:${port}/${token}`)
  // URL: np. "ws://34.89.123.45:30542/3482901234"
  break;
}
```

**Przepływ:** gracz klika PLAY → `mother.js` generuje token → wysyła typ 0 → `initGame()` buduje scenę 3D i łączy się z `child.js`.

---

#### Type 1 — Dane zalogowanego konta

| | |
|---|---|
| **Nazwa** | Dane konta gracza |
| **Co robi** | Wypełnia UI lobby: waluta, nick, lista posiadanych skinów |
| **Kiedy** | Raz po autoryzacji (logowanie / reconnect) |

**Struktura binarna:**
```
[count: 1B]  [type=1: 1B]  [email: string16]  [points: 4B uint32]  [total_points: 4B uint32]  [name: string16]  [owned_skins: int8_arr]  [reserved: string_arr]
```
| Pole | Typ | Opis |
|------|-----|------|
| `email` | `string16` | Email konta gracza (UTF-16) |
| `points` | `uint32` | Aktualna waluta |
| `total_points` | `uint32` | Łącznie zarobione złoto (historycznie) |
| `name` | `string16` | Nick do rankingu |
| `owned_skins` | `int8[]` | Lista ID posiadanych skinów, np. `[3, 7, 12]` |
| `reserved` | `string[]` | Zarezerwowane — ignorowane |

```js
// index.html — handleMotherMessage, case 1
case 1: {
  const email  = p.g_string16(); // email gracza
  const points = p.g_uint32();   // aktualna waluta
  const tp     = p.g_uint32();   // łącznie zarobione (total_points)
  const name   = p.g_string16(); // nick do rankingu
  const os     = p.g_int8_arr(); // lista ID posiadanych skinów [3, 7, 12, ...]
  p.g_string_arr();              // zarezerwowane — ignorowane (przyszłe użycie)

  accountSkins = os;             // zapisz które skiny posiada gracz
  // Aktualizuj UI: wyświetl punkty, nick, odznacz posiadane skiny w sklepie
  if (skins) loadSkinImage(skinId); // odśwież podgląd skina jeśli ceny już znane
  break;
}
```

---

#### Type 2 — Lista aktywnych serwerów gier

| | |
|---|---|
| **Nazwa** | Lista serwerów gry |
| **Co robi** | Przebudowuje listę dostępnych serwerów w UI lobby |
| **Kiedy** | Po każdej zmianie stanu serwerów (nowy serwer, zamknięcie, zmiana liczby graczy) — wysyłany przez `mother.js` po odebraniu `lobby_update` z Redis |

**Struktura binarna:**
```
[count: 1B]  [type=2: 1B]  [srv_count: 1B]  × srv_count: [g_id: 4B]  [players_len: 1B]  [players_lim: 1B]  [...]
```
| Pole | Typ | Opis |
|------|-----|------|
| `srv_count` | `uint8` | Liczba aktywnych serwerów |
| `g_id` | `uint32` | Unikalny ID serwera (ten sam co `game_id` w `child.js`) |
| `g_players_len` | `uint8` | Aktualna liczba graczy |
| `g_players_lim` | `uint8` | Limit graczy (np. `16`) |

```js
// index.html — handleMotherMessage, case 2
case 2: {
  const currentSelectedId = selectedGame ? selectedGame.g_id : null;
  // Zapamiętaj ID aktualnie wybranego serwera — przywrócimy po przebudowie listy
  games = [];

  for (let a = p.g_length8(); a--;) {
    games.push({
      g_id:          p.g_uint32(), // unikalny ID serwera (ten sam co game_id w child.js)
      g_players_len: p.g_uint8(),  // aktualna liczba graczy
      g_players_lim: p.g_uint8(), // limit graczy (np. 16)
      // ... inne pola (ip, port, lokalizacja) odczytywane dalej
    });
  }
  // Przebuduj UI listy serwerów, przywróć zaznaczenie jeśli serwer nadal istnieje
  // Pokaż przycisk PLAY (wcześniej display:none — gracz nie mógłby dołączyć do niczego)
  break;
}
```

---

#### Type 3 — Ceny skinów + kolory neonowe

| | |
|---|---|
| **Nazwa** | Cennik i paleta kolorów skinów |
| **Co robi** | Ładuje tablice `skins[]` (ceny) i `lightSkins[]` (kolory neonowe) używane w sklepie i przy kolorowaniu nicków graczy |
| **Kiedy** | Raz przy połączeniu z lobby |

**Struktura binarna:**
```
[count: 1B]  [type=3: 1B]  [skins: int32_arr (23 × 4B)]  [lightSkins: int32_arr (23 × 4B)]
```
| Pole | Typ | Opis |
|------|-----|------|
| `skins` | `int32[]` | 23 ceny skinów w złocie, np. `[0, 500, 1200, ...]` |
| `lightSkins` | `int32[]` | 23 kolory hex neonowe, np. `[0x00d4ff, 0xff44aa, ...]` — kolor nicku i świateł gracza |

```js
// index.html — handleMotherMessage, case 3
case 3: {
  skins      = p.g_int32_arr(); // tablica 23 cen (SKIN_COSTS z mother.js)
  lightSkins = p.g_int32_arr(); // tablica 23 kolorów hex (SKIN_LIGHTS z mother.js)

  const sv = localStorage.getItem('skin_id') | 0;
  // | 0: parseInt + fallback na 0 jeśli null (localStorage zwraca null gdy brak klucza)
  skinId = sv ? sv : ((Math.random() * 3) | 0) + 1;
  // Losowy skin startowy (1–3) jeśli gracz nie miał wcześniej wybranego

  if (accountSkins) loadSkinImage(skinId); // odśwież podgląd skina jeśli konto już znane
  break;
}
```

---

#### Type 4 — Serwer pełny

| | |
|---|---|
| **Nazwa** | Serwer pełny |
| **Co robi** | Wyświetla alert — gracz nie może dołączyć do wybranego serwera |
| **Kiedy** | Gdy `g_players_len >= g_players_lim` w momencie kliknięcia PLAY |

**Struktura binarna:**
```
[count: 1B]  [type=4: 1B]
```
Brak danych — sam typ wystarczy jako sygnał.

```js
// index.html — handleMotherMessage, case 4
case 4: {
  alert('Server is full — try again in a moment.');
  // Gracz musi wybrać inny serwer lub poczekać aż ktoś wyjdzie.
  break;
}
```

---

### 1.2 Pakiety z Game Servera (rozgrywka)

Funkcja odbierająca: `hgm` w `index.html`.
Podpięta przez: `gs.onmessage = hgm.bind(new PacketGet())`.
Jeden pakiet WebSocket może zawierać **wiele komend naraz** — `g_length8()` odczytuje ile ich jest.

```js
// index.html — hgm() (handleGameMessage)
function hgm(packet) {
  const p = this.set_buffer(packet.data);

  for (let i = p.g_length8(); i--;) {  // ile komend w tym pakiecie
    switch (p.g_uint8()) {             // typ komendy
```

| Typ | Nazwa | Co robi frontend |
|-----|-------|-----------------|
| `0` | Pozycje graczy | Aktualizuje modele 3D, przesuwa kamerę (dla myPlayer) |
| `1` | Nowi gracze | Tworzy obiekty `Player` (model OBJ + TextSprite) |
| `2` | Gracze wyszli | `player.destructor()` — usuwa ze sceny |
| `3` | Inicjalizacja gracza | Ustawia `myPlayerId`, tworzy wszystkich graczy w pokoju |
| `4` | Dane poziomów mapy | Wypełnia `levels[]`, ładuje ringi jeśli gotowe |
| `5` | Śmierć gracza | Ukrywa model, dla myPlayer pokazuje ekran śmierci |
| `6` | (zarezerwowane) | Pomija dane |
| `7` | Ukryj gracza | `player.obj.visible = false` (teleport/spawn) |
| `8` | Wiadomość czatu | `appendChat(player, msg)` |
| `9` | Ranking TOP 6 | Aktualizuje `#ranking` w UI |
| `10` | Własna pozycja poza TOP 6 | Dodaje wiersz za TOP 6 w `#ranking` |
| `11` | Postęp eventu | Aktualizuje licznik `X/10` pod przyciskiem eventu |
| `12` | Zarobione złoto | Wyświetla `"50000 Gold!"` na ekranie śmierci |
| `13` | Zmiana skina | `player.cheange_skin(sk)` — podmienia model |

---

#### Type 0 — Aktualizacja pozycji graczy (~60Hz)

| | |
|---|---|
| **Nazwa** | Pozycje graczy |
| **Co robi** | Aktualizuje pozycje modeli 3D wszystkich widocznych graczy; dla `myPlayer` przesuwa też kamerę i sprawdza scroll cylindra |
| **Kiedy** | Co tick (~60Hz) od `child.js` — najczęściej wysyłany pakiet w grze |

**Struktura binarna:**
```
[type=0: 1B]  [count: 1B]  × count: [id: 1B]  [x: 4B float]  [y: 4B float]  [event_state: 1B int8]
```
| Pole | Typ | Rozmiar | Opis |
|------|-----|---------|------|
| `id` | `uint8` | 1B | ID gracza (0–255) |
| `x` | `float` | 4B | Pozycja kątowa na okręgu (0–1023, 10-bit) |
| `y` | `float` | 4B | Pozycja pionowa wzdłuż cylindra |
| `event_state` | `int8` | 1B | Stan eventu: `-1`/`-3` = trafiony, inne = normalny |

```js
// index.html — hgm, case 0
case 0: {
  const vf = []; // lista graczy widocznych w tej klatce

  for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8();   // ID gracza (0–255)
    const pl = players[id];   // pobierz obiekt Player
    lastVisiblePlayers.rm_val(pl); // usuń ze "starych widocznych" (diff)

    const x  = p.g_float();   // pozycja kątowa 0–1023 na okręgu
    const y  = p.g_float();   // pozycja pionowa wzdłuż cylindra
    const ec = p.g_int8();    // stan eventu: -1/-3 = trafiony

    if (pl) {
      pl.obj.visible = true;  // gracz jest widoczny w tej klatce
      pl.set_pos(x, y);       // przelicz na pozycję 3D (sin/cos × R)
      vf.push(pl);
    }
  }
  // Gracze z lastVisiblePlayers których tu nie ma → obj.visible = false
  lastVisiblePlayers = vf;
  break;
}
```

---

#### Type 1 — Nowi gracze dołączyli

| | |
|---|---|
| **Nazwa** | Nowi gracze |
| **Co robi** | Tworzy obiekty `Player` — model OBJ + etykieta nicku (`TextSprite`) dodane do sceny Three.js |
| **Kiedy** | Gdy inny gracz dołącza do serwera gry w trakcie rozgrywki |

**Struktura binarna:**
```
[type=1: 1B]  [count: 1B]  × count: [id: 1B]  [nick: 2B len + NB string16]  [skin_id: 1B]
```
| Pole | Typ | Opis |
|------|-----|------|
| `id` | `uint8` | ID gracza w tym pokoju |
| `nick` | `string16` | Nazwa gracza (UTF-16, max 9 znaków) |
| `skin_id` | `uint8` | ID wybranego skina |

```js
// index.html — hgm, case 1
case 1: {
  for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8(),   // ID gracza
          n  = p.g_string16(), // nick (UTF-16)
          sk = p.g_uint8();    // skin_id
    if (!players[id]) players[id] = new Player(id, n, sk);
    // new Player(): tworzy THREE.Group z modelem OBJ + TextSprite nicku, dodaje do sceny
    // obj.visible = false — niewidoczny do pierwszego type 0
  }
  break;
}
```

---

#### Type 2 — Gracze wyszli z gry

| | |
|---|---|
| **Nazwa** | Gracze wyszli |
| **Co robi** | Wywołuje `player.destructor()` — usuwa model 3D ze sceny, zwalnia pamięć |
| **Kiedy** | Gdy gracz rozłączy się z serwerem gry (zamknięcie przeglądarki, timeout) |

**Struktura binarna:**
```
[type=2: 1B]  [count: 1B]  × count: [id: 1B]
```
| Pole | Typ | Opis |
|------|-----|------|
| `id` | `uint8` | ID gracza do usunięcia |

```js
// index.html — hgm, case 2
case 2: {
  for (let ix = p.g_length8(); ix--;) {
    players[p.g_uint8()].destructor();
    // destructor(): usuwa THREE.Group ze sceny, zwalnia materiały, czyści players[id]
  }
  break;
}
```

---

#### Type 3 — Inicjalizacja własnego gracza (wysyłany raz przy wejściu)

| | |
|---|---|
| **Nazwa** | Inicjalizacja gracza |
| **Co robi** | Ustawia `myPlayerId`, tworzy obiekty `Player` dla wszystkich graczy już obecnych w pokoju (łącznie z własnym) |
| **Kiedy** | Raz — natychmiast po zweryfikowaniu tokenu przez `child.js` |

**Struktura binarna:**
```
[type=3: 1B]  [my_id: 1B]  [count: 1B]  × count: [id: 1B]  [nick: string16]  [skin_id: 1B]
```
| Pole | Typ | Opis |
|------|-----|------|
| `my_id` | `uint8` | ID przypisane temu klientowi przez serwer gry |
| `count` | `uint8` | Liczba graczy w pokoju (łącznie z własnym) |
| `id`, `nick`, `skin_id` | jak type 1 | Dane każdego gracza |

```js
// index.html — hgm, case 3
case 3: {
  myPlayerId = p.g_uint8();
  // Zapamiętaj własne ID — w new Player() jeśli id === myPlayerId → myPlayer = this

  for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8(), n = p.g_string16(), sk = p.g_uint8();
    players[id] = new Player(id, n, sk);
    // Tworzy WSZYSTKICH graczy aktualnie w pokoju (łącznie z własnym)
  }
  break;
}
```

---

#### Type 4 — Dane poziomów mapy (10 ringów naraz)

| | |
|---|---|
| **Nazwa** | Dane poziomów mapy |
| **Co robi** | Zapisuje 10 poziomów do tablicy `levels[]`; jeśli ringi gotowe — wywołuje `loadRing()` i ustawia materiały kafelków |
| **Kiedy** | Przy wejściu (poziomy 0–9), potem proaktywnie co ~10 pokonanych ringów |

**Struktura binarna:**
```
[type=4: 1B]  [count=10: 1B]  × 10: [len=128: 2B uint16]  [tiles: 128B]
```
| Pole | Typ | Rozmiar | Opis |
|------|-----|---------|------|
| `count` | `uint8` | 1B | Zawsze `10` — liczba poziomów w pakiecie |
| `len` | `uint16` | 2B | Zawsze `128` — liczba kafelków na poziom |
| `tiles` | `uint8[128]` | 128B | Typ każdego kafelka: `0`=pusta, `1`=bezpieczna, `2`=niebezpieczna |

Łączny rozmiar jednego pakietu: `2 + 10 × (2 + 128) = 1302 B`.

```js
// index.html — hgm, case 4
case 4: {
  for (let ix = p.g_length8(); ix--;) {      // zawsze 10
    levels[levelsReceived + ix] = p.g_int8_arr();
    // g_int8_arr(): czyta uint16 długość (=128) + 128 bajtów → Uint8Array[128]
    // levels[N] = 128 kafelków dla poziomu N (0=pusta, 1=bezpieczna, 2=niebezpieczna)
  }
  if (!levelsReceived) {
    // To PIERWSZA paczka danych (poziomy 0–9)
    // Sprawdź czy ringi są już zbudowane (initGame może być w trakcie):
    // SCENARIUSZ A: ringDataReady=true → loadRing(i, i) dla ringów 0–4
    // SCENARIUSZ B: ringi nie gotowe  → ustaw ringDataReady=true, loadRing wywoła się później
  }
  levelsReceived += 10; // przesuń licznik odebranych poziomów
  break;
}
```

---

#### Type 5 — Śmierć gracza

| | |
|---|---|
| **Nazwa** | Śmierć gracza |
| **Co robi** | Ukrywa model gracza (`obj.visible = false`); dla `myPlayer` pokazuje ekran śmierci z liczbą zdobytych punktów |
| **Kiedy** | Gdy gracz wpadnie na platformę `type=2` (niebezpieczną) |

**Struktura binarna:**
```
[type=5: 1B]  [count: 1B]  × count: [id: 1B]
```
| Pole | Typ | Opis |
|------|-----|------|
| `id` | `uint8` | ID gracza który zginął |

Uwaga: pakiet type `12` (złoto) jest wysyłany przez `child.js` **przed** type `5` — żeby liczba była gotowa zanim pojawi się ekran śmierci.

```js
// index.html — hgm, case 5
case 5: {
  for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8();
    if (players[id]) {
      players[id].obj.visible = false; // ukryj model
      if (players[id] === myPlayer) {
        showRespawnMenu(gs, resetRings);
        // Ukryj HUD, pokaż ekran śmierci z punktami (z type 12), opcjonalnie reklama
      }
    }
  }
  break;
}
```

---

#### Type 7 — Ukryj gracza (teleport/spawn)

| | |
|---|---|
| **Nazwa** | Ukryj gracza |
| **Co robi** | Ustawia `player.obj.visible = false` — gracz "znika" i pojawi się ponownie po pierwszym type `0` z jego ID |
| **Kiedy** | Przy teleporcie, spawnie lub odrodzeniu gracza |

**Struktura binarna:**
```
[type=7: 1B]  [count: 1B]  × count: [id: 1B]
```

```js
// index.html — hgm, case 7
case 7: {
  for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8();
    if (players[id]) players[id].obj.visible = false;
    // Gracz "znika" — np. właśnie się odrodził w innym miejscu
    // Pojawi się znowu przy następnym type 0 z jego ID
  }
  break;
}
```

---

#### Type 8 — Wiadomość czatu

| | |
|---|---|
| **Nazwa** | Wiadomość czatu |
| **Co robi** | Dodaje wiersz do `#chat` z kolorem nicku z `lightSkins[skin_id]` nadawcy |
| **Kiedy** | Gdy gracz wyśle wiadomość przez pole czatu (Enter) |

**Struktura binarna:**
```
[type=8: 1B]  [count: 1B]  × count: [id: 1B]  [msg: 2B len + NB string16]
```
| Pole | Typ | Opis |
|------|-----|------|
| `id` | `uint8` | ID gracza — nadawcy wiadomości |
| `msg` | `string16` | Treść wiadomości (UTF-16, obsługuje emoji) |

```js
// index.html — hgm, case 8
case 8: {
  for (let ix = p.g_length8(); ix--;) {
    const id  = p.g_uint8();
    const msg = p.g_string16(); // UTF-16 — obsługuje emoji i znaki specjalne
    if (players[id]) appendChat(players[id], msg);
    // appendChat(): dodaje wiersz do #chat z kolorem nicku z lightSkins[skin_id]
  }
  break;
}
```

---

#### Type 9 — Ranking TOP 6

| | |
|---|---|
| **Nazwa** | Ranking TOP 6 |
| **Co robi** | Aktualizuje listę `#ranking` w HUD — nick i punkty 6 najlepszych graczy |
| **Kiedy** | Co tick gdy zmienią się punkty lub kolejność w rankingu |

**Struktura binarna:**
```
[type=9: 1B]  [count: 1B]  × count: [rank: 1B]  [points: 1B]
```
| Pole | Typ | Opis |
|------|-----|------|
| `count` | `uint8` | Liczba graczy w rankingu (0–6) |
| `rank` | `uint8` | Pozycja (0-indexed) |
| `points` | `uint8` | Skompresowane punkty |

```js
// index.html — hgm, case 9
case 9: {
  const cnt = p.g_length8(); // liczba graczy w rankingu (0–6)

  if (cnt < 6) {
    // Mniej niż 6 graczy — wyczyść nadmiarowe pozycje w #ranking
    for (let ix = 6; ix--;) $('#ranking').children[ix * 2].innerText = '';
  }
  for (let ix = 0; ix < cnt; ix++) {
    const rank = p.g_uint8(); // pozycja (0-indexed)
    const pts  = p.g_uint8(); // skompresowane punkty
    // Aktualizuj wiersz ix w #ranking: nick + punkty
  }
  break;
}
```

---

#### Type 10 — Własna pozycja poza TOP 6

| | |
|---|---|
| **Nazwa** | Własna pozycja poza TOP 6 |
| **Co robi** | Dodaje dodatkowy wiersz pod listą TOP 6 w `#ranking` z własną pozycją, np. `"#9  42"` |
| **Kiedy** | Gdy `myPlayer` nie mieści się w TOP 6 |

**Struktura binarna:**
```
[type=10: 1B]  [rank: 1B]  [points: 1B]
```
| Pole | Typ | Opis |
|------|-----|------|
| `rank` | `uint8` | Pozycja gracza w rankingu (> 5, 0-indexed) |
| `points` | `uint8` | Skompresowane punkty gracza |

```js
// index.html — hgm, case 10
case 10: {
  const rank = p.g_uint8(); // pozycja gracza w rankingu (0-indexed, > 5)
  const pts  = p.g_uint8(); // skompresowane punkty
  const cell = $('#ranking').children[12]; // 13. element = dodatkowy wiersz za TOP 6

  if (rank > 5) {
    cell.innerText = `#${rank + 1}  ${pts}`;
    // Wyświetl własną pozycję pod listą TOP 6, np. "#9  42"
  }
  break;
}
```

---

#### Type 11 — Postęp eventu

| | |
|---|---|
| **Nazwa** | Postęp eventu |
| **Co robi** | Aktualizuje licznik `X/10` widoczny pod przyciskiem strzałki eventu w HUD |
| **Kiedy** | Gdy gracz wykonuje akcję eventu (kliknięcie przycisku strzałki) |

**Struktura binarna:**
```
[type=11: 1B]  [progress: 1B]
```
| Pole | Typ | Opis |
|------|-----|------|
| `progress` | `uint8` | Aktualny postęp eventu (0–10) |

```js
// index.html — hgm, case 11
case 11: {
  const prog = p.g_uint8(); // aktualna wartość (0–10)
  $('#eventb').children[1].innerText = prog + '/10';
  // Aktualizuje licznik pod przyciskiem strzałki eventu: "7/10"
  break;
}
```

---

#### Type 12 — Zarobione złoto (po śmierci)

| | |
|---|---|
| **Nazwa** | Zarobione złoto |
| **Co robi** | Wyświetla liczbę zdobytych punktów na ekranie śmierci, np. `"50000 Gold!"` |
| **Kiedy** | Wysyłany przez `child.js` **przed** type `5` (śmierć) — żeby liczba była gotowa gdy pojawi się UI |

**Struktura binarna:**
```
[type=12: 1B]  [gold: 4B uint32]
```
| Pole | Typ | Rozmiar | Opis |
|------|-----|---------|------|
| `gold` | `uint32` | 4B | Liczba zarobionych punktów (może być duża — miliony) |

```js
// index.html — hgm, case 12
case 12: {
  const gold = p.g_uint32(); // może być duże (miliony punktów)
  $('#win_points').innerText = gold + ' Gold!';
  // Wyświetla na ekranie śmierci: "50000 Gold!"
  // Wysyłany przez child.js przed type 5 (śmierć) — żeby liczba była gotowa przed pokazaniem UI
  break;
}
```

---

#### Type 13 — Gracz zmienił skin podczas gry

| | |
|---|---|
| **Nazwa** | Zmiana skina |
| **Co robi** | Wywołuje `player.cheange_skin(sk)` — usuwa stary model OBJ, wczytuje nowy, zachowuje `TextSprite` nicku |
| **Kiedy** | Gdy gracz zmieni skin w menu (dostępne między rundami) |

**Struktura binarna:**
```
[type=13: 1B]  [count: 1B]  × count: [id: 1B]  [skin_id: 1B]
```
| Pole | Typ | Opis |
|------|-----|------|
| `id` | `uint8` | ID gracza który zmienił skin |
| `skin_id` | `uint8` | Nowe ID skina |

```js
// index.html — hgm, case 13
case 13: {
  for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8(), sk = p.g_uint8();
    if (players[id]) players[id].cheange_skin(sk);
    // cheange_skin(): usuwa stary model OBJ, wczytuje nowy, zachowuje TextSprite nicku
  }
  break;
}
```

---

## 2. Nieskończony scroll poziomów — skąd frontend dostaje nowe platformy

### 2.1 Problem

Gracz opada w dół nieskończonego tunelu. Frontend nie może załadować całej mapy z góry — byłoby to za dużo danych. Rozwiązanie to **recycling 5 ringów** i **streaming danych z serwera**.

### 2.2 Format pakietu type 4 — dane ringów

Serwer (child.js) wysyła dane przez **pakiet type 4** — porcjami po 10 poziomów naraz.

Struktura binarna jednego pakietu:

```
[count: 1B]               ← liczba poziomów w tym pakiecie (zawsze 10)
  × count:
    [len_hi: 1B]          ┐
    [len_lo: 1B]          ┘ uint16 = długość tablicy (zawsze 128)
    [tile_0: 1B]          ┐
    [tile_1: 1B]          │ 128 bajtów — kafelki dla tego poziomu
    ...                   │ każdy bajt: 0 = pusta, 1 = bezpieczna, 2 = niebezpieczna
    [tile_127: 1B]        ┘
```

Przykład — pakiet z 2 poziomami (uproszczony):

```
0A                        ← count = 10 (hex 0A)
  00 80                   ← len = 128 (hex 0x0080)
  01 00 02 01 00 00 01 ... ← 128 kafelków poziomu 0
  00 80
  00 01 01 02 00 01 00 ... ← 128 kafelków poziomu 1
  ...
```

Odczyt po stronie frontendu (`hgm`, case 4):

```js
for (let ix = p.g_length8(); ix--;) {          // odczytaj count (10)
  levels[levelsReceived + ix] = p.g_int8_arr(); // g_int8_arr: czyta uint16 długość + N bajtów
}
levelsReceived += 10;
```

### 2.3 Bufor poziomów `levels[]`

Serwer (child.js) wysyła dane przez **pakiet type 4** — porcjami po 10 poziomów naraz:
- **Przy wejściu do gry** — pierwsze 10 poziomów (0–9)
- **Proaktywnie** — gdy gracz zbliża się do końca znanych danych, serwer dosyła kolejne 10

```
levels[0]  = Uint8Array[128]  ← poziom 0  (128 kafelków kołowo)
levels[1]  = Uint8Array[128]  ← poziom 1
...
levels[N]  = Uint8Array[128]  ← rośnie w nieskończoność
```

Tablica `levels[]` rośnie bez limitu — gracz może grać wiecznie.

### 2.3 Recycling ringów — `advCyl()`

W scenie istnieje tylko **5 ringów** (`THREE.Group`). Gdy gracz opada i mija ring, jest on **recyclingowany** — teleportowany niżej i załadowany nowymi danymi:

```
Pętla animacji (60Hz):
  animate() → scrollCyl() → advCyl()
```

```js
function advCyl() {
  const og = ringGroups[(ringGroupIndex - 5) % 5];
  // Najstarszy ring = ten który był 5 poziomów temu

  // Gracz minął ring (jest 147j niżej) → recykluj
  if (og.position.y - 128 - 18 <= myPlayer.obj.position.y) return;

  ringGroups[ringGroupIndex % 5] = og; // przypisz do nowego slotu
  loadRing(og, ringGroupIndex);         // teleportuj niżej + załaduj levels[ringGroupIndex]
  ringGroupIndex++;                     // przesuń licznik
}
```

Wizualizacja stanu przy `ringGroupIndex = 5` (start gry, gracz na poziomie 0):

```
Y=  +16  [slot 0] poziom 0  ← gracz zaczyna tutaj
Y= -112  [slot 1] poziom 1
Y= -240  [slot 2] poziom 2
Y= -368  [slot 3] poziom 3
Y= -496  [slot 4] poziom 4  ← najniższy widoczny ring
```

Gdy gracz opada do Y ≈ -130, slot 0 (poziom 0) jest już za nim — teleport:

```
Y= -112  [slot 1] poziom 1  ← teraz najwyższy
Y= -240  [slot 2] poziom 2
Y= -368  [slot 3] poziom 3
Y= -496  [slot 4] poziom 4
Y= -624  [slot 0] poziom 5  ← teleportowany na dół z nowymi danymi
```

Gracz opada dalej — kolejne sloty są recyklingowane jeden po drugim, zawsze 5 ringów widocznych.

### 2.4 Funkcja `loadRing(group, ri)`

Ustawia pozycję Y ringu i przypisuje materiały kafelków na podstawie `levels[ri]`:

```js
function loadRing(group, ri) {
  group.position.y = -ri * 128 + 16; // pozycja Y = głębokość poziomu

  for (let y = 127; y >= 0; y--) {   // 128 kolumn kołowo
    const tile = group.children[127 - y];
    const type = levels[ri][y];       // 0/1/2 z danych serwera

    if (type === 0) { tile.visible = false; continue; }

    tile.visible = true;
    tile.children[0].material = /* tekstura segmentu */;
    tile.children[1].visible  = (type === 2); // czerwona nakładka dla niebezpiecznych
  }
}
```

### 2.5 Ściany cylindra — double-buffer

Ściany tunelu to **2 cylindry** (`CylinderBufferGeometry`) o wysokości `512j` każdy. Gdy gracz opada poniżej zakresu, wyższy cylinder jest teleportowany `512j` niżej:

```
cyl[0].y =    0  ]  gracz widzi oba naraz
cyl[1].y = -512  ]

Gracz opada → cyl[0] jest już za nim:
  cyl[0].y = -1024  ← teleport
  cyl[1].y =  -512  ← nadal widoczny
```

Efekt: gracz widzi nieskończoną ścianę bez żadnych przerw.

### 2.6 Synchronizacja WebSocket ↔ generowanie ringów

Dane poziomów (WebSocket) i generowanie ringów (Three.js) mogą być gotowe w różnej kolejności. Flaga `ringDataReady` rozwiązuje wyścig:

```
Jeśli ring gotowy PRZED danymi:
  ringDataReady = true → gdy przyjdzie pakiet type 4, loadRing od razu

Jeśli dane gotowe PRZED ringiem:
  ringDataReady = true → gdy ring będzie gotowy, loadRing od razu
```

### 2.7 Reset po śmierci (`resetRings`)

Po kliknięciu RESPAWN gracz wraca na poziom 0 — ringi są resetowane:

```js
function resetRings() {
  cyl[0].position.y = 0;
  cyl[1].position.y = -512;
  for (let i = 0; i < 5; i++) loadRing(ringGroups[i], i); // poziomy 0–4
  ringGroupIndex = 5; // następny advCyl() załaduje poziom 5
}
```

---

## 3. Tworzenie platform i cylindrów

### 2.1 Struktura tunelu

Gra rozgrywa się wewnątrz **cylindrycznego tunelu 3D**. Tunel zbudowany jest z:
- **2 cylindrów** (`CylinderBufferGeometry`) tworzących ściany — podwójne buforowanie (gdy gracz jedzie w dół, jeden cylinder jest recyclingowany przed graczem)
- **5 ringów** (`THREE.Group`) — każdy ring to pierścień 128 kolumn platform rozmieszczonych kołowo

```
Tunel = 2 cylindry (ściany) + 5 ringów × 128 kolumn (platformy)
```

### 2.2 Parametry geometrii

| Parametr | Wartość | Opis |
|----------|---------|------|
| Promień cylindra `R` | `162.815...` | Obliczony tak by 128 kolumn idealnie wypełniło obwód: `R = (szer_kolumny × 128) / (2π)` |
| Rozmiar kafelka `TS` | `16` jednostek | Jeden poziom mapy = 8 warstw × 16j = 128j między poziomami |
| Liczba kolumn na ring | `128` | Rozmieszczone co `2.8°` (360° / 128) |
| Liczba widocznych ringów | `5` | Łącznie 640 kolumn w scenie |

### 2.3 Pozycjonowanie kolumn w przestrzeni 3D

Każda kolumna (`OBJ`) jest klonem modelu obróconego wokół osi Y:

```js
// Rozmieszczenie 128 kolumn po okręgu:
for (let y = 0; y < 128; y++) {
  const clone = column.clone();
  clone.rotation.y = 0.02453125 * 2 * y;
  // 0.02453125 = π/128 ≈ 1.4° — kąt między sąsiednimi kolumnami
  // y=0   → rotation.y = 0°
  // y=64  → rotation.y = π = 180° (naprzeciwko)
  // y=127 → rotation.y ≈ 357°
  ringGroup.add(clone);
}
```

### 2.4 Typy kafelków (dane z serwera)

Dane poziomów to `Uint8Array[128]` dla każdego poziomu (pakiet type `4`):

| Wartość | Typ platformy | Materiał |
|---------|---------------|----------|
| `0` | Pusta przestrzeń | kolumna niewidoczna (`visible = false`) |
| `1` | Bezpieczna platforma | tekstura segmentu `fm[0]` lub `fm[1]` |
| `2` | Niebezpieczna platforma | `m_bad` — czerwony emisyjny, pulsuje w `animate()` |

---

## 3. Mechanika obracania gracza

Gracz porusza się **kołowo po wewnętrznej ścianie cylindra** — obraca się wokół osi Y tunelu, jednocześnie spadając/wspinając się wzdłuż osi Y.

### 3.1 Sterowanie myszą / dotykiem

```js
renderer.domElement.onmousemove = function (e) {
  if (!isDrag) return;
  const d = dsx - e.screenX; // delta: ujemna = prawo, dodatnia = lewo
  dsx = e.screenX;
  smi(d);                    // wyślij prędkość do serwera
};
```

- `isDrag` ustawiany przez `onmousedown` / `ontouchstart`
- Delta `d` to różnica pozycji ekranowej — im szybszy ruch myszy, tym większa wartość

### 3.2 Sterowanie klawiaturą (A/D lub strzałki)

```js
document.addEventListener('keydown', function (e) {
  switch (e.which) {
    case 68: case 39: // D lub →
      if (vel === 0) vel = 7 + ((Math.random() * 4 - 2) | 0); // start: 7 ± 2
      if (vel < 30)  vel += 1;  // przyspieszaj do max 30
      smi(vel);
      break;
    case 65: case 37: // A lub ←
      if (vel === 0) vel = -7 + ((Math.random() * 4 - 2) | 0);
      if (vel > -30) vel -= 1;
      smi(vel);
      break;
  }
});
document.addEventListener('keyup', function () { vel = 0; });
```

- Prędkość startowa jest lekko losowa (`± 2`) — "naturalne" przyspieszenie
- Wartość `vel` akumuluje się przy trzymaniu klawisza (max `±30`)
- Puszczenie klawisza zeruje `vel` — gracz zatrzymuje się

### 3.3 Funkcja `smi(v)` — wysyłanie ruchu

```js
function smi(v) {
  if (Math.abs(v) >= 127) v = v < 0 ? -127 : 127; // klamp do Int8
  if (myPlayer && v) gs.send(new Uint8Array([0, v]).buffer);
  // Bajt 0: typ = 0 (ruch poziomy)
  // Bajt 1: prędkość Int8 (-127..+127)
}
```

- `< 0` = obrót w lewo, `> 0` = obrót w prawo
- `v === 0` nie jest wysyłane (brak pakietu = brak ruchu)
- Serwer (`child.js`) aplikuje deltę kątową do pozycji gracza i rozsyła zaktualizowane pozycje wszystkim

### 3.4 Odpowiedź serwera → pozycja 3D na okręgu

Po odebraniu `v` serwer aktualizuje kąt gracza i co tick (~60 Hz) rozsyła pozycje wszystkich graczy przez **pakiet type 0**. Każdy gracz ma:
- `x` — pozycja kątowa jako liczba całkowita **0–1023** (10-bitowy int, pełny okrąg)
- `y` — pozycja pionowa wzdłuż osi cylindra

Frontend odbiera te wartości w `hgm()` (case 0) i wywołuje `player.set_pos(x, y)`:

```js
this.set_pos = function (x, y) {

  // Krok 1: x (0–1023) → kąt w radianach
  const ang = (x * 2 * Math.PI) / 1023;
  //  x =    0 → ang = 0      (0°,   prawa strona cylindra)
  //  x =  256 → ang = π/2    (90°)
  //  x =  512 → ang = π      (180°, lewa strona)
  //  x = 1023 → ang ≈ 2π     (360° − ε, niemal pełny okrąg)
  // Dlaczego 1023, nie 1024: zakres 0–1023 włącznie = 1024 wartości = 2^10 (10-bitowy int)

  // Krok 2: kąt → punkt na ścianie cylindra (promień R ≈ 162.8j)
  this.obj.position.set(
    R * Math.sin(ang),   // X = R × sin(ang)  — oś pozioma
    y,                   // Y                 — oś pionowa (głębokość tunelu)
    R * Math.cos(ang)    // Z = R × cos(ang)  — oś głębokości
  );
  // Punkt (X, Z) leży na okręgu o promieniu R w płaszczyźnie XZ.
  // Parametryczna definicja okręgu: X = R·sin(θ),  Z = R·cos(θ)

};
```

Wizualizacja — rzut z góry (płaszczyzna XZ):

```
             Z
             ↑   x=0 (ang=0°)
             |
     x=768 ──┼── x=256
   (270°)    |        (90°)
             |
      ────── 0 ──────→ X
             |
          x=512 (ang=180°)
```

Kamera gracza jest ustawiana na tej samej osi kątowej ale **3.5× dalej** od środka:

```js
camera.position.set(
  3.5 * R * Math.sin(ang),  // zawsze za graczem, na zewnątrz cylindra
  y,
  3.5 * R * Math.cos(ang)
);
camera.lookAt(new THREE.Vector3(0, camera.position.y - 130, 0));
// Patrzy na środek cylindra, 130j poniżej = naturalny kąt "z góry"
```

---

## 4. Komunikacja wychodząca Frontend → Serwer

### 4.1 Pakiety do Mother Servera

| Typ | Zdarzenie | Dane |
|-----|-----------|------|
| `0` | Kliknięcie PLAY | `game_id: uint32`, `nick: string16`, `skin_id: uint8`, `user_id: string` |
| `1` | Autoryzacja po zalogowaniu | `user_id: string` |
| `2` | Zakup skina | `user_id: string`, `skin_id: uint8` |
| `3` | Zmiana nazwy gracza | `user_id: string`, `new_name: string16` |
| `5` | Reconnect do gry | `game_id: int32`, `token: int32`, `user_id: string` |
| `6` | Polling listy serwerów | wysyłany co `500ms` przez `setInterval` |

```js
// Przykład pakietu PLAY (dołączenie do gry):
packetSender.new_type(0);
packetSender.s_uint32(selectedGame.g_id);   // ID wybranego serwera
packetSender.s_string16(playerNick);         // nick (UTF-16, max 9 znaków)
packetSender.s_uint8(skinId);                // wybrany skin (0–N)
packetSender.s_string(userId);               // MongoDB ObjectId lub '' (gość)
motherSocket.send(packetSender.get_buf());
```

### 4.2 Pakiety do Game Servera (child.js)

| Typ | Zdarzenie | Format | Rozmiar |
|-----|-----------|--------|---------|
| `0` | Ruch poziomy gracza | `[0x00, v: Int8]` | **2 bajty** |
| `1` | Wiadomość czatu | `[0x01] + string16(tekst)` | zmienny |
| `8` | Inicjalizacja gracza w grze | `[0x08, can_show_ad, skin_id]` | 3 bajty |

```js
// Pakiet ruchu (najczęściej wysyłany — 60+ razy/sekundę przy ruchu myszy):
gs.send(new Uint8Array([0, v]).buffer);
// v: Int8 — wartość ujemna = lewo, dodatnia = prawo, zakres -127..+127

// Pakiet czatu:
packetSender.s_uint8(1);                // typ = 1 (czat)
packetSender.s_string16(this.value);    // tekst UTF-16
gs.send(packetSender.get_buf());

// Inicjalizacja (wysyłana raz przy wejściu do gry):
gameSocket.send(new Uint8Array([8, canShowAd, skinId]).buffer);
```

### 4.3 Częstotliwość wysyłania

| Pakiet | Częstotliwość |
|--------|---------------|
| Ruch myszy/dotyk | ~60+ Hz (każdy `onmousemove` z `isDrag=true`) |
| Ruch klawiatura | wielokrotnie/s (każdy `keydown` przy trzymaniu klawisza) |
| Polling serwerów (typ 6) | co 500ms (`setInterval`) |
| Czat | na żądanie (Enter w polu czatu) |
| Brak ruchu | **0 pakietów** — `v === 0` nie jest wysyłane |

---

## 5. Przepływ pozycji gracza — od wejścia do serwera

### 5.1 Co jest wysyłane

Frontend **nigdy nie wysyła pozycji absolutnej** (X, Y, Z). Wysyła tylko **deltę ruchu** — prędkość/kierunek jako jeden bajt `Int8`. Serwer sam oblicza i przechowuje pozycję gracza.

```
Frontend  →  Serwer (child.js)
[0x00, v]    v: Int8 (-127..+127)
             < 0 = lewo
             > 0 = prawo
             = 0 = nie wysyłane (brak pakietu)
```

Pakiet ma zawsze **dokładnie 2 bajty** — jest najlżejszym możliwym pakietem ruchu.

### 5.2 Mysz — od ruchu do wysłania

```
onmousedown          → isDrag = true, zapisz dsx = e.screenX
onmousemove          → d = dsx - e.screenX   (różnica pozycji ekranowej)
                       dsx = e.screenX        (aktualizuj poprzednią pozycję)
                       smi(d)                 → wyślij d jako v
onmouseup            → isDrag = false
```

Przykład: gracz przesuwa mysz o 15 pikseli w prawo:
```
dsx = 500, e.screenX = 515
d = 500 - 515 = -15        ← ujemna = ruch w prawo
gs.send([0x00, -15])       ← 2 bajty do serwera
```

Im szybszy ruch myszy → większa delta `d` → większa prędkość obrotu gracza.

### 5.3 Klawiatura — od klawisza do wysłania

```
keydown (D / →)  → vel startuje na ~7 (7 ± losowe ±2)
                   każdy kolejny keydown: vel += 1 (max 30)
                   smi(vel)  → wyślij vel jako v

keydown (A / ←)  → vel startuje na ~-7
                   każdy kolejny keydown: vel -= 1 (min -30)
                   smi(vel)

keyup            → vel = 0, ld = 0
```

Przykład — gracz trzyma D przez 5 klatek:
```
keydown #1: vel = 7  → gs.send([0x00,  7])
keydown #2: vel = 8  → gs.send([0x00,  8])
keydown #3: vel = 9  → gs.send([0x00,  9])
keydown #4: vel = 10 → gs.send([0x00, 10])
keydown #5: vel = 11 → gs.send([0x00, 11])
keyup:       vel = 0, brak pakietu
```

Zmiana kierunku w locie resetuje prędkość:
```
trzymam D (vel=15) → puszczam → wciskam A:
  ld=1 (prawo) → ld=2 (lewo), vel = -7  ← reset do startu
```

### 5.4 Dotyk (mobile) — identycznie jak mysz

```
ontouchstart  → isDrag = true, dsx = e.touches[0].screenX
ontouchmove   → d = dsx - e.touches[0].screenX
                smi(d)
ontouchend    → isDrag = false
```

### 5.5 Co robi serwer z odebraną wartością

Serwer (`child.js`, case 0 w `handleClientMessage`) aplikuje `v` jako deltę kątową do pozycji gracza, a następnie co tick (~60Hz) rozsyła zaktualizowane pozycje wszystkich graczy do wszystkich klientów przez pakiet type 0:

```
Frontend wysyła:  [0x00, v]             ← 2 bajty, prędkość
Serwer oblicza:   player.angle += v     ← aktualizuje kąt gracza
Serwer rozsyła:   [type=0, id, x, y, event_state]  ← pozycje wszystkich graczy
Frontend odbiera: hgm() case 0 → set_pos(x, y)    ← aktualizuje model 3D
```

---

## 6. Scena 3D — geometria i materiały

### 6.1 Kamera

```js
camera = new THREE.PerspectiveCamera(
  50,    // FOV — 50° = "naturalne" pole widzenia
  asp,   // aspect ratio: Math.max(width/height, 0.9)
  1,     // near clipping — obiekty bliżej niż 1j = niewidoczne
  10000  // far clipping — obiekty dalej niż 10000j = niewidoczne
);
```

Kamera śledzi gracza w `set_pos()`:
- pozycja: `(3.5×R×sin(ang), y, 3.5×R×cos(ang))` — na zewnątrz cylindra
- cel: `lookAt(0, camera.y − 130, 0)` — 130j poniżej kamery, na osi cylindra
- efekt: widok z zewnątrz cylindra skierowany lekko w dół i do środka

### 6.2 Geometria cylindrów — ściany tunelu

```js
const tg = new THREE.CylinderBufferGeometry(
  R - 20,  // radiusTop    ≈ 142.8j — trochę mniejszy niż R gracza
  R - 20,  // radiusBottom ≈ 142.8j — cylinder prosty (nie stożek)
  512,     // height       = 512j   — jeden segment cylindra
  4        // radialSegments = 4   — czworokątny przekrój (kwadratowy tunel)
);
```

R gracza ≈ 162.8j, więc gracz jest WEWNĄTRZ cylindra. Cyfra 4 (nie 32) to optymalizacja — cztery ściany są niewidoczne bo teksturowane, FPS nie spada.

Dwa cylindry `cyl[0]` i `cyl[1]` tworzą nieskończony tunel:
```
cyl[0].y =    0  (materiał cm[0])
cyl[1].y = -512  (materiał cm[0])
```
Gdy gracz opada poniżej zakresu, wyższy cylinder jest teleportowany 512j niżej — patrz sekcja 2.5.

### 6.3 Sfera nieba (skybox)

```js
const geo = new THREE.SphereBufferGeometry(
  1000,  // radius = 1000j — otacza całą scenę
  20,    // widthSegments
  20     // heightSegments
);
// Material: MeshBasicMaterial z BackSide — renderowana od środka
// sky.position.y = player.y w każdej klatce — podąża za graczem
```

Sfera tworzy iluzję "nieba" i tła — gracz nigdy nie widzi jej krawędzi. `BackSide` = tekstura renderowana po wewnętrznej stronie sfery.

### 6.4 Renderer WebGL

```js
renderer = new THREE.WebGLRenderer({ antialias: true });
// antialias: true = MSAA — wygładzanie krawędzi (~10–20% kosztu GPU)

renderer.setSize(1280, 720);
// Stała rozdzielczość HD — niezależna od rozmiaru okna.
// CSS rozciąga canvas do 100%×100% ekranu.
// Dlaczego stała: adaptacyjna rozdzielczość mogłaby obciążyć słabe GPU.
```

### 6.5 System materiałów

| Zmienna | Typ | Opis |
|---------|-----|------|
| `ml.m_stone` | `MeshStandardMaterial` | Kamienna tekstura (`t_sto`) — domyślny materiał kolumn |
| `ml.m_bad` | `MeshStandardMaterial` | Czerwony emisyjny (`#ff0000`, emissive `#550000`) — śmiertelne platformy (typ 2) |
| `ml.m_col` | `MeshStandardMaterial` | Zielony emisyjny (`#00ff00`, emissive `#003300`) — checkpointy |
| `cm[0]`, `cm[1]` | `MeshStandardMaterial` | Dwie naprzemienne tekstury ścian cylindra (`ltc(0)`, `ltc(1)`) |
| `fm[0]`, `fm[1]` | `MeshStandardMaterial` | Dwie naprzemienne tekstury podłogi platform |

Który materiał trafia na platformę (typ 1) zależy od poziomu:
```js
// W loadRing():
tile.children[0].material =
  isCheckpoint            ? ml.m_col          // zielony pierścień (checkpoint)
  : fm[cylinderSegment % 2]; // tekstura kamienia (naprzemiennie)

// Typ 2 (niebezpieczna):
tile.children[0].material = ml.m_bad;  // czerwony (pulsuje w animate())
```

---

## 7. System oświetlenia

### 7.1 Światło otoczenia

```js
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
// Równomierne oświetlenie całej sceny bez cieni, intensywność 0.4
// Tło — żeby nic nie znikało w absolutnej ciemności
```

### 7.2 Dwa reflektory obracające się po ścianie (SpotLight)

```js
const wallScanLight = new THREE.SpotLight(
  0x00aaff,       // kolor: niebieski
  3.5,            // intensywność
  900,            // zasięg (jednostki Three.js)
  Math.PI / 10,   // kąt stożka = 18°  (wąski reflektor)
  0.65            // penumbra = 65% miękkiej krawędzi
);

const wallScanLight2 = new THREE.SpotLight(
  0xff44aa,       // kolor: różowy
  2.5,            // intensywność
  700,            // zasięg
  Math.PI / 14,   // kąt stożka ≈ 13°  (jeszcze węższy)
  0.7             // penumbra = 70%
);
```

Oba reflektory mają `Object3D` jako target — w każdej klatce `animate()` kąt obrotu `wslAngle` jest inkrementowany, co powoduje że reflektory obracają się wokół osi Y cylindra. Reflektor 2 obraca się z przesunięciem fazy (×1.37 + π = naprzeciwko).

### 7.3 Karuzelka świateł wokół platformy gracza (PLT_N)

```js
const PLT_N = 8;  // 8 świateł równomiernie po okręgu
for (let i = 0; i < PLT_N; i++) {
  const pl = new THREE.PointLight(
    0x00ff88,  // kolor: zielony neon
    0,         // intensywność: 0 na start (aktualizowana w animate())
    200        // zasięg: 200j
  );
  scene.add(pl);
}
```

W `animate()` każde z 8 świateł jest obracane kołowo wokół pozycji gracza:
```js
const ang = (i / PLT_N) * Math.PI * 2 + t * 0.0006; // obracają się z czasem
// + animacja intensywności pulsująca synchronicznie z ml.m_bad
```

### 7.4 Pula świateł graczy (playerLightPool)

```js
const MAX_PLAYER_LIGHTS = 12;  // max 12 świateł na 12 najbliższych graczy
for (let i = 0; i < MAX_PLAYER_LIGHTS; i++) {
  const pl = new THREE.PointLight(
    0xffffff,  // biały
    0,         // intensity = 0 = ukryte
    200        // zasięg 200j
  );
}
// W animate(): przypisz 12 najbliższych graczy do świateł z puli
// Dlaczego pula a nie 1 światło na gracza:
//   ~50 graczy × 1 PointLight = 50 render passów → duży spadek FPS
//   Pula 12 = kompromis jakość/wydajność
```

### 7.5 Cząsteczki kurzu (DUST_N)

```js
const DUST_N = 600;  // 600 cząsteczek losowo w cylindrze
// Pozycje: cos/sin × losowy_promień (0..R-22), Y losowe ±600j

const dustMat = new THREE.PointsMaterial({
  color:      0x99ddff,   // jasnoniebieski
  size:       1.6,        // rozmiar piksela
  transparent: true,
  opacity:    0.5,
  depthWrite: false,       // nie blokują obiektów za nimi
  fog:        true         // mgła — dalsze cząsteczki bardziej przezroczyste
});
// Renderowane jako THREE.Points — każda cząsteczka = jeden kwadrat (sprite)
// W animate(): pozycje Y cząsteczek są przesuwane (cząsteczki unoszą się/opadają)
```

---

## 8. Klasa Player — pozycjonowanie i animacja

### 8.1 Algorytm `set_pos(x, y)` — pełny przepływ

`set_pos()` wywoływana jest przy każdym pakiecie type 0 (pozycje graczy) z wartościami `x` (0–1023) i `y` (oś pionowa):

```js
this.set_pos = function (x, y) {
  this.x = x; this.y = y;

  // Krok 1: zamień x (0–1023) na kąt w radianach
  const ang = (x * 2 * Math.PI) / 1023;
  // 0    → ang = 0    rad (0°)
  // 256  → ang = π/2  rad (90°)
  // 512  → ang = π    rad (180°)
  // 1023 → ang ≈ 2π   rad (360° − ε)
  // Uwaga: zakres 0–1023 (nie 0–1024) bo to 10-bitowy integer

  // Krok 2: animacja chodu (rotation.y modelu gracza)
  if (this.obj.children[0]) this.obj.children[0].rotation.y += 0.07;
  // +0.07 rad (~4°) co wywołanie = animacja chodu
  // Nie zależy od kierunku ruchu — obraca się zawsze

  // Krok 3: ustaw pozycję modelu na ścianie cylindra
  this.obj.position.set(
    R * Math.sin(ang),  // X
    y,                  // Y (oś pionowa)
    R * Math.cos(ang)   // Z
  );
  // Punkt na kole o promieniu R w płaszczyźnie XZ

  // Krok 4: (tylko myPlayer) — kamera, poziom, scroll
  if (this === myPlayer) {
    const cd = 3.5;
    camera.position.set(cd * R * Math.sin(ang), y, cd * R * Math.cos(ang));
    sky.position.y = y;
    camera.lookAt(new THREE.Vector3(0, camera.position.y - 130, 0));
    scrollCyl(); // sprawdź czy cylindry wymagają teleportu
    // + aktualizacja licznika #level
  }
};
```

### 8.2 Przeliczenie x → pozycja 3D — przykład numeryczny

Dla `R ≈ 162.8`, `x = 256`:
```
ang = (256 × 2π) / 1023 ≈ 1.571 rad (≈ 90°)

position.x = 162.8 × sin(1.571) ≈ 162.8 × 1.000 ≈  162.8
position.z = 162.8 × cos(1.571) ≈ 162.8 × 0.001 ≈    0.1
position.y = y (z serwera)

camera.x   = 3.5 × 162.8 × sin(1.571) ≈  569.8  (na zewnątrz)
camera.z   = 3.5 × 162.8 × cos(1.571) ≈    0.4
```

Gracz stoi na ścianie cylindra w 90°, kamera patrzy na niego z zewnątrz.

### 8.3 Etykieta nicku (TextSprite)

Każdy gracz ma sprite z nickiem widoczny nad głową:

```js
const ns = new THREE.TextSprite({
  // tekst: playerObj.name
  // kolor: '#' + playerObj.hex_color  (neonowy kolor skina)
});
// Dodany jako children[1] do THREE.Group gracza (children[0] = model OBJ)
```

`TextSprite` to billboard — zawsze zwrócony do kamery (nie obraca się z modelem).

### 8.4 System skórki (skin) i kolorów

```js
this.hex_color = ch;   // string CSS np. "00d4ff" (bez #)
this.skin_id   = skin; // indeks skina (0–N)
```

- `hex_color` pochodzi z `lightSkins[skin_id]` — predefiniowana paleta neonowych kolorów
- Kolor używany do: etykiety nicku, pula świateł gracza, licznik poziomu `#level`
- Materiał modelu: `skinModelCache[skin_id]` lub materiał z OBJ jeśli skin niedostępny
- Zmiana skina (pakiet type 13): aktualizuje `pl.skin_id` i podmienia `children[0].children[0].material`
