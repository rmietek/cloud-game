# Plik: docs/protocol-frontend.md

## Protokół komunikacji z klientem (WebSocket — binarny)

---

## Przegląd

Klient (przeglądarka) komunikuje się z serwerami przez dwa niezależne WebSocket:

| Połączenie | Adres | Serwer | Cel |
|---|---|---|---|
| Lobby WS | `ws://host:3001/*` | `mother.js` | Lista gier, konto gracza, zakupy |
| Game WS | `ws://ip:port/<token>` | `child.js` | Właściwa rozgrywka |

Oba serwery używają biblioteki **uWebSockets.js** (C++ z bindingami Node.js). Wszystkie pakiety są **binarne** — zamiast JSON.

---

## Moduł binarny `shared/binary.js`

### `packet_set` — bufor do zapisu (serwer → klient)

```javascript
const ps = new packet_set(1000); // bufor 1000 bajtów

ps.new_type(n)           // nagłówek: typ pakietu (uint8)
ps.s_uint8(val)          // 1 bajt, 0–255
ps.s_uint16(val)         // 2 bajty, 0–65535
ps.s_uint32(val)         // 4 bajty, 0–4 294 967 295
ps.s_int8(val)           // 1 bajt ze znakiem, -128–127
ps.s_float(val)          // 4 bajty float32
ps.s_string(str)         // 1B prefiks długości + bajty UTF-8
ps.s_string16(str)       // 2B prefiks długości + bajty UTF-8
ps.s_int8_arr(arr, n)    // n bajtów z tablicy
ps.s_int32_arr(arr, n)   // n × 4 bajty
ps.s_string_arr(arr, n)  // n stringów (każdy z 1B prefixem)
ps.s_length8(n)          // uint8 — liczba elementów listy
ps.end_global()          // zaznacz koniec części wspólnej
ps.get_buf()             // zwróć cały bufor jako ArrayBuffer/Uint8Array
ps.get_uniq_buf()        // zwróć global + per-player część
ps.clear_uniq_buf()      // wyczyść część per-player
ps.clear()               // wyczyść cały bufor
```

### `packet_get` — parser do odczytu (klient → serwer)

```javascript
const p = new packet_get();
p.set_buffer(message)    // ustaw bufor do parsowania
p.g_uint8()              // odczytaj 1 bajt (przesuwa wskaźnik)
p.g_int8()               // odczytaj 1 bajt ze znakiem
p.g_uint16()             // odczytaj 2 bajty
p.g_uint32()             // odczytaj 4 bajty
p.g_string()             // odczytaj string z 1B prefixem
p.g_string16()           // odczytaj string z 2B prefixem
```

---

## Pakiety: Frontend ↔ Mother (Lobby)

### Wysyłane przez serwer do klienta

#### Typ 0 — dane połączenia z serwerem gry

Wysyłany po akceptacji prośby o dołączenie (`handleJoinGame`). Klient używa tych danych do nawiązania drugiego połączenia WebSocket z `child.js`.

```
[token: uint32] [port: uint16] [serv_ip: string(1B prefix)]
```

| Pole | Typ | Opis |
|---|---|---|
| `token` | uint32 | Jednorazowy klucz autoryzacji (~4 mld możliwości) |
| `port` | uint16 | Port WebSocket serwera gry (0–65535) |
| `serv_ip` | string | Publiczne IP węzła K8s lub `localhost` dev |

Klient łączy się: `ws://serv_ip:port/<token>`

#### Typ 1 — dane konta gracza

Wysyłany po: zalogowaniu, zakupie skina, zmianie nazwy, reconnect (`send_account()`).

```
[email: string16] [points: uint32] [total_points: uint32]
[name: string16] [skin_ids: int8[]] [acc_data: string[]]
```

| Pole | Typ | Opis |
|---|---|---|
| `email` | string16 | Email konta gracza |
| `points` | uint32 | Aktualna waluta (może być wydana w sklepie) |
| `total_points` | uint32 | Łącznie zarobione (nigdy nie maleje — rankingi) |
| `name` | string16 | Nick wyświetlany w grze |
| `skin_ids` | int8[] | Lista zakupionych numerów skinów |
| `acc_data` | string[] | Dodatkowe dane konta (rozszerzalne) |

#### Typ 2 — lista aktywnych serwerów gry

Wysyłany przy połączeniu z lobby i po każdym `lobby_update` z Redis (`buildGamesPacket()`).

```
[count: uint8] × {
    [id: uint32] [players_len: uint8] [players_lim: uint8]
    [serv_loc: string(1B)] [serv_name: string(1B)]
}
```

| Pole | Typ | Opis |
|---|---|---|
| `count` | uint8 | Liczba dostępnych serwerów |
| `id` | uint32 | ID gry (używane w pakiecie dołączenia) |
| `players_len` | uint8 | Aktualna liczba graczy |
| `players_lim` | uint8 | Limit graczy (np. 15) |
| `serv_loc` | string | Kod regionu: `"EU"`, `"US"`, `"ASIA"` |
| `serv_name` | string | Czytelna nazwa: `"EU-Phantom"` |

#### Typ 3 — dane skinów (wysyłane przy każdym połączeniu)

```javascript
ps.new_type(3);
ps.s_int32_arr(SKIN_COSTS,  23); // 23 × 4B = 92B
ps.s_int32_arr(SKIN_LIGHTS, 23); // 23 × 4B = 92B — kolory hex
```

| Pole | Typ | Opis |
|---|---|---|
| `SKIN_COSTS[0..22]` | int32[23] | Ceny zakupu skinów w punktach |
| `SKIN_LIGHTS[0..22]` | int32[23] | Kolory RGB hex (np. `0xff0000` = czerwony) |

Skiny 1–5 mają cenę `0` (darmowe). Cena `0` skina 0 to wyjątek (kosztuje 5000).

---

### Wysyłane przez klienta do serwera (Mother)

Każdy pakiet zaczyna się od: `[skip: int8] [type: int8] [dane...]`

Pierwszy bajt jest ignorowany (`p.g_int8()` bez przypisania).

```javascript
// mother.js — message handler
p.g_int8(); // pomiń
switch (p.g_int8()) { // odczytaj typ
    case 0: handleJoinGame(p, ws);     break;
    case 1: handleFetchAccount(p, ws); break;
    case 2: handleBuySkin(p, ws);      break;
    case 3: handleChangeName(p, ws);   break;
    case 4: handleChangeName(p, ws);   break; // TODO: inny typ zmiany nazwy
    case 5: handleReconnect(p, ws);    break;
    case 6: // odśwież listę serwerów (ręczny refresh)
}
```

| Typ | Handler | Zawartość pakietu |
|---|---|---|
| `0` | `handleJoinGame` | `[gameId: uint32] [name: string16] [skinId: uint8] [accountId: string]` |
| `1` | `handleFetchAccount` | `[accountId: string]` |
| `2` | `handleBuySkin` | `[accountId: string] [buyId: uint8]` |
| `3/4` | `handleChangeName` | `[accountId: string] [newName: string16]` |
| `5` | `handleReconnect` | `[gameId: uint32] [playerId: uint32] [accountId: string]` |
| `6` | *(inline)* | *(brak danych — sam sygnał refresh)* |

---

## Pakiety: Frontend ↔ Child (Rozgrywka)

### Wysyłane przez serwer do klienta (`gen_packet()` — co tick, ~62.5 razy/s)

Każdy tick składa się z **globalnej** części (wspólnej dla wszystkich) i **per-player** (unikalna per klient).

| Typ | Nazwa | Struktura |
|---|---|---|
| `0` | Pozycje graczy | `[count: uint8] × {[id: int8] [x: ?] [y: ?] [event_use: int8]}` |
| `1` | Nowi gracze | `[count: uint8] × {[id: int8] [name: string16] [skin_id: int8]}` |
| `2` | Gracze którzy wyszli | `[count: uint8] × {[id: int8]}` |
| `3` | Inicjalizacja (join) | `[self_id: uint8] [count: uint8] × {[id: uint8] [name: string16] [skin_id: uint8]}` |
| `4` | Dane mapy | `[level_count: uint8] × {Uint8Array[128] (128 bajtów)}` |
| `5` | Zabici gracze | `[count: uint8] × {[id: int8]}` |
| `6` | Odrodzeni gracze | `[count: uint8] × {[id: int8]}` |
| `7` | Lista martwych (przy join) | `[count: uint8] × {[id: uint8]}` |
| `8` | Wiadomości czatu | `[count: uint8] × {[id: int8] [msg: string16]}` |
| `9` | Leaderboard (top 6) | `[count: uint8] × {[id: int8] [byte_point: uint8]}` |
| `10` | Własna pozycja w rankingu | `[ranking_id: ?] [byte_point: uint8]` |
| `11` | Event (żywotność) | `[event_value: uint8]` — wartość 0–10 |
| `12` | Nagroda złota po śmierci | `[amount: uint32]` |
| `13` | Zmiana skina gracza | `[count: uint8] × {[id: int8] [skin_id: int8]}` |

**Uwaga o `byte_point`:** Punkty gracza (0–66M) są kompresowane do 1 bajtu (0–255) przez `to_bignum_byte()`:
- 0–100 000 → 0–100 (precyzja 1000 pkt/jednostka)
- 100 001–1 000 000 → 100–189 (10 000 pkt/jednostka)
- 1 000 001–66 000 000 → 189–255 (100 000 pkt/jednostka)

**Typy kafelków mapy (pakiet 4):**
- `0` = pustka (gracz spada)
- `1` = bezpieczna platforma (zielona — resetuje `jump_frame`)
- `2` = śmiertelna platforma (czerwona — odejmuje `event`)

---

### Wysyłane przez klienta do serwera (Child)

```javascript
// child.js — message handler
const p = data.pg.set_buffer(message);
switch (p.g_uint8()) { // typ w pierwszym bajcie
    case 0: // ruch gracza: [delta_x: int8]
    case 1: // zmiana skina: [skin_id: uint8]
    case 2: // użycie eventu (event_use = -1)
    case 3: // respawn po śmierci
    case 4: // wiadomość czatu: [text: string16]
    case 5: // keep-alive / ping
    case 8: // potwierdzenie respawnu
}
```

| Typ | Nazwa | Struktura |
|---|---|---|
| `0` | Ruch | `[delta_x: int8]` — wartość ruchu w osi X (ujemna = lewo, dodatnia = prawo) |
| `1` | Zmiana skina | `[skin_id: uint8]` — numer wybranego skina |
| `2` | Użycie eventu | *(brak danych)* — `event_use = -1` (skok/przepad) |
| `3` | Respawn | *(brak danych)* — odroź mnie po śmierci |
| `4` | Czat | `[text: string16]` — wiadomość tekstowa |
| `5` | Ping | *(brak danych)* — keep-alive |
| `8` | Respawn potwierdzenie | *(brak danych)* — `is_dead = false` |

---

## Autoryzacja połączenia z serwerem gry

Połączenie z `child.js` wymaga ważnego tokenu w URL:

```
ws://34.89.123.45:30542/3482901234
                        └── token (uint32 jako string)
```

Serwer waliduje token w `upgrade()`:
```javascript
const token_id = req.getUrl().slice(1); // usuń wiodący '/'
if (!have_token(token_id)) {
    res.writeStatus('401 Unauthorized').end();
    return;
}
```

Token wygasa po 10 000 tickach (~160 sekund) i jest jednorazowy — po użyciu usuwany z `tokens{}`.
