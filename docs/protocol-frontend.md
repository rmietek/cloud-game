# Protocol Frontend — [Komunikacja przeglądarka ↔ Mother/Child]

## 1. Cel i architektura

Dokument opisuje pełny protokół binarny WebSocket między przeglądarką a serwerami (Mother i Child). Klient używa tej samej biblioteki `binary.js` co serwery. Komunikacja działa w dwóch trybach: serwer rozsyła stan gry w stałym tempie (co takt serwera = 16 ms), a klient wysyła zdarzenia (ruch, akcje) reaktywnie — zaraz po ich wystąpieniu.


### Dwa połączenia WebSocket klienta

```
Przeglądarka
  │
  ├─ ws://LB:3001  ──► Mother uWS
  │   Połączenie z lobby:
  │   ← type 2: lista serwerów gier (przy connect + przy lobby_update)
  │   ← type 3: dane sklepu (SKIN_COSTS, SKIN_LIGHTS)
  │   ← type 0: token + IP:port serwera gry (po kliknięciu Join)
  │   ← type 1: dane konta gracza
  │   → type 0: dołącz do gry {gameId, name, skinId, accountId}
  │   → type 1: pobierz konto {accountId}
  │   → type 2: kup skin {skinId, accountId}
  │   → type 3/4: zmień nick {name, accountId}
  │   → type 5: reconnect {gameId, playerId, accountId}
  │   → type 6: odśwież listę gier
  │
  └─ ws://NODE_IP:AGONES_PORT/TOKEN  ──► Child uWS 
      Połączenie z grą:
      ← type 3: init (self_id, lista graczy)
      ← type 7: lista martwych graczy
      ← type 9: ranking top 6
      ← type 4: dane mapy (10 poziomów)
      ← type 0: pozycje widzialnych graczy (co takt)
      ← type 1: nowi gracze
      ← type 2: gracze którzy wyszli
      ← type 5: zabici gracze
      ← type 6: odrodzeni gracze
      ← type 8: wiadomości czatu
      ← type 10: własna pozycja w rankingu
      ← type 11: aktualizacja event (życia)
      ← type 12: nagroda po śmierci
      ← type 13: zmiany skinów
      → type 0: ruch {dx: int8}
      → type 1: czat {message: string16}
      → type 2: aktywuj event (brak danych)
      → type 8: respawn {ads: int8, skin_id: uint8}
```

---

## 2. Kluczowa Logika i Przepływ

### Format każdego pakietu binarnego

```
Bajt [0]:     liczba bloków (uint8)
Bajt [1]:     typ pierwszego bloku
Bajt [2..N]:  dane pierwszego bloku
Bajt [N+1]:   typ drugiego bloku
...
```

Jeden pakiet może zawierać wiele bloków różnych typów (np. pozycje + ranking + event).

### Szczegóły pakietów Mother → Klient

**Typ 0 — token dołączenia**
```
[1][0][uint32:token][uint16:port][uint8:ip_len][...ip_ascii...]
Przykład dla token=2847362910, port=30510, ip="34.89.123.45":
  [01][00][A9 B4 2E 1E][77 2E][0B][33 34 2E 38 39 2E 31 32 33 2E 34 35]
  = 21 bajtów
```

**Typ 1 — dane konta**
```
[1][1]
  [uint8:email_len][...email UTF-16...]
  [uint32:points]
  [uint32:total_points]
  [uint8:name_len][...name UTF-16...]
  [uint16:skins_count][...skin_ids uint8...]
  [uint16:acc_data_count][per item: uint8:len + ascii]
```

**Typ 2 — lista serwerów**
```
[1][2][uint8:count]
  per serwer:
    [uint32:id]
    [uint8:players_count]
    [uint8:players_limit]
    [uint8:loc_len][...loc ascii...]    np. "EU"
    [uint8:name_len][...name ascii...]  np. "EU-Phantom"
```

**Typ 3 — dane sklepu**
```
[1][3]
  [uint16:23][int32×23: SKIN_COSTS]    // ceny skinów 0-22
  [uint16:23][int32×23: SKIN_LIGHTS]   // kolory świateł
```

### Szczegóły pakietów Child → Klient

**Typ 3 — inicjalizacja (przy połączeniu)**
```
[N_bloków][3]
  [uint8:self_id]         ← własne ID gracza
  [uint8:player_count]
  per gracz:
    [uint8:id]
    [uint8:name_len][...name UTF-16...]
    [uint8:skin_id]
[7]
  [uint8:dead_count]
  per martwy: [uint8:id]
[9]
  [uint8:rank_count ≤6]
  per gracz: [int8:id][int8:byte_point]
```

**Typ 0 — pozycje (co takt, per-player)**
```
[N][0]
  [uint8:count]    ← liczba widzialnych graczy (7 segmentów)
  per gracz:
    [int8:id]
    [float32:x]
    [float32:y]
    [int8:event_use]   ← stan kolizji (-2=normalny, -3=uderzony)
  Łącznie per gracz: 10 bajtów
  50 graczy = 501 bajtów (1 + 50×10)
```

**Typ 4 — dane mapy (10 poziomów, ~1283 bajtów)**
```
[1][4][uint8:10]
  per poziom (10×):
    [uint16:128][int8×128]    ← 128 kafelków (0=puste, 1=platforma, 2=kolce)
```

---

## 3. Przykłady z kodu (implementacja)

### Parsowanie pakietu od klienta (Child)

```javascript
// apps/child-gameserver/main.js
message: (ws, message, isBinary) => {
    const p = data.pg.set_buffer(message);  // per-klient instancja parsera

    switch (p.g_uint8()) {  // pierwszy bajt = typ polecenia
        case 0: {  // ruch poziomy
            const dx = p.g_int8();
            pl.move_x = dx;
            pl.x     += dx;
            pl.x     &= 0x3ff;  // wrap: x % 1024 (cylindryczna mapa)
            break;
        }
        case 1: {  // czat
            const text = p.g_string16();
            pl.chat    = text;
            chat_players.uniq_push(pl);
            break;
        }
        case 2: {  // aktywuj event (power-up)
            if (pl.event > 0 && pl.event_use !== -1) {
                pl.event_use  = -1;  // stan "używam eventu"
                pl.event--;
                pl.event_send = true;
            }
            break;
        }
        case 8: {  // respawn
            const ads     = p.g_int8();
            const skin_id = p.g_uint8();
            if (pl.is_dead) {
                pl.is_dead = false;
                // ... respawn logic
            }
            break;
        }
    }
}
```

> W kodzie Childa **nie istnieje osobny pakiet „skok"** — skok nie jest odrębnym typem wiadomości, lecz elementem ogólnej logiki ruchu. Mechanika `pl.jump_frame` / `pl.vecy` żyje po stronie serwera i jest sterowana innymi sygnałami.

### Wysyłanie pakietu pozycji (Child → Klient)

```javascript
// apps/child-gameserver/main.js
// Per-player część pakietu:
p.new_type(0);
let count = 0;
const countIndex = p.index;
p.index++;  // zarezerwuj bajt na count

for (let seg = pl.lvl - 2; seg < pl.lvl + 5; seg++) {
    if (!segment_player[seg]) continue;
    count += segment_player[seg].length;
    for (const visible of segment_player[seg]) {
        p.s_int8(visible.id);
        p.s_float(visible.x);
        p.s_float(visible.y);
        p.s_int8(visible.event_use);
        // 10 bajtów per gracz
    }
}
p.int8[countIndex] = count;  // wstaw count wstecz w zarezerwowane miejsce
```

### Inicjalizacja parsera w przeglądarce

Klient nie pobiera `binary.js` jako osobnego pliku — kod `PacketGet` (parser) i `PacketSet` (sender) jest **wklejony bezpośrednio z `apps/shared/binary.js`** do `index.html`. To ten sam protokół binarny co po stronie Mother i Child — wszystkie metody (`g_uint8`, `s_string16`, `s_int8_arr` itd.) są identyczne.  

```javascript
// apps/mother-lobby/public/index.html
motherSocket.onmessage = handleMotherMessage.bind(new PacketGet());

function handleMotherMessage(packet) {
    const p = this.set_buffer(packet.data);  // 'this' = PacketGet z bind()

    for (let i = p.g_length8(); i--;) {       // pierwszy bajt = liczba bloków
        switch (p.g_uint8()) {                 // bajt typu pakietu
            case 0: { /* token + IP:port */    break; }
            case 1: { /* dane konta */         break; }
            case 2: { /* lista serwerów */     break; }
            case 3: { /* dane sklepu */        break; }
            case 4: { /* serwer pełny */       break; }
        }
    }
}
```

Ten sam wzorzec dla pakietów od Childa — `hgm` (handleGameMessage) obsługuje typy 0–13:

```javascript
// apps/mother-lobby/public/index.html
gs.onmessage = hgm.bind(new PacketGet());

function hgm(packet) {
    const p = this.set_buffer(packet.data);

    for (let i = p.g_length8(); i--;) {
        switch (p.g_uint8()) {
            case 0:  { /* pozycje widzialnych graczy */  break; }
            case 1:  { /* nowi gracze */                  break; }
            case 2:  { /* gracze wyszli */                break; }
            case 3:  { /* init: self_id + lista graczy */ break; }
            case 4:  { /* dane mapy (10 poziomów) */      break; }
            case 5:  { /* gracze zginęli */               break; }
            case 6:  { /* odrodzeni gracze (zarezerw.) */ break; }
            case 7:  { /* lista martwych przy init */     break; }
            case 8:  { /* wiadomości czatu */             break; }
            case 9:  { /* ranking TOP 6 */                break; }
            case 10: { /* własna pozycja w rankingu */    break; }
            case 11: { /* postęp eventu */                break; }
            case 12: { /* zarobione złoto */              break; }
            case 13: { /* zmiana skina */                 break; }
        }
    }
}
```

---

## 4. Zależności i protokoły

### Typy event_use (stan kolizji)

Pole `event_use` jest dołączane do każdego rekordu gracza w pakiecie type 0 (pozycje). Klient na jego podstawie wybiera materiał shadera modelu.

| Wartość | Stan gracza na serwerze | Renderowanie klienta |
|---|---|---|
| -2 | Stan domyślny — gracz porusza się swobodnie, nie ma aktywnej kolizji ani trafienia | Standardowy materiał skina (kolor neonowy z `SKIN_LIGHTS`) |
| -3 | Gracz właśnie uderzył w kolce (czerwone kafle = wartość 2 w danych mapy) i traci życie | `xm` — biały materiał z efektem "uszkodzenia" przez ~10 ticków |
| ≥ 0 | ID innego gracza, którego event aktywnie wypycha tego gracza (kolizja PvP) | Materiał `xm` na czas trwania pchnięcia, pozycja korygowana co tick |

### Stałe i limity protokołu

| Stała | Wartość | Definicja | Konsekwencja dla protokołu |
|---|---|---|---|
| `MAX_PLAYERS` | 15 | `child-gameserver/main.js` | `players_limit` w pakiecie type 2 (lista serwerów), Mother odrzuca `handleJoinGame` gdy osiągnięte |
| `SERVER_TICK_MS` | 16 ms (~62.5 Hz) | `child-gameserver/main.js` | Częstotliwość pakietów type 0 (pozycje) z Childa |
| max długość nicku | 9 znaków | `mother-lobby/main.js` | Walidacja `name.length > 9` w `handleJoinGame` — pakiet odrzucany |
| zakres skin_id | 0–22 (23 skiny) | `SKIN_COSTS` / `SKIN_LIGHTS` w `mother-lobby/main.js` | Pakiet type 3 (sklep) wysyła 2× tablicę 23 elementów |
| zakres ID gracza | 0–254 (uint8) | Pula `free_ids` w Childzie | Wszystkie pola `id` w pakietach Childa = 1 bajt |
| szerokość mapy | 1024 jedn. (cylindryczna) | `pl.x &= 0x3ff` w `child-gameserver/main.js` | Pozycja `x` w pakiecie type 0 zawsze ∈ [0, 1023] |

### Endpointy HTTP REST (Mother)

WebSocket nie obsługuje rejestracji ani logowania — te przepływy idą przez Express na porcie 9876 (port 80 z perspektywy `LoadBalancer` Service).

| Endpoint | Cel |
|---|---|
| `POST /auth/register` | Utwórz konto (nazwa użytkownika + hasło) |
| `POST /auth/login`    | Zaloguj się, zwróć MongoDB ObjectId |
| `GET /`               | Serwuj `index.html` |
| `GET /lang`           | Zwróć kraj gracza z `cf-ipcountry` (Cloudflare) |
| `GET /js/*`, `/img/*`, `/obj/*`, `/mp3/*`, `/site/*` | Pliki statyczne |

Przepływ logowania (kolejność jest istotna — żaden pakiet WebSocket wymagający `accountId` nie może polecieć wcześniej):

1. Użytkownik klika "Zaloguj" → frontend wysyła `POST /auth/login` (HTTP, port 9876).
2. Mother weryfikuje email  (wlasciwie obecnie nazwę użytkownika) + hasło w MongoDB i odpowiada JSON-em `{ id: "<MongoDB ObjectId>" }`.
3. Frontend zapisuje ten ObjectId pod `localStorage.id` — to jest "token" sesji gracza (brak JWT, brak ciasteczek, brak wygaśnięcia).
4. Dopiero teraz frontend może wysłać pakiety WebSocket, które wymagają identyfikacji konta: type 1 (pobierz dane konta), type 0 (dołącz do gry z punktami zapisanymi do konta), type 2 (kup skin), type 3 (zmień nick), type 5 (reconnect).

Goście (niezalogowani) wysyłają te same pakiety z `accountId = ''` — Mother wtedy nie zapisuje punktów ani zakupów do MongoDB, ale gra działa.

### Współdzielenie binary.js

```
apps/shared/binary.js
  ├─ require() → apps/mother-lobby/main.js       (Node.js)
  ├─ require() → apps/child-gameserver/main.js   (Node.js)
  └─ wklejone (PacketGet/PacketSet) → apps/mother-lobby/public/index.html  (przeglądarka)
```

### Stan w Redis (zależność Mother ↔ Child)

Mother nie komunikuje się bezpośrednio z Childami — wszystko leci przez Redis:

| Klucz / kanał | Typ | Producent | Konsument |
|---|---|---|---|
| `game:{game_id}` | HASH `{ g_port, g_players_len, g_players_lim, serv_ip, serv_loc, serv_name }` | Child (przy starcie i co zmianę liczby graczy) | Mother (`buildGamesPacket` → pakiet type 2) |
| `lobby_update` | pub/sub | Child (rejestracja / zmiana licznika / shutdown) | Mother (`broadcast_games` → wszystkie repliki rozsyłają nową listę) |
| `players` | SET id graczy | Child | Mother (sprawdzenie czy gracz jest aktywnie w grze) |

`lobby_update` to mechanizm push — bez niego klient musiałby pollować type 6 znacznie częściej.

---

## 5. Kod Frontendu — Wysyłanie do Mother

Format każdego pakietu: `[typ: uint8] [dane...]` — brak bajtu licznika (pełna wiadomość = jeden pakiet).

### Type `0` — Dołącz do gry

Wysyłamy gdy gracz kliknie przycisk PLAY i wybierze serwer z listy.

```javascript
// index.html
packetSender.new_type(0);
packetSender.s_uint32(selectedGame.g_id);  // ID wybranego serwera gry
packetSender.s_string16(playerNick);        // nick (UTF-16, max 9 znaków)
packetSender.s_uint8(skinId);               // ID wybranego skina
packetSender.s_string(userId);              // MongoDB ObjectId lub '' dla gości
motherSocket.send(packetSender.get_buf());
// Struktura: [gameId: uint32] [name: string16] [skinId: uint8] [accountId: string]
```

### Type `1` — Pobierz dane konta

Wysyłamy po zalogowaniu przez HTTP, gdy WebSocket z lobby jest już otwarty.

```javascript
// index.html
packetSender.new_type(1);
packetSender.s_string(id);  // MongoDB ObjectId zalogowanego gracza
motherSocket.send(packetSender.get_buf());
// Struktura: [accountId: string]
```

### Type `2` — Kup skina

Wysyłamy gdy gracz kliknie "KUP" w karuzeli skinów.

```javascript
// index.html
packetSender.new_type(2);
packetSender.s_string(id);
packetSender.s_uint8(skinId);
motherSocket.send(packetSender.get_buf());
// Struktura: [accountId: string] [skinId: uint8]
```

### Type `3` — Zmień nick

Wysyłamy po potwierdzeniu edycji nicku w panelu konta.

```javascript
// index.html
packetSender.new_type(3);
packetSender.s_string($('#r_name_che').value.length ? id : '');
// Jeśli pole ma wartość → wyślij ID konta, inaczej pusty string (brak aktualizacji)
packetSender.s_string16($('#r_name_che').value);
motherSocket.send(packetSender.get_buf());
// Struktura: [accountId: string] [name: string16]
```

### Type `5` — Reconnect (powrót do gry)

Wysyłamy automatycznie przy odświeżeniu strony jeśli gracz miał aktywną grę (`gameToken` zapisany lokalnie). Używamy `s_int32` zamiast `s_uint32` — dla zakresu wartości gameId i tokenu jest bez znaczenia.

```javascript
// index.html
packetSender.new_type(5);
packetSender.s_int32(selectedGame.g_id);  // ← s_int32, nie s_uint32
packetSender.s_int32(gameToken);
packetSender.s_string(id);
motherSocket.send(packetSender.get_buf());
// Struktura: [gameId: int32] [token: int32] [accountId: string]
```

### Type `6` — Odśwież listę gier

Wysyłamy automatycznie co 500ms (polling) — tylko gdy gracz jest w lobby.

```javascript
// index.html
packetSender.new_type(6);
motherSocket.send(packetSender.get_buf());
// Struktura: (brak danych — sam typ)
```

---

## 6. Kod Frontendu — Odbieranie od Mother

### Type `0` — Token + adres serwera gry

```javascript
// index.html — case 0 w handleMotherMessage
const token = p.g_uint32();
const port  = p.g_uint16();
const ip    = p.g_string();
gameToken = token;  // zapamiętaj flagę "jesteśmy w grze"
initGame('ws://' + ip + ':' + port + '/' + token);
```

### Type `1` — Dane konta

```javascript
// index.html — case 1 w handleMotherMessage
const email  = p.g_string16();
const points = p.g_uint32();
const tp     = p.g_uint32();     // total_points
const name   = p.g_string16();
const os     = p.g_int8_arr();   // lista posiadanych skinów
p.g_string_arr();                // acc_data — odczytywana ale ignorowana (zarezerwowane)
```

### Type `2` — Lista gier

```javascript
// index.html — case 2 w handleMotherMessage
for (let a = p.g_length8(); a--;) {
    games.push({
        g_id:          p.g_uint32(),
        g_players_len: p.g_uint8(),
        g_players_lim: p.g_uint8(),
        g_location:    p.g_string(),
        g_name:        p.g_string(),
    });
}
```

### Type `3` — Konfiguracja skinów

```javascript
// index.html — case 3 w handleMotherMessage
skins      = p.g_int32_arr();  // ceny 23 skinów
lightSkins = p.g_int32_arr();  // kolory 23 skinów
```

### Type `4` — Serwer pełny (nieaktywny)

```javascript
// index.html — case 4 w handleMotherMessage
alert('Server is full — try again in a moment.');
```

> **Uwaga:** `mother.js` aktualnie **nigdy nie wysyła** tego pakietu — przy pełnym serwerze odrzuca żądanie. Handler istnieje do przyszłego użycia.

---

## 7. Kod Frontendu — Wysyłanie do Child

Format: `[typ: uint8] [dane...]` — bajty, bez licznika sub-pakietów.

### Type `0` — Ruch poziomy

Wysyłamy przy każdym `keydown`/`mousemove`/`touchmove`. Nie wysyłamy gdy `dx = 0`.

```javascript
// index.html — funkcja smi()
gs.send(new Uint8Array([0, v]).buffer);
// [0x00] = typ, [v] = Int8 prędkość/kierunek
// dx < 0 = obrót w lewo, dx > 0 = w prawo, |dx| maks 127
```

### Type `1` — Wiadomość czatu

Wysyłamy po naciśnięciu Enter w polu czatu.

```javascript
// index.html
packetSender.index--;        // cofnij wskaźnik — nadpisz poprzedni typ w buforze
packetSender.s_uint8(1);     // Typ 1 = czat (case 1 w child.js)
packetSender.s_string16(this.value);
gs.send(packetSender.get_buf());
```

### Type `2` — Aktywuj event

Wysyłamy po kliknięciu przycisku eventu (strzałka w górę). Brak danych.

```javascript
// index.html
gs.send(new Uint8Array([2]).buffer);
// Struktura: [typ=2: uint8] — łącznie 1 bajt
```

### Type `8` — Respawn

Wysyłamy po kliknięciu RESPAWN na ekranie śmierci.

```javascript
// index.html
gameSocket.send(new Uint8Array([8, canShowAd, skinId]).buffer);
// ads = 1 jeśli gracz obejrzał reklamę (bonus punktowy), 0 jeśli nie
// skin_id = ID skina wybranego na ekranie śmierci
```

---

## 8. Kod Frontendu — Odbieranie od Child

Każda wiadomość zaczyna się od bajtu licznika sub-pakietów.

### Type `0` — Pozycje graczy (~60 Hz)

```javascript
// index.html — hgm case 0
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8();
    pl.set_pos(p.g_float(), p.g_float());
    const ec = p.g_int8();   // event_use: -2=normalny, -3=uderzony
}
```

### Type `1` — Nowi gracze dołączyli

```javascript
// hgm case 1
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8(), n = p.g_string16(), sk = p.g_uint8();
    if (!players[id]) players[id] = new Player(id, n, sk);
}
```

### Type `2` — Gracze wyszli

```javascript
// hgm case 2
for (let ix = p.g_length8(); ix--;) {
    players[p.g_uint8()].destructor();
}
```

### Type `3` — Inicjalizacja (raz przy połączeniu)

```javascript
// hgm case 3
myPlayerId = p.g_uint8();
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8(), n = p.g_string16(), sk = p.g_uint8();
    players[id] = new Player(id, n, sk);
}
```

### Type `4` — Dane poziomów mapy

```javascript
// hgm case 4
for (let ix = p.g_length8(); ix--;) {
    levels[levelsReceived + ix] = p.g_int8_arr(); // Uint8Array[128]
}
levelsReceived += 10;
```

### Type `5` — Gracze zginęli

```javascript
// hgm case 5
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8();
    players[id].obj.visible = false;
    if (players[id] === myPlayer) showRespawnMenu(gs, resetRings);
}
```

### Type `6` — Gracze odrodzili się (zarezerwowane)

```javascript
// hgm case 6 — frontend IGNORUJE dane
for (let ix = p.g_length8(); ix--;) p.g_uint8(); // odczyt ale odrzucanie
```

> **Uwaga:** `child.js` wysyła ID odrodzonych graczy, ale frontend aktualnie tylko przesuwa wskaźnik odczytu. Zarezerwowane do przyszłej implementacji.

### Type `7` — Lista martwych (przy inicjalizacji)

```javascript
// hgm case 7
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8();
    if (players[id]) players[id].obj.visible = false;
}
```

### Type `8` — Wiadomości czatu

```javascript
// hgm case 8
for (let ix = p.g_length8(); ix--;) {
    const id  = p.g_uint8();
    const msg = p.g_string16();
    if (players[id]) appendChat(players[id], msg);
}
```

### Type `9` — Ranking TOP 6

```javascript
// hgm case 9
const cnt = p.g_length8();
for (let ix = cnt; ix--;) {
    const id  = p.g_uint8();
    const pts = p.g_uint8(); // byte_point (skompresowane)
    // aktualizuj wiersz rankingu
}
```

### Type `10` — Moja pozycja w rankingu

```javascript
// hgm case 10
const rank = p.g_uint8(); // pozycja (0-indexed)
const pts  = p.g_uint8(); // byte_point
// jeśli rank > 5: pokaż dodatkowy wiersz za TOP6
```

### Type `11` — Postęp eventu (per-gracz)

```javascript
// hgm case 11
const prog = p.g_uint8(); // 0–10
$('#eventb').children[1].innerText = prog + '/10';
```

### Type `12` — Zarobione złoto (przy śmierci)

```javascript
// hgm case 12
const gold = p.g_uint32();
$('#win_points').innerText = gold + ' Złota!';
```

### Type `13` — Zmiana skina podczas gry

```javascript
// hgm case 13
for (let ix = p.g_length8(); ix--;) {
    const id = p.g_uint8(), sk = p.g_uint8();
    if (players[id]) players[id].cheange_skin(sk);
}
```

---

### Potencjalne problemy przy aktualizacji

Przy rolling update Mother:
- Stary klient (binary.js v1) połączony z nową Mother (binary.js v2)
- Jeśli zmienił się format pakietu → desynchronizacja

