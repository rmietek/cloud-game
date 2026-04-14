'use strict';

const path     = require('path');
const PUBLIC   = path.join(__dirname, 'public');

const uWS      = require('uWebSockets.js');
/*
 * uWebSockets.js — serwer WebSocket napisany w C++ z bindingami dla Node.js.
 *
 * Używamy go do obsługi połączeń z KLIENTAMI gry (przeglądarka gracza).
 * Klient łączy się przez WebSocket do lobby (ten serwer), a NIE bezpośrednio do serwera gry.
 *
 * Flow połączenia:
 *   Przeglądarka ──WebSocket──► Mother (ten plik) ──Redis pub/sub──► Serwer gry (child.js)
 *
 * uWS jest wielokrotnie szybszy od standardowego modułu 'ws' — ważne gdy lobby
 * obsługuje setki jednoczesnych graczy przeglądających listę serwerów.
 *
 * Kluczowe API:
 *   uWS.App()                — tworzy aplikację
 *   .ws('/*', handlers)      — obsługa WebSocket pod dowolną ścieżką
 *   ws.subscribe('kanal')    — subskrybuj kanał pub/sub (wbudowany w uWS, nie Redis!)
 *   app.publish('kanal', buf)— wyślij do wszystkich subskrybentów kanału
 *   ws.send(buf, true)       — wyślij dane binarne (true = binary, nie tekst)
 */



const express  = require('express');
/*
 * Express.js — framework HTTP dla Node.js.
 *
 * Używamy do:
 *   POST /auth/register  — rejestracja nowego konta
 *   POST /auth/login     — logowanie (weryfikacja hasła)
 *   GET  /               — serwowanie głównej strony gry (index.html)
 *   GET  /lang           — detekcja kraju gracza  (work in progress)
 *   Serwowanie statycznych plików: /obj, /js, /mp3, /img, /site
 *
 * Dlaczego Express (HTTP) zamiast samego uWS (WebSocket)?
 *   Express jest prostszy dla typowych HTTP requestów (REST API).
 *   uWS obsługuje WebSocket
 *   Używamy obydwu: Express na porcie 9876, uWS na porcie 3001.
 */


const bcrypt   = require('bcrypt');
/*
 * bcrypt — biblioteka do hashowania haseł.
 *
 * Dlaczego nie przechowujemy haseł w plaintext lub MD5?
 *   Plaintext: jeśli baza wycieknie → atakujący ma hasła wszystkich użytkowników.
 *   MD5/SHA: szybkie do złamania słownikiem (GPU może sprawdzić miliardy haseł/s).
 *   bcrypt: celowo wolny algorytm — nawet z GPU złamanie jednego hasła trwa sekundy.
 *
 * Jak działa bcrypt:
 *   hash = bcrypt.hash("moje_haslo", rounds=10)
 *   → $2b$10$XWxkV3q7Y...  (string ~60 znaków)
 *   Zawiera: algorytm + rounds + sól (losowe 22 znaki) + hash
 *
 *   bcrypt.compare("moje_haslo", hash) → true   (hasło zgadza się)
 *   bcrypt.compare("złe_haslo",  hash) → false  (nie zgadza się)
 *
 */


const mongodb  = require('mongodb');
/*
 * MongoDB oficjalny sterownik dla Node.js.
 * MongoDB to baza NoSQL — przechowuje dokumenty JSON-like (BSON).
 *
 * Używamy do przechowywania danych graczy:
 *   {
 *     _id:          ObjectId("507f1f77bcf86cd799439011"),
 *     email:        "gracz@example.com",
 *     password_hash:"$2b$10$...",
 *     points:       15000,       ← aktualna waluta (może być wydana w sklepie)
 *     total_points: 45000,       ← łącznie zarobione (nigdy nie maleje, do rankingów)
 *     name:         "Kacper",
 *     last_login:   Date,
 *     skin:         [3, 7, 12],  ← lista zakupionych skinów
 *     acc_data:     [],          ← dodatkowe dane konta
 *   }
 */


const { createClient } = require('redis');
/*
 * Klient Redis dla Node.js.
 * Redis (Remote Dictionary Server) — baza klucz-wartość działająca w RAM.
 *
 * W tej architekturze Redis pełni rolę "magistrali komunikacyjnej":
 *
 *   DANE SERWERÓW GRY (zapisywane przez child.js):
 *     game:{id} → HASH { g_port, g_players_len, g_players_lim, serv_ip, serv_loc, serv_name }
 *     game_ids  → SET  { id1, id2, id3, ... }  ← lista aktywnych gier
 *
 *   PUB/SUB KANAŁY:
 *     'lobby_update'    → child.js publikuje gdy zmienia się liczba graczy / nowa gra / gra znika
 *                         mother.js subskrybuje i rozsyła aktualizację do klientów za pomocą WebSocket
 *     'join:{game_id}'  → mother.js publikuje token gracza
 *                         child.js subskrybuje i dodaje gracza do gry
 *
 * Dlaczego Redis zamiast bezpośredniej komunikacji HTTP między serwerami?
 *   Luźne powiązanie: mother nie musi znać adresów IP child serwerów.
 *   Skalowalność: 10 mother serwerów + 100 child serwerów — Redis obsługuje wszystko.
 *   Pub/sub: natychmiastowe powiadomienia zamiast pollingu (odpytywania co X sekund).
 */


const { MongoClient, ObjectId } = mongodb;
/*
 * MongoClient — klasa do nawiązywania połączenia z MongoDB.
 * ObjectId    — specjalny typ identyfikatora dokumentu w MongoDB.
 *
 * WAŻNE: MongoDB przechowuje _id jako binarny ObjectId, NIE string.
 * Zapytanie { _id: "507f1f..." }       → NIC nie znajdzie! (szuka stringa)
 * Zapytanie { _id: new ObjectId("507f1f...") } → ZNAJDZIE (poprawny typ)
 */



const fs = require('fs');
const isDocker = fs.existsSync('/.dockerenv');
const { packet_get, packet_set } = require(isDocker ? './shared/binary.js' : '../shared/binary.js');
/*
 * Własny moduł binarnego protokołu komunikacji z klientami gry.
 *
 * Dlaczego binarny zamiast JSON?
 *   JSON: { "type": 2, "games": [{"port": 30542, "players": 5}] } = ~60 bajtów
 *   Bin:  [02] [01] [9B B6 00 00] [05] [0F] ...                 = ~15 bajtów
 *   4× mniejsze pakiety = niższy ping, tańszy transfer, więcej graczy jednocześnie.
 *
 * packet_set — bufor do ZAPISU:
 *   new packet_set(1000)  → bufor 1000 bajtów
 *   .new_type(n)          → zacznij pakiet typu n
 *   .s_uint8(val)         → zapisz uint8 (0–255)
 *   .s_uint16(val)        → zapisz uint16 (0–65535)
 *   .s_uint32(val)        → zapisz uint32 (0–4 294 967 295)
 *   .s_int32_arr(arr, n)  → zapisz tablicę n liczb int32
 *   .s_string(str)        → zapisz string z 1-bajtowym prefixem długości
 *   .s_string16(str)      → zapisz string z 2-bajtowym prefixem długości
 *   .s_int8_arr(arr, n)   → zapisz n bajtów z tablicy
 *   .s_string_arr(arr, n) → zapisz tablicę n stringów
 *   .get_buf()            → zwróć zbudowany bufor
 *
 * packet_get — parser do ODCZYTU:
 *   new packet_get()      → utwórz parser
 *   .set_buffer(buf)      → ustaw bufor do parsowania
 *   .g_int8()             → odczytaj int8 (przesuń wskaźnik o 1)
 *   .g_uint8()            → odczytaj uint8
 *   .g_uint16()           → odczytaj uint16
 *   .g_uint32()           → odczytaj uint32
 *   .g_string()           → odczytaj string (1B prefix)
 *   .g_string16()         → odczytaj string (2B prefix)
 */




// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA 2: KONFIGURACJA
//
//  Wszystkie liczby i adresy zebrane w jednym obiekcie CONFIG.
//  Zmiana ustawień = edycja tylko tej sekcji, bez szukania po całym kodzie.
//
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    HTTP_PORT:     9876,
        /*
     * Port Express.js — HTTP API (rejestracja, logowanie, pliki statyczne).
     * Klienty gry NIE łączą się tu przez WebSocket.
     * Przykładowe zapytania: POST http://ip:9876/auth/login
     *
     * Dlaczego niestandardowy port (nie 80/443)? W plikach kubernetesa bedzie przekierowanie na port 80
     */

    CLIENT_PORT:   3001,
    /*
     * Port uWS WebSocket — połączenia klientów do lobby.
     * Tu klient łączy się po WebSocket żeby:
     *   - Pobrać listę dostępnych serwerów gry
     *   - Dołączyć do konkretnego serwera (dostać token)
     *   - Zarządzać kontem (kupić skin, zmienić nazwę)
     *   - Otrzymywać aktualizacje listy serwerów w czasie rzeczywistym
     */

    MONGO_URL:     process.env.MONGO_URL || 'mongodb://localhost:27017',
    /*
     * Adres MongoDB z fallbackiem na localhost.
     * W Kubernetes: MONGO_URL=mongodb://mongo-service:27017 (nazwa serwisu K8s)
     * Lokalnie: brak zmiennej → połączenie z lokalnym MongoDB
     */

    REDIS_URL:     process.env.REDIS_URL || 'redis://localhost:6379',
    /*
     * Adres Redis z fallbackiem na localhost.
     * Tak samo jak MongoDB: K8s ustawia przez zmienną środowiskową.
     * 6379 = domyślny port Redis.
     */

    BCRYPT_ROUNDS: 10,
    /*
     * Liczba rund hashowania bcrypt = 2^10 = 1024 iteracje.
     *
     * Im więcej rund, tym:
     *   + trudniejszy bruteforce (każde dodatkowe +1 = 2× wolniejsze łamanie)
     *   - wolniejsze logowanie (server musi "odczekać" ten czas przy każdym login)
     *
     * rounds=10 → ~100ms na jedno hashowanie (akceptowalny czas logowania)
     * rounds=12 → ~400ms (bardziej bezpieczne, zauważalne opóźnienie)
     * rounds=14 → ~1600ms (bardzo bezpieczne, ale 1.6s przy logowaniu)
     *
     * 10 to powszechnie akceptowany kompromis dla aplikacji webowych
     */
};



// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA : WSPÓŁDZIELONY STAN APLIKACJI
//
//  Zmienne dostępne w całym module — "stan globalny" serwera lobby.
//
// ═══════════════════════════════════════════════════════════════════════════════

let db_users;
/*
 * Referencja do kolekcji MongoDB 'users'.
 * Ustawiana w connectDatabase() — nie jest dostępna przy starcie.
 * Przed użyciem: zawsze sprawdź czy db_users != null
 *
 * Kolekcja 'users' zawiera konta graczy z hash hasłem, punktami, skinami itp.
 * Bezpośredni dostęp z tego pliku: rejestracja, logowanie, zakupy, zmiana nazwy.
 */


 
let c_man;
/*
 * Referencja do instancji ClientManager — WebSocket serwer dla klientów.
 * Ustawiana po inicjalizacji na dole pliku.
 *
 * Używana w subskrypcji Redis 'lobby_update':
 *   redisSub.subscribe('lobby_update', () => {
 *     if (c_man) c_man.broadcast_games();  ← wyślij aktualizację do wszystkich klientów
 *   });
 *
 * Dlaczego 'if (c_man)'?
 *   Redis może odebrać 'lobby_update' zanim ClientManager zdąży się zainicjalizować.
 */



const ps = new packet_set(1000);
/*
 * GLOBALNY bufor do budowania pakietów wychodzących.
 * Tworzony raz, reużywany przy każdym pakiecie (bez alokacji co request).
 *
 * 1000 bajtów = wystarczający bufor dla wszystkich pakietów lobby:
 *   Pakiet skinów (type 3):   23 skin_costs × 4B + 23 skin_lights × 4B ≈ 184 bajtów
 *   Pakiet gier  (type 2):    buildGamesPacket używa własnego lokalnego packet_set
 *   Pakiet konta (type 1):    email + punkty + nazwa + skiny + acc_data ≈ 200-400 bajtów
 *   Pakiet join  (type 0):    token(4) + port(2) + ip(~15) ≈ 25 bajtów
 *
 * UWAGA: ps jest współdzielone — nie można używać go jednocześnie w dwóch miejscach!
 *   Kod jest jednowątkowy (Node.js event loop)
 *   Ale buildGamesPacket() tworzy własny lokalny ps — nie blokuje ps.
 */




const gen_id = (function () {
    const buf = new Uint32Array(1);
    /*
     * Uint32Array(1) — tablica jednej liczby 32-bitowej bez znaku.
     * Kluczowa właściwość: każde przypisanie AUTOMATYCZNIE:
     *   - Obcina część ułamkową (float → int)
     *   - Clampuje do zakresu 0–4 294 967 295
     *
     * Przykład bez Uint32Array:
     *   let x = Math.random() * 0xffffffff;  → x = 3456789012.345  (float, zły!)
     * Z Uint32Array:
     *   buf[0] = Math.random() * 0xffffffff; → buf[0] = 3456789012 (czysty uint32)
     */
    return function () {
        buf[0] = Math.random() * 0xffffffff;
        /*
         * 0xffffffff = 4 294 967 295 = maksymalna wartość uint32.
         * Math.random() × 0xffffffff = losowy float [0, 4 294 967 295).
         * Przypisanie do buf[0] → automatyczna konwersja na uint32.
         */
        return buf[0];
    };
})();
/*
 * gen_id() używane do generowania tokenów dołączenia do gry.
 * Token = losowy uint32 → bardzo małe ryzyko kolizji.
 *
 * Bezpieczeństwo: uint32 = 4 miliardy możliwości.
 * Jeśli ktoś próbuje odgadnąć token (bruteforce)
 * Praktycznie niemożliwe w normalnych warunkach.
 */







// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: DANE SKINÓW
//
//  Skiny to wygląd postaci gracza. Kupowane za punkty w sklepie.
//  Dane skinów są zakodowane jako stałe tablice — nie zmieniają się w czasie działania.
//
// ═══════════════════════════════════════════════════════════════════════════════

const SKIN_COSTS = [
    //  idx 0        1     2     3     4     5  ← numery skinów (indeksy tablicy)
        5000,        0,    0,    0,    0,    0,  // Skin 0: 5000pkt; Skiny 1-5: DARMOWE (startowe)
    //  idx 6        7        8        9       10       11
        8000,    15000,   10000,   18000,  25000,   35000,
    //  idx 12      13       14       15      16       17
        50000,   70000,   90000,  120000,  100000,  160000,
    //  idx 18      19       20       21       22
        200000,  280000,  400000,  550000,  800000,
];
/*
 * Ceny zakupu skinów w punktach gry.
 * Indeks tablicy = numer skina.
 *
 * Logika cen:
 *   Skiny 1–5:   koszt 0 (darmowe) → startowe opcje dla nowych graczy
 *   Skiny 6–22:  płatne, rosnące ceny (od 8 000 do 800 000 punktów)
 *
 * Jak używane:
 *   handleBuySkin(): MongoDB $inc { points: -SKIN_COSTS[buyId] }
 *   open(): wysyłane do klienta przy połączeniu (klient wyświetla ceny w sklepie)
 *
 * Dlaczego tablica zamiast obiektu { "0": 5000, "1": 0, ... }?
 *   Tablica: SKIN_COSTS[7] = 15000 — O(1) dostęp przez indeks
 *   Obiekt: szybki dostęp ale więcej pamięci i overhead JSON keys
 *   Wysyłamy jako s_int32_arr() — tablica to naturalny format dla serializacji
 */




const SKIN_LIGHTS = [
    0xffffff, 0xff,     0xff00,   0xff9b00, 0x616161, 0x00f1ff,
    0xf9ff00, 0xff00e9, 0xff0000, 0x330002, 0xa44aee, 0x4bc6ff,
    0xefa94d, 0x86ff5f, 0x504eeb, 0x6a6a6a, 0xccca23, 0x8c55c8,
    0xa28b63, 0xfa3936, 0x4d6cfd, 0xeaaa93, 0xa9a9a9,
];
/*
 * Kolory świateł/emisji dla każdego skina (format RGB hex).
 *
 * Indeks odpowiada SKIN_COSTS — SKIN_LIGHTS[i] = kolor dla skina i.
 * Przykłady:
 *   0:  0xffffff = biały (RGB: 255, 255, 255)
 *   1:  0x0000ff = niebieski (RGB: 0, 0, 255) — 0xff to skrót od 0x0000ff
 *   8:  0xff0000 = czerwony
 *   12: 0xefa94d = złoty/pomarańczowy
 *
 * Klent używa tych kolorów do:
 *   - Podświetlenia postaci gracza (emissive lighting w Three.js)
 *   - Efektów cząsteczkowych (particle colors)
 *   - Wyróżnienia skina w sklepie
 *
 * Wysyłane do klienta razem z SKIN_COSTS w pakiecie type 3 przy połączeniu.
 */







// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: POŁĄCZENIE REDIS
//
//  Redis wymaga dwóch osobnych klientów:
//    redis    — do zapisu/odczytu/publish (hGetAll, sMembers, publish, exists...)
//    redisSub — TYLKO do subscribe (protokół Redis blokuje klienta po SUBSCRIBE)
//
// ═══════════════════════════════════════════════════════════════════════════════

const redis    = createClient({ url: CONFIG.REDIS_URL });
const redisSub = createClient({ url: CONFIG.REDIS_URL });
/*
 * Dwa oddzielne połączenia TCP do Redis.
 *
 * Dlaczego dwa klienty?
 *   Protokół Redis: gdy klient wywoła SUBSCRIBE, wchodzi w "subscriber mode".
 *   W tym trybie może TYLKO odbierać wiadomości.
 *   Nie może wykonywać: GET, HGETALL, PUBLISH, SET itp.
 *
 *   redis    → normalne operacje (czytanie danych, publish tokenów)
 *   redisSub → TYLKO nasłuchiwanie na kanały (subscribe)
 *
 * To standardowy wzorzec — każda biblioteka Redis wymaga tego rozróżnienia.
 */



redis.on('error',    err => console.error('Redis error:', err));
redisSub.on('error', err => console.error('Redis sub error:', err));
/*
 * Globalne handlery błędów połączenia.
 *
 * KRYTYCZNE: bez tych handlerów, błąd sieci (np. Redis chwilowo niedostępny)
 * spowodowałby "unhandled error event" → CRASH całego serwera mother!
 *
 * Z handlerami:
 *   - Błąd jest logowany (widoczny w logach K8s/docker)
 *   - Biblioteka redis automatycznie próbuje się reconnektować
 *   - Serwer nie crasha
 *
 * Typowe błędy które tu trafiają:
 *   ECONNREFUSED — Redis nie działa lub zły adres
 *   ETIMEDOUT    — sieć niestabilna, timeout połączenia
 *   ENOTFOUND    — nieprawidłowa nazwa hosta Redis
 */



/**
 * Nawiązuje połączenia Redis i konfiguruje subskrypcję aktualizacji lobby.
 */
async function connectRedis() {
    await redis.connect();
    await redisSub.connect();
    /*
     * await = czekaj aż TCP handshake zostanie zakończony.
     * Bez await: następne operacje na redis/redisSub mogłyby się nie udać.
     */



    // Każda instancja mother subskrybuje kanał powiadomień.
    // Child publikuje 'lobby_update' gdy rejestruje grę, zmienia licznik lub zamyka serwer.
    await redisSub.subscribe('lobby_update', () => {
        /*
         * Subskrybuj kanał 'lobby_update'.
         *
         * KTO publikuje na ten kanał?
         *   child.js (serwer gry) publikuje '1' gdy:
         *     - Nowy serwer się rejestruje (connectRedis w child.js)
         *     - Zmienia się liczba graczy (redis_update_player_count co ~1s)
         *     - Serwer znika (redis_cleanup przy SIGTERM)
         *
         * CO robimy gdy dostaniemy powiadomienie?
         *   Pobieramy aktualną listę gier z Redis i rozsyłamy do WSZYSTKICH
         *   podłączonych klientów (przez uWS pub/sub 'lobby').
         *
         * EFEKT dla gracza:
         *   Lista serwerów w lobby odświeża się automatycznie w czasie rzeczywistym.
         *   Gracz widzi "EU-Phantom: 3/15 graczy" i po chwili "4/15" — bez odświeżania strony.
         */


        if (c_man) c_man.broadcast_games().catch(console.error);
        /*
         * c_man może być null jeśli Redis odebrał 'lobby_update' zanim
         * ClientManager zdążył się zainicjalizować (race condition przy starcie).
         * Guard 'if (c_man)' zapobiega błędowi.
         */
    });

    console.log('Connected to Redis');
}








// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA : BUDOWANIE PAKIETU LISTY GIER
//
//  Funkcja czytająca z Redis wszystkie aktywne serwery gier
//  i pakująca je do binarnego pakietu do wysłania klientom.
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pobiera z Redis listę wszystkich aktywnych serwerów gier i buduje binarny pakiet.
 *
 * Format danych w Redis (zapisywany przez child.js):
 *   game_ids        → SET  z ID wszystkich aktywnych gier
 *   game:{id}       → HASH z polami:
 *     g_port        — port WebSocket serwera gry
 *     g_players_len — aktualna liczba graczy
 *     g_players_lim — maksymalna liczba graczy (np. 15)
 *     serv_ip       — publiczny adres IP
 *     serv_loc      — region (EU/US/ASIA)
 *     serv_name     — czytelna nazwa (np. "EU-Phantom")
 *
 * @returns {Promise<Buffer>}  Gotowy bufor binarny do wysłania przez ws.send()
 */
// Czyta wszystkie gry z Redis i buduje binarny pakiet dla klientów.
//   (zapisywana przez child.js):
//   game:{id}  → HASH { g_port, g_players_len, g_players_lim, serv_ip, serv_loc }
//   game_ids   → SET  { id, id, ... }
async function buildGamesPacket() {
    const ids   = await redis.sMembers('game_ids');
    /*
     * SMEMBERS — pobierz WSZYSTKICH członków zbioru Redis.
     * 'game_ids' = Set zawierający ID wszystkich aktywnych serwerów gier.
     * Przykładowy wynik: ["3482901234", "1234567890", "9876543210"]
     *
     * Dlaczego Set a nie np. KEYS 'game:*'?
     *   KEYS skanuje całą bazę Redis — wolne przy dużej liczbie kluczy.
     *   Set z SMEMBERS = O(n) gdzie n = liczba aktywnych gier (zwykle < 100).
     *   Set jest też "self-cleaning" — child.js usuwa swoje ID przy zamknięciu.
     */



    const games = [];
    for (const id of ids) {
        const g = await redis.hGetAll(`game:${id}`);
        /*
         * HGETALL — pobierz wszystkie pola hash mapy dla tego ID.
         * Zwraca obiekt: { g_port: "30542", g_players_len: "5", ... }
         *
         * Uwaga: HGETALL zwraca null jeśli klucz nie istnieje
         */


        if (g && g.g_port) games.push({ id: parseInt(id), ...g });
        /*
         * g && g.g_port — podwójne sprawdzenie:
         *   g = null? → HGETALL nie znalazło klucza → pomiń
         *   g.g_port falsy (null/undefined/"")? → brak danych portu → pomiń
         *
         * parseInt(id) — id w Redis Set to string, konwertujemy na number.
         * ...g — spread operator: kopiuje wszystkie pola z hash mapy do nowego obiektu.
         *   { id: 3482901234, g_port: "30542", g_players_len: "5", ... }
         */
    }


    // Buduj binarny pakiet z listą gier
    const lps = new packet_set(1000);
    /*
     * LOKALNY packet_set — nie używamy globalnego ps żeby nie blokować innych operacji.
     * buildGamesPacket() jest async i może być wywoływana wielokrotnie jednocześnie.
     * Lokalny bufor = bezpieczne równoległe wywołania.
     */


    lps.new_type(2);
    // Typ 2 = "lista gier" — klient wie jak zinterpretować ten pakiet.


    lps.s_length8(games.length);
    // Liczba serwerów gier (uint8). Klient wie ile razy czytać dane serwera.
    // Jeśli games.length = 0 → klient wyświetla "brak dostępnych serwerów".


    for (const g of games) {
        lps.s_uint32(g.id);
        // ID gry (uint32) — używane przez klienta w pakiecie "dołącz" (handleJoinGame).
        // Klient wysyła ten ID i mother wie do którego child.js wysłać token.


        lps.s_uint8(parseInt(g.g_players_len) || 0);
        // Aktualna liczba graczy. parseInt() bo Redis zwraca strings.
        // || 0 → fallback na 0 jeśli pole jest null/undefined/"" (ochrona przed NaN).


        lps.s_uint8(parseInt(g.g_players_lim) || 0);
        // Limit graczy (np. 15). Klient może oznaczyć pełny serwer (len >= lim).


        lps.s_string(g.serv_loc || '');
        // Kod regionu (np. "EU") z 1-bajtowym prefixem długości.
        // || '' — jeśli pole nie istnieje → pusty string zamiast "undefined".


        lps.s_string(g.serv_name || g.serv_loc || 'Server');
        // Czytelna nazwa (np. "EU-Phantom").
        // Fallback: jeśli brak nazwy → użyj regionu → ostatecznie "Server".
        // Starsze wersje child.js mogły nie zapisywać serv_name.

    }
    return Buffer.from(lps.get_buf());
        /*
     * get_buf() zwraca ArrayBuffer lub Uint8Array z zawartością packet_set.
     * Buffer.from() konwertuje na Node.js Buffer.
     * Node.js Buffer jest wymagany przez ws.send() w uWS.
     */
}



// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA : POŁĄCZENIE MONGODB
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Łączy z MongoDB i inicjalizuje kolekcję 'users' z indeksem na polu email.
 */
async function connectDatabase() {
    const client = await MongoClient.connect(CONFIG.MONGO_URL);
    const db = client.db('gra');
    /*
     * db('gra') — wybierz bazę danych o nazwie 'gra'. 
     * Baza zostanie automatycznie utworzona jeśli nie istnieje.
     */
    console.log('Connected to MongoDB');
    db_users = db.collection('users');
    /*
     * Przechowaj referencję do kolekcji globalnie.
     * Nie potrzebujemy reconnektować przy każdym zapytaniu — reużywamy połączenie.
     */
    
    await db_users.createIndex({ email: 1 }, { unique: true });
    /*
     * Utwórz UNIKALNY indeks na polu email.
     *
     * Co robi ten indeks:
     *   1. UNIKALNOŚĆ: MongoDB odrzuci insertOne jeśli email już istnieje.
     *      Kod rejestracji przechwytuje błąd err.code === 11000 → "email zajęty".
     *   2. SZYBKOŚĆ: findOne({ email: ... }) = O(log n) zamiast O(n).
     *      Bez indeksu MongoDB skanuje KAŻDY dokument szukając emaila.
     *      Z indeksem: prawie natychmiastowe trafienie, nawet przy milionach użytkowników.
     *
     * { email: 1 } — indeks rosnący (1) na polu email.
     * { unique: true } — wymuszenie unikalności.
     *
     * createIndex — wywołanie przy każdym starcie jest bezpieczne.
     * Jeśli indeks już istnieje → MongoDB go nie tworzy ponownie.
     */
}




// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: POMOCNICZA FUNKCJA WYSYŁKI DANYCH KONTA
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Wysyła pełne dane konta gracza przez WebSocket.
 * Wywoływana po: zalogowaniu, zakupie skina, zmianie nazwy, ponownym połączeniu.
 *
 * @param {WebSocket} ws    Socket klienta który ma otrzymać dane
 * @param {object}    user  Dokument gracza z MongoDB
 */

function send_account(ws, user) {
    ps.new_type(1);
    // Typ 1 = "dane konta" — klient zaktualizuje wyświetlane informacje o graczu.

    ps.s_string16(user.email);
    // Email (2-bajtowy prefix długości + bajty UTF-8).
    // Klient pokazuje email w menu ustawień konta.

    ps.s_uint32(user.points);
    // Aktualna waluta gracza (0–4 294 967 295).
    // Wyświetlana w sklepie: "Masz 15 000 punktów".
    // Zmniejszana przy zakupie skina ($inc { points: -SKIN_COSTS[id] }).
    // Zwiększana przez serwer gry ($inc { points: earned, total_points: earned }).

    ps.s_uint32(user.total_points);
    // Łącznie zarobione punkty (nigdy nie maleje — nawet po zakupach).
    // Używane do globalnego rankingu (kto zarobił więcej przez całą historię).

    ps.s_string16(user.name);
    // Nick wyświetlany nad postacią gracza w grze.
    // Może być zmieniony przez handleChangeName().

    ps.s_int8_arr(user.skin, user.skin.length);
    /*
     * Lista zakupionych skinów jako tablica uint8.
     * Przykład: [3, 7, 12] → gracz kupił skiny nr 3, 7 i 12.
     *
     * Klient używa tej listy do:
     *   - Wyświetlenia "zakupiony" obok skinów w sklepie
     *   - Umożliwienia wyboru skina przy respawnie
     *
     * Przesyłamy jako surową tablicę bajtów — efektywniejsze niż JSON array.
     */

    ps.s_string_arr(user.acc_data, user.acc_data.length);
    /*
     * Dodatkowe dane konta — tablica stringów (rozszerzalne).
     * Zarezerwowane dla: osiągnięcia, tytuły, historia konta, preferencje itp.
     */

    ws.send(ps.get_buf(), true);
    // true = tryb binarny (nie tekst).
    // get_buf() zwraca zbudowany bufor z wszystkimi powyższymi polami.
}



// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: HTTP API (Express.js)
//
//  REST API dla operacji konta: rejestracja i logowanie.
//  Serwuje też statyczne pliki gry (HTML, JS, obrazy).
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Konfiguruje i uruchamia serwer Express na HTTP_PORT (9876).
 */
function setupExpressApp() {
    const app = express();
    app.use(express.json());
    /*
     * express.json() — middleware parsujący JSON z ciała requestu.
     * Bez tego: req.body = undefined.
     * Z tym:    req.body = { email: "...", password: "..." } (sparsowany obiekt)
     *
     * Działa tylko dla requestów z Content-Type: application/json.
     * Frontend wysyła: fetch('/auth/login', { body: JSON.stringify({email, password}) })
     */

    // ── POST /auth/register — Rejestracja nowego konta ───────────────────────
    app.post('/auth/register', async function (req, res) {
        const { email, password } = req.body;
        /*
         * Destrukturyzacja: wyciągnij email i password z ciała requestu.
         * Jeśli req.body = null (brak JSON) → email = undefined, password = undefined.
         */

        if (!email || !password || password.length < 4) {
            return res.status(400).json({ error: 'Podaj email i haslo (min. 4 znaki).' });
            /*
             * Walidacja danych wejściowych.
             * !email     → brak emaila lub pusty string
             * !password  → brak hasła lub pusty string
             * length < 4 → hasło za krótkie (zbyt łatwe do zgadnięcia)
             *
             * HTTP 400 Bad Request = "coś jest nie tak z twoim requestem" (błąd klienta).
             * return = kończymy tu, nie wykonujemy dalszego kodu.
             */
        }
        try {
            const hash = await bcrypt.hash(password, CONFIG.BCRYPT_ROUNDS);
            /*
             * Hashuj hasło przed zapisem do bazy.
             * bcrypt.hash() jest async — trwa ~100ms (celowo wolne, utrudnia bruteforce).
             * Wynik: string ~60 znaków, np. "$2b$10$XWxkV3q7YmJkVWJR..."
             *
             * NIGDY nie zapisujemy plaintext hasła!
             * Jeśli baza wycieknie: atakujący widzi tylko hashe, nie hasła.
             */

            const newAccount = {
                email,
                // email

                password_hash: hash,
                // Przechowujemy HASH, nie oryginalne hasło!


                points:       10000000,
                total_points: 10000000,
                /*
                 * Nowy gracz startuje z 10 000 000 punktami!
                 * To "starter pack" — gracz może od razu kupić kilka tanich skinów.
                 * Balans gry: zachęca nowych graczy do eksploracji sklepu.
                 */

                name:         'User' + ((Math.random() * 0xffffff) | 0),
                /*
                 * Domyślna nazwa: "User" + losowe 6-cyfrowe ID (hex → decimal).
                 * 0xffffff = 16 777 215 → "User8234521", "User16234521" itp.
                 * | 0 = Math.floor (szybkie obcięcie ułamka dla >= 0).
                 * Gracz może zmienić przez handleChangeName().
                 */

                last_login:   new Date(),
                // Data ostatniego logowania (aktualizowana przy każdym login).
                // Używana do statystyk aktywności użytkowników.


                skin:         [],
                // Lista zakupionych skinów — na start pusta.
                // Skiny 1–5 są darmowe → klient sprawdza SKIN_COSTS[id] === 0.

                acc_data:     [],
                // Dodatkowe dane konta — na start pusta tablica.

            };
            const result = await db_users.insertOne(newAccount);
            /*
             * insertOne() — wstaw jeden dokument do kolekcji.
             * Jeśli email już istnieje → MongoDB rzuca błąd z kodem 11000 (duplicate key).
             * Dzięki unikalnemu indeksowi na email — baza sama pilnuje unikalności.
             *
             * result.insertedId = ObjectId nowo utworzonego dokumentu.
             */


            res.json({ id: result.insertedId.toString() });
            /*
             * Odpowiedź: { id: "507f1f77bcf86cd799439011" }
             * Klient zapisuje ten ID lokalnie (localStorage/sessionStorage).
             * W kolejnych requestach: używa ID do identyfikacji konta (handleFetchAccount itp.)
             *
             * .toString() konwertuje ObjectId → string (JSON nie obsługuje binarnego ObjectId).
             */

            
        } catch (err) {
            if (err.code === 11000) {
                return res.status(409).json({ error: 'Ta nazwa użytkownika jest już zajęta.' });
                /*
                 * HTTP 409 Conflict = "zasoby są w konflikcie z istniejącym stanem".
                 * Kod 11000 = MongoDB duplicate key error (naruszenie unikalnego indeksu).
                 * Dzieje się gdy: dwa requesty rejestracji z tym samym emailem.
                 */

            }
            console.error('Register error:', err);
            res.status(500).json({ error: 'Blad serwera.' });
            // HTTP 500 Internal Server Error = coś poszło nie tak po naszej stronie.
        }
    });


    
     // ── POST /auth/login — Logowanie na istniejące konto ─────────────────────
    app.post('/auth/login', async function (req, res) {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: 'Podaj email i haslo.' });
        }

        try {
            const user = await db_users.findOne({ email });
            /*
             * Znajdź użytkownika po emailu.
             * Dzięki unikalnemu indeksowi: O(log n) — szybkie nawet przy milionach użytkowników.
             * Zwraca: pełny dokument gracza lub null jeśli email nie istnieje.
             */

            if (!user) {
                return res.status(401).json({ error: 'Nieprawidłowa nazwa użytkownika lub haslo.' });
                /*
                 * HTTP 401 Unauthorized = "brak autoryzacji / błędne dane".
                 * CELOWO: ten sam komunikat błędu dla "brak emaila" i "złe hasło".
                 *
                 * Dlaczego jeden komunikat zamiast dokładniejszego?
                 *   Bezpieczeństwo: jeśli powiemy "email nie istnieje" →
                 *   atakujący może sprawdzać które emaile są zarejestrowane (user enumeration).
                 *   Jeden ogólny komunikat = atakujący nie wie czy email istnieje czy nie.
                 */
            }

            const match = await bcrypt.compare(password, user.password_hash);
            /*
             * Porównaj podane hasło z hashem w bazie.
             * bcrypt.compare() haszuje podane hasło z tą samą solą (wbudowaną w hash)
             * i porównuje wyniki.
             *
             * match = true  → hasło poprawne
             * match = false → błędne hasło
             *
             * ~100ms opóźnienia (celowe — utrudnia bruteforce nawet jeśli atakujący
             * ma bezpośredni dostęp do bazy z hashami).
             */

            if (!match) {
                return res.status(401).json({ error: 'Nieprawidłowa nazwa użytkownika lub haslo.' });
                // Ten sam komunikat co przy braku emaila — security by design.
            }

            db_users.updateOne(
                { _id: user._id },
                { $currentDate: { last_login: true } }
            );
            /*
             * Aktualizuj datę ostatniego logowania.
             * $currentDate: { last_login: true } = ustaw last_login na aktualny timestamp MongoDB.
             *
             * Uwaga: NIE używamy await — nie czekamy na wynik tej operacji.
             * Dlaczego? Aktualizacja daty logowania nie jest krytyczna.
             * Gracz dostaje odpowiedź od razu, aktualizacja dzieje się "w tle".
             * Oszczędza ~5-20ms na każdym logowaniu.
             */

            res.json({ id: user._id.toString() });
            // Odpowiedź: { id: "507f1f..." } — identyczny format jak przy rejestracji.
            // Klient używa tego ID do dalszych operacji (pobieranie konta, dołączanie do gry).

        } catch (err) {
            console.error('Login error:', err);
            res.status(500).json({ error: 'Blad serwera.' });
        }
    });


    // ── Pliki specjalne ───────────────────────────────────────────────────────

    app.get('/ads.txt', function (req, res) {
        res.sendFile(path.join(PUBLIC, 'ads.txt'));
        /*
         * ads.txt — plik wymagany przez sieci reklamowe (Google AdSense, AdMob).
         * Zawiera listę autoryzowanych vendorów reklamowych.
         * __dirname = ścieżka do katalogu w którym jest ten plik JS.
         */
    });

    app.get('/', function (req, res) {
        res.sendFile(path.join(PUBLIC, 'index.html'));
        /*
         * Główna strona gry — HTML z całym interfejsem klienta.
         * index.html to entry point aplikacji (ładuje Three.js, logikę gry itp.).
         * Serwowana dla każdej wizyty na "/" (root URL).
         */
    });

    app.get('/lang', function (req, res) {
        res.send(req.headers['cf-ipcountry']);
        /*
         * Detekcja kraju gracza przez Cloudflare.
         *
         * Cloudflare (CDN/proxy) dodaje nagłówek 'cf-ipcountry' do każdego requestu.
         * Wartość: kod kraju ISO 3166 (np. "PL", "DE", "US", "T1" dla Tor).
         *
         * Klient wywołuje fetch('/lang') żeby wiedzieć w jakim języku wyświetlić UI.
         * Brak Cloudflare (lokalnie): req.headers['cf-ipcountry'] = undefined → klient dostaje "undefined".
         *
         */
    });

    // ── Pliki statyczne ───────────────────────────────────────────────────────
    app.use('/obj',  express.static(path.join(PUBLIC, 'obj')));   // modele 3D (.obj, .mtl, .gltf)
    app.use('/js',   express.static(path.join(PUBLIC, 'js')));    // kod JavaScript klienta
    app.use('/mp3',  express.static(path.join(PUBLIC, 'mp3')));   // dźwięki (muzyka, efekty)
    app.use('/img',  express.static(path.join(PUBLIC, 'img')));   // obrazy (textury, UI, ikonki skinów)
    app.use('/site', express.static(path.join(PUBLIC, 'site')));  // dodatkowe zasoby (CSS, fonty)
    /*
     * express.static(folder) — middleware serwujące pliki statyczne z podanego folderu.
     *
     * Działanie: GET /img/player.png → wysyła plik ./img/player.png z dysku.
     * Obsługuje: Cache-Control, ETag, If-None-Match (304 Not Modified) automatycznie.
     * Bezpieczne: express.static zapobiega path traversal (np. /img/../../../etc/passwd).
     *
     * W K8s: zdefiniowany w Dockerfile/WORKDIR.
     */

    app.listen(CONFIG.HTTP_PORT, () => console.log('Express listening on', CONFIG.HTTP_PORT));
    /*
     * Uruchom serwer HTTP na HTTP_PORT (9876).
     * Callback loguje sukces.
     * Jeśli port zajęty → błąd EADDRINUSE → proces crash.
     */
}




/**
 * Tworzy i uruchamia WebSocket serwer dla klientów lobby.
 * @param {number} port  Port nasłuchiwania (CLIENT_PORT = 3001)
 */
function ClientManager(port) {
    const self = this;
    /*
     * Zachowaj referencję 'this' w closure.
     * 'self' zawsze wskazuje na obiekt ClientManager — bezpieczna referencja.
     */

    this.app = uWS.App();
    /*
     * Utwórz instancję aplikacji uWS.
     * Jedna aplikacja może obsługiwać wiele "route" (.ws(), .get(), .post() itp.).
     * Tu używamy tylko .ws('/*') — jeden endpoint WebSocket.
     */

    this.app.ws('/*', {
        // '/*' = obsługuj WebSocket pod DOWOLNĄ ścieżką URL.

        upgrade: function (res, req, context) {
            /*
             * Wywoływana gdy klient wysyła HTTP Upgrade Request (HTTP → WebSocket).
             *
             * Tu NIE walidujemy tokenów — lobby jest otwarte dla wszystkich.
             * Każdy może się podłączyć do listy serwerów gier.
             *
             * W child.js (serwer gry) upgrade() sprawdza token — tam dostęp jest ograniczony.
             * Tu: brak autoryzacji = uproszczenie (lobby jest publiczne).
             */
            res.upgrade(
                {},
                // Dane powiązane z tym socketem — tutaj pusty obiekt (nie potrzebujemy stanu).
                req.getHeader('sec-websocket-key'),
                req.getHeader('sec-websocket-protocol'),
                req.getHeader('sec-websocket-extensions'),
                context
                // Cztery obowiązkowe parametry WebSocket handshake (RFC 6455).
            );
        },

        open: function (ws) {
            /*
             * Gracz właśnie połączył się z lobby!
             * Musimy natychmiast wysłać mu:
             *   1. Listę aktywnych serwerów gier (żeby mógł wybrać do czego dołączyć)
             *   2. Dane skinów (ceny i kolory, żeby sklep działał offline)
             */

            ws.subscribe('lobby');
            /*
             * Subskrybuj kanał 'lobby' w wewnętrznym pub/sub uWS.
             * UWAGA: to NIE jest Redis pub/sub — to osobny mechanizm wbudowany w uWS
             *
             * Jak to działa:
             *   ws.subscribe('lobby')     → ten socket "dołącza" do grupy 'lobby'
             *   app.publish('lobby', buf) → wyślij buf do WSZYSTKICH socketów w grupie 'lobby'
             *
             * Po co to?
             *   broadcast_games() jest wywoływana gdy Redis dostaje 'lobby_update'.
             *   Zamiast iterować wszystkich klientów (O(n)), app.publish() robi to wewnętrznie.
             *   Wydajniejsze i prostsze.
             *
             * Każdy nowy klient automatycznie dołącza do 'lobby' przy połączeniu.
             * Przy rozłączeniu (close) uWS automatycznie usuwa go z grupy — nie trzeba nic robić.
             */

            buildGamesPacket().then(buf => {
                try { ws.send(buf, true); } catch (_) {}
            }).catch(console.error);
            /*
             * Wyślij listę serwerów gier natychmiast po połączeniu.
             *
             * Dlaczego try/catch wokół ws.send()?
             *   Klient może się rozłączyć między momentem wywołania buildGamesPacket()
             *   a momentem gdy Promise się rozwiąże (buildGamesPacket jest async).
             *   Wysłanie do rozłączonego socketa → wyjątek.
             *   try/catch z ignorowanym błędem (_) = obsługujemy ten edge case 
             *
             * .catch(console.error) — jeśli buildGamesPacket() rzuci błąd Redis → loguj.
             */

            ps.new_type(3);
            ps.s_int32_arr(SKIN_COSTS,  SKIN_COSTS.length);
            ps.s_int32_arr(SKIN_LIGHTS, SKIN_LIGHTS.length);
            ws.send(ps.get_buf(), true);
            /*
             * Wyślij dane skinów (ceny i kolory) — pakiet type 3.
             *
             * Dlaczego przy każdym połączeniu a nie tylko przy logowaniu?
             *   Klient potrzebuje tych danych do wyświetlenia sklepu.
             *   Wysyłamy zawsze — nawet gościom (mogą przeglądać sklep bez konta).
             *
             * Kolejność: dwie tablice po 23 elementy int32.
             *   SKIN_COSTS[0..22]  → 23 × 4 bajty = 92 bajty
             *   SKIN_LIGHTS[0..22] → 23 × 4 bajty = 92 bajty
             *   Łącznie: ~186 bajtów dla całego sklepu — bardzo efektywnie.
             *
             * Uwaga: używamy globalnego ps (nie lokalnego) — synchroniczne, bezpieczne.
             */
        },

        message: function (ws, message, isBinary) {
            /*
             * Klient wysłał wiadomość binarną do lobby.
             * Parsujemy typ i przekazujemy do odpowiedniego handlera.
             */

            const p = new packet_get();
            p.set_buffer(message);
            /*
             * Utwórz LOKALNY parser dla tej wiadomości.
             * Każda wiadomość to niezależny bufor — lokalna instancja jest bezpieczna.
             *
             * Dlaczego nowy packet_get() przy każdej wiadomości?
             *   packet_get przechowuje wewnętrzny wskaźnik pozycji odczytu.
             *   Gdyby współdzielony: jedna wiadomość "przesuwa" wskaźnik i psuje następną.
             */

            p.g_int8();
            // SKIP: odczytaj i pomiń pierwszy bajt.
            // aktualnie nieużywane
            // g_int8() bez przypisania = "przesuń wskaźnik o 1 bajt, ignoruj wartość".

            switch (p.g_int8()) {
            // Odczytaj drugi bajt = typ pakietu.

                case 0: handleJoinGame(p, ws);     break;
                // Gracz chce dołączyć do konkretnego serwera gry.

                case 1: handleFetchAccount(p, ws); break;
                // Gracz chce pobrać dane swojego konta (po zalogowaniu).

                case 2: handleBuySkin(p, ws);      break;
                // Gracz chce kupić skin w sklepie.

                case 3: handleChangeName(p, ws);   break;
                case 4: handleChangeName(p, ws);   break;
                // Case 3 i 4 robią na razie to samo (handleChangeName).
                // TODO: różne typy zmiany nazwy (case 3 = zmiana nicku, case 4 = zmiana wyświetlanej nazwy).

                case 5: handleReconnect(p, ws);    break;
                // Gracz próbuje ponownie połączyć się z grą (po zerwaniu połączenia).

                case 6:
                    buildGamesPacket().then(buf => {
                        try { ws.send(buf, true); } catch (_) {}
                    }).catch(console.error);
                    break;
                /*
                 * Gracz ręcznie prosi o odświeżenie listy serwerów.
                 * Normalnie lista aktualizuje się automatycznie przez Redis 'lobby_update'.
                 * Case 6 = "odśwież teraz" TODO: button w UI — na żądanie gracza.
                 */
            }
        },

        close: function (ws) {
            // Gracz rozłączył się z lobby.
            // uWS automatycznie usuwa go z subskrypcji 'lobby' — nie trzeba nic robić            // Brak stanu per-klient
        },

    }).listen(port, function (token) {
        if (token) console.log('ClientManager listening on port', port);
        else console.error('ClientManager failed on port', port);
        // token= sukces, false = błąd (zajęty port, brak uprawnień itp.)
    });

    // ── Broadcast ──────────────────────────────────────────────────────────────

    /**
     * Wysyła aktualną listę gier do WSZYSTKICH podłączonych klientów lobby.
     * Wywoływana automatycznie gdy Redis dostaje 'lobby_update' (z child.js).
     */
    this.broadcast_games = async function () {
        const buf = await buildGamesPacket();
        // Pobierz aktualne dane z Redis i spakuj do bufora.

        self.app.publish('lobby', buf, true);
        /*
         * Wyślij bufor do WSZYSTKICH klientów subskrybujących kanał 'lobby'.
         * (każdy klient subskrybuje 'lobby' w open() → ws.subscribe('lobby'))
         *
         * self.app.publish() = jeden call → uWS wewnętrznie iteruje wszystkich subskrybentów.
         * Wydajniejsze niż: for (client of clients) { client.send(buf) }
         *
         * true = tryb binarny.
         *
         * Efekt: wszyscy gracze w lobby jednocześnie widzą zaktualizowaną listę serwerów.
         * np. "EU-Phantom: 3/15" zmienia się na "EU-Phantom: 4/15" gdy ktoś dołącza.
         */
    };







    // ── Handlery wiadomości ────────────────────────────────────────────────────

    /**
     * Obsługuje prośbę gracza o dołączenie do serwera gry.
     * Generuje jednorazowy token i publikuje go przez Redis do child.js.
     *
     * Flow:
     *   1. Odczytaj: gameId, name, skinId, accountId z pakietu
     *   2. Sprawdź czy gracz ma prawo do wybranego skina
     *   3. Wygeneruj token i wyślij przez Redis do child.js
     *   4. Wyślij token + dane połączenia (IP, port) do klienta
     */
    function handleJoinGame(p, ws) {
        let gameId, name, skinId, accountId;
        try {
            gameId    = p.g_uint32();   // ID gry (uint32) — który serwer gry wybrał gracz
            name      = p.g_string16(); // Nick gracza w tej sesji (może być inny niż w profilu)
            skinId    = p.g_uint8();    // Wybrany skin (0–22)
            accountId = p.g_string();   // MongoDB ObjectId stringa (lub "" dla gościa)
            if (accountId !== '') accountId = new ObjectId(accountId);
            /*
             * Konwertuj string → ObjectId TYLKO jeśli nie jest pusty.
             * Pusty string = gracz-gość (nie zalogowany) → accountId zostaje '' (string).
             * Zalogowany gracz: "507f1f..." → new ObjectId("507f1f...") (binarny typ MongoDB).
             */
        } catch (e) {}
        /*
         * try/catch bez obsługi błędu = "jeśli parsowanie się nie uda, pomiń".
         * Może się zdarzyć gdy:
         *   - Nieprawidłowy format ObjectId → new ObjectId() rzuca wyjątek
         *   - Bufor zbyt krótki → g_uint32() rzuca wyjątek
         *
         * W takim przypadku: gameId/name/skinId/accountId zostają undefined.
         * Walidacja poniżej (name == null || name.length > 9) wyłapie undefined.
         */

        if (name == null || name.length > 9) return;
        /*
         * Walidacja nicku:
         *   name == null  → parsowanie się nie udało
         *   name.length > 9 → nick za długi (max 9 znaków, UI tego nie obsłuży)
         *
         */

        async function doAddPlayer() {
            /*
             * Wewnętrzna async funkcja — wykonuje właściwą logikę dołączenia.
             * Zdefiniowana tu żeby mieć dostęp do zmiennych z closure (gameId, name itp.).
             */

            const gameData = await redis.hGetAll(`game:${gameId}`);
            /*
             * Pobierz aktualne dane serwera gry z Redis.
             * Sprawdzamy TERAZ (nie ufamy danym sprzed chwili) bo serwer mógł się zamknąć.
             */

            if (!gameData || !gameData.g_port) return;
            // Serwer nie istnieje lub brak danych → anuluj dołączenie.

            if (parseInt(gameData.g_players_len) >= parseInt(gameData.g_players_lim)) return;
            /*
             * Serwer jest PEŁNY (aktualna liczba graczy >= limit).
             * Sprawdzamy ponownie bo między wyborem serwera a wysłaniem pakietu
             * ktoś inny mógł wypełnić ostatnie miejsce (race condition).
             */

            const token = gen_id();
            /*
             * Generuj jednorazowy token = losowy uint32.
             * Token to "klucz" który gracz poda serwerowi gry przy połączeniu.
             * Serwer gry (child.js) sprawdza: have_token(token) → true → pozwól dołączyć.
             */

            await redis.publish(`join:${gameId}`, JSON.stringify({
                token,
                name,
                skin_id: skinId,
                account: accountId ? accountId.toString() : '',
            }));
            /*
             * Wyślij token przez Redis do serwera gry.
             *
             * Kanał: 'join:<gameId>' — każdy serwer gry subskrybuje SWÓJ kanał.
             * child.js robi: redis_sub.subscribe(`join:${game_id}`, handler)
             *
             * JSON.stringify() bo Redis pub/sub przesyła strings, nie obiekty.
             *
             * Zawartość:
             *   token   — jednorazowy token (uint32)
             *   name    — nick gracza
             *   skin_id — wybrany skin
             *   account — MongoDB ObjectId lub '' dla gości
             *
             * accountId.toString(): konwertuje ObjectId z powrotem na string
             * (JSON nie obsługuje binarnych typów MongoDB).
             * '' dla gości — child.js nie zapisze punktów do bazy jeśli account = ''.
             */

            ps.new_type(0);
            ps.s_uint32(token);
            ps.s_uint16(parseInt(gameData.g_port));
            ps.s_string(gameData.serv_ip);
            const clientPacket = Buffer.from(ps.get_buf());
            /*
             * Zbuduj pakiet dla klienta (type 0 = "dane połączenia"):
             *   token    (uint32): jednorazowy klucz do połączenia z serwerem gry
             *   g_port   (uint16): port serwera gry (0–65535)
             *   serv_ip  (string): IP serwera gry
             *
             * Klient połączy się: ws://serv_ip:g_port/token
             * Np.:              ws://34.89.123.45:30542/3482901234
             *
             * Dlaczego Buffer.from() przed setTimeout?
             *   ps jest buforem globalnym — może być nadpisany przez kolejne wywołania ps.new_type().
             *   Buffer.from() tworzy KOPIĘ zawartości w tym momencie.
             *   Bez kopii: setTimeout mógłby wysłać inne dane (jeśli ps zmienił się w 50ms).
             */

            setTimeout(() => { try { ws.send(clientPacket, true); } catch (_) {} }, 50);
            /*
             * Wyślij token do klienta z 50ms OPÓŹNIENIEM.
             *
             * Dlaczego 50ms?
             *   1. redis.publish() jest async — wiadomość musi dojść do child.js
             *   2. child.js musi przetworzyć wiadomość i dodać token do tokens{}
             *   3. Dopiero wtedy klient może się połączyć z serwerem gry
             *
             *   Bez opóźnienia:
             *     Klient dostaje IP:port:token prawie jednocześnie z redis.publish()
             *     Klient łączy się ZANIM child.js zdążył przetworzyć token
             *     child.js: have_token(token) = false → odrzuca połączenie! (401)
             *
             *   50ms to zazwyczaj więcej niż wystarczy (Redis pub/sub latency ~1-5ms,
             *   przetwarzanie w child.js ~1ms). Bufor dla wolnych sieci.
             *
             *   try/catch: klient mógł się rozłączyć w ciągu tych 50ms → ignorujemy błąd.
             */
        }

        if (skinId >= 1 && skinId <= 5) {
            doAddPlayer().catch(console.error);
            /*
             * Skiny 1–5 są DARMOWE (SKIN_COSTS[1..5] = 0).
             * Każdy może ich użyć — nie weryfikujemy zakupu w bazie.
             * Szybka ścieżka: od razu dodaj gracza bez zapytania do MongoDB.
             */
        } else {
            db_users.findOne({ _id: accountId, skin: skinId })
                .then(function (result) { if (result) doAddPlayer(); })
                .catch(console.error);
            /*
             * Płatny skin (skinId 0 lub 6–22) — sprawdź czy gracz go kupił.
             *
             * Zapytanie MongoDB:
             *   { _id: accountId, skin: skinId }
             *   → znajdź dokument gracza gdzie:
             *     _id = ten gracz (po ID konta)
             *     skin zawiera skinId (pole 'skin' to tablica, MongoDB sprawdza element tablicy)
             *
             * Przykład:
             *   Gracz ma skin: [3, 7, 12].
             *   skinId = 7 → MongoDB zwróci dokument (ma skin 7) → dozwolone.
             *   skinId = 9 → MongoDB zwróci null (nie kupił 9) → zablokowane.
             *
             * if (result) → null jeśli gracz nie ma skina → nie dołącza.
             * Ochrona przed cheatingiem po stronie serwera.
             */
        }
    }

    /**
     * Pobiera dane konta gracza z MongoDB i wysyła je przez WebSocket.
     * Wywoływana gdy gracz loguje się (chce zobaczyć swoje punkty, skiny itp.)
     */
    function handleFetchAccount(p, ws) {
        let accountId;
        try { accountId = new ObjectId(p.g_string()); } catch (e) { return; }
        /*
         * Odczytaj MongoDB ObjectId z pakietu.
         * try/catch: nieprawidłowy format stringa → new ObjectId() rzuca błąd → return.
         */

        db_users.findOneAndUpdate(
            { _id: accountId },
            { $currentDate: { last_login: true } },
            { returnDocument: 'after' }
        ).then(function (result) {
            if (result) send_account(ws, result);
        }).catch(console.error);
        /*
         * findOneAndUpdate — znajdź dokument I zaktualizuj go ATOMOWO.
         * Jedna operacja zamiast dwóch (findOne + updateOne) = lepsza wydajność i spójność.
         *
         * Co robi:
         *   1. Znajdź gracza: { _id: accountId }
         *   2. Ustaw: { $currentDate: { last_login: true } } → last_login = teraz
         *   3. Zwróć dokument PO aktualizacji: { returnDocument: 'after' }
         *
         * Dlaczego 'after' a nie 'before'?
         *   Chcemy wysłać AKTUALNY dokument (z nową datą logowania).
         *   'before' zwróciłby stary dokument (przed aktualizacją daty).
         *
         * if (result) — null gdy gracz nie istnieje (zły accountId) → nic nie wysyłamy.
         */
    }

    /**
     * Obsługuje zakup skina przez gracza.
     * Atomowo pobiera punkty i dodaje skin do kolekcji (bez możliwości kupienia dwa razy).
     */
    function handleBuySkin(p, ws) {
        let accountId, buyId;
        try {
            accountId = new ObjectId(p.g_string());
            buyId     = p.g_uint8();
            // buyId = numer skina do zakupu (0–22)
        } catch (e) { return; }

        db_users.findOneAndUpdate(
            {
                _id:    accountId,
                skin:   { $ne: buyId },
                // $ne (not equal) — skin nie jest w tablicy 'skin'
                // Jeśli skin już zakupiony → nie znajdzie dokumentu → brak aktualizacji → OK
                points: { $gt: SKIN_COSTS[buyId] },
                // $gt (greater than) — gracz ma WIĘCEJ punktów niż cena skina
                // Jeśli za mało punktów → nie znajdzie dokumentu → brak zakupu → OK
            },
            {
                $inc:  { points: -SKIN_COSTS[buyId] },
                // $inc z ujemną wartością = odejmij punkty (zapłata za skin)
                $push: { skin: buyId },
                // $push — dodaj buyId do tablicy 'skin' (lista zakupionych skinów)
            },
            { returnDocument: 'after' }
            // Zwróć dokument po aktualizacji (z nową liczbą punktów i nowym skinem).
        ).then(function (result) {
            if (result) send_account(ws, result);
            /*
             * Wyślij zaktualizowane dane konta (z nowym saldem punktów i skinem).
             * Klient odświeży UI: "kupiono skin, odjęto X punktów".
             *
             * result = null gdy:
             *   - Gracz już ma ten skin ($ne buyId nie spełnione → dokument nie znaleziony)
             *   - Gracz ma za mało punktów ($gt nie spełnione)
             *   - Gracz nie istnieje
             * W takich przypadkach: nie wysyłamy nic → klient nie dostaje potwierdzenia.
             * Klient może to interpretować jako "zakup nie powiódł się".
             */
        }).catch(console.error);

        /*
         * DLACZEGO JEDNO ATOMOWE findOneAndUpdate ZAMIAST DWÓCH OPERACJI?
         *
         * Niebezpieczne (race condition):
         *   1. findOne → gracz ma 10000 punktów, nie ma skina 7
         *   2. Dwa requesty jednocześnie: oba sprawdzają i oba widzą "ma punkty, nie ma skina"
         *   3. Oba robią $inc -10000 → gracz wydał 20000 ale ma tylko 10000 (ujemne saldo!)
         *   4. Oba robią $push → gracz ma skin 7 dwa razy w tablicy
         *
         * Bezpieczne (atomowe findOneAndUpdate):
         *   MongoDB wykonuje filtr + update ATOMOWO w jednej operacji.
         *   Drugi request: filtr { points: { $gt: 10000 } } nie spełniony (już 0) → null → odrzut.
         *   Brak duplikatu, brak ujemnego salda.
         */
    }

    /**
     * Zmienia nick gracza w bazie i wysyła zaktualizowane dane konta.
     */
    function handleChangeName(p, ws) {
        let accountId, name;
        try {
            accountId = new ObjectId(p.g_string());
            name      = p.g_string16(); // nowa nazwa gracza
        } catch (e) { return; }

        if (!name || name.length >= 20) return;
        /*
         * Walidacja nazwy:
         *   !name        → pusta nazwa → odrzuć
         *   length >= 20 → za długa (limit wyświetlania w UI = 19 znaków)
         *
         * Brak walidacji contentu (np. obraźliwe słowa):
         *   To zadanie dla moderacji post-factum lub filtra po stronie klienta.
         *   Serwer pilnuje tylko długości.
         */

        db_users.findOneAndUpdate(
            { _id: accountId },
            { $set: { name } },
            // $set = ustaw pole 'name' na nową wartość (nadpisz).
            { returnDocument: 'after' }
        ).then(function (result) {
            if (result) send_account(ws, result);
        }).catch(console.error);
    }

    /**
     * Obsługuje próbę ponownego połączenia z serwerem gry po zerwaniu połączenia.
     * Weryfikuje czy serwer nadal działa i wysyła zaktualizowane dane konta.
     */
    function handleReconnect(p, ws) {
        let gameId, accountId;
        try {
            gameId = p.g_uint32();      // ID serwera gry z którym gracz był połączony
            p.g_uint32();               // playerId — pomin (ID gracza na serwerze gry)
            accountId = new ObjectId(p.g_string());
        } catch (e) { return; }
        /*
         * playerId jest odczytywany (g_uint32()) a
         * Aktualnie: sprawdzamy tylko czy serwer gry nadal działa (game_id istnieje w Redis).
         */

        redis.exists(`game:${gameId}`).then(function (exists) {
            /*
             * Sprawdź czy serwer gry nadal jest aktywny w Redis.
             * exists() zwraca: 1 (istnieje) lub 0 (nie istnieje / wygasł TTL).
             *
             * Serwer może nie istnieć gdy:
             *   - Restart (SIGTERM, crash)
             *   - Brak heartbeatu przez 5s → klucz wygasł
             *   - Gracz miał zerwane połączenie przez długi czas
             */

            if (!exists) return null;
            /*
             * Serwer już nie istnieje → return null → .then(function(result)) dostaje null.
             * Nie próbujemy reconnektować — klient musi wybrać inny serwer.
             */

            return db_users.findOneAndUpdate(
                { _id: accountId },
                { $currentDate: { last_login: true } },
                { returnDocument: 'after' }
            );
            /*
             * Serwer działa → pobierz aktualne dane konta.
             * Przy reconnect gracz mógł być offline długo → punkty z ostatniej gry zapisane przez child.js.
             * Wysyłamy świeże dane (z zaktualizowanymi punktami) żeby UI było aktualne.
             */
        }).then(function (result) {
            if (result) send_account(ws, result);
            // Wyślij dane konta jeśli serwer istnieje i gracz znaleziony.
        }).catch(console.error);
    }
}



// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA : URUCHOMIENIE SERWERA
//
//  Sekwencja inicjalizacji:
//    1. Połącz z MongoDB  → potrzebne dla rejestracji/logowania/kont
//    2. Połącz z Redis    → potrzebne dla listy gier i tokenów
//    3. Uruchom Express   → HTTP API 
//    4. Uruchom ClientManager → WebSocket lobby
//
//  Dlaczego sekwencja a nie równoległe uruchomienie?
//    Każdy krok ZALEŻY od poprzedniego:
//      Express potrzebuje db_users → db_users ustawiany w connectDatabase()
//      ClientManager.broadcast_games potrzebuje Redis → Redis w connectRedis()
//      redis.subscribe w connectRedis może dostać 'lobby_update' zanim ClientManager gotowy
//        → c_man null check w callbacku subskrypcji
//
// ═══════════════════════════════════════════════════════════════════════════════
connectDatabase()
    .then(connectRedis)
    // Najpierw baza, potem Redis — kolejność (Redis używa db_users pośrednio przez c_man)

    
    .then(function () {
        setupExpressApp();
        // Uruchom HTTP API — db_users jest już gotowe.

        c_man = new ClientManager(CONFIG.CLIENT_PORT);
        // Uruchom WebSocket lobby — Redis i MongoDB gotowe.
        // Przypisanie do c_man odblokuje callback Redis 'lobby_update' (if (c_man) przestaje być false).
    })
    .catch(function (err) {
        console.error('Startup error:', err);
        process.exit(1);
        /*
         * Krytyczny błąd przy starcie → zakończ proces z kodem 1 (błąd).
         * Kubernetes/Docker widzi exit code 1 → próbuje zrestartować pod.
         *
         * Typowe przyczyny:
         *   - MongoDB niedostępne (ECONNREFUSED)
         *   - Redis niedostępne
         *   - Port HTTP zajęty (EADDRINUSE)
         *
         * Bez process.exit(1): serwer działałby "na wpół" (bez DB/Redis).
         * Z process.exit(1): szybki fail + restart → czysty stan zamiast broken state.
         */
    });

