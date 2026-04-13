'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
//  KONFIGURACJA SERWERA
//  Wszystkie stałe zebraliśmy w jednym miejscu — łatwa zmiana parametrów gry
//  bez przeszukiwania całego kodu.
// ══════════════════════════════════════════════════════════════════════════════



const COUNTRY = "EU"; 
/*
 * Kod regionu tego serwera.
 * Używany do dwóch celów:
 *   1. Wyświetlany w lobby (gracze widzą "EU-Phantom" i wiedzą że to europejski serwer)
 *   2. Gracze mogą filtrować serwery według regionu — niższy ping dla graczy z UE
 *
 * Inne możliwe wartości: 'US', 'ASIA', 'BR' itd. — zależne od tego gdzie działa K8s.
 */
// serwery według lokalizacji (EU, US, ASIA itp.)



const SERVER_NAME_WORDS = [
    "Nexus", "Phantom", "Vortex", "Eclipse", "Orion",
    "Nova",  "Titan",   "Apex",   "Storm",   "Zenith",
    "Cipher","Vector",  "Pulse",  "Matrix",  "Sigma",
    "Hydra", "Falcon",  "Comet",  "Nebula",  "Quasar"
];
/*
 * Pula słów do losowej nazwy serwera.
 *
 * Po co losowe nazwy zamiast np. "Serwer-1", "Serwer-2"?
 *   - Gracze łatwiej zapamiętują "EU-Phantom" niż "EU-Game-7f3a"
 *   - Wygląda profesjonalnie w lobby
 *   - Działa jak UUID ale czytelny dla człowieka
 *
 * Nazwa generowana jest RAZ przy starcie procesu i nie zmienia się
 * przez całe życie tej instancji serwera.
 */



const SERVER_NAME = COUNTRY + "-" + SERVER_NAME_WORDS[Math.floor(Math.random() * SERVER_NAME_WORDS.length)];
console.log("Nazwa serwera:", SERVER_NAME);
/*
 * Przykładowe wyniki: "EU-Phantom", "EU-Quasar", "EU-Storm"
 *
 * Rozkład kodu:
 *   Math.random()                → liczba float z zakresu [0.0, 1.0)   np. 0.734
 *   * SERVER_NAME_WORDS.length   → skalowanie do [0.0, 20.0)           np. 14.68
 *   Math.floor(...)              → zaokrąglenie w dół do całkowitej    np. 14
 *   SERVER_NAME_WORDS[14]        → element tablicy o indeksie 14        np. "Sigma"
 *   COUNTRY + '-' + wynik        → sklejenie stringów                  → "EU-Sigma"
 *
 * Dlaczego Math.floor a nie Math.round?
 *   Math.random() nigdy nie zwróci dokładnie 1.0 (zakres [0.0, 1.0))
 *   Math.floor(19.99) = 19 — bezpieczny, max indeks = długość-1
 *   Math.round mogłoby dać 20 dla wartości 19.5+ → IndexOutOfBounds
 */



const SERVER_PORT    = parseInt(process.env.PORT || process.argv[2] || 5000);
// Skąd pobierany jest port gry na którym będą łączyć się gracze (3 opcje mamy w zalezności od tego czy to 
// jest na kubernetesie, czy lokalnie uruchamiany serwer na dekstopie):
//   1. Zmienna środowiskowa PORT     (ustawiana przez Kubernetes / Docker)
//   2. Argument linii poleceń [2]    (node server.js 6000)
//   3. Domyślny fallback: 5000
// parseInt konwertuje string → number (process.env zawsze zwraca string)

/*
 * Port na którym serwer nasłuchuje połączeń WebSocket.
 *
 * Trzy źródła (priorytet malejący):
 *
 *   1. process.env.PORT
 *      Zmienna środowiskowa — ustawiana przez Kubernetes/Docker.
 *      Nie jest ustawiana ręcznie w gitops/base/prz-agones.yaml
 *      (Fleet), bo port przydziela Agones dynamicznie z zakresu 7000-8000
 *      i zwraca go przez SDK (gs.status.ports). Zmienna przydatna przy
 *      lokalnym uruchamianiu przez Docker: docker run -e PORT=6000 ...
 *      Odziela konfigurację od kodu.
 *
 *   2. process.argv[2]
 *      Argument linii poleceń przy ręcznym uruchamianiu:
 *        node server.js 6000    ← process.argv = ['node', 'server.js', '6000']
 *        process.argv[2] = '6000'   (indeks 0 = 'node', 1 = 'server.js')
 *      Wygodne przy lokalnym developmencie — uruchamiasz kilka serwerów na różnych portach.
 *
 *   3. 5000 — domyślny fallback gdy żadne z powyższych nie jest ustawione.
 *
 *   4. Ustawiona przez AGONES - zaktualizowac
 * parseInt() konwertuje string → number.
 *   Dlaczego potrzebne? process.env zawsze zwraca string.
 *   parseInt("5000") = 5000  ← liczba, uWS.listen() wymaga number
 *   Bez parseInt: listen("5000", ...) mogłoby nie działać.
 */



const MAX_PLAYERS    = 15; 
/*
 * Maksymalna liczba graczy na tym serwerze.
 * (Boty nie wliczają się do tego limitu — są osobną pulą)
 *
 * Kiedy player_length >= MAX_PLAYERS, lobby nie kieruje nowych graczy i blokuje wejscie
 * na ten serwer (lobby sprawdza g_players_len < g_players_lim przy wyborze serwera).
 *
 * Dlaczego 15 graczy?
 *   Kompromis między: liczbą graczy a wydajnością serwera
 *   (za dużo = pakiety pozycji graczy za duże oraz kolizje kosztowne obliczeniowo).
 *   Przy 15 graczach + 37 botów = 52 obiektów na mapie → still OK dla 62.5 Hz.
 */



const SERVER_TICK_MS = 16;
/*
 * Czas jednego ticka w milisekundach.
 * 1000 / 16 ≈ 62.5 ticków na sekundę (zbliżone do 60 fps).
 * Wszystka fizyka i sieć dzieje się dokładnie co tyle ms.
 * 
 * Czas jednego "tiku" (kroku symulacji gry) w milisekundach.
 *
 * Związek z FPS:
 *   1000ms / 16ms = 62.5 tików na sekundę ≈ "62.5 FPS" dla fizyki serwera
 *
 * Dlaczego 16ms?
 *   - Większość monitorów odświeża się w 60Hz (16.67ms) lub 60+ Hz
 *   - Serwer produkuje dane szybciej niż klient może je wyświetlić → bufor jest zawsze pełny
 *   - 16ms to minimum które czujemy jako "płynne" w grach online
 *
 * Co się dzieje co tick:
 *   1. Aktualizacja AI botów
 *   2. Fizyka wszystkich graczy (kolizje, grawitacja, lądowanie)
 *   3. Wysyłka pakietów pozycji do klientów
 */
/*
 * SERVER_TICK_MS = 16 oznacza że setInterval(gameLoop, 16) — pętla gry odpala się co 16ms, czyli ~62.5 razy na sekundę.
 * Każde jedno odpalenie tej pętli to jeden tick. W jednym ticku dzieją się WSZYSTKIE te rzeczy (w tej kolejności):
 * 
    
  CO SIĘ DZIEJE CO TICK (JEDEN KROK SYMULACJI GRY) CZYLI 16 milisekund:
  tick N (co 16ms):
  │
  ├─ frame++                          ← licznik ticków (rośnie w nieskończoność)
  │
  ├─ if (frame % 10000 === 0)         ← co 10000 × 16ms = co ~160 sekund
  │    usuń wygasłe tokeny z tokens[]
  │
  ├─ for each bot:                    ← CO TICK
  │    przesuń bota losowo w lewo/prawo
  │    zmniejsz b.time (odliczanie do zmiany kierunku)
  │
  ├─ for each player:                 ← CO TICK
  │    if (!pl.is_dead) pl.move()
  │    │
  │    └─ pl.move():
  │         move_x = 0               ← zresetuj ruch (wchłonięty, już zastosowany)
  │         jump_frame++
  │         vecy = 4 - jump_frame × 0.1     ← grawitacja
  │         pl.y += vecy             ← aktualizacja pozycji Y
  │         sprawdź kolizję z kafelkami
  │         sprawdź kolizję z graczami
  │
  ├─ gen_packet()                     ← CO TICK
  │    zbuduj binarny pakiet dla każdego gracza
  │    wyślij ws.send() do każdego gracza
  │
  └─ if (frame % 60 === 0)            ← co 60 × 16ms = co ~960ms ≈ co 1 sekundę
      redis_update_player_count()    ← odśwież klucz game:{id} w Redis (TTL 5s)
 */
 


const GRAVITY        = 0.1;
// Przyspieszenie grawitacyjne odejmowane od prędkości Y co tick.
// Prędkość startowa skoku to 4 jednostki/tick — po 40 tickach (~640ms) gracz zaczyna opadać.
// Formuła: v = 4 - jump_frame * 0.1 → 0 przy jump_frame=40, -10 (limit) przy jump_frame=140
/*
 * Przyspieszenie grawitacyjne odejmowane od prędkości pionowej co tick.
 *
 * Jak to działa (w funkcji move()):
 *   jump_frame = ile ticków minęło od ostatniego lądowania
 *   prędkość_y = 4 - jump_frame * GRAVITY (0.1)
 *
 *   tick  0: prędkość = 4.0  (gracz startuje skokiem w górę)
 *   tick 10: prędkość = 3.0
 *   tick 20: prędkość = 2.0
 *   tick 40: prędkość = 0.0  (szczyt łuku — gracz "wisi" przez moment)
 *   tick 60: prędkość = -2.0 (opada)
 *   tick 80: prędkość = -4.0
 *   tick 140: prędkość = -10.0 (osiągnięty limit — patrz ograniczenie w move()) czyli
 * let vecy = 4 - this.jump_frame * GRAVITY;
   if (vecy < -10) vecy = -10;   // ← to jest "ograniczenie "  mówi: "prędkość opadania nie może być większa niż 10 jednostek na tick
   this.y += vecy;
 *
 * Dlaczego 0.1 a nie np. 9.8 (ziemska grawitacja w m/s²)?
 *   Gry używają sztucznej grawitacji dostosowanej do "feel" rozgrywki.
 *   Zbyt duże wartości = gracz spada błyskawicznie, nie ma czasu reagować.
 *   0.1 daje przyjemny łuk skoku w skali tej gry (jednostki to piksele, nie metry).
 */



const PLAYER_RADIUS  = 11;
/*
 * Promień "hitboxa" gracza w jednostkach gry.
 * Każdy gracz jest kołem o promieniu 11 jednostek (hitbox = koło, nie prostokąt).
 *
 * Kolizja zachodzi gdy:
 *   odległość_między_środkami ≤ PLAYER_RADIUS + PLAYER_RADIUS = 22 jednostki
 *
 * Dlaczego koło a nie prostokąt?
 *   - Prostokąt jest trudniejszy obliczeniowo (trzeba sprawdzać 4 strony)
 *   - Kołowy hitbox wygląda bardziej naturalnie dla postaci
 *   - Gra cylindryczna — koła pasują do zaokrąglonej estetyki gracza

  PODSUMOWUJĄC: Dwie postaci kolidują gdy odległość ich środków ≤ 11 + 11 = 22 jednostki.
 * 
 */



const BOT_COUNT      = 37;
// Liczba botów AI generowanych przy starcie serwera.
// Boty zapełniają serwer — gracze nigdy nie grają na pustej mapie.
/*
 * Liczba botów AI tworzonych przy starcie serwera.
 *
 * Dlaczego boty?
 *   - Nowy gracz który dołącza na pustym serwerze nie widzi nikogo → nudno → wychodzi
 *   - Boty wypełniają mapę, tworzą kolizje i interakcje
 *   - 37 botów to liczba "testowo dobrana" — wystarczająco dużo żeby mapa żyła
 *
 * Boty NIE wliczają się do MAX_PLAYERS (15) — mają osobne ID z puli free_ids.
 * 37 botów + 15 graczy = 52 obiekty, MAX_FREE_IDS = 255 → spokojnie mieści.
 */



const MAX_FREE_IDS   = 255;
// Maksymalna liczba jednoczesnych obiektów gracza (bot + human).
// uint8 → ID mieści się w 1 bajcie pakietu binarnego (0–254, bo 255 = zarezerwowane).



const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017';
/*
 * Adresy połączeń do baz danych.
 *
 * W produkcji (Kubernetes) — ustawiane w gitops/base/prz-agones.yaml (Fleet):
 *   REDIS_URL=redis://redis:6379        ← nazwa serwisu K8s (prz-redis.yaml: metadata.name: redis)
 *   MONGO_URL                           ← pobierany z Kubernetes Secret "cosmos-db-secret",
 *                                          klucz MONGO_URL (connection string do Azure CosmosDB).
 *                                          NIE jest wpisany jako literał — secretKeyRef zapewnia
 *                                          że hasło nie trafia do repozytorium.
 *
 * Lokalnie (development):
 *   Nie ustawiamy zmiennych → fallback na localhost → baza lokalna.
 *   Wystarczy mieć Redis i MongoDB uruchomione lokalnie.
 *
 * 6379 — domyślny port Redis (od 2009, pochodzi od "6379" ← nie ma specjalnego znaczenia)
 * 27017 — domyślny port MongoDB
 */



// ═══════════════════════════════════════════════════════════════════════════════
//  Obsługa SIGTERM — Kubernetes wysyła ten sygnał zanim zabije pod.
//
//  Problem: Kubernetes może w każdej chwili zabić ten pod (np. aktualizacja deploymentu,
//  autoskaler usuwa zbędne pody, node jest restartowany).
//
//
//  Daje serwerowi czas na posprzątanie (usunięcie z Redis, powiadomienie lobby).
//  Co trzeba posprzątać:
//    - Usunąć serwer z Redis → lobby przestanie wysyłać graczy na martwy serwer
//    - Powiadomić lobby o zmianie → UI lobby odświeży listę serwerów
//
// ═══════════════════════════════════════════════════════════════════════════════
process.on('SIGTERM', () => {
    /*
     * process.on('SIGTERM', handler) — rejestracja handlera na sygnał systemu operacyjnego.
     *
     * SIGTERM (Signal Terminate) — "grzeczna prośba" o zakończenie.
     * Różni się od SIGKILL który natychmiast zabija proces bez możliwości reakcji.
     *
     * Kubernetes flow:
     *   1. K8s wysyła SIGTERM do naszego procesu
     *   2. Ten handler się uruchamia
     *   3. redis_cleanup() usuwa grę z Redis
     *   4. setTimeout 1000ms — czekamy żeby Redis zdążył wysłać dane
     *   5. process.exit(0) — kończymy proceso z kodem 0 (sukces, nie błąd)
     */

    console.log('Otrzymano SIGTERM. Usuwam grę z Redis i zamykam.');

    is_shutting_down = true;
    // Flaga zatrzymuje dalsze aktualizacje Redis (redis_update_player_count sprawdza tę flagę)
    /*
     * Ustawiamy flagę globalną.
     *
     * Dlaczego ta flaga jest potrzebna?
     * redis_update_player_count() jest wywoływana co sekundę w pętli gry.
     * Bez tej flagi — po SIGTERM ciągle próbowalibyśmy aktualizować Redis
     * podczas gdy jednocześnie redis_cleanup() go czyści.
     * Wyścig: cleanup usuwa klucz → update go z powrotem tworzy → brudny stan.
     *
     * is_shutting_down = true mówi redis_update_player_count(): "przestań działać".
     */
  
    redis_cleanup().then(() => {
        // Usuń klucz game:<id> z Redis i powiadom lobby (publish 'lobby_update')
        /*
         * Dlaczego setTimeout 1000ms zamiast natychmiastowego exit?
         *
         * Redis pub/sub jest asynchroniczny — redis_pub.publish('lobby_update', '1')
         * wysyła wiadomość przez sieć. Sieć ma opóźnienie ~1-5ms.
         * Bez czekania: process.exit() może wywołać się PRZED dotarciem wiadomości.
         * lobby na pewno dostanie powiadomienie przy 1 sekundzie.
         */

        
        setTimeout(() => process.exit(0), 1000); 
        // Poczekaj 1 sekundę — daj czas na rozesłanie wiadomości Redis zanim proces zginie
    }).catch(console.error);
         /*
         * Jeśli redis_cleanup() rzuci błąd (np. Redis niedostępny) — logujemy do konsoli.
         * Nie możemy zrobić "retry" bo zamykamy serwer. Logowanie wystarczy.
         */   
});





// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA 3: ŁADOWANIE ZALEŻNOŚCI (require)
//  require() wczytuje moduł raz i cachuje
// ═══════════════════════════════════════════════════════════════════════════════


const uWS       = require('uWebSockets.js');
// uWebSockets.js — serwer WebSocket napisany w C++, o wiele szybszy niż 'ws'.
// Kluczowe dla gry real-time: niskie opoznienie
/*
 * uWebSockets.js — serwer WebSocket napisany w C++ z bindingami dla Node.js.
 *
 * Dlaczego nie wbudowany moduł 'ws'?
 *   Benchmarki pokazują że uWS jest 5-10× szybszy od 'ws' przy dużej liczbie połączeń.
 *   Dla gry real-time z 50+ połączeniami i 62.5 pakietami/sekundę każde połączenie —
 *   przepustowość i latency mają krytyczne znaczenie.
 *
 * Kluczowe API które używamy:
 *   uWS.App()          — tworzy aplikację HTTP/WebSocket
 *   .ws('/*', {...})   — obsługuje WebSocket pod dowolną ścieżką
 *   .listen(port, cb)  — nasłuchuje na porcie
 *   ws.send(buf, true) — wysyła dane binarne (true = binary mode)
 *   ws.getBufferedAmount() — sprawdza ile bajtów czeka w kolejce wysyłki 
 */



const AgonesSDK = require('@google-cloud/agones-sdk');
// Agones SDK — komunikacja z kontrolerem K8s zarządzającym serwerami gry.
// Pozwala na: ready(), allocate(), health() — cykl życia GameServer obiektu.
/*
 * Agones — open-source system do zarządzania serwerami gier na Kubernetes.
 * Stworzony przez Google i Unity Technologies.
 *
 * Problem który rozwiązuje:
 *   W normalnym K8s możesz skalować "bezstanowe" serwisy (HTTP).
 *   Serwery gier są STANOWE — każdy 'pod' to unikalna sesja gry z graczami.
 *   Nie możesz po prostu zabić poda gdy gracze grają.
 *
 * Stany GameServera w Agones:
 *   Starting  → pod się uruchamia (jeszcze nie gotowy)
 *   Ready     → gotowy do przyjęcia graczy (autoskaler może przydzielić)
 *   Allocated → ma przydzielonych graczy (autoskaler go nie ruszy)
 *   Shutdown  → kończy działanie
 *
 * My zarządzamy przejściami:
 *   ready()    → Starting/Shutdown → Ready (moze wrocic do puli serwerow a autoskaler sam ubije)
 *   allocate() → Ready → Allocated  (przy pierwszym graczu)
 *   health()   → heartbeat "żyję" (co 2s)
 */
const agonesSDK = new AgonesSDK();



const { createClient } = require('redis');
/*
 * Klient Redis dla Node.js.
 * Redis (Remote Dictionary Server) — baza danych w pamięci RAM.
 * Używamy jako "szyna komunikacyjna" między serwisami:
 *   - Serwer gry zapisuje swoje dane  → lobby je czyta
 *   - Mother server (lobby) publikuje tokeny → serwer gry je odbiera
 *
 * Dlaczego Redis a nie bezpośrednia komunikacja WebSocket?
 *   Architektura mikrousług — każdy serwis nie musi "znać" adresów innych.
 *   Redis to centralny punkt wymiany informacji.
 *   Przy skalowaniu: 10 serwerów gry + 3 serwery lobby — Redis obsługuje wszystko.
 */

const { MongoClient, ObjectId } = require('mongodb');
/*
 * MongoDB — baza danych dokumentowa (NoSQL).
 * Używamy do trwałego przechowywania danych graczy (punkty, statystyki).
 *
 * Dlaczego MongoDB a nie SQL (PostgreSQL)?
 *   - Dokumenty (JSON-like) są naturalne dla obiektów gracza
 *   - Brak schematu — łatwe dodawanie nowych pól bez migracji
 *   - Dobra wydajność dla prostych operacji: findOne, updateOne z $inc
 *
 * ObjectId — specjalny typ BSON (Binary JSON) używany przez MongoDB jako _id.
 *   Wygląda jak string: "507f1f77bcf86cd799439011" (24 znaki hex)
 *   Ale wewnętrznie to 12 bajtów: 4B timestamp + 5B losowe + 3B licznik
 *   new ObjectId("507f1...") — konwertuje string → binarny ObjectId dla zapytań
 */


const bin        = require('../../shared/binary.js');
const packet_get = bin.packet_get;
const packet_set = bin.packet_set;
// Własny moduł do kodowania/dekodowania pakietów binarnych.
//   packet_set — bufor do zapisu (s_int8, s_float, s_string16 itd.)
//   packet_get — bufor do odczytu (g_uint8, g_int8, g_string16 itd.)
// Protokół binarny zamiast JSON: 10–20× mniejsze pakiety, niższy ping.
/*
 * Własny moduł protokołu binarnego.
 *
 * Dlaczego binarny protokół zamiast JSON?
 *
 *   Przykład danych do wysłania: pozycja gracza {id: 5, x: 512.3, y: -1024.7}
 *
 *   JSON:    {"id":5,"x":512.3,"y":-1024.7}  = 30 bajtów (tekst)
 *   Binarny: [05] [00 00 FF 3F] [00 00 80 C4] = 9 bajtów  (binary)
 *
 *   3× mniej danych = mniejszy ping, mniejsze opłaty za transfer, więcej miejsca na graczy.
 *
 *   Przy 50 graczach, 62.5 pakietach/s, każdy pakiet ~500B:
 *     JSON:    50 × 62.5 × 500B  = 1.5 MB/s
 *     Binary:  50 × 62.5 × 166B  = 0.5 MB/s  ← 3× mniej!
 *
 * packet_set — klasa do ZAPISU pakietu:
 *   new packet_set(5000) — bufor 5000 bajtów
 *   p.new_type(n)        — zacznij blok pakietu typu n
 *   p.s_int8(val)        — zapisz liczbę 8-bitową ze znakiem (-128..127)
 *   p.s_uint8(val)       — zapisz liczbę 8-bitową bez znaku (0..255)
 *   p.s_uint32(val)      — zapisz liczbę 32-bitową bez znaku (0..4294967295)
 *   p.s_float(val)       — zapisz float 32-bit (4 bajty, precyzja ~7 miejsc)
 *   p.s_string16(str)    — zapisz string: 2 bajty długość + bajty UTF-8
 *   p.s_int8_arr(arr, n) — zapisz tablicę n liczb 8-bitowych
 *   p.s_length8(n)       — zapisz liczbę elementów listy (uint8)
 *   p.end_global()       — zaznacz koniec "globalnej" części
 *   p.get_buf()          — zwróć cały bufor
 *   p.get_uniq_buf()     — zwróć global + per-player część
 *   p.clear_uniq_buf()   — wyczyść per-player część
 *   p.clear()            — wyczyść cały bufor
 *
 * packet_get — klasa do ODCZYTU pakietu:
 *   new packet_get()     — utwórz parser
 *   .set_buffer(buf)     — ustaw bufor do parsowania
 *   .g_uint8()           — odczytaj uint8 (przesuwa wskaźnik o 1 bajt)
 *   .g_int8()            — odczytaj int8 ze znakiem
 *   .g_string16()        — odczytaj string (2 bajty długość + treść)
 */





// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA 4: AGONES — połączenie z kontrolerem K8s i rejestracja serwera
//
// ═══════════════════════════════════════════════════════════════════════════════

const USE_AGONES = process.env.USE_AGONES === 'true'; // <- NOWA FLAGA
const IS_LOCAL = process.env.USE_AGONES !== 'true';


let AGONES_PORT = SERVER_PORT;
// Publiczny port przydzielony przez Agones (może różnić się od SERVER_PORT,
// bo Kubernetes robi NodePort mapping — zewnętrzny port ≠ wewnętrzny port poda).
/*
 * Publiczny port tego serwera gry — ten który KLIENT używa do połączenia.
 *
 * Dlaczego może różnić się od SERVER_PORT?
 *   Kubernetes NodePort: pod nasłuchuje na porcie 5000 (wewnętrzny)
 *   ale z zewnątrz dostępny jest pod portem 30000-32767 (NodePort, publiczny).
 *   Przykład:
 *     SERVER_PORT  = 5000   ← wewnętrzny port poda (uWS.listen(5000))
 *     AGONES_PORT  = 30542  ← zewnętrzny port węzła K8s (client → node:30542 → pod:5000)
 *
 *   Klient łączy się pod: ws://1.2.3.4:30542  (AGONES_IP:AGONES_PORT)
 *   NIE: ws://1.2.3.4:5000  (to wewnętrzny adres, niedostępny z internetu)
 *
 * Wartość jest aktualizowana w connectAgones() gdy Agones poda nam prawdziwy port.
 */


let AGONES_IP = process.env.PUBLIC_GAME_IP || (IS_LOCAL ? 'localhost' : '127.0.0.1');
/*
 * Publiczny adres IP węzła K8s na którym działa ten pod.
 *
 * W produkcji:
 *   Agones dostarcza adres przez gs.status.address → aktualizujemy AGONES_IP.
 *   Przykład: "34.89.123.45" 
 *
 * Fallback 127.0.0.1 (localhost):
 *   Używany przy lokalnym developmencie bez K8s — klient łączy się lokalnie.
 *   process.env.PUBLIC_GAME_IP można też ustawić ręcznie: PUBLIC_GAME_IP=192.168.1.5 node server.js
 */

 


// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA 8: REDIS + MONGODB
//
// ═══════════════════════════════════════════════════════════════════════════════

let redis_pub; // klient do zapisu i publishowania (hSet, expire, publish, sAdd, del, sRem)
let redis_sub; // klient DEDYKOWANY tylko do subscribe (protokół Redis wymaga osobnego klienta)
let db_users;   // MongoDB — bezpośredni zapis punktów graczy



// ─── Agones ───────────────────────────────────────────────────────────────────
/**
 * Łączy się z Agones SDK, pobiera przydzielony port i IP z metadanych GameServera,
 * zgłasza gotowość serwera (Ready) i rejestruje go w Redis.
 *
 * Ważna kolejność: connect() PRZED getGameServer() — SDK musi być gotowe.
 * ready() PO pobraniu danych — Agones wie, że serwer poprawnie się zainicjalizował.
 * redis_connect() NA KOŃCU — rejestrujemy dopiero gdy znamy ostateczny port i IP.
 */
async function connectAgones() {
    if (!USE_AGONES) {
        console.log('[LOCAL] Pomijam Agones, uruchamiam lokalnie na porcie', AGONES_PORT);
        await redis_connect(); //  rejestrujemy serwer w Redis
        console.log('[INFO] Serwer zarejestrowany jako:', AGONES_IP + ':' + AGONES_PORT);

        return;
    }


    // Na kubernetesie to ponizej sie uruchamia, a to wyzej bylo gdybysmy lokalnie odpalali serwer
    try {
         // Nawiązuje połączenie z "sidecar" kontenerem Agones.
        await agonesSDK.connect();
        console.log('Agones SDK połączone!');

        const gs = await agonesSDK.getGameServer();
        /*
         * Pobiera aktualny stan obiektu GameServer z Kubernetes API.
         *
         * Obiekt GameServer to zasób K8s (jak Pod, Service itp.) definiowany przez Agones.
         * Zawiera m.in.:
         *   gs.status.address      — publiczny IP węzła na którym działa pod
         *   gs.status.portsList    — lista przydzielonych portów [{ name, port }]
         *   gs.status.state        — "Ready", "Allocated", "Shutdown" itp.
         *   gs.metadata.name       — nazwa poda (np. "game-server-7f3a9b2")
         *
         * Używamy tylko port i IP — reszta nas na razie nie interesuje:
        // gs.status.portsList / gs.status.ports — lista przydzielonych portów.
        // gs.status.address — publiczne IP węzła, na którym działa pod.
         */


        const allocatedPorts = gs.status.portsList || gs.status.ports;
        /*
         * API Agones zmieniło nazwę pola w pewnej wersji:
         *   Stara wersja: gs.status.ports     (tablicowa, deprecated)
         *   Nowa wersja:  gs.status.portsList  (lista protobuf)
         *
         * || (OR) — spróbuj portsList najpierw, jeśli undefined/null → użyj ports.
         * Zapewnia kompatybilność z różnymi wersjami Agones w klastrze.
         */


        if (allocatedPorts && allocatedPorts.length > 0) {
            AGONES_PORT = allocatedPorts[0].port;
            /*
             * Bierzemy PIERWSZY port z listy.
             * Agones może przydzielić wiele portów (UDP, TCP) — my potrzebujemy tylko jednego (WebSocket = TCP).
             * [0] = pierwszy port z listy = port dla WebSocket.
             */
            console.log('Agones przydzielił publiczny port:', AGONES_PORT);
        } else {
            console.log('UWAGA: Nie znaleziono portu! Status:', JSON.stringify(gs.status));
                        /*
             * Brak portu = błąd konfiguracji GameServer YAML w K8s.
             * Serwer działa dalej z SERVER_PORT (domyślnym) — może działać w localdev.
             * W produkcji trzeba sprawdzić czy GameServer ma sekcję ports: w YAML.
             */
        }

        
        // ---  KOD DO POBRANIA IP ---
        if (gs.status.address) {
            AGONES_IP = gs.status.address;
            /*
             * Publiczne IP węzła K8s — klienci będą łączyć się pod ten adres.
             * Ważne: to IP WĘZŁA (maszyny wirtualnej), nie poda!
             * Pod ma prywatne IP (10.x.x.x) — niedostępne z internetu.
             */
            console.log('Agones przydzielił publiczne IP:', AGONES_IP);
        }
        // -------------------------------

        console.log("AGONES ")
        console.log(AGONES_IP)
        await agonesSDK.ready();
        /*
         * Sygnalizuje Agones że serwer jest GOTOWY do przyjęcia graczy.
         * Bez tego wywołania serwer pozostaje w stanie "Starting" i lobby go nie widzi.
         *
         * Dlaczego ready() TUTAJ, a nie na początku?
         *   Chcemy najpierw pobrać IP i port.
         *   Jeśli ready() byłoby pierwsze → lobby widzi serwer ale z błędnymi danymi połączenia.
         *   Gracze próbowaliby połączyć się pod zły adres → błąd połączenia.
         *
         * Po ready(): GameServer w K8s zmienia stan Starting → Ready.
         * Autoskaler Agones może teraz przydzielić ten serwer do gry.
         */

        console.log('Serwer zgłosił gotowość (Ready)!');

        health_interval = setInterval(() => {
            try { agonesSDK.health(); } catch (_) {}
            /*
             * Heartbeat (bicie serca) — wysyłamy sygnał "żyję" do Agones co 2 sekundy.
             *
             * Dlaczego to konieczne?
             *   Agones monitoruje czy serwer gry nie zawiesił się (deadlock, nieskończona pętla itp.).
             *   Jeśli przez ~30 sekund nie dostanie health() → uznaje serwer za martwy → restartuje pod.
             *   To "watchdog" mechanism — ochrona przed "zombie" procesami.
             *
             * try/catch:
             *   agonesSDK.health() może rzucić błąd jeśli sidecar chwilowo niedostępny.
             *   Ignorujemy błąd (catch(_)) — jeden pominięty heartbeat nie zabije serwera.
             *   _ = konwencja "nie obchodzi mnie ta wartość" (nazwa zmiennej którą ignorujemy).
             */
        }, 2000);  // co 2000ms = co 2 sekundy

      
        await redis_connect();
        /*
         * Teraz rejestrujemy serwer w Redis.
         * DLACZEGO na końcu, a nie na początku?
         *
         * Mamy już:
         *   ✓ AGONES_PORT — prawdziwy publiczny port (nie domyślny 5000)
         *   ✓ AGONES_IP   — prawdziwy publiczny IP węzła K8s
         *   ✓ Serwer w stanie Ready
         *
         * Gdybyśmy zarejestrowali wcześniej → lobby widziałoby serwer z błędnym IP/portem.
         * Gracze nie mogliby się połączyć a serwer widniałby w lobby.
         */
    } catch (error) {
        console.error('Błąd krytyczny łączenia z Agones:', error);
    }
}




connectAgones();
/*
 * Wywołujemy natychmiast przy starcie procesu.
 * Funkcja jest async → wraca od razu (Promise), nie blokuje.
 * Połączenie z Agones i Redis dzieje się "w tle" podczas gdy reszta kodu kontynuuje.
 * Dzięki temu serwer WebSocket może startować niezależnie od opóźnień sieci.
 */





// ═══════════════════════════════════════════════════════════════════════════════
//  ROZSZERZENIA Array.prototype
//  Wbudowane w tablicę metody pomocnicze — dostępne na każdej tablicy w kodzie.
// ═══════════════════════════════════════════════════════════════════════════════
//  Dodajemy dwie wygodne metody do KAŻDEJ tablicy w całym kodzie.
//  "Prototype" to mechanizm dziedziczenia JS — modyfikujemy "prototyp" (szablon)
//  klasy Array, więc nowe metody są dostępne na KAŻDEJ instancji tablicy.
//
//  Analogia: to jakbyś dodał metodę do klasy String — nagle wszystkie stringi
//  mają tę metodę. My robimy to samo dla Array.
/**
 * Dodaje element do tablicy TYLKO jeśli jeszcze w niej nie istnieje.
 * Przeszukuje od końca (i--) — szybsze gdy element jest zwykle na końcu.
 * @returns {boolean} true = dodano, false = już istniał (duplikat odrzucony)
 */
/**
 * Dodaje element TYLKO jeśli nie istnieje w tablicy (chroni przed duplikatami).
 *
 * Zastosowanie: czat (gracz nie może pojawić się 2× w liście wiadomości),
 *               listy zdarzeń (join/kill nie może pojawić się 2× dla tego samego gracza).
 *
 * @param {*} item  Dowolna wartość do dodania
 * @returns {boolean}  true = dodano (był nowy), false = już istniał (pominięto)
 */
Array.prototype.uniq_push = function (item) {
    for (let i = this.length; i--;) {
        // i-- zamiast i++ — przeszukiwanie wsteczne. Jeśli elementy są świeże (dodawane
        // na końcu), trafienie jest szybsze bez przeszukiwania całej tablicy od początku.

        if (item === this[i]) return false; // znaleziono duplikat — przerwij i odrzuć
        /*
         * === (triple equals) = ścisłe równość: sprawdza WARTOŚĆ i TYP.
         * np. 5 === "5" → false (różne typy)
         *     5 === 5   → true
         *
         * Dla obiektów: sprawdza czy to TEN SAM obiekt w pamięci (referencja).
         * np. player1 === player1 → true (ta sama referencja)
         *     player1 === player2 → false (różne obiekty, nawet jeśli mają te same dane)
         *
         * Znaleźliśmy duplikat → zwróć false (nie dodawaj)
         */
    }
    this.push(item); // element jest unikalny — dodaj na koniec
    return true;
};

/**
 * Usuwa PIERWSZE wystąpienie elementu z tablicy.
 *
 * Modyfikuje tablicę IN-PLACE (zmienia oryginalną, nie tworzy kopii).
 * Przesuwa pozostałe elementy w lewo (jak wyciągnięcie kartki ze środka stosu).
 *
 * @param {*} item  Element do usunięcia
 */
Array.prototype.rm_val = function(item) {
    const index = this.indexOf(item);
    if (index !== -1) this.splice(index, 1);
    // splice(index, 1) usuwa 1 element na pozycji index.
    // Przesuwa wszystkie późniejsze elementy o 1 w lewo — stąd O(n).

    /*
     * splice(index, deleteCount):
     *   index       = od którego miejsca zacząć usuwanie
     *   deleteCount = ile elementów usunąć (1 = usuń jeden element)
     *
     * Przykład:
     *   tablica = [a, b, c, d, e]
     *   splice(2, 1) → usuwa element na indeksie 2 → [a, b, d, e]
     *   Elementy d i e przesuwają się o 1 w lewo.
     *
     * Złożoność: O(n) — w najgorszym przypadku przesuwa wszystkie elementy.
     * Dla małych tablic (<100 elementów) całkowicie akceptowalne.
     */
};





// ═══════════════════════════════════════════════════════════════════════════════
//
//  GENERATOR UNIKALNEGO ID GRY
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Funkcja generująca losowe uint32 (liczba całkowita 0 – 4 294 967 295).
 *
 * Używana tylko do: game_id = unikalny identyfikator TEJ instancji serwera gry.
 * Nie używana do ID graczy — te są zarządzane przez pulę free_ids[].
 *
 * Mechanizm Uint32Array:
 *   Uint32Array to tablica liczb 32-bitowych bez znaku.
 *   Każde przypisanie do jej elementu automatycznie:
 *     - Obcina część ułamkową (float → int)
 *     - Clampuje do zakresu 0 – 4 294 967 295
 *
 *   Bez Uint32Array:
 *     let x = Math.random() * 0xffffffff;  → x = 3456789012.345  (float!)
 *   Z Uint32Array:
 *     arr[0] = Math.random() * 0xffffffff; → arr[0] = 3456789012 (czysty uint32)
 *
 * .bind(new Uint32Array(1)):
 *   bind() tworzy nową funkcję gdzie this = podany obiekt.
 *   new Uint32Array(1) → tablica [0] (jeden element, wartość 0)
 *   this w funkcji zawsze wskazuje na TĘ SAMĄ tablicę (stworzono raz, reużywana).
 *   Dlaczego to mądre? Unikamy alokacji nowej tablicy przy każdym wywołaniu gen_id().
 */
const gen_id = function() {
    this[0] = Math.random() * 0xffffffff;
    /*
     * 0xffffffff = 4 294 967 295 = 2³² - 1 = maksymalna wartość uint32
     *
     * Math.random() * 0xffffffff = losowy float z zakresu [0.0, 4 294 967 295.0)
     * Przypisanie do this[0] (Uint32Array) automatycznie konwertuje na uint32.
     */
    return this[0]; // zwróć czystą liczbę całkowitą
}.bind(new Uint32Array(1)); 
// .bind() na nowym Uint32Array — "this" w funkcji to zawsze ta sama tablica.





// ═══════════════════════════════════════════════════════════════════════════════
//
//  GLOBALNY STAN GRY
//
//  Wszystkie zmienne przechowujące aktualny stan serwera i rozgrywki.
//  Zmienne "let" (mogą się zmieniać) vs "const" (niezmienne po przypisaniu).
//
// ═══════════════════════════════════════════════════════════════════════════════

let frame              = 0;
/*
 * Licznik ticków (kroków symulacji) od momentu uruchomienia serwera.
 * Rośnie o 1 co 16ms → po 1 sekundzie frame = 62 lub 63.
 *
 * Używany jako "zegar gry" — zamiast osobnych setInterval dla różnych operacji:
 *   frame % 60 === 0   → co ~1 sekundę (co 60 ticków)
 *   frame % 10000 === 0 → co ~160 sekund (co 10000 ticków)
 *
 * Dlaczego nie Date.now()?
 *   Date.now() to wywołanie systemowe — wolniejsze niż inkrementacja zmiennej.
 *   Przy 62.5 wywołaniach na sekundę różnica jest mierzalna.
 *   frame++ to jedna instrukcja CPU.
 *
 * Czy może się przepełnić?
 *   frame to Number (float64 w JS) → max bezpieczna liczba całkowita = 2⁵³ = 9 007 199 254 740 992
 *   Przy 62.5/s: 9 007 199 254 740 992 / 62.5 = 144 115 188 075 855 872 sekund = ~4.5 miliarda lat
 *   Nie przepełni się nigdy w praktyce.
 */




let player_length      = 0;
/*
 * Liczba aktualnie POŁĄCZONYCH graczy (bez botów).
 *
 * Zarządzanie:
 *   open()  → player_length++  (gracz dołączył)
 *   close() → player_length--  (gracz odłączył się)
 *
 * Używana do:
 *   1. Redis: wysyłana co sekundę → lobby wyświetla "X/15 graczy"
 *   2. Logika Agones: player_length === 0 → wróć do stanu Ready
 *   3. Logika Agones: player_length === 1 → wywołaj allocate()
 *
 * WAŻNE: to NIE jest Object.keys(players).length !
 *   players{} zawiera też boty → keys().length = ludzie + boty
 *   player_length = tylko ludzie
 */


let send_ranking       = false;
/*
 * Flaga: "ranking się zmienił — wyślij top 6 wszystkim graczom w tej klatce".
 *
 * Ustawiana na true przez:
 *   - add_points() gdy gracz z top 6 zmienił byte_point
 *   - open() gdy nowy gracz dołącza (ranking ma nowego uczestnika)
 *   - close() gdy gracz z top 6 wychodzi
 *
 * Resetowana na false w gen_packet() po wysłaniu pakietu type 9.
 *
 * Dlaczego nie wysyłamy rankingu ZAWSZE co tick?
 *   Ranking zmienia się rzadko (punkty zmieniają się co kilka sekund).
 *   Wysyłanie co tick = marnowanie pasma internetowego na niezmienione dane.
 *   Flaga = wysyłamy TYLKO gdy coś się zmieniło = optymalizacja.
 */


let levels_sav         = 0;
// Liczba dotychczas wygenerowanych poziomów (inkrementowana po 100).
// gen_lvl() generuje levels[levels_sav .. levels_sav+99] i podnosi levels_sav o 100.
/*
 * Ile poziomów mapy zostało dotychczas wygenerowanych.
 *
 * gen_lvl() generuje 100 poziomów naraz i inkrementuje levels_sav o 100.
 * Przy starcie: 25 wywołań gen_lvl() → levels_sav = 2500 (poziomy 0–2499 gotowe).
 *
 * Używane w gen_lvl() by wiedzieć od którego indeksu zacząć:
 *   for (let l = 100; l--;) {
 *       const id = levels_sav + l;  ← indeks bezwzględny generowanego poziomu
 *   }
 */



let shutdown_timer     = null;
/*
 * Referencja do setTimeout dla opóźnionego zamknięcia serwera.
 * Mechanizm: gdy serwer się opróżnia → czekaj X sekund → jeśli nikt nie wrócił → zamknij.
 *
 * Aktualny status: infrastruktura jest, ale timer nie jest aktywnie uruchamiany
 * (zakomentowany kod w close()). Zachowane jako "hook" na przyszłe użycie.
 *
 * Gdy gracz dołączy zanim timer wystrzelił → clearTimeout(shutdown_timer).
 */



let is_allocated       = false;
/*
 * Czy ten serwer gry jest w stanie "Allocated" w Agones.
 *
 * Ready     = serwer pusty, czeka na graczy, autoskaler może go usunąć
 * Allocated = gracz dołączył, serwer "zajęty", autoskaler go nie ruszy
 *
 * Przejścia:
 *   false → true: pierwszy gracz dołącza (open()) → wywołujemy agonesSDK.allocate()
 *   true → false: ostatni gracz wychodzi (close()) → wywołujemy agonesSDK.ready()
 *
 * Dlaczego ta flaga?
 *   Bez niej wywoływalibyśmy allocate() / ready() przy KAŻDYM open()/close().
 *   allocate() przy drugim graczu = błąd (już Allocated).
 *   ready() gdy jeszcze są gracze = błąd logiczny.
 */


let is_shutting_down   = false;
/*
 * Flaga ustawiana przez handler SIGTERM.
 * Blokuje redis_update_player_count() żeby nie tworzyć nowych kluczy Redis
 * podczas gdy redis_cleanup() je usuwa (race condition protection).
 */
// Flaga ustawiana przez handler SIGTERM.
// Blokuje redis_update_player_count() — nie ma sensu aktualizować gdy zamykamy.


let game_loop_interval = null;
let health_interval    = null;
/*
 * Referencje do setInterval().
 * Zachowane na wypadek potrzeby clearInterval() przy zamykaniu.
 * Aktualnie nie wywołujemy clearInterval() (process.exit() to robi automatycznie).
 */


const game_id = gen_id();
/*
 * Unikalny identyfikator tej instancji serwera gry.
 * Losowy uint32 → 4 miliardy możliwości → praktycznie zerowe ryzyko kolizji
 * nawet przy dziesiątkach serwerów uruchomionych jednocześnie.
 *
 * Używany jako klucz Redis: game:<game_id>
 * Przykład: game:3482901234 → hash z g_port, g_players_len, serv_ip itp.
 */


const players = {};
/*
 * Główna mapa wszystkich obiektów gracza (ludzkich i botów).
 *
 * Struktura: { [id: number]: player_object }
 * Przykład:  { 0: {...}, 5: {...}, 23: {...}, 100: {...} }
 *
 * Dlaczego obiekt {} zamiast tablicy []?
 *   Tablica: players[0], players[1], players[2]... — dziury po usunięciu gracza
 *   Obiekt:  dla (const i in players) — iterujemy tylko istniejące klucze
 *
 *   Tablica z dziurami: players = [obj, null, null, obj, null, obj]
 *     → for (let i = 0; i < players.length; i++) — iterujemy null wartości
 *     → marnujemy czas na sprawdzanie nullów
 *
 *   Obiekt bez dziur: players = {0: obj, 3: obj, 5: obj}
 *     → for (const i in players) — tylko klucze które istnieją
 *     → brak marnowania na nullowe iteracje
 */


const ranking = [];
/*
 * Posortowana tablica uczestników rankingu.
 * ranking[0] = gracz z NAJWIĘKSZĄ liczbą punktów (lider).
 * ranking[ranking.length-1] = gracz z NAJMNIEJSZĄ.
 *
 * Sortowanie utrzymywane przez add_points() — bubble-sort przy każdej zmianie.
 * 
 * Sortowanie utrzymywane przez add_points() — bubble-sort jeden krok przy każdej zmianie.
 * Nie używamy Array.sort() bo: sort() = O(n log n), sortujemy po JEDNEJ zmianie.
 * Bubble-sort jeden krok = O(n) w najgorszym przypadku, O(1) gdy zmiana minimalna.
 *
 * Każdy gracz ma this.ranking_id = swój bieżący indeks w tej tablicy.
 * Gdy ranking się zmienia → aktualizujemy ranking_id wszystkich przesuniętych graczy.
 */

const tokens  = {};
/*
 * Mapa jednorazowych tokenów autoryzacji.
 * { [token_uuid: string]: { token, name, skin_id, account, timelive } }
 *
 * Przepływ tokenów:
 *   1. Gracz klika "Dołącz" w lobby
 *   2. Mother server (lobby) generuje UUID token i wysyła przez Redis pub/sub:
 *      redis.publish("join:<game_id>", JSON.stringify({token: "abc-123", name: "Kacper", ...}))
 *   3. Nasz child.js odbiera token → tokens["abc-123"] = {...}
 *   4. Gracz łączy się WebSocketem: ws://ip:port/abc-123
 *   5. upgrade() sprawdza have_token("abc-123") → OK → połączenie dozwolone
 *   6. open() zużywa token: delete tokens["abc-123"] → nie można użyć ponownie
 *
 * Dlaczego tak złożony flow zamiast np. hasła?
 *   Tokeny są jednorazowe → replay attacks niemożliwe
 *   Token ma krótki TTL → skradzione tokeny szybko wygasają
 *   Mother server kontroluje kto może dołączyć → autoryzacja scentralizowana
 */

const bots    = [];
/*
 * bots[]   — tablica obiektów Bot (maszyna stanów AI)
              Pętla gry iteruje bots[] żeby aktualizować AI, osobno iteruje players{} dla fizyki.
 */


const levels  = [];
/*
 * levels[] — tablica poziomów mapy: levels[id] = Uint8Array[128]
 *            levels[0] = poziom 0, levels[1] = poziom 1, itd.
 */
// Tablica poziomów: levels[id] = Uint8Array[128].
// Każdy element to kafelek cylindrycznej mapy:
//   0 = brak platformy   (wolna przestrzeń — gracz spada przez)
//   1 = bezpieczna platforma (zielona — resetuje event i jump_frame)
//   2 = śmiertelna platforma (czerwona — zabija lub odbiera event)
// Cylindr ma 128 "slotów" kołowo rozmieszczonych (indeks wrap-around & 0x7F).


const free_ids = [];
for (let i = MAX_FREE_IDS; i--;) free_ids.push(i);
// Pula wolnych ID graczy (0–254). Działamy jak stos (push/pop):
//   pop() przy tworzeniu gracza — pobierz dostępne ID.
//   push() przy usuwaniu gracza — zwróć ID do puli.
// Pętla: i zaczyna od 254, kończy na 0 → free_ids = [0, 1, 2, ..., 254] w odwrotnej kolejności.



// Kolejki (struktura danych) zdarzeń — zbierane przez cały tick, wysyłane razem w gen_packet() na końcu ticka
let joined_players       = []; // gracze którzy dołączyli w tej klatce → typ pakietu 1
let remove_players       = []; // gracze którzy odłączyli / umarli → typ pakietu 2
let killed_players       = []; // ID zabitych graczy → typ pakietu 5
let respawned_players    = []; // ID odrodzonych graczy → typ pakietu 6
let players_cheange_skin = []; // gracze którzy zmienili skin → typ pakietu 13
let chat_players         = []; // gracze z wiadomością czatu → typ pakietu 8
/*
 * Dlaczego kolejki zamiast natychmiastowego wysyłania?
 *
 * Wyobraź sobie że 5 graczy umiera w tym samym ticku.
 * Bez kolejki: wysyłamy 5 osobnych pakietów "gracz X umarł" do każdego klienta.
 * Z kolejką: zbieramy wszystkie zdarzenia → ONE pakiet "umarli gracze X, Y, Z, A, B".
 *
 * 5 oddzielnych pakietów vs 1 pakiet zbiorczy:
 *   - Mniej wywołań send() = mniej narzutu systemowego
 *   - Mniejsza fragmentacja TCP (jeden duży segment zamiast 5 małych)
 *   - Atomowość: klient dostaje wszystkie zdarzenia z jednego ticka razem
 *     (nie ma ryzyka że "gracz X umarł" dotrze w innym ticku niż "gracz X respawnął")
 */



const segment_player = [];
/*
 * MAPA PRZESTRZENNA — optymalizacja detekcji kolizji.
 *
 * Problem: sprawdzanie kolizji każdego gracza z każdym = O(n²) operacji.
 * Przy 52 obiektach (37 botów + 15 graczy): 52² = 2704 porównania co tick.
 * Przy 62.5 Hz: 2704 × 62.5 = 169 000 porównań/sekundę.
 *
 * Rozwiązanie: podziel mapę na "segmenty" (piętra cylindra).
 * Gracze na poziomie 5 nie mogą kolidować z graczami na poziomie 50.
 * Sprawdzamy kolizje tylko z graczami w segmentach (lvl-1) i (lvl).
 *
 * Struktura:
 *   segment_player[0] = [gracz A, bot B, bot C]  ← gracze na poziomie 0
 *   segment_player[1] = [bot D, gracz E]          ← gracze na poziomie 1
 *   segment_player[5] = [bot F]                   ← gracze na poziomie 5
 *   segment_player[6] = undefined                 ← pusty poziom
 *
 * Złożoność po optymalizacji:
 *   Każdy gracz sprawdza tylko 2 segmenty × średnio ~2 graczy/segment = 4 porównania.
 *   52 graczy × 4 = 208 porównań vs 2704 bez optymalizacji.
 *   13× szybciej!
 */
// Mapa przestrzenna: segment_player[poziom] = tablica graczy na tym poziomie.
// Optymalizacja kolizji — zamiast sprawdzać N² par, sprawdzamy tylko graczy
// w segmencie (poziom-1) i (poziom) — zazwyczaj kilku graczy, nie kilkudziesięciu.


const p = new packet_set(5000);
/*
 * Globalny bufor do budowania pakietów wychodzących.
 * Tworzony RAZ przy starcie, reużywany co tick (nie alokujemy nowej pamięci co 16ms).
 *
 * 5000 bajtów = ~5 KB. Dlaczego ta wartość?
 *   Globalna część (wspólna dla wszystkich): ~200-500B (join, kill, chat, ranking)
 *   Per-player część: ~200-400B (pozycje widocznych graczy + indywidualne zdarzenia)
 *   5000B z zapasem na edge case (np. dużo graczy w zasięgu widoczności).
 *
 * Uwaga: p jest zmienną globalną, ALE w message() jest LOKALNE p:
 *   const p = data.pg.set_buffer(message);  ← lokalna zmienna, przesłania globalną
 *   To jest celowe — parsowanie wiadomości klienta używa osobnego bufora.
 */
// Globalny bufor wychodzący, reużywany co tick (unikamy alokacji co 16ms).
// 5000 bajtów = max rozmiar pakietu globalnego + wszystkich pakietów per-player.
// packet_set trzyma wewnętrznie Uint8Array i pozycję (index) zapisu.


// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA 8: REDIS + MONGODB
//
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Inicjalizuje połączenie Redis i MongoDB, rejestruje serwer w Redis
 * i subskrybuje kanał tokenów graczy.
 */
async function redis_connect() {
    redis_pub = createClient({ url: REDIS_URL });
    redis_sub = createClient({ url: REDIS_URL });
    /*
     * Dlaczego DWA klienty Redis zamiast jednego?
     *
     * Protokół Redis ma ograniczenie: gdy klient wywołuje SUBSCRIBE lub PSUBSCRIBE,
     * wchodzi w "subscriber mode" i może TYLKO:
     *   - odbierać wiadomości (subscribe, unsubscribe, message)
     *   - nic innego! (nie może robić GET, SET, HSET itp.)
     *
     * Rozwiązanie: dwa osobne połączenia TCP:
     *   redis_pub — normalne operacje (zapis, publish, expire...)
     *   redis_sub — TYLKO nasłuchiwanie (subscribe + odbieranie wiadomości)
     *
     * To standardowy wzorzec — każda biblioteka Redis wymaga tego.
     */

    redis_pub.on('error', err => console.error('Redis pub error:', err));
    redis_sub.on('error', err => console.error('Redis sub error:', err));
    /*
     * Rejestracja globalnych handlerów błędów połączenia.
     *
     * WAŻNE: bez tych linii, błąd Redis (np. serwer chwilowo niedostępny)
     * spowodowałby "unhandled error event" w Node.js → CRASH całego procesu serwera gry!
     *
     * Z handlerami: błąd jest logowany, ale serwer działa dalej.
     * Redis client automatycznie próbuje się ponownie połączyć (retry logic wbudowana w bibliotekę).
     */
    

    await redis_pub.connect();
    await redis_sub.connect();
    /*
     * await = czekaj aż TCP handshake z Redis zostanie zakończony zanim przejdziesz dalej.
     * Bez await: następne hSet() mogłoby się wywołać zanim połączenie gotowe → błąd.
     */


    const mongoClient = await MongoClient.connect(MONGO_URL);
    db_users = mongoClient.db('gra').collection('users');
    /*
     * Łączymy z MongoDB i od razu pobieramy referencję do kolekcji.
     * Trzymamy db_users jako stałą referencję — nie potrzeba reconnektować przy każdym zapisie.
     *
     * db('gra')           — wybierz bazę danych o nazwie 'gra' 
     * .collection('users') — wybierz kolekcję 'users' w tej bazie
     *                        Odpowiednik tabeli SQL, ale bez schematu
     *
     * Format dokumentu gracza w MongoDB:
     *   {
     *     _id: ObjectId("507f1f77bcf86cd799439011"),  ← unikalny ID
     *     username: "Kacper",
     *     points: 15000,                              ← aktualna waluta
     *     total_points: 45000,                        ← łącznie zarobione (nigdy nie maleje)
     *     skin_id: 3,
     *     ...inne pola
     *   }
     */
    // db('gra') — nazwa bazy danych projektu
    // collection('users') — kolekcja z dokumentami graczy




    // Rejestracja serwera w Redis (hash "game:<id>")
    // Wszystkie wartości jako string — redis hSet wymaga string dla wartości hash.
    await redis_pub.hSet(`game:${game_id}`, {
        g_port:        AGONES_PORT.toString(),  // port do połączenia WebSocket
        g_players_len: "0",                     // aktualnie 0 graczy (właśnie startujemy)
        g_players_lim: MAX_PLAYERS.toString(),  // limit graczy — lobby nie przekroczy tego
        serv_ip:       AGONES_IP,               // publiczne IP węzła K8s
        serv_loc:      COUNTRY,                 // region (EU/US) — do filtrowania w lobby
        serv_name:     SERVER_NAME,             // czytelna nazwa (np. "EU-Phantom")
    });
    /*
     * Tworzenie hash mapy w Redis z danymi tego serwera.
     *
     * HSET (Hash SET) — Redis hash to kolekcja par klucz-wartość.
     * Analogia: jeden rekord w tabeli SQL, lub jeden obiekt JSON.
     *
     * Klucz Redis: "game:<game_id>" np. "game:3482901234"
     * Pola:
     *   g_port        — zewnętrzny port WebSocket (klienci łączą się pod ten port)
     *   g_players_len — aktualna liczba graczy (aktualizowana co sekundę)
     *   g_players_lim — limit graczy (lobby sprawdza czy len < lim przed wysłaniem gracza)
     *   serv_ip       — IP do połączenia
     *   serv_loc      — region (EU/US) — filtr w lobby
     *   serv_name     — czytelna nazwa (EU-Phantom)
     *
     * Dlaczego .toString()?
     *   AGONES_PORT to number (np. 30542).
     *   Redis hSet wymaga string jako wartości.
     *   Bez toString() → TypeError lub nieprzewidywalne zachowanie zależne od wersji biblioteki.
     *
     * Template literal `game:${game_id}`:
     *   JavaScript interpolacja stringów — game_id wstawiany bezpośrednio.
     *   Odpowiednik "game:" + game_id.toString()
     */





    await redis_pub.expire(`game:${game_id}`, 5); 
    // Klucz wygasa po 5 sekundach jeśli nikt go nie odnowi.
    // redis_update_player_count() odnawia go co ~1 sekundę (co 60 ticków).
    // Mechanizm "dead man's switch" — gdy serwer crashnie bez SIGTERM,
    // klucz sam zniknie z Redis po max 5 sekundach. Lobby nie pokaże martwego serwera.
    /*
     * Ustawia czas wygaśnięcia (TTL = Time To Live) klucza na 5 sekund.
     *
     * MECHANIZM "DEAD MAN'S SWITCH":
     *
     *   Wyobraź sobie że serwer gry crashuje (segfault, out of memory, bug):
     *   - Proces umiera natychmiast — bez SIGTERM, bez cleanup
     *   - Klucz "game:XYZ" zostaje w Redis na zawsze (Redis nie wie że serwer umarł)
     *   - Lobby dalej pokazuje martwy serwer graczom
     *   - Gracze próbują się połączyć → "połączenie odrzucone"
     *
     *   Z TTL 5 sekund:
     *   - Serwer crashuje
     *   - redis_update_player_count() przestaje się wywoływać (serwer martwy)
     *   - Po max 5 sekundach klucz automatycznie znika z Redis
     *   - Lobby na następnym odświeżeniu nie widzi serwera
     *
     *   redis_update_player_count() wywołuje expire() co ~1 sekundę.
     *   TTL jest "odnawiany" co sekundę przy żywym serwerze.
     *   5 sekund = bezpieczny bufor × 5 (gdyby jeden heartbeat się spóźnił).
     */



    await redis_pub.sAdd('game_ids', game_id.toString());
    // Dodaj ID gry do globalnego Setu z aktywymi grami.
    // Lobby iteruje ten Set żeby znaleźć dostępne serwery.
    /*
     * SADD (Set ADD) — dodaj element do Redis Set (zbioru unikalnych wartości).
     * 'game_ids' — Set zawierający ID wszystkich aktywnych serwerów gier.
     *
     * Lobby używa tego:
     *   const ids = await redis.sMembers('game_ids');  ← pobierz wszystkie ID
     *   for (const id of ids) {
     *     const data = await redis.hGetAll(`game:${id}`);  ← pobierz dane każdego
     *     servers.push(data);
     *   }
     *
     * Dlaczego Set a nie np. lista wszystkich kluczy "game:*"?
     *   SCAN/KEYS 'game:*' w Redis skanuje całą bazę → wolne przy dużej liczbie kluczy.
     *   Set members w O(n) gdzie n = liczba aktywnych serwerów (zwykle < 100) → szybsze.
     */



    await redis_pub.publish('lobby_update', '1');
    // Powiadom wszystkie lobby-serwery że pojawił się nowy serwer.
    // '1' to dowolna wartość — sam sygnał (publish) wystarcza
    /*
     * PUBLISH — wysyła wiadomość do wszystkich klientów subskrybujących kanał 'lobby_update'.
     *
     * Lobby-serwery subskrybują ten kanał:
     *   redis_sub.subscribe('lobby_update', () => {
     *     // odśwież listę serwerów gier w UI
     *     refreshServerList();
     *   });
     *
     * Wiadomość '1' = dowolna wartość (nie ma znaczenia, sam fakt wysłania to sygnał).
     *
     * Bez tego: lobby odświeżałoby listę tylko periodycznie (np. co 5 sekund) → opóźnienie.
     * Z publishem: lobby od razu wie o nowym serwerze → UI aktualizuje się natychmiast.
     */






    await redis_sub.subscribe(`join:${game_id}`, (message) => {
        // Subskrybuj kanał "join:<game_id>" — mother server wysyła tu tokeny
        // gdy gracz kliknie "Dołącz" na tym serwerze.
        /*
         * Subskrybuj kanał "join:<game_id>" — dedykowany kanał dla tokenów tego serwera.
         *
         * Każdy serwer gry ma SWÓJ kanał: join:3482901234, join:1234567890 itp.
         * Mother server (lobby) wie z którym serwerem gracz chce się połączyć
         * i wysyła token na właściwy kanał.
         *
         * Callback wywoływany ASYNCHRONICZNIE gdy dotrze wiadomość.
         * message = string JSON wysłany przez mother server.
         */

        console.log('[REDIS] Otrzymano wiadomość na join:', game_id, '→', message);
        try {

            const data = JSON.parse(message);
            // Zapis tokena — WebSocket upgrade sprawdzi czy token istnieje
            /*
             * JSON.parse() konwertuje string JSON na obiekt JavaScript.
             * '{"token":"abc","name":"Kacper","skin_id":3,"account":"507f..."}' → obiekt
             *
             * Owinięte w try/catch bo JSON.parse() rzuca SyntaxError dla nieprawidłowego JSON.
             * Np. gdyby mother server wysłał błędnie sformatowaną wiadomość.
             */


            tokens[data.token] = {
                token:    data.token,
                name:     data.name,
                skin_id:  data.skin_id,
                account:  data.account,  // MongoDB ObjectId string gracza
                timelive: frame + 10000,
                // Token ważny przez 10000 ticków od teraz.
                // 10000 * 16ms = 160 sekund — wystarczy na połączenie WebSocket.
                // Stare tokeny czyszczone w pętli gry co 10000 ticków.
                /*
                 * timelive = "żyj do tej klatki".
                 * Token jest ważny przez 10000 ticków od teraz.
                 * 10000 × 16ms = 160 sekund = 2 minuty i 40 sekund.
                 *
                 * Dlaczego 160 sekund?
                 *   Gracz kliknął "Dołącz" → przeglądarka musi nawiązać połączenie WebSocket.
                 *   Na słabym połączeniu może to trwać kilka sekund.
                 *   160s to bardzo hojny bufor.
                 *
                 * Czyszczenie: pętla gry co 10000 ticków usuwa tokeny gdzie timelive < frame.
                 */

            };
            console.log('Token otrzymany dla gracza:', data.name);
        } catch (e) {
            console.error('Błąd parsowania join message:', e);
        }
    });

    console.log('Gra zarejestrowana w Redis, id:', game_id, 'port:', AGONES_PORT);
}





/**
 * Usuwa ten serwer gry z Redis i powiadamia lobby (SIGTERM lub opustoszały serwer)
 */
async function redis_cleanup() {
    if (!redis_pub) return;
    /*
     * Jeśli redis_pub jest undefined/null — Redis nigdy nie połączył się (np. błąd startowy).
     * Nie ma co czyścić — wyjdź natychmiast.
     */


    try {
        await redis_pub.del(`game:${game_id}`);
        /*
         * DEL — usuwa klucz z Redis (hash "game:<id>" znika natychmiast, nie czeka na TTL).
         * Lobby natychmiast przestaje widzieć ten serwer.
         */


        await redis_pub.sRem('game_ids', game_id.toString());
        /*
         * SREM (Set REMove) — usuwa element ze zbioru 'game_ids'.
         * Bez tego lobby dalej iterowałoby przez stary ID i próbowało pobrać
         * dane hash które już nie istnieją (del powyżej usunął je) → null → puste pole.
         */


        await redis_pub.publish('lobby_update', '1');
        // Powiadom lobby że lista serwerów się zmieniła → odśwież UI.


        console.log('Gra usunięta z Redis:', game_id);
    } catch (e) {
        console.error('Błąd redis_cleanup:', e);
    }
}

// Aktualizuje licznik graczy w Redis 
/**
 * Aktualizuje liczbę graczy w Redis i "odnawia" TTL (czas zycia) klucza (heartbeat).
 * Wywoływana co ~60 ticków (~1 sekundę).
 */
function redis_update_player_count() {
if (!redis_pub || is_shutting_down) return;
   /*
     * Dwa warunki pominięcia:
     *   !redis_pub        → Redis niepołączony → nie ma gdzie zapisywać
     *   is_shutting_down  → SIGTERM w trakcie → redis_cleanup() zamyka serwer, my nie przeszkadzamy
     */
    // Jeśli Redis niepołączony lub zamykamy serwer → pomiń.



    // Aktualizujemy liczbę graczy i odnawiamy ważność klucza na 5 sekund
    /*
     * Aktualizuj tylko JEDNO pole hash (g_players_len) — reszta (IP, port, limit) się nie zmienia.
     * .toString() wymagane bo Redis hSet przyjmuje string jako wartość.
     */
    redis_pub.hSet(`game:${game_id}`, 'g_players_len', player_length.toString())
        .then(() => redis_pub.expire(`game:${game_id}`, 5)) // <-- NOWE: Bicie serca
        /*
         * 2) Odnów TTL: klucz wygaśnie za 5 sekund jeśli serwer przestanie heartbeatować.
         * .then() = "gdy hSet się zakończy, WTEDY wywołaj expire".
         * Sekwencja jest ważna — nie ma sensu odnawiać TTL przed aktualizacją licznika.
         * 
         *  Jeśli serwer crashnie, klucz wygaśnie sam po max 5 sekundach.
         */

        .then(() => redis_pub.publish('lobby_update', '1'))
        // 3) Powiadom lobby o zmianie liczby graczy → aktualizacja UI w czasie rzeczywistym.

        .catch(console.error);
}





/**
 * Zapisuje punkty gracza do MongoDB używając $inc (inkrementacja, nie nadpisanie).
 * Wywoływana przy: śmierci gracza, rozłączeniu, respawnie.

 * $inc zamiast $set — kilka serwerów może jednocześnie dodawać punkty temu samemu kontu.
 * $set nadpisałby niezależne zapisy. $inc jest atomowy i bezpieczny współbieżnie.
 *
 * @param {object|string} token_or_account - obiekt tokena LUB string z MongoDB ObjectId
 * @param {number}        money            - Ile punktów dodać do konta (ignorowane jeśli <= 0)
 */
// Zapisuje punkty gracza bezpośrednio do MongoDB
function save_player_money(token_or_account, money) {
    if (money <= 0 || !db_users) return;
    /*
     * money <= 0: nic do zapisania. Może się zdarzyć gdy gracz umiera bez punktów
     *             (np. nowy gracz który jeszcze nic nie zarobił).
     * !db_users:  MongoDB niepołączone (błąd startowy) → nie próbujemy zapisać.
     */

    let accountStr = '';
    if (typeof token_or_account === 'object' && token_or_account !== null) {
        // przekazano token object
        accountStr = token_or_account.account || '';
        // Przekazano obiekt gracza (player.account = MongoDB ObjectId string)
        /*
         * Przekazano obiekt gracza (player). Pobieramy pole .account (MongoDB ObjectId string).
         * || '' — jeśli account nie ustawiony (gracz-gość) → pusty string
         */


    } else {
        accountStr = token_or_account || '';
        /*
         * Przekazano string bezpośrednio (np. wyciągnięty wcześniej z obiektu).
         * || '' — zabezpieczenie na wypadek null/undefined.
         */

    }


    if (!accountStr) return;
    // Gracze-goście (nie zalogowani) mają account = '' — nie zapisuj ich punktów.
    /*
     * Pusty string = gracz-gość (nie zalogowany, brak konta w MongoDB).
     * Nie ma gdzie zapisać punktów → wyjdź bez błędu.
     */



    try {
        db_users.updateOne(
            { _id: new ObjectId(accountStr) },
            /*
             * Filtr: znajdź dokument gdzie _id = ten ObjectId.
             * new ObjectId("507f1f...") konwertuje string → binarny BSON ObjectId.
             *
             * WAŻNE: MongoDB przechowuje _id jako ObjectId, nie jako string.
             * Gdybyśmy napisali { _id: accountStr } (string) → MongoDB szuka dokumentu
             * gdzie _id jest STRINGIEM "507f1f..." → nie znajdzie nic!
             * Musimy konwertować string → ObjectId.
             */



            { $inc: { points: money, total_points: money } }
            // $inc atomowo zwiększa oba pola o "money".
            // points      — aktualna waluta (może być wydana, cena w sklepie odejmiie)
            // total_points — całkowite zarobione punkty (nigdy nie maleje — do statystyk/rankingów)



        ).catch(console.error);
        // .catch — updateOne zwraca Promise. Błędy (np. nieprawidłowy ObjectId) logujemy.

    } catch (e) {
        console.error('save_player_money error:', e);
        // new ObjectId() może rzucić wyjątek dla nieprawidłowego stringa — łapiemy go tutaj.

    }
}




// ═══════════════════════════════════════════════════════════════════════════════
//
//  MAPA GRY — zarządzanie segmentami
//
//  Cylinder gry jest podzielony na "segmenty" (piętra).
//
//  Optymalizacja: zamiast sprawdzać kolizje N² (każdy z każdym),
//  Każdy gracz jest przypisany do jednego 'segmentu' (piętra mapy) przez this.lvl.
//  Kolizje sprawdzamy TYLKO między graczami w tym samym lub sąsiednim segmencie.
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Dodaje gracza do listy graczy na podanym segmencie (poziomie).
 * Wywoływana gdy: gracz startuje (lvl=0), bot się tworzy, gracz awansuje na wyższy poziom.
 */
/**
 * Dodaje gracza do listy graczy na danym poziomie.
 * @param {object} player - referencja do obiektu Player
 * @param {number} level  - indeks segmentu (= player.lvl)
 */
function add_player_seg(player, level) {
    if (segment_player[level]) {
        segment_player[level].push(player);
        // Segment już istnieje — dołącz gracza
        /*
         * Segment już istnieje (jest już jakiś gracz na tym poziomie).
         * Dołącz nowego na koniec listy.
         */
    } else {
        segment_player[level] = [player];
        // Pierwszy gracz na tym poziomie — utwórz nową tablicę
        /*
         * Pierwszy gracz na tym poziomie — utwórz nową tablicę z jednym elementem.
         * Dlaczego nie segment_player[level] = []; segment_player[level].push(player)?
         * Krócej i tak samo poprawnie.
         */
    }
}



/**
 * Usuwa gracza z listy graczy na podanym segmencie.
 * Wywoływana gdy: gracz awansuje na głębszy poziom, gracz ginie, gracz wychodzi.
 */
/**
 * Usuwa gracza z listy graczy na danym poziomie.
 * Wywoływane gdy gracz awansuje na wyższy poziom lub ginie.
 * @param {object} player - referencja do obiektu Player
 * @param {number} level  - indeks segmentu, z którego usuwamy
 */
function rmv_player_seg(player, level) {
    if (!segment_player[level]) return;
    /*
     * Segment może nie istnieć jeśli wszyscy gracze już z niego wyszli.
     * Bez tej ochrony: segment_player[level].length → TypeError: Cannot read property 'length' of undefined
     */


    const arr = segment_player[level];
    for (let i = arr.length; i--;) {
        /*
         * Szukamy gracza od KOŃCA tablicy.
         * Gracze dodawani są na koniec (push) → ostatnio dodany szukany od tyłu = szybko.
         */
        // Przeszukiwanie wsteczne — gracze niedawno dodani są na końcu,
        // więc trafienie następuje szybciej.

    
        if (arr[i] === player) {
            arr.splice(i, 1); // usuń 1 element na pozycji i
            break;          
            /*
             * Przerywamy po znalezieniu — gracz jest UNIKALNY w segmencie
             * (add_player_seg nigdy nie doda dwa razy tego samego gracza).
             * Bez break: kontynuowalibyśmy szukanie aż do końca tablicy (zbędna praca).
             */

        }
    }
}


// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: DETEKCJA KOLIZJI
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Sprawdza czy dwa kołowe "hitboxy" na siebie nachodzą.
 *
 * Matematyka:
 *   Dwa okręgi kolidują gdy odległość między środkami ≤ suma promieni.
 *   Klasyczna formuła: sqrt(dx² + dy²) ≤ r1 + r2
 *
 * Optymalizacja (unikanie pierwiastka):
 *   Obie strony nierówności podnosimy do kwadratu (obie są ≥ 0, więc wynik poprawny):
 *   dx² + dy² ≤ (r1 + r2)²
 *
 *   Dlaczego to ważne?
 *   sqrt() jest jedną z NAJWOLNIEJSZYCH operacji matematycznych na CPU.
 *   Jest wywoływana przy każdej parze graczy co tick.
 *   Unikając sqrt() przy każdej kolizji: ~10× szybsza detekcja.
 *
 * @param {number} ax  Pozycja X obiektu A (środek)
 * @param {number} ay  Pozycja Y obiektu A (środek)
 * @param {number} ar  Promień obiektu A
 * @param {number} bx  Pozycja X obiektu B
 * @param {number} by  Pozycja Y obiektu B
 * @param {number} br  Promień obiektu B
 * @returns {boolean}  true = kolizja (nachodzą na siebie)
 */
/**
 * Sprawdza kolizję dwóch okręgów bez pierwiastka (10× szybsze niż sqrt).
 *
 * Klasyczna detekcja: sqrt(dx²+dy²) ≤ r1+r2
 * Optymalizacja:       dx²+dy² ≤ (r1+r2)²
 * Obie strony są ≥ 0, więc podniesienie do kwadratu nie zmienia wyniku porównania.
 *
 * @param {number} ax, ay - środek obiektu A
 * @param {number} ar     - promień obiektu A
 * @param {number} bx, by - środek obiektu B
 * @param {number} br     - promień obiektu B
 * @returns {boolean} true jeśli okręgi nakładają się
 */
function is_colid(ax, ay, ar, bx, by, br) {
    const dx = ax - bx;     // różnica X (może być ujemna)
    const dy = ay - by;     // różnica Y (może być ujemna)
    const r  = ar + br;     // suma promieni = minimalna odległość bez kolizji
    return dx * dx + dy * dy <= r * r;
    // Lewa strona: dystans² między środkami
    // Prawa strona: (r1+r2)² = maksymalny dystans² przy którym jeszcze kolidują

    /*
     * Lewa strona:  dx² + dy² = kwadrat odległości między środkami
     * Prawa strona: r² = kwadrat sumy promieni
     *
     * Przykład:
     *   Gracz A: x=100, r=11
     *   Gracz B: x=118, r=11
     *   dx = 100-118 = -18, dy = 0
     *   dx²+dy² = 324+0 = 324
     *   r = 11+11 = 22, r² = 484
     *   324 ≤ 484 → TRUE → kolizja! (gracze nachodzą o 22-18=4 jednostki)
     */
}




// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA : GENERATORY POZYCJI I LICZB LOSOWYCH
//
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Generuje bezpieczną pozycję X spawnu na cylindrze.
 *
 * Cylindryczna mapa:
 *   128 kafelków rozmieszczonych w kółko (jak tarcza zegara ale z 128 pozycjami).
 *   Każdy kafelek ma "szerokość" 8 jednostek (0–1023 pozycji X / 8 = 128 kafelków).
 *
 *   Pozycja X: 0–1023 (10-bitowa, cylinder jest "owinięty" — 1023+1 = 0)
 *   Indeks kafelka: x >> 3 = x / 8 (0–127)
 *
 * Zakazane strefy spawnu:
 *   Checkpointy (okrągłe poziomy) mają DZIURY w 3 miejscach:
 *     Kafelki 0–2:   przejście 1 (indeksy 0,1,2)
 *     Kafelki 42–44: przejście 2 (indeksy 42,43,44)
 *     Kafelki 84–86: przejście 3 (indeksy 84,85,86)
 *
 *   Gdyby gracz spawnował na kafelku 0 → od razu wpadłby w dziurę → natychmiastowa śmierć.
 *   Używamy trochę szerszych stref wykluczenia (0–3, 41–46, 83–88) dla bezpieczeństwa.
 *
 * Dlaczego rekurencja zamiast pętli while?
 *   Semantycznie to samo, ale rekurencja jest krótsza w zapisie.
 *   Ryzyko stack overflow: ~17/128 ≈ 13% szans na trafienie w strefę.
 *   Prawdopodobieństwo 10 kolizji z rzędu: 0.13^10 ≈ 0.0000001% → pomijalnie małe.
 */

/**
 * Generuje bezpieczną pozycję X spawnu na cylindrze (0–1023).
 *
 * Cylinder ma 128 kafelków (0–127), każdy kafelek to 8 jednostek szerokości.
 * Pozycja X (0–1023) mapuje się na kafelek: kafelek = x >> 3 (czyli x / 8).
 *
 * Wykluczone indeksy kafelków: 0–3, 41–46, 83–88
 * To miejsca gdzie checkpoint-poziomy mają dziury (przejścia do kolejnej sekcji).
 * Gdyby gracz spawnował tam — od razu wpadłby w dziurę i zginął.
 *
 * Rekurencja zamiast pętli while — krótszy kod, taka sama semantyka.
 * Ryzyko stack overflow: ~1.17% szans na trafienie w strefę wykluczoną → ~17 stref z 128.
 * Prawdopodobieństwo głębokiej rekurencji jest pomijalnie małe.
 *
 * @returns {number} pozycja X (10-bitowa, 0–1023)
 */
function random_pos() {
    let r     = (Math.random() * 0x3ff) | 0;
    /*
     * 0x3ff = 1023 (hexadecymalnie)
     * Math.random() * 0x3ff → float z zakresu [0.0, 1022.99...)
     * | 0 (bitowy OR z zerem) → obcięcie części ułamkowej → int 0–1022
     *
     * | 0 jako szybki Math.floor():
     *   Math.floor() to wywołanie funkcji (overhead)
     *   | 0 to jedna instrukcja CPU (bitwise OR)
     *   Dla >= 0 wynik identyczny: Math.floor(14.7) = 14, 14.7 | 0 = 14
     *   UWAGA: dla ujemnych różni się! -14.7 | 0 = -14, Math.floor(-14.7) = -15
     *   Tu zawsze dodatnie, więc bezpieczne.
     */

    r        &= 0x3ff;
    // & 0x3ff = & 1023 → maskowanie do 10 bitów (0–1023).
    // Tu technicznie zbędne (już jesteśmy 0–1022), ale zostawione dla bezpieczeństwa.


    const ind = r >> 3;
    /*
     * >> 3 = przesunięcie bitowe w prawo o 3 pozycje = dzielenie przez 2³ = przez 8.
     *
     * Dlaczego działa:
     *   8 = 2³, więc dzielenie przez 8 = usunięcie 3 najmniej znaczących bitów.
     *   r = 100 = 0b1100100 → >> 3 → 0b1100 = 12 (indeks kafelka 12)
     *   r = 107 = 0b1101011 → >> 3 → 0b1101 = 13 (indeks kafelka 13)
     *   r = 108 = 0b1101100 → >> 3 → 0b1101 = 13 (ten sam kafelek)
     *
     * Efekt: 8 kolejnych pozycji X (100–107) mapuje się na jeden kafelek (12).
     * Każdy kafelek "pokrywa" 8 jednostek szerokości cylindra.
     */


    if (ind < 4 || (ind >= 41 && ind <= 46) || (ind >= 83 && ind <= 88)) {
        return random_pos(); // trafiliśmy w zakazaną strefę — spróbuj ponownie
        /*
         * Trafiliśmy w zakazaną strefę → wywołaj siebie rekurencyjnie.
         * Nowe Math.random() da inną pozycję.
         */
    }
    return r; // bezpieczna pozycja — zwróć
}




/**
 * Losuje liczbę całkowitą z zakresu [minv, maxv).
 * Nie używa modulo na dużym float — zamiast tego maskuje do 24 bitów.
 *
 * Dlaczego nie Math.floor(Math.random() * (maxv-minv)) + minv?
 * Operacje bitowe są szybsze na silnikach JS niż Math.floor + mnożenie.
 * 0xffffff = 16 777 215 → wystarczy dla typowych zakresów w grze.
 *
 * @param {number} minv - minimum (włącznie)
 * @param {number} maxv - maksimum (wyłącznie)
 * @returns {number} losowa liczba całkowita z zakresu [minv, maxv)
 */
function rnd(minv, maxv) {
    if (maxv < minv) return 0; // nieprawidłowy zakres — zwróć 0 zamiast NaN/Infinity

    return (((Math.random() * 0xffffff) | 0) % (maxv - minv)) + minv;
    // Math.random() * 0xffffff → float 0–16 777 214
    // | 0                      → int (obcięcie dziesiętnych)
    // % (maxv - minv)          → redukcja do zakresu 0 do (maxv-minv-1)
    // + minv                   → przesunięcie do [minv, maxv)
}







// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: GENERATOR NAZW BOTÓW
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generuje losową nazwę brzmiącą jak prawdziwy nick/imię.
 *
 * Problem: całkowicie losowe nazwy ("xrtqmz", "bfgkp") wyglądają sztucznie.
 * Rozwiązanie: naprzemienne samogłoski i spółgłoski z kontrolą sekwencji.
 *
 * Przykładowe wyniki: "Karim", "Belvox", "Trauna", "Stikar", "Ovimel"
 *
 * @param {number} minlength  Minimalna liczba znaków
 * @param {number} maxlength  Maksymalna liczba znaków
 * @returns {string}          Losowa nazwa
 */
function getName(minlength, maxlength) {
    const vocals = 'aeiouyhaeiouaeiou';
    /*
     * String samogłosek z POWTÓRZENIAMI — to nie błąd!
     *
     * Efekt powtórzeń na prawdopodobieństwo:
     *   a: 3 wystąpienia / 17 znaków = 17.6% szans na wylosowanie 'a'
     *   e: 3/17 = 17.6%
     *   i: 2/17 = 11.8%
     *   o: 2/17 = 11.8%
     *   u: 2/17 = 11.8%
     *   y: 1/17 = 5.9%
     *   h: 1/17 = 5.9%
     *
     * Dlaczego 'h' w samogłoskach?
     *   'h' często towarzyszy samogłoskom w imionach (Khatarina, Rhema).
     *   Traktowanie go jak samogłoski daje naturalniejsze wyniki.
     *   Nie zwiększa licznika consnum.
     */

    const cons = 'bcdfghjklmnpqrstvwxzbcdfgjklmnprstvwbcdfgjklmnprst';
    /*
     * Spółgłoski z powtórzeniami — częste spółgłoski mają wyższe prawdopodobieństwo.
     *
     * 3 powtórzenia: b,c,d,f,g,j,k,l,m,n,p,r,s,t,v,w (popularne w imionach)
     * 2 powtórzenia: brak
     * 1 powtórzenie: q,x,z (rzadkie, egzotyczne brzmienie)
     *
     * Efekt: nazwa "Baltor" (b,l,r = częste) jest bardziej prawdopodobna niż "Qaxtor".
     */

    const allchars = vocals + cons;
    /*
     * Połączona pula wszystkich znaków.
     * Stosunek samogłoski:spółgłoski ≈ 17:(17+50) ≈ 34%:66%
     * Podobnie jak w języku angielskim (ok. 40% samogłosek w tekście).
     */

    let length = rnd(minlength, maxlength);
    if (length < 1) length = 1; // minimum 1 znak (ochrona przed 0 z rnd)

    let name    = '';
    let consnum = 0; // licznik kolejnych spółgłosek w bieżącej sekwencji

    for (let i = 0; i < length; i++) {

        const pool = (consnum === 2) ? vocals : allchars;
        /*
         * ZASADA FONETYCZNA: po 2 spółgłoskach z rzędu WYMUŚ samogłoskę.
         *
         * Dlaczego 2 a nie 3?
         *   Dwie spółgłoski pod rząd są normalne: "st" w "Storm", "tr" w "Track"
         *   Trzy spółgłoski pod rząd są trudne do wymówienia: "strk", "bctf"
         *   Dopuszczamy max 2 i wymuszamy samogłoskę.
         *
         * Przykład bez tej zasady: "Xrtkbm" (niemożliwe do wymówienia)
         * Przykład z tą zasadą:    "Xratum" (brzmi jak imię z fantasy)
         */
        if (consnum === 2) consnum = 0;
        /*
         * Reset licznika PRZED losowaniem.
         * Po wylosowaniu samogłoski i tak sprawdzimy czy to spółgłoska (będzie false).
         * Reset tutaj zapewnia poprawność dla następnej iteracji.
         */

        const c = pool[rnd(0, pool.length - 1)];
        /*
         * Wylosuj znak z aktywnej puli.
         * rnd(0, pool.length-1) = indeks 0 do (długość-1)
         *
         * Uwaga: rnd(min, max) zwraca [min, max) — max wyłączony!
         * Więc rnd(0, 16) = 0 do 15 ← brakuje ostatniego znaku!
         * Powinno być rnd(0, pool.length) dla równomiernego losowania.
         * Jest to potencjalny off-by-one bug — ostatni znak tablicy nigdy nie zostanie wylosowany.
         * Jednak biorąc pod uwagę że pule mają powtórzenia, efekt jest pomijalny.
         */
        name += c; // dołącz wylosowany znak do nazwy

        // Sprawdź czy wylosowany znak jest spółgłoską
        for (let b = cons.length; b--;) {
            if (cons[b] === c) {
                consnum++; // to spółgłoska → zwiększ licznik
                break;
                /*
                 * Szukamy c w tablicy spółgłosek.
                 * Jeśli znaleźliśmy → to spółgłoska → consnum++.
                 * Jeśli nie znaleźliśmy → to samogłoska → consnum zostaje (0 lub reset).
                 *
                 * Iteracja wsteczna (b--) jak w uniq_push — szukamy od końca dla wydajności.
                 * break po znalezieniu — nie ma sensu dalej szukać (sprawdzamy tylko czy JEST).
                 */
            }
        }
    }

    return name;
}








// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: KOMPRESJA PUNKTÓW DO 1 BAJTU
//
//  W protokole binarnym musimy zmieścić liczbę punktów (0–66 milionów!) w 1 bajcie (0–255).
//  Używamy skali logarytmicznej — precyzja maleje dla wysokich wyników.
//  OK, bo dla leaderboardu ważna jest KOLEJNOŚĆ, nie dokładna wartość.
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Konwertuje liczbę punktów na wartość 0–255 (losowa kompresja do uint8).
 *
 * Trzy zakresy o różnej "rozdzielczości":
 *
 *   Zakres punktów     Wynik byte   Precyzja (ile punktów = 1 jednostka)
 *   0 – 100 000        0 – 100      1 000 punktów/jednostka
 *   100 001 – 1 000 000  100 – 189  10 000 punktów/jednostka
 *   1 000 001 – 66 000 000  189 – 255  100 000 punktów/jednostka
 *   powyżej 66 000 000   255          (saturacja)
 *
 * Przykład: czy gracz ma 1 mln czy 1.09 mln — różnica niewidoczna w leaderboardzie.
 * Ale czy ma 0 czy 1000 — widoczna (bo małe wartości mają wysoką precyzję).
 *
 * @param {number} points  Surowa liczba punktów gracza
 * @returns {number}       Skompresowana wartość 0–255
 */
function to_bignum_byte(points) {
    if (points > 66000000) return 255;
    // Saturacja: powyżej 66M wszystko = 255 (maksimum bajtu)

    if (points > 1000000) return points / 100000 + 189;
    /*
     * Zakres 1M–66M → byte 199–255 (nie dokładnie 189 bo 1000001/100000+189 ≈ 199)
     * Formuła liniowa: co 100 000 punktów = +1 w bajcie
     */

    if (points > 100000) return (points - 100000) / 10000 + 100;
    /*
     * Zakres 100K–1M → byte 100–189
     * (points - 100000) przesunięcie do 0, /10000 skalowanie, +100 offset
     * Sprawdzenie: points=100001 → (1)/10000+100 = 100.0001 ≈ 100 ✓
     *              points=1000000 → (900000)/10000+100 = 90+100 = 190 (≈189 z zaokrągleniem)
     */

    return points / 1000;
    /*
     * Zakres 0–100K → byte 0–100
     * points=0 → 0/1000 = 0 ✓
     * points=1000 → 1 ✓ (1 punkt = 1 unit w leaderboardzie do 1000 punktów)
     * points=100000 → 100 ✓
     */
}





// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: GENEROWANIE POZIOMÓW MAPY (proceduralnie)
//
//  Mapa jest generowana proceduralnie podczas gry — nie ma z góry zdefiniowanych poziomów.
//  Cylinder składa się z setek poziomów "pierścieni" z różnymi układami kafelków.
//
// ═══════════════════════════════════════════════════════════════════════════════
for (let i = 25; i--;) gen_lvl();
/*
 * Przed otwarciem serwera — wygeneruj 2500 poziomów (25 × 100).
 * Gracz startuje od poziomu 0 i spada coraz głębiej.
 * 2500 poziomów = bardzo długi czas zanim gracz "dobiegnie do końca" (praktycznie nieskończone).
 * Nowe poziomy dogenerowane dynamicznie gdy gracz zbliży się do końca.
 */









/**
 * Generuje kolejne 100 poziomów mapy i zapisuje je w tablicy levels[].
 *
 * Każdy poziom = Uint8Array[128] (cylinder ma 128 kafelkowych "slotów" w kółku).
 * Wraparound: indeks & 0b1111111 = indeks % 128 (maska 7-bitowa).
 *
 * Typy kafelków: 0 = pustka, 1 = bezpieczna platforma, 2 = śmiertelna platforma.
 *
 * "Checkpoint" (co sqrt(id/10) ∈ ℤ, czyli id = 0,10,40,90,160,...):
 *   Pełny pierścień z 3 otworami (przejścia do następnej sekcji cylindra).
 *   Gracz musi trafić w otwór żeby przejść przez "bramę" checkpointu.
 *
 * Poziomy "normalne":
 *   Losowo rozmieszczone grupy czerwonych i zielonych platform.
 *   Trudność (badCount i norCount) rośnie liniowo z głębokością (id).
 */

/**
 * Generuje 100 kolejnych poziomów mapy.
 *
 * ARCHITEKTURA CYLINDRA:
 *   Wyobraź sobie cylindryczną torbę (jak w Geometry Dash ale w 3D).
 *   Cylinder obraca się — gracz "biega" po wewnętrznej ścianie.
 *   Każdy "pierścień" (poziom) to krąg 128 kafelków dookoła cylindra.
 *
 *   Kafelek ma "szerokość" 8 jednostek (cylinder = 128 × 8 = 1024 jednostki obwodu).
 *   Indeks kafelka: 0–127 (kołowy — po indeksie 127 wraca do 0).
 *
 * TYPY KAFELKÓW:
 *   0 = pustka     (pusta przestrzeń — gracz spada przez ten obszar)
 *   1 = platforma  (bezpieczna — gracz może stanąć, resetuje jump_frame)
 *   2 = kolce/ogień (śmiertelna — gracz traci event, ewentualnie ginie)
 *
 * CHECKPOINTY (co sqrt(id/10) ∈ ℤ):
 *   Specjalne poziomy: pełny pierścień z 3 przejściami.
 *   Gracz MUSI trafić w jedno z 3 wąskich przejść żeby przejść dalej.
 *   Przy przejściu przez checkpoint: gracz zyskuje +1 event (życie) + nowy respawn_lvl.
 *
 * Jakie id są checkpointami?
 *   sqrt(id/10) ∈ ℤ  ↔  id/10 = n²  ↔  id = 10n²
 *   id=0: 10×0² = 0 ✓      id=10: 10×1² = 10 ✓
 *   id=40: 10×2² = 40 ✓    id=90: 10×3² = 90 ✓
 *   id=160: 10×4² = 160 ✓  (coraz rzadziej — checkpointy się rozsuwają)
 */
function gen_lvl() {
    for (let l = 100; l--;) {
        const id = levels_sav + l;
        /*
         * id = bezwzględny numer poziomu w całej mapie.
         * levels_sav = ile już wygenerowano (skumulowana wartość).
         * Pierwsze wywołanie: levels_sav=0, l=99..0, id=99..0
         * Drugie wywołanie:   levels_sav=100, l=99..0, id=199..100
         */


        if (!(Math.sqrt(id / 10) % 1)) {
            /*
             * Sprawdzenie czy id jest checkpoint-poziomem:
             *   id / 10 = 0.0 → sqrt = 0.0 → 0.0 % 1 = 0.0 → !0.0 = true ✓ (id=0)
             *   id / 10 = 1.0 → sqrt = 1.0 → 1.0 % 1 = 0.0 → !0.0 = true ✓ (id=10)
             *   id / 10 = 1.5 → sqrt = 1.22 → 1.22 % 1 = 0.22 → !0.22 = false ✗ (nie checkpoint)
             *
             * % 1 = reszta z dzielenia przez 1 = część ułamkowa liczby!
             *   3.7 % 1 = 0.7  (część ułamkowa)
             *   3.0 % 1 = 0.0  (cała liczba — brak ułamka)
             *
             * Sprawdzamy czy sqrt jest liczbą całkowitą (brak ułamka = checkpoint).
             */




            levels[id] = new Uint8Array(128).fill(1);
            /*
             * Utwórz pełny pierścień z samych "1" (bezpieczne platformy).
             * new Uint8Array(128) → tablica 128 zer
             * .fill(1)            → wypełnij wszystkie elementy wartością 1
             *
             * Wynik: pełna platforma dookoła cylindra (żaden gracz nie może spaść).
             */

            levels[id][0]  = levels[id][1]  = levels[id][2]  = 0; // Przejście 1: kafelki 0, 1, 2
            levels[id][42] = levels[id][43] = levels[id][44] = 0; // Przejście 2: kafelki 42, 43, 44
            levels[id][84] = levels[id][85] = levels[id][86] = 0; // Przejście 3: kafelki 84, 85, 86
            /*
             * "Wybij" 3 otwory po 3 kafelki — gracze mogą tędy przejść.
             * Rozmieszczenie co ~42 kafelki (128/3 ≈ 42.67) — równomiernie dookoła cylindra.
             * 3 przejścia = 3 × 3 = 9 "otwartych" kafelków na 128 = 7% otwartości.
             * Trzeba celować — checkpoint jest wyzwaniem!
             */
            continue;
            /*
             * continue = przejdź do następnej iteracji pętli (l--).
             * Nie generujemy losowej zawartości dla checkpoint-poziomów.
             */
        }

        levels[id] = new Uint8Array(128); // wszystkie kafelki = 0 (pusta przestrzeń)
        /*
         * Normalny poziom — wszystko puste (0) na start.
         * Uint8Array(128) automatycznie inicjalizuje wszystkie 128 bajtów wartością 0.
         */



        const badCount = ((id / 40) | 0) + 4;
        /*
         * Ile grup "złych" (śmiertelnych) kafelków na tym poziomie.
         * Rosnąca trudność:
         *   id=0:   0/40=0  | 0=0, +4 = 4 grupy
         *   id=40:  40/40=1 | 0=1, +4 = 5 grup
         *   id=200: 200/40=5| 0=5, +4 = 9 grup
         *   id=400: 400/40=10|0=10,+4 = 14 grup
         *
         * | 0 = Math.floor dla >= 0 (szybki wariant)
         */


        const norCount = ((id / 20) | 0) + 20;
        /*
         * Ile grup "dobrych" (bezpiecznych) platform.
         *   id=0:   0/20=0  +20 = 20 grup
         *   id=100: 100/20=5+20 = 25 grup
         *   id=200: 200/20=10+20= 30 grup
         *
         * norCount rośnie szybciej niż badCount — mapa jest trudniejsza
         * ale nie staje się niemożliwa (jest gdzie stanąć).
         */



        // Generuj grupy śmiertelnych platform (typ 2)
        // ── Generuj śmiertelne platformy ──
        for (let o = badCount; o--;) {
            let pos = (Math.random() * 127) | 0;
            // Losowy kafelek startowy 0–126 (nie 127, żeby wrap działał poprawnie przy długiej grupie)
            const len = ((Math.random() * 3) | 0) + 2; // długość grupy: 2, 3 lub 4 kafelki
            for (let oo = len; oo--;) {
                levels[id][pos++] = 2; // ustaw śmiertelny kafelek
                pos &= 0b1111111;
                /*
                 * & 0b1111111 = & 127 = modulo 128 (ale szybciej niż % 128).
                 * 0b1111111 = 7 jedynek = maska 7-bitowa.
                 *
                 * Jak to działa (wrap-around):
                 *   pos = 126 → pos++ = 127 → & 127 = 127 (ok)
                 *   pos = 127 → pos++ = 128 → 128 & 127 = 0 (wrap! 128 w binarnym = 10000000, AND 1111111 = 0000000 = 0)
                 *   pos = 129 → & 127 = 1 (129 = 10000001, AND 1111111 = 0000001 = 1)
                 *
                 * Cylinder jest kołowy — po kafelku 127 wracamy do kafelka 0.
                 * Grupy kafelków mogą "opasać" cylinder i przejść przez 0.
                 */
            }
        }

        // ── Generuj bezpieczne platformy ──
        for (let o = norCount; o--;) {
            let pos = (Math.random() * 127) | 0;
            const len = ((Math.random() * 6) | 0) + 3; // długość: 3–8 kafelków
            for (let oo = len; oo--;) {
                if (!levels[id][pos]) {
                    /*
                     * Dodaj bezpieczny kafelek TYLKO jeśli miejsce jest puste (levels[id][pos] === 0).
                     * NIE nadpisujemy czerwonych kafelków zielonymi.
                     * Efekt: czerwone platformy "wycinają" dziury w zielonych.
                     */
                    levels[id][pos++] = 1;
                    pos &= 0b1111111; // wrap-around
                }
            }
        }

        // ── Wybij losowe "dziury" w platformach ──
        for (let o = 2; o--;) { // 2 dziury na poziom
            let pos = (Math.random() * 127) | 0;
            for (let oo = 3; oo--;) { // każda dziura = 3 puste kafelki
                levels[id][pos++] = 0;  // wymaż (puste = 0)
                pos &= 0b1111111;
            }
        }
        /*
         * Dlaczego wybijamy dziury PO wygenerowaniu platform?
         *   Zapobiega sytuacji gdzie platformy tworzą pełny pierścień (gracz nie może spaść).
         *   Dwie wymuszone dziury gwarantują że poziom ma "otwarte" miejsca.
         */
    }

    levels_sav += 100;
    console.log("level gen = " + levels_sav);
    /*
     * Po wygenerowaniu 100 poziomów:
     *   Przesuń wskaźnik o 100 — następne gen_lvl() zacznie od levels_sav.
     *   Logujemy dla diagnostyki (widać w logach K8s jak szybko gracze schodzą).
     */

}


// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA 15: KONSTRUKTOR GRACZA
//
//  Funkcja konstruktora (używana z new) tworząca obiekt gracza.
//  W JavaScript (bez klas ES6) konstruktory to zwykłe funkcje gdzie:
//    - new player() tworzy pusty obiekt {}
//    - this wewnątrz konstruktora = ten nowo tworzony obiekt
//    - Po zakończeniu konstruktora: obiekt jest zwracany automatycznie
//
// ═══════════════════════════════════════════════════════════════════════════════


/**
 * Tworzy obiekt gracza (ludzkiego lub bota).
 * Boty i ludzie mają IDENTYCZNĄ strukturę — różnią się tylko:
 *   - socket: WebSocket (ludzki) vs null (bot)
 *   - bot: null (ludzki) vs referencja do obiektu Bot (bot)
 *
 * @param {number}    id     Unikalny ID z puli free_ids (uint8, 0–254)
 * @param {WebSocket} socket uWS socket lub null dla botów
 * @param {object}    tok    Dane autoryzacji: { name, token, account, skin_id }
 */
function player(id, socket, tok) {

    // ── IDENTYFIKACJA ──────────────────────────────────────────────────────────

    this.id      = id;
    /*
     * Unikalny numer identyfikacyjny w tej sesji gry.
     * Używany w każdym pakiecie binarnym żeby klient wiedział o którym graczu mowa.
     * Zakres 0–254 (uint8 w protokole).
     */

    this.socket  = socket;
    /*
     * Referencja do socketa WebSocket (uWS).
     * null dla botów — boty nie "słuchają" i nie "wysyłają" pakietów.
     * Przed każdym socket.send() sprawdzamy: if (!this.bot) { ... }
     */

    this.name    = tok.name;    // wyświetlana nazwa gracza (może być pusta dla niektórych botów)
    this.token   = tok.token;   // oryginalny token (zachowany dla celów debugowania)
    this.account = tok.account || '';
    /*
     * MongoDB ObjectId string ("507f1f77bcf86cd799439011") lub '' dla:
     *   - graczy-gości (nie zalogowanych)
     *   - botów (tok.account = '' bo token bota ma account: '')
     *
     * Używany w save_player_money() — jeśli '', punkty nie są zapisywane.
     */

    // ── POZYCJA NA MAPIE ──────────────────────────────────────────────────────

    this.x = random_pos();
    /*
     * Pozycja kątowa na cylindrze (0–1023).
     * Wyobraź sobie zegar: 0 = godzina 12, 512 = godzina 6, 1023 ≈ godzina 12 (prawie dookoła).
     * Cylinder jest "owinięty" — po pozycji 1023 następuje 0.
     */

    this.y = 0;
    /*
     * Pozycja pionowa (głębokość w cylindrze).
     * Y=0 = punkt startowy (najwyżej w cylindrze).
     * Y rośnie gdy gracz opada, maleje gdy skacze.
     *
     * UWAGA: układ współrzędnych jest "odwrócony" względem intuicji:
     *   Większy Y = niżej w cylindrze = głębiej (wyższy numer poziomu).
     *   Ujemny Y = WYŻEJ niż punkt startowy (gracz "wystrzelony" w górę nie istnieje w grze).
     *
     * W obliczeniach kolizji z kafelkami:
     *   col = Math.abs((y - 8) >> 4)  ← bierzemy wartość bezwzględną właśnie dlatego.
     */

    this.move_x = 0;
    /*
     * Horyzontalna prędkość w bieżącym ticku.
     * Ustawiana przez pakiet case 0 (klient wysyła delta X).
     * Zerowana po zastosowaniu w move() (każdy tick zaczyna z v=0).
     *
     * Dlaczego przechowujemy dx zamiast kierunku (lewo/prawo)?
     *   Klient wysyła dokładną deltę. Może to być 1, 2, 3 piksele w lewo/prawo.
     *   Przechowujemy dokładną wartość dla dokładności kolizji.
     */

    // ── SYSTEM POZIOMÓW ────────────────────────────────────────────────────────

    this.lvl = 0;
    /*
     * Bieżący indeks segmentu (poziomu) na którym gracz się znajduje.
     * Odpowiada indeksowi w segment_player[] i levels[].
     * Rośnie gdy gracz opada głębiej w cylinder.
     * Używany do: detekcji kolizji (sprawdzamy segmenty lvl-1 i lvl),
     *             wysyłki danych mapy (wysyłamy poziomy od send_lvl wzwyż),
     *             punktów za awans (add_points przy przejściu na wyższy poziom).
     */

    this.send_lvl = 10;
    /*
     * Do którego poziomu WYSŁANO dane mapy do tego klienta.
     * Inicjalnie 10 — przy połączeniu wysyłamy poziomy 0–9 (10 poziomów).
     * Gdy lvl > send_lvl - 5 → czas wysłać kolejne 10 (pakiet type 4).
     *
     * Dlaczego 5 poziomów "zapasu" a nie wysyłamy dokładnie gdy potrzeba?
     *   Gracz opada z prędkością ~4 j/tick → może "przeskoczyć" kilka poziomów.
     *   5 poziomów buforu = czas na wysłanie + dotarcie pakietu przez sieć.
     */

    this.respawn_lvl = 0;
    /*
     * Ostatni "checkpoint" przez który gracz przeszedł.
     * Przy śmierci i respawnie: gracz teleportuje się NA TEN POZIOM (nie od 0).
     *
     * Wartość to "ranga" (Math.sqrt(lvl/10) | 0), nie bezpośredni indeks poziomu:
     *   respawn_lvl=0 → poziomy 0–9     (pierwsza sekcja)
     *   respawn_lvl=1 → poziomy 10–39   (po pierwszym checkpoint)
     *   respawn_lvl=2 → poziomy 40–89   (po drugim checkpoint)
     *
     * Aktualizowana w move() gdy gracz osiąga nową "rangę".
     */

    this.colid = null; // placeholder — nieużywany aktywnie

    // ── RANKING ───────────────────────────────────────────────────────────────

    this.ranking_id = ranking.push(this) - 1;
    /*
     * Indeks gracza w tablicy ranking[].
     * ranking.push(this) dodaje gracza na KONIEC i zwraca nową długość.
     * Indeks = długość - 1 (bo tablice są 0-indeksowane).
     *
     * Każdy nowy gracz zaczyna na OSTATNIM miejscu rankingu (ma 0 punktów).
     * Awansuje w add_points() gdy zdobędzie więcej punktów niż poprzednik.
     *
     * ranking_id jest DYNAMICZNE — zmienia się przy każdym awansie w rankingu.
     * Musimy aktualizować ranking_id WSZYSTKICH przesuniętych graczy.
     */

    this.points      = 0; // aktualna suma punktów (zmienia się przez cały mecz)
    this.kill_points = 0; // punkty TYLKO za zabijanie graczy (wyodrębnione bo "trwałe" po śmierci)
    this.byte_point  = 0; // cache skompresowanych punktów (to_bignum_byte), unikamy przeliczania co tick

    this.send_rank_pos = false;
    /*
     * Flaga: wyślij temu graczowi jego nową pozycję w rankingu.
     * Ustawiana gdy byte_point się zmienia (punkt widziany przez klienta jest inny).
     * Nie ustawiamy co tick — tylko gdy faktycznie coś się zmieniło (optymalizacja).
     */

    // ── KONTO MONGODB ─────────────────────────────────────────────────────────

    this.account_points = 0;
    /*
     * Ile punktów zostało zapisane do MongoDB przy ostatnim wywołaniu save_player_money().
     * Używane do obliczenia "nowych" punktów:
     *   do_zapisania = this.points - this.account_points
     *   (ile zarobił od ostatniego zapisu)
     *
     * Aktualizowane po każdym save_player_money().
     */

    this.saved_points = 0;
    /*
     * Punkty w momencie ostatniego CHECKPOINTU (bez kill_points).
     * Przy respawnie: gracz odzyskuje saved_points + kill_points.
     * Cel: gracz nie traci wszystkiego przy śmierci, zaczyna od ostatniego checkpointu.
     *
     * Aktualizowane w move() gdy gracz przechodzi przez checkpoint.
     */

    this.extra_power = 0; // zarezerwowane (przyszłe power-upy)

    // ── FIZYKA I EVENTY ───────────────────────────────────────────────────────

    this.jump_frame = 0;
    /*
     * Liczba ticków od ostatniego lądowania na platformie (lub startu).
     * Używana do obliczenia prędkości pionowej:
     *   v_y = 4 - jump_frame × GRAVITY(0.1)
     *
     * jump_frame=0:  v=4.0 (maksymalny skok — tuż po lądowaniu/starcie)
     * jump_frame=40: v=0.0 (szczyt łuku — gracz "zawisł")
     * jump_frame=80: v=-4.0 (opada w dół)
     * jump_frame=140:v=-10.0 (osiągnięty limit prędkości opadania)
     *
     * Resetowane do 0 przy lądowaniu na bezpiecznej platformie.
     */

    this.event = 1;
    /*
     * "Żywotność" gracza — liczba "punktów życia".
     * Zakres: 0–10
     *
     * Znaczenie:
     *   event=10 → pełne życie (gracz ma max ochronę przed czerwonymi)
     *   event=1  → jedno trafienie w czerwoną i gracz ginie (stan startowy)
     *   event=0  → gracz ginie od następnej czerwonej platformy
     *
     * Zmiana przez:
     *   +1: przejście przez checkpoint, zabicie gracza (+1 dla zabójcy)
     *   +1: respawn po reklamie lub normalnie
     *   -2: uderzenie w czerwoną platformę (jeśli event > 0)
     *   =0: śmierć na czerwonej gdy event <= 0
     *
     * event > 10 → clampowane do 10 (nie może przekroczyć maksimum).
     */

    this.event_use = -2;
    /*
     * Maszyna stanów dla interakcji z kafelkami.
     * Kontroluje kiedy gracz może "wylądować" na kafelku i wywołać efekt.
     *
     * Stany:
     *   -2 → NORMALNY: gracz może lądować i wywoływać efekty kafelków
     *   -1 → UŻYWA EVENTU: gracz nacisnął przycisk "użyj" (case 2) — "skacze" przez kafelek
     *   -3 → UDERZONY: gracz właśnie trafił w czerwony kafelek — chwilowa odporność
     *    n ≥ 0 → ID poziomu ostatniego lądowania — blokuje wielokrotne triggery na tym samym kafelku
     *
     * Po co ten skomplikowany stan?
     *   Bez niego: gracz lądujący na kafelku triggerowałby efekt KAŻDY TICK przez który jest na nim.
     *   Z tymi stanami: efekt wyzwalany tylko raz i dopiero przy kolejnym kafelku znów.
     */

    this.event_send = false;
    // Flaga: zaktualizuj UI gracza (prześlij nową wartość this.event przez pakiet type 11).

    this.target = null;
    /*
     * Referencja do ostatniego gracza z którym była kolizja fizyczna.
     *
     * Cel: "kto mnie zepchnął na czerwony kafelek dostanie kill bonus".
     * Mechanizm:
     *   1. Kolizja: this.target = other (gracz B zepchnął gracza A)
     *   2. Gracz A trafia w czerwony i ginie
     *   3. Sprawdzamy this.target → if (this.target) → gracz B dostaje +1000 punktów
     *
     * Zerowane gdy:
     *   - Gracz bezpiecznie ląduje (target = null — to lądowanie bez walki)
     *   - Gracz uderza w czerwony bez gracza (target = null w obsłudze trafienia)
     */

    // ── SIEĆ ──────────────────────────────────────────────────────────────────

    this.ping = false; this.ping_c = 0; // infrastruktura ping (nieaktywna w tej wersji)

    this.is_dead = false;
    /*
     * true gdy gracz zginął i czeka na respawn.
     * Gdy is_dead = true:
     *   - Fizyka pomijana (pl.move() nie wywoływana)
     *   - Gracz niewidoczny dla innych (nie renderowany po client-side)
     *   - Socket nadal otwarty — klient widzi ekran śmierci
     *   - Gracz czeka na pakiet case 8 (respawn potwierdzenie)
     * Resetowane do false gdy klient wyśle pakiet respawn (case 8).
     */

    this.send_points = false;
    /*
     * Po śmierci: ile punktów (złota) gracz zarobił i powinien otrzymać na konto UI.
     * false = nic do wysłania (normalne stany gry)
     * -1 = wysłano (sentinel po wysyłce w gen_packet)
     * n > 0 = wyślij n jako nagrodę za sesję (pakiet type 12)
     */

    this.bot = null;
    /*
     * null = gracz ludzki.
     * Obiekt Bot = ten gracz jest botem.
     *
     * Używany jako "flaga" przez cały kod:
     *   if (!this.bot) → tylko dla ludzkich graczy (socket.send, save_player_money, is_dead)
     *   if (this.bot)  → tylko dla botów (bot.respawn_lvl, bot AI behavior)
     */

    // ═════════════════════════════════════════════════════════════════════════
    //  METODY GRACZA
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * Dodaje punkty graczowi i aktualizuje jego pozycję w tablicy rankingu.
     * Używa algorytmu bubble-sort (jeden krok w górę) — efektywne gdy zmiany są małe.
     *
     * @param {number} amount  Liczba punktów do dodania (zawsze > 0)
     */
    this.add_points = function (amount) {
        this.points += amount; // dodaj punkty do sumy

        const oldByte = this.byte_point;
        const newByte = to_bignum_byte(this.points);
        /*
         * Sprawdź czy "widoczna" wartość punktów (skompresowana do 1 bajtu) się zmieniła.
         * Jeśli gracz ma 50 000 punktów i zarobi 100 → to_bignum_byte(50100) = to_bignum_byte(50000)
         * Zmiana niewidoczna w protokole → nie ma co wysyłać pakietu.
         * Optymalizacja: unikamy przesyłania niepotrzebnych danych.
         */

        if (oldByte !== newByte) {
            this.send_rank_pos = true; // wyślij graczowi nową pozycję (pakiet type 10)
            this.byte_point    = newByte; // zaktualizuj cache

            if (this.ranking_id < 6) send_ranking = true;
            /*
             * Jeśli gracz jest w TOP 6 → wszyscy powinni zobaczyć zmianę leaderboardu (pakiet type 9).
             * ranking_id < 6 = gracz jest na pozycji 1–6 (indeksy 0–5).
             */
        }

        // ── Bubble-sort: przesuń gracza w górę rankingu ──
        let above = ranking[this.ranking_id - 1];
        /*
         * "above" = gracz bezpośrednio POWYŻEJ w rankingu (ma więcej punktów).
         * ranking[0] = lider (najwyższy ranking_id to 0).
         * ranking[this.ranking_id - 1] = gracz o 1 pozycję wyżej.
         * undefined gdy this.ranking_id = 0 (już na szczycie) → pętla od razu kończy.
         */

        while (above && above.points < this.points) {
            /*
             * Kontynuuj przesuwanie dopóki:
             *   - Jest ktoś wyżej (above !== undefined)
             *   - Ten ktoś ma MNIEJ punktów niż my
             *
             * Gdy obaj mają tyle samo → nie ruszamy (równorzędność = nie zamieniamy)
             */

            if (this.ranking_id - 1 < 6) send_ranking = true;
            // Przesuwamy kogoś z top 6 → wyślij zaktualizowany ranking wszystkim.

            ranking[this.ranking_id - 1].ranking_id++;
            /*
             * Gracz powyżej SPADA o 1 pozycję — zaktualizuj jego ranking_id.
             * Ważne: najpierw aktualizujemy ranking_id, POTEM zmieniamy miejsce w tablicy.
             */

            ranking[this.ranking_id]     = ranking[this.ranking_id - 1];
            ranking[this.ranking_id - 1] = this;
            /*
             * ZAMIANA (swap) dwóch elementów w tablicy ranking[]:
             *   Gracz powyżej SPADA na nasze miejsce.
             *   My WCHODZIMY na jego miejsce.
             *
             * Nie potrzebujemy temp zmiennej bo używamy referencji:
             *   ranking[this.ranking_id] = ranking[this.ranking_id - 1]
             *   ← nadpisujemy starą pozycję (this) wskaźnikiem na gracza z góry
             *   ranking[this.ranking_id - 1] = this
             *   ← wstawiamy this na wyższe miejsce
             */

            this.ranking_id--;
            // My awansowaliśmy — nasz indeks jest teraz o 1 mniejszy.

            above = ranking[this.ranking_id - 1];
            // Sprawdź nowego poprzednika (może trzeba awansować dalej).
        }
    };

    /**
     * Wykonuje jeden tick fizyki, kolizji i interakcji z mapą dla tego gracza.
     * Wywoływana przez główną pętlę dla każdego żywego gracza.
     */
    this.move = function () {

        // ── KROK 1: KOLIZJE Z INNYMI GRACZAMI ────────────────────────────
        for (let z = this.lvl - 1; z <= this.lvl; z++) {
            /*
             * Sprawdzamy DWA sąsiednie segmenty: (lvl-1) i (lvl).
             * Dlaczego nie więcej?
             *   Gracz może opaść max ~10 jednostek na tick (prędkość cap = -10).
             *   Jeden segment = 8 poziomów = 8 × 16 = 128 jednostek wysokości.
             *   Gracz nigdy nie "przeskoczy" przez cały segment w jednym ticku.
             *   Sprawdzanie dalszych segmentów = strata czasu na niemożliwe kolizje.
             */
            if (!segment_player[z]) continue;
            // Ten segment nie ma żadnych graczy → pomiń (by nie wywołać TypeError na undefined).

            for (let i = segment_player[z].length; i--;) {
                const other = segment_player[z][i];
                if (other === this) continue;
                // Nie sprawdzaj kolizji gracza ze samym sobą (zawsze "koliduje" — ten sam punkt!).

                if (is_colid(other.x, other.y, PLAYER_RADIUS, this.x, this.y, PLAYER_RADIUS)) {
                    // KOLIZJA WYKRYTA!

                    other.x += this.move_x;
                    this.x  += other.move_x;
                    /*
                     * WYMIANA PRĘDKOŚCI (uproszczona fizyka zderzenia elastycznego):
                     *
                     * "other" przesuwa się w kierunku w którym "this" chciał iść.
                     * "this" przesuwa się w kierunku w którym "other" chciał iść.
                     *
                     * Analogia: dwie kule bilardowe — każda "przejmuje" prędkość drugiej.
                     * Uproszczenie: zakładamy równe masy i prostą wymianę (nie pełna fizyka).
                     */

                    this.move_x  = 0;
                    other.move_x = 0;
                    // Zerujemy prędkości PO wymianie — żeby w fizyce nie zastosowano ruchu ponownie.

                    other.x &= 0x3ff;
                    this.x  &= 0x3ff;
                    // Wrap-around cylindra po przesunięciu (x może wyjść poza 0–1023).

                    this.target  = other;
                    other.target = this;
                    /*
                     * REJESTRACJA KOLIZJI DLA SYSTEMU ZABÓJSTW:
                     * Zapamiętaj kto z kim kolidował.
                     * Jeśli "this" umrze → this.target (other) dostanie kill points.
                     * Jeśli "other" umrze → other.target (this) dostanie kill points.
                     */

                    // ── SEPARACJA GRACZY (rozsuń żeby nie nachodzili) ──
                    const diameter = PLAYER_RADIUS + PLAYER_RADIUS; // 22 jednostki
                    const dx   = other.x - this.x; // wektor od "this" do "other"
                    const dy   = other.y - this.y;
                    const dist = Math.sqrt(dx * dx + dy * dy) || 1;
                    /*
                     * Oblicz aktualną odległość między środkami (tak, tu używamy sqrt!).
                     * || 1: jeśli dist = 0 (gracze dokładnie w tym samym punkcie) → unikaj dzielenia przez 0.
                     * Wartość 1 daje arbitralny kierunek separacji (okej dla edge case).
                     */
                    const ux = dx / dist; // jednostkowy wektor X (kierunek od "this" do "other")
                    const uy = dy / dist; // jednostkowy wektor Y

                    other.x = this.x + diameter * ux;
                    other.y = this.y + diameter * uy;
                    /*
                     * Umieść "other" dokładnie w odległości 22 jednostek od "this".
                     * Kierunek: wzdłuż wektora łączącego środki (rozsuń na zewnątrz).
                     *
                     * Dlaczego przesuwamy tylko "other" a nie oboje?
                     * Uproszczenie — "this" jest "dominantem" w tej kolizji.
                     * Pełna fizyka = przesunięcie obydwu o połowę overlapping distance.
                     * Tu: prostsze = wystarczające dla płynnej gry.
                     */

                    other.x &= 0x3ff;
                    this.x  &= 0x3ff; // wrap-around po separacji
                }
            }
        }

        this.move_x = 0;  // wyzeruj ruch — czekamy na nowy pakiet od klienta w następnym ticku
        this.jump_frame++; // tick w powietrzu — rośnie każdy tick, resetowane przy lądowaniu

        // ── KROK 2: GRAWITACJA ────────────────────────────────────────────
        let vecy = 4 - this.jump_frame * GRAVITY;
        /*
         * Prędkość pionowa w tej klatce.
         * jump_frame=0 → v=4 (silny skok/tuż po lądowaniu)
         * jump_frame=40 → v=0 (szczyt łuku)
         * jump_frame=80 → v=-4 (opada)
         *
         * v > 0 = gracz unosi się w górę (cylinder "w dół" to większy Y)
         * v < 0 = gracz opada (cylinder głębiej)
         */
        if (vecy < -10) vecy = -10;
        /*
         * CAP prędkości opadania na -10 jednostek/tick.
         * Bez tego: po bardzo długim czasie w powietrzu prędkość byłaby -50, -100...
         * Gracz "przelatywałby" przez kilka platform w jednym ticku (tunnel effect).
         * -10 jednostek/tick = max opadanie mniejsze niż połowa wysokości kafelka (16j).
         */
        this.y += vecy;
        // Zastosuj prędkość — Y rośnie = głębiej w cylindrze.

        // ── KROK 3: SPRAWDZENIE KONTAKTU Z KAFELKAMI ─────────────────────
        const col = Math.abs((this.y - 8) >> 4);
        /*
         * Oblicz "rząd" w siatce kafelków na którym gracz aktualnie jest.
         *
         * (this.y - 8):
         *   Przesunięcie o -8 jednostek — środek gracza jest 8 jednostek NAD jego podstawą.
         *   Bez tego: kolizja byłaby sprawdzana przy środku gracza, nie przy stopach.
         *   Gracz "wsiąkałby" w platformę o połowę swojego rozmiaru zanim kolizja by zadziałała.
         *
         * >> 4 (dzielenie przez 16):
         *   Każda "warstwa" kafelków zajmuje 16 jednostek wysokości.
         *   Dzielimy Y przez 16 żeby uzyskać indeks warstwy.
         *   Przykład: y=32 → (32-8)>>4 = 24>>4 = 1 (warstwa 1)
         *             y=48 → (48-8)>>4 = 40>>4 = 2 (warstwa 2)
         *
         * Math.abs():
         *   Y może być ujemne (gracz wystrzelony wysoko).
         *   Absolutna wartość zapewnia nieujemny indeks tablicy.
         */

        if (!(col % 8)) {
            /*
             * Sprawdzaj TYLKO gdy col jest wielokrotnością 8.
             * Warstwy kafelków są co 8 "rzędów" pionowych (co 128 jednostek Y).
             *
             * Dlaczego nie sprawdzamy co tick?
             *   Gracz porusza się z prędkością max 10 j/tick.
             *   Platforma jest na KONKRETNEJ wysokości.
             *   Bez tej optymalizacji: sprawdzamy kolizje 8× więcej niż potrzeba.
             *
             * !(x % 8) = true gdy x jest wielokrotnością 8:
             *   col=0:  0%8=0, !0=true  ← sprawdź
             *   col=8:  8%8=0, !0=true  ← sprawdź
             *   col=4:  4%8=4, !4=false ← pomiń
             *   col=16: 16%8=0,!0=true  ← sprawdź
             */

            const tileTop  = (this.x + 6) >> 3;
            const tileDown = (this.x - 6) >> 3;
            const tileMid  = this.x       >> 3;
            /*
             * TRZY PUNKTY DETEKCJI KOLIZJI (3-point collision):
             *
             *   tileTop:  indeks kafelka pod PRAWĄ krawędzią gracza (x+6 = prawa noga/bok)
             *   tileDown: indeks kafelka pod LEWĄ krawędzią (x-6 = lewa noga/bok)
             *   tileMid:  indeks kafelka pod ŚRODKIEM gracza
             *
             *   >> 3 = dzielenie przez 8 = konwersja pozycji (0–1023) → indeks kafelka (0–127)
             *
             * Dlaczego 3 punkty a nie 1?
             *   Gracz ma promień 11 jednostek (szerokość 22j).
             *   Kafelek ma szerokość 8 jednostek.
             *   Gracz może być na granicy między kafelkami.
             *   1 punkt (środek): gracz mógłby "wpaść" między dwa kafelki.
             *   3 punkty: prawa noga, środek, lewa noga = pełne pokrycie.
             *
             * Gracz "stoi" jeśli KTÓRYKOLWIEK z 3 punktów dotyka platformy:
             *   levels[idn][tileMid] || levels[idn][tileTop] || levels[idn][tileDown]
             */

            const idn = (col / 8) | 0;
            /*
             * Indeks poziomu mapy (levels[]) na którym gracz aktualnie stoi.
             *
             * col = rząd w siatce pionowej (0, 8, 16, 24...)
             * col / 8 = indeks poziomu (0, 1, 2, 3...)
             * | 0 = Math.floor (szybkie obcięcie ułamków dla >= 0)
             */

            if (idn >= this.lvl && levels[idn] &&
                (levels[idn][tileMid] || levels[idn][tileTop] || levels[idn][tileDown])) {
                /*
                 * Gracz dotknął kafelka! Ale sprawdzamy kilka warunków:
                 *
                 *   idn >= this.lvl:
                 *     Sprawdzamy tylko platformy NA lub POD aktualnym poziomem gracza.
                 *     Platformy WYŻEJ (idn < lvl) są za plecami/głową — gracz już przez nie przeszedł.
                 *
                 *   levels[idn]:
                 *     Sprawdzamy czy ten poziom w ogóle istnieje (gen_lvl mógł jeszcze nie dotrzeć).
                 *     Undefined check — bez tego: levels[idn][tileMid] → TypeError.
                 *
                 *   levels[idn][tileMid] || tileTop || tileDown:
                 *     Czy którykolwiek z 3 punktów dotyka niezerowego kafelka (1 lub 2)?
                 *     0 = pustka = gracz "przechodzi przez" → brak kolizji.
                 */

                if (this.event_use === -1) {
                    this.event_use = idn;
                    /*
                     * Stan: gracz nacisnął przycisk "użyj eventu" (case 2) → event_use = -1.
                     * Teraz ląduje na kafelku → zapamiętaj ID poziomu.
                     * Blokuje wielokrotne triggery na tym samym poziomie.
                     */

                } else if (this.event_use !== idn) {
                    /*
                     * Gracz dotknął INNEGO kafelka niż ostatnio.
                     * event_use = id ostatniego kafelka, idn = aktualny kafelek.
                     * Jeśli te same → nie triggeruj ponownie (gracz stoi na kafelku, nie "ląduje").
                     */

                    if (this.event_use + 1 === idn) this.event_use = -2;
                    /*
                     * Gracz szybko przeszedł przez dwa sąsiednie poziomy.
                     * Poprzedni poziom był dokładnie "jeden niżej" — reset do stanu normalnego.
                     */

                    // ── Sprawdź typ kafelka ──
                    const isHazard = levels[idn][tileMid]  === 2 ||
                                     levels[idn][tileTop]  === 2 ||
                                     levels[idn][tileDown] === 2;
                    /*
                     * Czy KTÓRYKOLWIEK z trzech punktów dotyka kafelka śmiertelnego (typ 2)?
                     * Wystarczy jeden punkt żeby kafelek był "niebezpieczny".
                     *
                     * Dlaczego sprawdzamy każdy punkt osobno?
                     *   Gracz może być na granicy: 2 nogi na zielonym, 1 noga na czerwonym.
                     *   Jeden kontakt z czerwonym = triggerkuje efekt.
                     */

                    if (isHazard) {
                        // ── KAFELEK ŚMIERTELNY (czerwony) ──

                        if (this.event > 0) {
                            // Gracz ma jeszcze "życia" → odsuń i odbierz 2 jednostki.

                            this.y        += 8;
                            /*
                             * Odsuń gracza od kafelka o 8 jednostek w górę.
                             * Cel: zapobiec "wsiąknięciu" i wielokrotnemu triggerowaniu.
                             * Bez tego: gracz przez kilka ticków byłby na tej samej wysokości
                             * i event triggerowałby się wielokrotnie.
                             */
                            this.event_use  = -3;
                            // Stan "właśnie uderzony" — blokuje kolejne triggery.

                            this.event -= 2;
                            if (this.event < 0) this.event = 0;
                            // Odbierz 2 życia (clampowane do 0, nie ujemne).

                            this.event_send = true; // wyślij klientowi zaktualizowane życia
                            this.target     = null; // reset — to nie była walka z graczem
                            this.jump_frame = 0;    // gracz "odskakuje" od kafelka — reset fizyki

                        } else {
                            // event = 0 → gracz GINIE.

                            if (this.target) {
                                /*
                                 * Był gracz który nas zepchnął na ten kafelek.
                                 * Nagroda: +1000 punktów + +1 do eventu (żywotności).
                                 */
                                this.target.kill_points += 1000;
                                this.target.add_points(1000);
                                this.target.event_send = true;
                                if (this.target.event <= 10) this.target.event++;
                                // Cap na 10 — event zabójcy nie przekracza maksimum.
                            }

                            rmv_player_seg(this, this.lvl);
                            // Usuń z mapy przestrzennej — nie uczestniczy już w kolizjach.

                            if (!this.bot) {
                                // ── ŚMIERĆ GRACZA LUDZKIEGO ──

                                this.is_dead = true;
                                // Gracz "martwi się" — pętla gry pomija jego move(), socket otwarty.

                                this.send_points = this.points - this.account_points;
                                // Ile złota gracz zarobił od ostatniego zapisu do DB.
                                // Zostanie wysłane klientowi przez pakiet type 12.

                                save_player_money(this, this.points - this.account_points);
                                // Zapisz do MongoDB — przy śmierci gracz "inkasuje" nagrody.

                                this.account_points = this.saved_points + this.kill_points;
                                // Zaktualizuj punkt odniesienia dla następnego zapisu.
                                // (saved_points = punkty przy ostatnim checkpoint, kill_points = za zabójstwa)

                                killed_players.push(this.id);
                                // Dodaj ID do kolejki — gen_packet() wyśle pakiet type 5 do wszystkich.

                                return;
                                /*
                                 * PRZERWIJ move() natychmiast!
                                 * Gracz jest martwy — dalsza fizyka bezsensowna.
                                 * return z funkcji zamiast break (jesteśmy w pętli kolizji).
                                 */

                            } else {
                                // ── ŚMIERĆ BOTA ─────────────────────────────────────
                                // Boty się "odradzają" natychmiast, bez ekranu śmierci.

                                this.x = random_pos();
                                this.y = -((Math.pow(this.bot.respawn_lvl, 2) * 10) << 4) * 8 + 30;
                                /*
                                 * Teleportuj bota na jego "stały" poziom (respawn_lvl).
                                 *
                                 * Formuła Y respawnu — obliczenie pozycji pionowej:
                                 *   rl = this.bot.respawn_lvl (np. 5)
                                 *
                                 *   Math.pow(rl, 2) = rl² = 25
                                 *   * 10             = 250    (skalowanie do jednostek mapy)
                                 *   << 4             = × 16  = 4000 (konwersja poziom → jednostki Y, 1 poziom = 16j)
                                 *   * 8              = 32000  (8 podpoziomów na poziom)
                                 *   negacja (-)      → -32000 (Y ujemne = wyżej w cylindrze!)
                                 *   + 30             → -31970 (małe przesunięcie żeby bot pojawiał się POWYŻEJ platformy, nie w niej)
                                 *
                                 * Dlaczego taka skomplikowana formuła?
                                 *   Mapa rośnie kwadratowo (checkpointy co id=10n²).
                                 *   Respawn musi też być kwadratowy żeby trafić w właściwą "sekcję" cylindra.
                                 */

                                // Reset pozycji w rankingu (bot "umiera" i wraca na koniec)
                                for (let y = this.ranking_id + 1; y < ranking.length; y++) {
                                    ranking[y].ranking_id--;
                                    // Wszyscy poniżej awansują o 1 (gracz wychodzi z rankingu).
                                }
                                ranking.splice(this.ranking_id, 1); // usuń z tablicy
                                this.ranking_id = ranking.push(this) - 1; // wstaw na koniec

                                this.points     = Math.pow(players[id].bot.respawn_lvl, 2) * 400;
                                // Resetuj punkty do wartości startowej dla tego poziomu bota.
                                // Wzór: rl=0→0, rl=5→10000, rl=12→57600

                                this.event      = 10; // pełne życie po respawnie
                                this.lvl        = 0;
                                this.event_use  = -2;
                                this.jump_frame = 0;
                                add_player_seg(this, this.lvl); // z powrotem na mapę
                            }
                        }

                    } else {
                        // ── BEZPIECZNA PLATFORMA (zielona) — normalne lądowanie ──

                        if (this.event_use === -3) this.event_use = -2;
                        /*
                         * Jeśli byliśmy w stanie "uderzony" (-3) → reset do normalnego (-2).
                         * Gracz wylądował bezpiecznie po poprzednim odbiciu od czerwonego.
                         */

                        this.target     = null;  // bezpieczne lądowanie = reset "ostatni kolizja z graczem"
                        this.jump_frame = 0;     // lądowanie! reset fizyki skoku — gracz stoi na platformie
                    }
                }
            }

            // ── AWANS NA GŁĘBSZY POZIOM ────────────────────────────────────
            if (idn > this.lvl) {
                /*
                 * Gracz przekroczył granicę aktualnego segmentu.
                 * idn = nowy indeks segmentu (głębszy w cylindrze).
                 * this.lvl = stary indeks segmentu.
                 */

                rmv_player_seg(this, this.lvl); // usuń ze starego segmentu
                add_player_seg(this, idn);       // dodaj do nowego segmentu
                this.lvl = idn;                  // zaktualizuj bieżący poziom

                const rl = Math.sqrt(idn / 10) | 0;
                /*
                 * Oblicz "rangę" (sekcję) na której jest gracz.
                 * sqrt(idn/10) = numer sekcji (zaokrąglony w dół).
                 *   idn=0–9:    sqrt(0–0.9) = 0–0.9  → rl=0 (sekcja 0)
                 *   idn=10–39:  sqrt(1–3.9) = 1–1.97 → rl=1 (sekcja 1)
                 *   idn=40–89:  sqrt(4–8.9) = 2–2.98 → rl=2 (sekcja 2)
                 *   idn=90–159: sqrt(9–15.9)= 3–3.99 → rl=3 (sekcja 3)
                 */
                this.add_points(50 * (rl + 1));
                /*
                 * Punkty za awans. Rosną z każdą sekcją:
                 *   Sekcja 0 (rl=0): 50 × 1 = 50 punktów/awans
                 *   Sekcja 1 (rl=1): 50 × 2 = 100 punktów/awans
                 *   Sekcja 2 (rl=2): 50 × 3 = 150 punktów/awans
                 *
                 * Motywacja: głębsze sekcje = trudniejsza gra = wyższy reward.
                 */

                if (this.respawn_lvl !== rl) {
                    /*
                     * Gracz wkroczył w NOWĄ sekcję (nowa "ranga").
                     * Checkpoint! Aktualizuj punkt respawnu i saved_points.
                     */
                    this.saved_points = this.points - this.kill_points;
                    /*
                     * Zapisz aktualne punkty MINUS kill_points jako "bazę" dla respawnu.
                     * Dlaczego odejmujemy kill_points?
                     *   kill_points są "trwałe" — oddzielnie zachowywane przy respawnie.
                     *   saved_points = "czyste" punkty z przechodzenia przez poziomy.
                     */
                    this.respawn_lvl = rl; // nowy punkt respawnu

                    if (this.event < 10) {
                        this.event++;          // +1 życie za przejście do nowej sekcji
                        this.event_send = true; // wyślij klientowi zaktualizowane życia
                        if (this.event > 10) this.event = 10; // cap na 10
                    }
                }

                // ── WYSYŁKA DANYCH MAPY ───────────────────────────────────
                if (this.lvl > this.send_lvl - 5) {
                    /*
                     * Gracz jest w odległości < 5 poziomów od końca znanych danych mapy.
                     * Czas wysłać kolejną "stronę" (10 poziomów).
                     *
                     * Dlaczego 5 poziomów "z wyprzedzeniem"?
                     *   Gracz może szybko opaść 5 poziomów zanim pakiet dotrze przez sieć.
                     *   5 poziomów buforu = zabezpieczenie przed "renderowaniem w ciemno".
                     */

                    if (this.send_lvl > levels_sav - 10) gen_lvl();
                    /*
                     * Jeśli wygenerowane poziomy kończą się za < 10 kroków → dogeneruj.
                     * levels_sav = ile wygenerowano. send_lvl = co klientowi wysłano.
                     * Generujemy gdy: wysłaliśmy do poziomy blisko końca generowania.
                     */

                    if (!this.bot) {
                        // Boty nie mają socketów — wysyłamy dane mapy TYLKO ludzkim graczom.
                        p.new_type(4);      // typ 4 = dane mapy
                        p.s_length8(10);    // 10 poziomów naraz
                        for (let i = 10; i--;) {
                            p.s_int8_arr(levels[this.send_lvl + i], 128);
                            /*
                             * Serializuj każdy poziom (Uint8Array[128]) do bufora pakietu.
                             * 10 poziomów × 128 bajtów = 1280 bajtów danych mapy.
                             * + nagłówek pakietu = ~1285 bajtów.
                             */
                        }
                        this.send_lvl += 10; // zaktualizuj wskaźnik "do czego wysłano"
                        this.socket.send(Buffer.from(p.get_buf()), true);
                        // Wyślij natychmiast (nie czekamy na gen_packet — dane mapy są priorytetowe).
                    }
                }
            }
        }
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA 16: KONSTRUKTOR BOTA AI
//
//  Boty to gracze sterowane przez serwer, używające prostego algorytmu:
//  "ruszaj losowo w lewo lub prawo przez losowy czas, potem zmień kierunek".
//  Nie używają pathfindingu — wystarczy do ożywienia mapy i tworzenia kolizji.
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Tworzy bota i dodaje go do gry.
 */
function bot() {
    this.move = 0;
    /*
     * Bieżący "tryb ruchu" bota:
     *   0 = stój (bot stoi w miejscu)
     *   1 = ruch w lewo  (x -= losowa wartość 0–3)
     *   2 = ruch w prawo (x += losowa wartość 0–3)
     */

    this.time = 0;
    /*
     * Ile ticków bot będzie wykonywał bieżący ruch zanim zmieni kierunek.
     * Inicjalnie 0 → od razu zmieni kierunek przy pierwszym ticku (b.time < 0 po b.time--).
     * Po pierwszej iteracji: losowany nowy czas 0–99 ticków.
     */

    this.respawn_lvl = (Math.random() * 13) | 0;
    /*
     * Stały "docelowy poziom" bota (0–12).
     * Bot spawnuje na tym poziomie i wraca tu po śmierci.
     * Różne poziomy dla różnych botów = boty są rozłożone po całej długości cylindra.
     * Bez tego: wszystkie 37 botów spawnowałoby na poziomie 0 → sztuczne skupisko.
     *
     * | 0 = Math.floor dla >= 0 (szybki wariant)
     */

    const id     = free_ids.pop();
    /*
     * Pobierz wolne ID z puli.
     * Boty używają tej samej puli ID co ludzie (0–254).
     * Ważne: ID zostaje zwrócone do puli (free_ids.push(id)) TYLKO gdy gracz ludzki wychodzi.
     * Boty NIE zwracają ID (żyją przez cały czas serwera).
     * 37 botów rezerwuje 37 ID na stałe → 255 - 37 = 218 ID dostępnych dla graczy (> MAX_PLAYERS=15).
     */

    const botName = ((Math.random() * 2) | 0) ? '' : getName(3, 8);
    /*
     * 50% szans na pustą nazwę, 50% na losowe imię 3–8 znaków.
     *
     * (Math.random() * 2) | 0 = 0 lub 1 (losowy bit)
     * Warunek: (0) ? '' : getName(...)  → '' (pusty string, falsy → wykonaj rhs)
     * Warunek: (1) ? '' : getName(...)  → '' (truthy → wykonaj lhs → pusty string)
     *
     * Poczekaj — przy (1) wynik to '' (pusty string)?
     * Tak! Mamy tu logikę odwrotną:
     *   (1) ? ''            → truthy  → pusty string
     *   (0) ? '' : getName  → falsy   → losowa nazwa
     * 50% bez nazwy, 50% z nazwą. Boty anonimowe wyglądają jak AFKujący gracze.
     */

    players[id] = new player(id, null, { name: botName, token: null, account: '' });
    // Utwórz obiekt gracza dla bota:
    //   socket = null (bot nie ma połączenia sieciowego)
    //   token = null  (bot nie potrzebuje autoryzacji)
    //   account = ''  (bot nie ma konta MongoDB)

    players[id].skin_id = (Math.random() * 22) | 0;
    // Losowy skin 0–21 (tyle jest skinów w grze).

    players[id].bot = this;
    // Oznacz że ten gracz jest botem — referencja do obiektu Bot.
    // Dzięki temu w move() wiemy: if (this.bot) → zachowanie bota.

    add_player_seg(players[id], 0); // dodaj do mapy przestrzennej na poziomie 0

    // Teleportuj bota na jego "docelowy" poziom
    players[id].x = random_pos();
    players[id].y = -((Math.pow(players[id].bot.respawn_lvl, 2) * 10) << 4) * 8 + 30;
    // Ta sama formuła co przy respawnie — patrz szczegółowy komentarz w move().

    this.player = players[id]; // referencja Bot → Player (dla głównej pętli: bots[i].player.x)

    const startPoints = Math.pow(players[id].bot.respawn_lvl, 2) * 400;
    /*
     * Punkty startowe proporcjonalne do poziomu bota:
     *   rl=0  → 0² × 400 = 0 punktów (nowy gracz na dole)
     *   rl=3  → 9 × 400  = 3600 punktów
     *   rl=7  → 49 × 400 = 19600 punktów
     *   rl=12 → 144 × 400= 57600 punktów (doświadczony gracz blisko szczytu)
     *
     * Bot na poziomie 12 ma punkty adekwatne do gracza który "doszedł" do poziomu 12.
     * Ranking wygląda realistycznie — boty z różnymi poziomami = różne pozycje w rankingu.
     */
    this.player.saved_points = startPoints; // punkt odniesienia dla respawnu
    this.player.points       = startPoints; // aktualne punkty
}




// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA 17: GENEROWANIE PAKIETU WYCHODZĄCEGO
//
//  Wywoływana RAZ NA TICK. Buduje i wysyła pakiety binarne do wszystkich klientów.
//
//  ARCHITEKTURA "GLOBAL + PER-PLAYER":
//    Zamiast wysyłać osobne pakiety dla każdego zdarzenia (join, kill, czat...),
//    zbieramy WSZYSTKIE zdarzenia z ticka i wysyłamy je RAZEM.
//
//    "Global" część:  jeden blok danych wysyłany do WSZYSTKICH graczy
//                    (nowi gracze, zabici, czat, ranking...)
//    "Per-player" część: unikalna dla każdego gracza
//                    (pozycje widzialnych graczy + własne zdarzenia)
//
//    Wynikowy pakiet = global + per-player = jeden send() na klienta
//
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Typy pakietów wychodzących (pierwszy bajt każdego bloku danych):
 *   0  = pozycje widzialnych graczy: [count] ([id x y event_use] × count)
 *   1  = nowi gracze: [count] ([id name skin_id] × count)
 *   2  = gracze którzy wyszli: [count] ([id] × count)
 *   3  = inicjalizacja (tylko raz): [self_id count] ([id name skin_id] × count)
 *   4  = dane mapy: [level_count] ([128 bajtów] × level_count)
 *   5  = zabici: [count] ([id] × count)
 *   6  = odrodzeni: [count] ([id] × count)
 *   7  = lista martwych (przy połączeniu): [count] ([id] × count)
 *   8  = czat: [count] ([id message] × count)
 *   9  = leaderboard: [count] ([id byte_point] × count, max count=6)
 *   10 = własna pozycja rankingowa: [ranking_id byte_point]
 *   11 = event (żywotność): [event_value]
 *   12 = złoto (nagroda po śmierci): [uint32 amount]
 *   13 = zmiana skina: [count] ([id skin_id] × count)
 */
function gen_packet() {

    // ── GLOBALNA CZĘŚĆ WSPOLNA DLA WSZYSTKICH GRACZY NA TYM SERWERZE ────────────────────

    // ── Gracze którzy odłączyli się lub zginęli ──
    if (remove_players.length) {
        // Gracze którzy odłączyli się lub zostali zabici w tym ticku.
        p.new_type(2);
        p.s_length8(remove_players.length); // liczba graczy do usunięcia (uint8)
        for (let i = remove_players.length; i--;) {
            p.s_int8(remove_players[i]); // ID każdego usuniętego gracza
        }
        remove_players = []; // wyczyść po przetworzeniu — nie wysyłaj drugi raz
    }

    // ── Nowi gracze (dołączyli w tej klatce) ──
    if (joined_players.length) {
        // Gracze którzy dołączyli w tym ticku.
        p.new_type(1);
        p.s_length8(joined_players.length);
        for (let i = joined_players.length; i--;) {
            const pl = joined_players[i];
            p.s_int8(pl.id);          // ID nowego gracza
            p.s_string16(pl.name);    // imię: 2 bajty długości + bajty UTF-8
            p.s_int8(pl.skin_id);     // numer skina (0–21)
        }
        joined_players = [];
    }

    // ── Odrodzeni gracze (respawn) ──
    if (respawned_players.length) {
        // Gracze którzy odrodzili się (respawn) w tym ticku.
        p.new_type(6);
        p.s_length8(respawned_players.length);
        for (let i = respawned_players.length; i--;) {
            p.s_int8(respawned_players[i]); // ID odrodzonego
        }
        respawned_players = [];
    }

    // ── Zabici gracze ──
    if (killed_players.length) {
        // Gracze którzy zginęli w tym ticku (klienci ukrywają ich duszki).
        p.new_type(5);
        p.s_length8(killed_players.length);
        for (let i = killed_players.length; i--;) {
            p.s_int8(killed_players[i]); // ID zabitego
        }
        killed_players = [];
    }

    // ── Wiadomości czatu ──
    if (chat_players.length) {
        // Wiadomości czatu zebrane w tym ticku.
        p.new_type(8);
        p.s_length8(chat_players.length);
        for (let i = chat_players.length; i--;) {
            p.s_int8(chat_players[i].id);       // kto wysłał
            p.s_string16(chat_players[i].chat); // treść wiadomości
        }
        chat_players = [];
    }

    // ── Leaderboard (top 6) — tylko gdy ranking się zmienił ──
    if (send_ranking) {
        // Leaderboard zmienił się — wyślij top 6.
        p.new_type(9);
        const l = ranking.length < 6 ? ranking.length : 6;
        // min(aktualnych graczy, 6) — nie możemy wysłać więcej niż mamy.
        p.s_length8(l);
        for (let i = l; i--;) {
            p.s_int8(ranking[i].id);          // ID gracza na pozycji i
            p.s_int8(ranking[i].byte_point);   // jego skompresowane punkty
        }
        send_ranking = false; // zresetuj flagę — nie wysyłaj następnym razem jeśli nic się nie zmieniło
    }

    // ── Zmiany skinów ──
    if (players_cheange_skin.length) {
        // Gracze którzy zmienili skin (np. przy respawnie).
        p.new_type(13);
        p.s_length8(players_cheange_skin.length);
        for (let i = players_cheange_skin.length; i--;) {
            p.s_int8(players_cheange_skin[i].id);
            p.s_uint8(players_cheange_skin[i].skin_id);
            // s_uint8 (bez znaku) — skin_id nigdy nie jest ujemne.
        }
        players_cheange_skin = [];
    }

    p.end_global();
    // Zapamiętaj koniec "globalnej" części bufora.
    // get_uniq_buf() dla każdego gracza = część_globalna + indywidualna tego gracza.
    /*
     * KLUCZOWY KROK: zapamiętaj koniec "globalnej" części bufora.
     *
     * Schemat bufora po end_global():
     * [======== GLOBAL ========][--- PER-PLAYER ---]
     *                           ↑ ten punkt zapamiętany
     *
     * get_uniq_buf() dla gracza A = [GLOBAL][PER_PLAYER_A]
     * get_uniq_buf() dla gracza B = [GLOBAL][PER_PLAYER_B]
     *
     * Każdy gracz dostaje globalną część (tę samą) + swoją unikalną część.
     * Globalna część jest zapisana RAZ w buforze — nie kopiujemy danych.
     */


    // ── Część per-player — różna dla każdego gracza ──
    // ─────────────────────
    for (const i in players) {
        const pl = players[i];
        if (pl.bot) continue;
        // Boty nie mają socketów — nie wysyłamy im niczego.

        // Własna pozycja rankingowa (gdy zmieniła się w tym ticku)
        if (pl.send_rank_pos) {
            p.new_type(10);
            p.s_int8(pl.ranking_id); // pozycja w tablicy ranking[] (0=lider, wyżej=gorszy)
            p.s_int8(pl.byte_point); // skompresowane punkty
            pl.send_rank_pos = false;
        }

        // Zmiana żywotności (event) — gdy gracz uderzył w czerwony lub przeszedł checkpoint
        if (pl.event_send) {
            p.new_type(11);
            p.s_int8(pl.event); // 0–10 — klient renderuje ikony serc/energii
            pl.event_send = false;
        }

        // Nagroda po śmierci (złoto) — wysyłana raz gdy gracz zginął
        if (pl.send_points !== -1) {
            p.new_type(12);
            p.s_uint32(pl.send_points); // uint32 — może być do 66M+ punktów!
            pl.send_points = -1;        // sentinel: "wysłano, nie wysyłaj następnym razem"
        }

        // Pozycje widzialnych graczy — serce aktualizacji pozycji
        p.new_type(0);
        let count        = 0;
        const countIndex = p.index;
        p.index++;
        /*
         * TRICK: zarezerwuj 1 bajt na liczbę graczy ZANIM wiemy ile ich będzie.
         * Zapisujemy count NA KOŃCU (p.int8[countIndex] = count).
         *
         * Dlaczego nie obliczyć count najpierw?
         *   Musielibyśmy dwukrotnie iterować segment_player (raz dla count, raz dla danych).
         *   Lepiej: przejdź raz, zbierz dane, na końcu wstaw count w zarezerwowane miejsce.
         */

        for (let from = pl.lvl - 2, to = pl.lvl + 5; from < to; from++) {
            /*
             * "Widzialność" gracza = segmenty od (lvl-2) do (lvl+4) — 7 segmentów.
             *
             * Dlaczego te zakresy?
             *   lvl-2: gracze powyżej mogą "spaść" na naszego gracza (widać przez 2 segmenty w górę)
             *   lvl+4: gracz widzi kilka segmentów "w dół" cylindra
             *
             * Optymalizacja: nie wysyłamy pozycji graczy na poziomie 50 do gracza na poziomie 1.
             * Mniej danych = mniejszy pakiet = niższy ping.
             */
            if (!segment_player[from]) continue;

            count += segment_player[from].length;
            for (let u = segment_player[from].length; u--;) {
                const visible = segment_player[from][u];
                p.s_int8(visible.id);         // ID gracza (1 bajt)
                p.s_float(visible.x);          // pozycja X (4 bajty, float32)
                p.s_float(visible.y);          // pozycja Y (4 bajty, float32)
                p.s_int8(visible.event_use);   // stan event (1 bajt) — klient renderuje odpowiedni efekt
                // Łącznie: 10 bajtów na gracza.
                // 50 graczy = 500 bajtów danych pozycji na pakiet per-player.
            }
        }
        p.int8[countIndex] = count;
        /*
         * Wstaw liczbę graczy w zarezerwowane miejsce.
         * p.int8 = widok Int8Array na bufor pakietu.
         * Klient odczytuje: count = g_int8(), potem czyta count × 10 bajtów danych.
         */

        if (pl.socket.getBufferedAmount() < 256 * 1024) {
            /*
             * KONTROLA BACKPRESSURE:
             * getBufferedAmount() = ile bajtów czeka w kolejce wysyłki dla tego klienta.
             *
             * Jeśli klient nie nadąża z odbieraniem (słabe połączenie, przepełniony bufor):
             *   < 256 KB → wyślij (klient nadąża)
             *   ≥ 256 KB → pomiń (klient nie nadąża — nie zalewaj go jeszcze bardziej)
             *
             * Bez tej kontroli: serwer by "pompował" dane do przepełnionego bufora.
             * Efekt: rosnące opóźnienie (lag), w końcu disconnect.
             * Z kontrolą: pominięte klatki = klient widzi gorzej przez chwilę, ale nie rozłącza się.
             */
            pl.socket.send(p.get_uniq_buf(), true);
            // get_uniq_buf() = część_globalna + część_per-player tego gracza.
            // true = tryb binarny (nie tekst UTF-8).
        } else {
            p.clear_uniq_buf();
            // Odrzuć per-player część żeby "wyczyścić" bufor dla następnego gracza.
            // Bez tego: następny gracz miałby "błoto" z nieudanej wysyłki poprzedniego.
        }
    }

    p.clear();
    // Wyczyść CAŁY bufor (globalny + wszystkie per-player).
    // Gotowy na następny tick — reużywamy ten sam 5000-bajtowy bufor.
}






/**
 * Sprawdza czy token istnieje i nie wygasł.
 * Prosta funkcja wrapping operacji na obiekcie tokens{}.
 *
 * @param {string} token  UUID tokena z URL WebSocket
 * @returns {boolean}     true = token istnieje i jest ważny
 */
function have_token(token) {
    return !!(tokens[token]);
    /*
     * tokens[token] = wartość pod tym kluczem w obiekcie tokens{}:
     *   {token, name, skin_id, ...} → truthy (obiekt istnieje)
     *   undefined                    → falsy (klucz nie istnieje)
     *   null                         → falsy (token zużyty — ustawiony na null po użyciu)
     *
     * !! (podwójna negacja) konwertuje dowolną wartość na boolean:
     *   !!{...}    = true
     *   !!undefined = false
     *   !!null      = false
     *
     * Równoważne z: return tokens[token] !== null && tokens[token] !== undefined;
     * Ale krócej i bardziej "idiomatyczne" w JS.
     */
}



// ─── WebSocket Server (uWebSockets.js) ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA  : SERWER WEBSOCKET
//
//  Cykl życia połączenia:
//    HTTP Upgrade request → upgrade() [walidacja tokena]
//         ↓
//    Połączenie otwarte → open() [inicjalizacja gracza, dane startowe]
//         ↓
//    Wiadomości → message() [ruch, czat, respawn, event]
//         ↓
//    Rozłączenie → close() [cleanup, zapis punktów]
//
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * Inicjalizuje serwer WebSocket na podanym porcie.
 * Klient łączy się pod: ws://<AGONES_IP>:<AGONES_PORT>/<TOKEN>
 *
 * @param {number} port - lokalny port nasłuchiwania (SERVER_PORT)
 */
function init_server_websocket(port) {
    uWS.App().ws('/*', {
        // '/*' = obsługuj WebSocket pod KAŻDĄ ścieżką (niezależnie od URL po porcie)
        compression: uWS.SHARED_COMPRESSOR,
        /*
         * Kompresja WebSocket (permessage-deflate).
         * SHARED_COMPRESSOR = jeden kontekst kompresji współdzielony przez wszystkich.
         * Mniej pamięci niż DEDICATED (osobny kontekst dla każdego połączenia).
         *
         * Kompresja zmniejsza rozmiar pakietów o 60–80%.
         * Ważne dla graczy mobilnych z ograniczoną transmisją danych.
         * Kosztem: CPU na kompresję/dekompresję — akceptowalny na serwerze gry.
         */


        maxPayloadLength: 16 * 1024 * 1024,
        /*
         * Maksymalny rozmiar JEDNEJ wiadomości od klienta: 16 MB.
         * Ochrona przed atakami DoS: klient wysyłający gigantyczny pakiet zostanie rozłączony.
         * W normalnej grze: pakiety klienta mają < 50 bajtów.
         * 16 MB to bardzo hojny limit — praktycznie bez ograniczeń dla normalnego użycia.
         */


        idleTimeout: 0,
        /*
         * Timeout bezczynności: 0 = wyłączony.
         * Gracz AFK przez godzinę nie zostanie automatycznie rozłączony.
         * Dlaczego? Gracze mogą pauzować grę, wychodzić po piwo itp.
         * Rozłączenie = utrata kontekstu gry = negatywne doświadczenie gracza.
         */


        maxBackpressure: 1024 * 1024,
        /*
         * Maksymalny bufor wysyłki: 1 MB.
         * Gdy getBufferedAmount() > 1 MB → uWS automatycznie rozłącza klienta.
         * My sprawdzamy < 256 KB w gen_packet() i pomijamy pakiety wcześniej.
         * To "twardy limit" na wypadek gdyby nasza kontrola zawodna.
         */

        // ── UPGRADE: HTTP → WebSocket, walidacja przed handshake ──────────
        // ── UPGRADE: Walidacja przed handshake ───────────────────────────

        upgrade: (res, req, context) => {
            /*
             * Wywoływana gdy klient wysyła HTTP request:
             *   GET /abc123-token-uuid HTTP/1.1
             *   Upgrade: websocket
             *   ...
             *
             * To jest MOMENT DECYZJI — akceptujemy lub odrzucamy połączenie.
             * Jeśli odrzucimy: klient dostaje HTTP 401, WebSocket NIE jest otwierany.
             * Tańsze niż odrzucenie po open() (nie tworzymy stanu gracza).
             */


            const url      = req.getUrl();
            // URL ścieżka, np. "/abc123-token-uuid-here"


            const token_id = url.slice(1);
            // Usuń wiodący '/' → "abc123-token-uuid-here"
            // .slice(1) = zwróć podstring od indeksu 1 do końca.


            console.log('[UPGRADE] token z URL:', token_id);
            console.log('[UPGRADE] tokeny w pamięci:', Object.keys(tokens));
            if (!have_token(token_id)) {
                console.log('[UPGRADE] ODRZUCONO - brak tokenu!');
                res.writeStatus('401 Unauthorized').end();
                /*
                 * Token nieznany lub wygasły — odrzuć połączenie.
                 * '401 Unauthorized' = standard HTTP dla "nie masz uprawnień".
                 * .end() finalizuje odpowiedź HTTP bez otwierania WebSocket.
                 */
                // Token nieznany lub wygasły — odrzuć połączenie z HTTP 401.
                // Klient musi ponownie pobrać token z lobby (mother server).


                return;
            }

            res.upgrade(
                { token_id: token_id },
                // Dane przekazywane do getUserData() w open/message/close.
                // Zapisujemy token_id żeby w open() wiedzieć który token zużyć.
                
                req.getHeader('sec-websocket-key'),
                req.getHeader('sec-websocket-protocol'),
                req.getHeader('sec-websocket-extensions'),
                context
                // Cztery parametry wymagane przez protokół WebSocket handshake (RFC 6455).
                // Muszą być przekazane dokładnie w tej kolejności do uWS.
            );
        },


        // ── OPEN: Połączenie nawiązane, inicjalizacja gracza ──────────────
        open: (ws) => {
            const data     = ws.getUserData();
            // Dane powiązane z tym socketem — ustawione w upgrade() → { token_id: "abc123..." }


            const token_id = data.token_id;

            if (ranking.length < 6) send_ranking = true;
            // Nowy gracz zmienia liczebność rankingu → wyślij zaktualizowany top 6.





            /*
               Utwórz obiekt gracza
             */
            const id = free_ids.pop();
            // Pobierz wolne ID dla nowego gracza.

            players[id]         = new player(id, ws, tokens[token_id]);
            players[id].skin_id = tokens[token_id].skin_id;
            // Utwórz obiekt gracza.
            // tokens[token_id] = dane gracza przesłane przez mother server.
            // skin_id w tokenie = skin wybrany w lobby przed dołączeniem.







            // Zużyj token — każdy token jednorazowy (zapobiega wielokrotnemu dołączeniu)
            tokens[token_id] = null;
            delete tokens[token_id];
           /*
             * JEDNORAZOWOŚĆ TOKENA:
             * Ustaw na null i usuń z obiektu.
             * Bez tego: ktoś mógłby otworzyć drugie połączenie z tym samym tokenem.
             * Po delete: have_token() zwróci false → drugi próba = HTTP 401.
             *
             * null + delete = podwójne zabezpieczenie:
             *   null   → wartość falsy → have_token() zwróci false
             *   delete → usuwa klucz   → brak "widma" w obiekcie tokens{}
             */



            data.player = players[id]; // przypisz gracza do danych socketa
            player_length++;           // zaktualizuj licznik (będzie wysłany do Redis)
            // zaktualizuj licznik (Redis synchronizowany co ~1s)


            // Anuluj timer zamykania serwera jeśli gracz dołączył zanim zdążył odliczać
            if (shutdown_timer) {
                clearTimeout(shutdown_timer);
                shutdown_timer = null;
                console.log("Gracz powrócił, anulowano zamykanie serwera.");
            }
                        /*
             * ANULOWANIE TIMERA ZAMKNIĘCIA po powrocie gracza.
             *
             * Kontekst: w callbacku close() gdy serwer pustoszeje startowany jest
             * shutdown_timer (setTimeout) — opóźnione zamknięcie serwera.
             * Ale co jeśli nowy gracz dołączy ZANIM timer dobiegnie końca?
             *
             * shutdown_timer to uchwyt zwrócony przez setTimeout().
             * clearTimeout(shutdown_timer) — anuluje zaplanowane wywołanie.
             * shutdown_timer = null — czyścimy referencję (garbage collector może zwolnić pamięć).
             *
             * Bez tego sprawdzenia: nowy gracz dołącza → za chwilę serwer się zamyka
             * bo stary timer z poprzedniej sesji nie został anulowany.
             * Wyścig między dołączaniem a zamykaniem = nieoczekiwane disconnekty.
             */



            if (player_length === 1 && !is_allocated) {
                is_allocated = true;
                console.log("Wszedł pierwszy gracz! Wywołuję allocate()...");
              if (USE_AGONES)  agonesSDK.allocate().catch(console.log);
               // allocate() → serwer w stanie Allocated nie zostanie zabrany przez autoskalera.
                // Serwer "Reserved" dla tej konkretnej sesji gry.
            }
            /*
             * PRZEJŚCIE AGONES: Ready → Allocated przy PIERWSZYM graczu.
             *
             * player_length === 1: sprawdzamy dokładnie "1" bo właśnie wykonano player_length++
             *   na linii powyżej — czyli to jest pierwsza osoba która dołączyła.
             *
             * !is_allocated: guard (strażnik) przed wielokrotnym wywołaniem allocate().
             *   allocate() jest idempotentne (wywołanie 2× nie psuje), ale generuje niepotrzebne
             *   logi i requesty do Agones SDK. Flaga is_allocated zapobiega temu.
             *
             * agonesSDK.allocate():
             *   Sygnalizuje Agones że ten serwer ma teraz przydzieloną sesję gry.
             *   Agones zmienia stan GameServera: Ready → Allocated.
             *   W stanie Allocated: autoskaler NIE usunie tego poda nawet jeśli klaster
             *   jest przeciążony — serwer z graczami jest chroniony.
             *
             * .catch(console.log): błąd allocate() logujemy ale nie crashujemy serwera.
             *   Gracz może grać normalnie nawet jeśli Agones chwilowo niedostępny.
             *
             * USE_AGONES: flaga globalna — w trybie lokalnym (development bez K8s)
             *   pomijamy wszystkie wywołania SDK żeby nie dostawać błędów połączenia.
             */



            add_player_seg(players[id], 0); // gracz startuje na poziomie 0
            /*
             * Dodaj segmenty (kolumny) gracza do globalnej mapy segmentów.
             * Drugi argument 0 = poziom 0 (gracz dopiero dołączył, ma 0 poziomów).
             *
             * Segmenty to "wieża" gracza — im wyższy poziom, tym więcej segmentów (wyższa wieża).
             * Segment to jeden "blok" w kolumnie gracza, zajmujący określone pozycje Y na mapie.
             * Mapa segmentów służy do wykrywania kolizji — zamiast sprawdzać każdego gracza
             * z każdym (O(n²)), sprawdzamy tylko segmenty w tym samym miejscu mapy (O(1)).
             *
             * lvl=0 przy wejściu: nowy gracz startuje bez wieży — tylko jego "głowa" jest
             * wpisana do segmentów. Wieża rośnie w miarę jak gracz zdobywa poziomy.
             */




            // ── Pakiet inicjalizacyjny: type 3 = pełna lista graczy ──
            p.new_type(3);
            p.s_uint8(id); // własne ID nowego gracza (musi wiedzieć który to "ja")
            p.s_length8(Object.keys(players).length); // łączna liczba graczy (w tym boty)
            /*
             * ── PAKIET TYPU 3: "Witaj w grze" — stan wszystkich graczy ──
             *
             * Wysyłany TYLKO do nowo dołączonego gracza (ws.send poniżej).
             * Informuje klienta: "jesteś graczem o ID=X, a oto lista wszystkich
             * graczy aktualnie w grze".
             *
             * p.new_type(3) — zacznij nowy pakiet (nagłówek z numerem 3).
             *
             * p.s_uint8(id) — ID przydzielone nowemu graczowi (z puli free_ids).
             *   Klient musi wiedzieć które ID to "ja" żeby poprawnie renderować
             *   swój avatar i ignorować własny ruch wysyłany z serwera.
             *
             * p.s_length8(Object.keys(players).length) — liczba graczy (wliczając nowego).
             *   Object.keys(players) = tablica kluczy obiektu players{} = lista ID.
             *   .length = ile jest graczy łącznie.
             *   Klient wie ile razy ma czytać pętlę poniżej (ile rekordów gracza nastąpi).
             */



            const killed = []; // lista graczy aktualnie martwych
            for (const i in players) {
                const pl = players[i];
                if (pl.is_dead) killed.push(pl.id);
                p.s_uint8(pl.id);        // ID każdego gracza
                p.s_string16(pl.name);   // imię
                p.s_uint8(pl.skin_id);   // skin
            }
            // Nowy gracz dostaje pełną listę żeby wiedzieć kto już jest na mapie.
            /*
             * Iteracja po WSZYSTKICH graczach (w tym nowym) — zapis ich danych do pakietu.
             *
             * for...in na obiekcie: iteruje po kluczach (i = id gracza jako string).
             * players[i] = obiekt gracza.
             *
             * Zbieranie killed[]:
             *   Jednocześnie budujemy listę martwych graczy.
             *   Nowy gracz musi wiedzieć kto jest martwy → żeby nie renderować ich avatarów
             *   jako żywych i poprawnie wyświetlić overlay "ten gracz umarł".
             *
             * Dla każdego gracza serializujemy:
             *   p.s_uint8(pl.id)       — ID (0-254, 1 bajt)
             *   p.s_string16(pl.name)  — nick gracza (2 bajty długość + bajty UTF-8)
             *   p.s_uint8(pl.skin_id)  — wybrany skin (0-254, 1 bajt)
             *
             * Klient na podstawie tych danych tworzy lokalną listę graczy i renderuje ich.
             */



            // Lista martwych graczy (typ 7) — klient ich ukrywa do respawnu
            p.new_type(7);
            p.s_length8(killed.length);
            for (let i = killed.length; i--;) {
                p.s_uint8(killed[i]);
            }
            /*
             * ── PAKIET TYPU 7: Lista martwych graczy ──
             *
             * Wysyłany razem z pakietem 3 (w tym samym buforze przed ws.send).
             * Klient musi wiedzieć którzy gracze są w stanie "martwy" żeby:
             *   - Ukryć ich avatary (nie renderować)
             *   - Nie wykrywać z nimi kolizji
             *   - Wyświetlić odpowiednią ikonę na rankingu
             *
             * p.s_length8(killed.length) — ile martwych graczy nastąpi.
             * Pętla od końca (i--): efektywna iteracja bez tworzenia licznika osobno.
             *   killed[i] = id martwego gracza (uint8, 1 bajt)
             *
             * Dlaczego oddzielny pakiet zamiast flagi is_dead w pakiecie 3?
             *   Separacja odpowiedzialności — pakiet 3 = "kto jest w grze",
             *   pakiet 7 = "kto jest martwy". Klient może je obsługiwać niezależnie.
             *   Też w późniejszej grze typ 7 może być wysyłany samodzielnie (bez 3).
             */


             // Aktualny ranking (typ 9)
            p.new_type(9);
            const rankLen = ranking.length < 6 ? ranking.length : 6;
            p.s_length8(rankLen);
            for (let i = rankLen; i--;) {
                p.s_int8(ranking[i].id);
                p.s_int8(ranking[i].byte_point);
            }
            ws.send(Buffer.from(p.get_buf()), true);
            /*
             * ── PAKIET TYPU 9: Top 6 ranking ──
             *
             * ranking.length < 6 ? ranking.length : 6:
             *   Ternary (skrócone if/else) — bierz min(ranking.length, 6).
             *   Jeśli jest mniej niż 6 graczy → wyślij tyle ile jest.
             *   Jeśli jest 6 lub więcej → wyślij tylko top 6.
             *   Dlaczego 6? Tyle pozycji wyświetla UI rankingu na ekranie klienta.
             *
             * ranking[i].id         — ID gracza w rankingu (int8, bo może być -1 jako sentinel)
             * ranking[i].byte_point — spakowane punkty (int8: -128 do 127, przeskalowane z pełnej wartości)
             *
             * ws.send(Buffer.from(p.get_buf()), true):
             *   Wyślij cały bufor (typy 3 + 7 + 9 sklejone) do nowego gracza.
             *   Buffer.from() — konwertuje ArrayBuffer (z pakietów) na Node.js Buffer.
             *   true — tryb binarny (nie tekstowy). WebSocket może działać w obu trybach.
             *   Bez `true` uWS wysłałoby tekst UTF-8 zamiast raw binary → klient błędnie odczytałby dane.
             *
             * Po tym ws.send bufor p jest czyszczony przez następne p.new_type(4).
             */




            // ── Dane pierwszych 10 poziomów mapy (typ 4) ──
            p.new_type(4);
            p.s_length8(10);
            for (let i = 10; i--;) {
                p.s_int8_arr(levels[i], 128);
            }
            ws.send(Buffer.from(p.get_buf()), true);
            // Klient nie może renderować gry bez danych mapy — wysyłamy od razu przy połączeniu.

         /*
             * ── PAKIET TYPU 4: Mapa poziomów (levels) ──
             *
             * Wysyłany OSOBNO (drugi ws.send) bo jest duży — nie miesza się z pakietem powitalnym.
             *
             * levels[] — globalna tablica przechowująca ukształtowanie terenu.
             *   levels[i] = tablica 128 wartości int8 opisująca "profil" poziomu i.
             *   10 poziomów × 128 wartości = 1280 bajtów danych mapy.
             *
             * p.s_length8(10) — informuje klienta: "nastąpi 10 poziomów".
             * p.s_int8_arr(levels[i], 128) — zapisz 128 wartości int8 naraz (bulk write).
             *   Szybsze niż 128 × p.s_int8() w pętli — jeden memcpy zamiast 128 wywołań.
             *
             * Dlaczego mapa wysyłana przy dołączeniu, a nie co tick?
             *   Mapa jest STATYCZNA — nie zmienia się podczas trwania serwera.
             *   Wysyłamy ją raz przy połączeniu. Gdybyśmy wysyłali co tick:
             *   1280 bajtów × 62.5 ticków × 15 graczy = 1.2 MB/s samej mapy! Bez sensu.
             *
             * Klient buforuje mapę lokalnie i używa przez całą sesję.
             */




            // Inni gracze dowiedzą się o nowym graczu w następnym ticku (gen_packet type 1).
            joined_players.push(players[id]);
            /*
             * Dodaj gracza do listy "właśnie dołączyli" — przetwarzanej w gen_packet().
             *
             * gen_packet() co tick wysyła do POZOSTAŁYCH graczy informację o nowo dołączonym.
             * Pozostali gracze muszą dodać nowego do swojej lokalnej listy i wyrenderować go.
             *
             * Dlaczego lista zamiast bezpośredniego wysyłania?
             *   Pętla gry (setInterval) działa co 16ms. Może dołączyć kilku graczy
             *   między jednym tikiem a następnym. Lista zbiera ich wszystkich → gen_packet()
             *   przetwarza całą paczkę razem (jeden pakiet zawierający wielu nowych graczy
             *   zamiast osobnego pakietu per gracz → mniejszy overhead nagłówków).
             */

            data.pg = new packet_get();
            // Utwórz parser pakietów dla tego połączenia.
            // Każde połączenie ma własną instancję (niezależne bufory odczytu).
            /*
             * Utwórz parser pakietów przychodzących (wejście od klienta) dla tego gracza.
             *
             * packet_get to klasa ze ./binary.js — czyta binarne dane przychodzące od klienta.
             * Każdy gracz ma WŁASNĄ instancję parsera (data.pg = per-connection).
             *
             * Dlaczego nie jedna globalna instancja packet_get?
             *   packet_get jest STATEFUL — przechowuje wskaźnik pozycji czytania (offset).
             *   Gdyby była globalna: gracz A ustawia offset=5, serwer odbiera wiadomość od B,
             *   B resetuje offset=0, A czyta od 0 zamiast 5 → błędne dane.
             *   Jedna instancja per gracz = izolacja stanu parsowania.
             */
        },



        // ── MESSAGE: Obsługa wiadomości od gracza  ────────────────────────
        message: (ws, message, isBinary) => {
            const data = ws.getUserData();
            const pl   = data.player;
            if (!pl) return; // gracz jeszcze nie zainicjalizowany (race condition) — ignoruj
            /*
             * ws.getUserData() — pobierz dane przypisane do tego połączenia (ustawione w upgrade()).
             * data.player — obiekt gracza (null jeśli gracz nie przeszedł jeszcze upgrade/open).
             *
             * if (!pl) return — guard clause:
             *   Jeśli wiadomość przychodzi PRZED zakończeniem open() (race condition przy
             *   bardzo szybkim kliencie) → pl może być null → return zapobiega crash.
             *   W praktyce rzadkie, ale serwer gry musi być odporny na wszelkie kolejności zdarzeń.
             */


            const p = data.pg.set_buffer(message);
            // Ustaw bufor odczytu na odebraną wiadomość i zwróć parser.
           /*
             * Ustaw bufor parsera na właśnie otrzymaną wiadomość binarną.
             * set_buffer() resetuje wewnętrzny offset do 0 i zwraca this (dla chaining).
             *
             * message = ArrayBuffer z danymi binarnymi od klienta (np. [0x00, 0x05] = ruch w prawo o 5).
             * Każde wywołanie message() to OSOBNA wiadomość — parser startuje od początku.
             */








            // g_uint8() odczytuje pierwszy bajt = typ pakietu.
            switch (p.g_uint8()) { 
            /*
             * p.g_uint8() — odczytaj pierwszy bajt wiadomości = TYP POLECENIA.
             * Przesuwa wewnętrzny wskaźnik o 1 bajt (kolejne g_*() będą czytać dalej).
             *
             * switch zamiast if/else:
             *   switch na stałych wartościach jest przez silnik JS (V8) kompilowany
             *   do tablicy skoków (jump table) — O(1) zamiast O(n) sprawdzeń.
             *   Przy 60 wiadomościach/s od 15 graczy = 900 sprawdzeń/s → warto.
             */







                // Ruch poziomy — klient wysyła delta X (int8: -128 do 127)
                case 0: {
                    /*
                     * ── TYP 0: Ruch poziomy gracza ──
                     *
                     * Klient wysyła ten pakiet gdy gracz naciska strzałkę/WASD.
                     * Struktura: [0x00] [dx: int8]
                     */
                    
                    const dx  = p.g_int8();
                    /*
                     * dx = delta X = o ile pikseli gracz poruszył się w poziomie.
                     * int8: zakres -128 do 127 (ujemne = lewo, dodatnie = prawo).
                     * Klient wysyła już przeliczoną wartość ruchu (uwzględnia prędkość gracza).
                     */

                    pl.move_x = dx;   // zapamiętaj delta (używane w move() przy kolizjach)
                    pl.x     += dx;   // natychmiast zastosuj ruch (redukcja lagbacku)
                    pl.x     &= 0x3ff; // wrap-around (np. x=-1 → x=1023, wrap cylindra)
                    /*
                     * pl.move_x = dx — zapamiętaj wektor ruchu (używany w gen_packet()
                     *   do wysyłania pozycji do innych graczy).
                     *
                     * pl.x += dx — natychmiastowa aktualizacja pozycji po stronie serwera.
                     *   Serwer jest "autorytetem" — jego pozycja jest prawdziwa.
                     *   Klient też aktualizuje lokalnie (client-side prediction), ale serwer
                     *   to weryfikuje i koryguje jeśli się rozjadą.
                     *
                     * pl.x &= 0x3ff — bitowe AND z 0x3ff (binarnie: 0011 1111 1111 = 1023).
                     *   Efekt: pl.x = pl.x % 1024 (ale szybciej — bitowe AND zamiast modulo).
                     *   Mapa ma szerokość 1024 jednostek i jest CYLINDRYCZNA (zapętlona w poziomie).
                     *   Gdy gracz wychodzi za prawy brzeg (x=1024) → pojawia się po lewej (x=0).
                     *   &= 0x3ff to efektywny sposób na "zawijanie" współrzędnej bez if/else.
                     *
                     *   Przykład:
                     *     pl.x = 1020, dx = 10 → pl.x = 1030 → 1030 & 1023 = 6 (przeskoczył na lewo)
                     *     pl.x = 500,  dx = -10 → pl.x = 490 → 490 & 1023 = 490 (normalny ruch)
                     */
                    break;
                }










                case 8: {
                    /*
                     * ── TYP 8: Respawn (odrodzenie po śmierci) ──
                     *
                     * Klient wysyła gdy gracz naciśnie przycisk "Zagraj ponownie" po śmierci.
                     * Struktura: [0x08] [ads: int8] [skin_id: uint8]
                     */
                    // Respawn — klient wysyła gdy potwierdza respawn (po obejrzeniu reklamy)
                    const ads     = p.g_int8();  // czy oglądał reklamę (bool jako int8)
                    const skin_id = p.g_uint8(); // wybrany skin (może się zmienić między śmierciami)
                    /*
                     * ads:
                     *   Flaga czy gracz obejrzał reklamę przed respawnem.
                     *   ads === true (lub 1?) → gracz dostaje bonus startowy 2500 punktów.
                     *   Mechanizm monetyzacji: "obejrzyj reklamę, zacznij z przewagą".
                     *   UWAGA: ads === true sprawdza wartość int8 przez ===, co jest podejrzane
                     *   (int8 to liczba, nie boolean). Może być błąd lub celowa konwencja (1 = true).
                     *
                     * skin_id:
                     *   Gracz może zmienić skin przy respawnie (wybór w ekranie śmierci).
                     *   Wczytujemy nowy skin_id z pakietu i porównamy z poprzednim.
                     */




                    if (pl.is_dead) {
                        /*
                         * Sprawdzamy is_dead — zabezpieczenie przed "podwójnym respawnem".
                         * Złośliwy klient mógłby wysłać pakiet 8 gdy gracz jest żywy.
                         * Bez sprawdzenia: punkty byłyby resetowane, pozycja losowana = exploit.
                         */

                        pl.is_dead = false;
                        respawned_players.push(pl.id);
                        // Powiadom innych graczy że ten gracz znów żyje (gen_packet type 6).
                        /*
                         * is_dead = false — gracz ożył.
                         * respawned_players[] — lista przetwarzana w gen_packet():
                         *   inni gracze dostaną informację "gracz X odrodzył się" →
                         *   ich klienty przywrócą avatar X na ekranie.
                         */



                        // Teleport na ostatni checkpoint (respawn_lvl)
                        pl.x = random_pos();
                        pl.y = -((Math.pow(pl.respawn_lvl, 2) * 10) << 4) * 8 + 30;
                        // Ta sama formuła co w move() dla śmierci bota.
                        /*
                         * Losuj pozycję startu:
                         *   pl.x = random_pos() — losowa pozycja X w zakresie [0, 1024).
                         *
                         * Oblicz pozycję Y (wysokość odrodzenia):
                         *   pl.respawn_lvl — liczba śmierci gracza (rośnie co śmierć).
                         *
                         *   Wzór: y = -(respawn_lvl² × 10 << 4) × 8 + 30
                         *
                         *   << 4 = mnożenie przez 16 (przesunięcie bitowe, szybsze niż × 16).
                         *   Przykład dla respawn_lvl = 0 (pierwsza śmierć):
                         *     -(0² × 10 × 16) × 8 + 30 = -(0) + 30 = 30
                         *   Dla respawn_lvl = 2:
                         *     -(4 × 10 × 16) × 8 + 30 = -(640 × 8) + 30 = -5120 + 30 = -5090
                         *
                         *   Ujemne Y = wysoko nad mapą (oś Y rośnie w dół).
                         *   Im więcej razy gracz umarł, tym wyżej spada → dłuższy lot → więcej czasu
                         *   bez kontroli → kara za częste umieranie.
                         */




                        // Zmiana skina jeśli gracz wybrał inny po śmierci
                        if (pl.skin_id !== skin_id) {
                            players_cheange_skin.push(pl); // inni dowiedzą się o zmianie (type 13)
                            pl.skin_id = skin_id;
                        }
                        /*
                         * Zmiana skina przy respawnie (opcjonalna):
                         *   Jeśli nowy skin_id różni się od poprzedniego → gracz zmienił wygląd.
                         *   players_cheange_skin[] — lista przetwarzana w gen_packet():
                         *     inni gracze dostaną pakiet "gracz X zmienił skin na Y".
                         *   pl.skin_id = skin_id — zaktualizuj skin po stronie serwera.
                         *
                         * Dlaczego tylko przy różnicy (pl.skin_id !== skin_id)?
                         *   Unikamy wysyłania zbędnego pakietu gdy skin się nie zmienił.
                         *   "cheange" w nazwie to literówka od "change" — zachowana w kodzie.
                         */


                        // Reset pozycji w rankingu (po śmierci gracz wraca na koniec)
                        for (let y = pl.ranking_id + 1; y < ranking.length; y++) {
                            ranking[y].ranking_id--;
                        }
                        ranking.splice(pl.ranking_id, 1);
                        pl.ranking_id = ranking.push(pl) - 1; // dodaj na koniec
                        
                        /*
                         * PRZEPOZYCJONOWANIE W RANKINGU po respawnie:
                         *
                         * ranking[] = posortowana tablica graczy według punktów.
                         * pl.ranking_id = indeks tego gracza w tablicy ranking[].
                         *
                         * Problem: gdy gracz respawnuje, traci punkty (zaczyna od 0/2500).
                         * Musi "spaść" na koniec rankingu (ostatnie miejsce).
                         *
                         * Krok 1: zaktualizuj ranking_id graczy PONIŻEJ:
                         *   for y = pl.ranking_id+1 to końca: ranking[y].ranking_id--
                         *   Każdy gracz który był "za" naszym graczem przesuwa się o 1 w górę.
                         *
                         * Krok 2: usuń gracza z jego obecnej pozycji:
                         *   ranking.splice(pl.ranking_id, 1) — usuń 1 element na pozycji ranking_id.
                         *
                         * Krok 3: dodaj gracza na koniec (najgorsze miejsce):
                         *   ranking.push(pl) — dodaj na koniec tablicy.
                         *   push() zwraca NOWĄ długość tablicy.
                         *   pl.ranking_id = push() - 1 = indeks ostatniego elementu.
                         *
                         * Dlaczego nie sortujemy po każdej zmianie?
                         *   sort() = O(n log n), ręczne aktualizacje = O(n) → szybciej.
                         *   Przy 50 graczach i 62.5 tickach/s: każde sort() to ~6250 porównań/s vs ~3125.
                         */

                        

                        // Punkty startowe po respawnie
                        pl.points = (ads === true) ? 2500 : 0;
                        // Bonus 2500 za obejrzenie reklamy (monetyzacja).
                        pl.add_points(pl.saved_points + pl.kill_points);
                        // Odzyskaj punkty z ostatniego checkpointu + punkty za zabójstwa.
                        // Kill_points są "trwałe" — nie tracisz ich przy śmierci.
                        /*
                         * Resetowanie i ustawianie punktów po respawnie:
                         *
                         * pl.points = (ads === true) ? 2500 : 0:
                         *   Baza punktów po respawnie — 0 lub 2500 (bonus za reklamę).
                         *
                         * pl.add_points(pl.saved_points + pl.kill_points):
                         *   saved_points  — punkty "zachowane" z poprzedniego życia (mechanika gry).
                         *   kill_points   — punkty za zabicia w poprzednim życiu.
                         *   add_points() dodaje je do pl.points i aktualizuje ranking.
                         *
                         *   Dzięki temu gracz nie traci WSZYSTKIEGO po śmierci — zachowuje
                         *   część dorobku, co motywuje do dalszej gry.
                         */




                        pl.lvl        = 0;
                        pl.event_use  = -2;
                        pl.jump_frame = 0;
                        add_player_seg(pl, pl.lvl); // z powrotem na mapę
                        /*
                         * Reset stanu gracza do wartości startowych:
                         *
                         * pl.lvl = 0:
                         *   Gracz traci całą wieżę (wróci do poziomu 0).
                         *   Wieża rośnie od nowa w miarę zdobywania punktów.
                         *
                         * pl.event_use = -2:
                         *   -2 = specjalna wartość "gracz właśnie respawnował".
                         *   W logice eventów: -2 oznacza "nie można użyć eventu przez chwilę"
                         *   (gracz musi wylądować zanim będzie mógł aktywować power-up).
                         *   -1 = event w trakcie użycia, ≥0 = event dostępny.
                         *
                         * pl.jump_frame = 0:
                         *   Resetuje licznik klatki skoku — gracz "leci w dół" od razu
                         *   (nie ma impulsu skoku na start, ląduje siłą grawitacji).
                         *
                         * add_player_seg(pl, 0):
                         *   Dodaj gracza do mapy segmentów na poziomie 0 (bez wieży).
                         *   Konieczne bo rmv_player_seg() zostało wywołane przy śmierci.
                         */
                    }
                    break;
                }

                case 1: {
                    /*
                     * ── TYP 1: Wiadomość czatu ──
                     *
                     * Klient wysyła gdy gracz wpisze wiadomość i naciśnie Enter.
                     * Struktura: [0x01] [text: string16 (2B długość + bajty UTF-8)]
                     */
                    // Wiadomość czatu — tekst od gracza
                    const text = p.g_string16(); // odczytaj string z 2-bajtowym prefixem długości
                    pl.chat    = text;
                    // uniq_push — jeden gracz nie może wysłać tej samej wiadomości dwukrotnie
                    chat_players.uniq_push(pl); 
                    /*
                     * g_string16() — odczytaj string: najpierw 2 bajty jako długość,
                     *   potem tyle bajtów UTF-8 jako treść. Dekoduje do JS string.
                     *
                     * pl.chat = text — zapisz wiadomość na obiekcie gracza.
                     *   gen_packet() odczyta pl.chat i wyśle do wszystkich graczy.
                     *
                     * chat_players.uniq_push(pl) — dodaj gracza do listy "czekają na wysyłkę".
                     *   uniq_push() zapobiega duplikatom jeśli gracz wyśle 2 wiadomości
                     *   w jednym tiku (np. szybkie wciśnięcia Enter).
                     *   W praktyce tylko jedna wiadomość zostanie wysłana — ostatnia zapisana w pl.chat.
                     *
                     */
                    break;
                }

                case 2: {
                    /*
                     * ── TYP 2: Użycie eventu (power-up) ──
                     *
                     * Klient wysyła gdy gracz aktywuje zebrany power-up (np. tarczę, przyspieszenie).
                     * Struktura: [0x02] — brak dodatkowych danych, sam typ wystarczy.
                     */
                       // Użycie eventu (np. aktywacja power-upa / skoku)
                    if (pl.event > 0 && pl.event_use !== -1) {
                        // Musimy mieć life > 0 i nie być już w stanie "używania" (-1).
                        pl.event_use  = -1; // stan "używam eventu" — zaznacza flagę
                        pl.event--;         // zużyj 1 punkt życia
                        pl.event_send = true; // zaktualizuj UI klienta
                    }
                    /*
                     * pl.event > 0:
                     *   Gracz musi mieć przynajmniej jeden event do użycia.
                     *   pl.event = liczba zebranych power-upów (zwiększa się przez zbieranie itemów).
                     *   Bez sprawdzenia: złośliwy klient mógłby wysyłać pakiet 2 bez końca.
                     *
                     * pl.event_use !== -1:
                     *   -1 = event jest właśnie w trakcie użycia (trwa efekt).
                     *   Zapobiega "stackowaniu" wielu eventów jednocześnie.
                     *   Dopiero gdy efekt się skończy (event_use wróci do ≥0), można użyć kolejnego.
                     *
                     * pl.event_use = -1:
                     *   Oznacz event jako "w użyciu" — zablokuj kolejne użycie.
                     *
                     * pl.event--:
                     *   Zużyj jeden event z puli (odejmij od licznika).
                     *
                     * pl.event_send = true:
                     *   Flaga dla gen_packet() — wyślij do innych graczy informację
                     *   że gracz X aktywował power-up (inne klienty mogą odtworzyć animację/efekt).
                     */
                    break;
                }
            }
        },









        // ── CLOSE: Rozłączenie gracza — sprzątanie ────────────────────────

        // ── CLOSE: Rozłączenie klienta ────────────────────────────────────
        close: (ws, code, message) => {
            // code = kod zamknięcia WebSocket (1000 = normalne, 1006 = zerwane połączenie itp.)
            // message = opcjonalna wiadomość zamknięcia (zwykle pusty Buffer)
            const data = ws.getUserData();
            const pl   = data.player;
            if (!pl) return; // gracz nie zainicjalizowany (np. token failure) — ignoruj
            /*
             * Callback wywoływany gdy połączenie WebSocket zostaje zamknięte.
             * Może nastąpić z powodu:
             *   - Gracz świadomie wyszedł (zamknął kartę/grę)
             *   - Utrata połączenia (internet, router)
             *   - Timeout (zbyt długi brak aktywności)
             *   - Błąd sieci
             *
             * code    = kod zamknięcia WebSocket (1000 = normalne, 1006 = błąd sieci itp.)
             * message = opcjonalny powód zamknięcia (często pusty)
             * Nie używamy ich — traktujemy każde zamknięcie identycznie (sprzątanie).
             *
             * if (!pl) return: jeśli gracz rozłączy się PRZED zakończeniem open()
             *   (np. przerwał połączenie w trakcie handshake), pl = null → wychodzimy.
             *   Bez tego guard: próba dostępu do pl.ranking_id → TypeError: null.ranking_id.
             */



            player_length--;
            /*
             * Zmniejsz globalny licznik graczy.
             * Wartość jest synchronizowana z Redis co ~1 sekundę przez redis_update_player_count().
             * Lobby odczyta zaktualizowaną wartość i może wysłać nowych graczy jeśli jest miejsce.
             */
 
            save_player_money(pl, pl.points - pl.account_points);
            // Zapisz punkty zarobione od ostatniego zapisu (mogło być dużo).
            // pl.points - pl.account_points = ile zarobił od ostatniego save_player_money.
            /*
             * Zapisz zarobione monety/punkty do bazy danych (MongoDB).
             *
             * pl.points         — aktualne punkty po rozłączeniu.
             * pl.account_points — punkty które BYŁY na koncie gdy gracz dołączył (wczytane z MongoDB).
             * różnica = ile punktów gracz ZAROBIŁ w tej sesji.
             *
             * save_player_money() wysyła do MongoDB: { $inc: { money: różnica } }
             * $inc zamiast $set — atomowe dodawanie, bezpieczne przy równoczesnym dostępie.
             *
             * Dlaczego różnica a nie pl.points wprost?
             *   Gracz mógł mieć 1000 punktów na koncie PRZED sesją (account_points = 1000).
             *   Zarobił jeszcze 500 (pl.points = 1500 na koncie i 500 w grze = 2000 total?).
             *   Logika punktów — zapisujemy tylko przyrost, nie nadpisujemy.
             */

            if (pl.ranking_id < 6) send_ranking = true;
            // Usunięcie kogoś z top 6 → wyślij zaktualizowany ranking.
            /*
             * Jeśli gracz był w top 6 rankingu → flaga do wysyłki zaktualizowanego rankingu.
             * Po jego wyjściu ranking się zmienia → inni gracze muszą to zobaczyć.
             * Jeśli był poza top 6 (ranking_id ≥ 6) → ranking top 6 się nie zmienił → bez wysyłki.
             */



            // Przesuń pozostałych graczy w rankingu (usuwa "dziurę")
            for (let y = pl.ranking_id + 1; y < ranking.length; y++) {
                ranking[y].ranking_id--;
            }
            ranking.splice(pl.ranking_id, 1); // usuń gracza z tablicy rankingu

            /*
             * Usuń gracza z tablicy ranking[]:
             *
             * Krok 1: zaktualizuj ranking_id graczy PONIŻEJ rozłączonego:
             *   Każdy kto był "za" wychodzącym graczem teraz przesuwa się o 1 w górę (ranking_id--).
             *   Bez tego: po splice() indeksy w ranking[] się przesuwają ale
             *   pl.ranking_id w obiektach graczy pozostają stare → niespójność.
             *
             * Krok 2: ranking.splice(pl.ranking_id, 1) — usuń 1 element.
             *   Taka sama logika jak przy respawnie (case 8).
             */





            remove_players.push(pl.id);
            // Inni gracze dowiedzą się o rozłączeniu w następnym ticku (gen_packet type 2).

            rmv_player_seg(pl, pl.lvl); // usuń z mapy przestrzennej
            /*
             * remove_players[] — lista ID graczy do usunięcia przetwarzana w gen_packet().
             *   gen_packet() wyśle do pozostałych graczy pakiet "gracz X wyszedł" →
             *   ich klienty usuną avatar X z renderowania.
             *
             * rmv_player_seg(pl, pl.lvl) — usuń segmenty gracza z mapy kolizji.
             *   Analogicznie do add_player_seg() przy dołączaniu, ale odwrotnie.
             *   pl.lvl = aktualny poziom gracza (decyduje ile segmentów do usunięcia).
             *   Bez tego: "duch" gracza nadal zajmuje segmenty → inne obiekty "zderzają się"
             *   z nieistniejącym graczem → błędy fizyki.
             */



            // Zwróć ID do puli — może być użyte przez nowego gracza
            free_ids.push(pl.id);
            players[pl.id] = null;
            delete players[pl.id];
            data.player = null;  // usuń referencję do gracza (garbage collection)

            /*
             * Zwolnij zasoby po graczu:
             *
             * free_ids.push(pl.id):
             *   Zwróć ID do puli wolnych ID.
             *   Kolejny gracz który dołączy dostanie to ID z powrotem (free_ids.pop()).
             *   Bez tego: IDs skończyłyby się po wyjściu/wejściu 255 graczy.
             *
             * players[pl.id] = null:
             *   Ustaw na null (szybkie usunięcie referencji).
             *   Jeśli jakaś pętla przegląda players{} i trafi na null → może je ominąć
             *   bez wchodzenia w delete (który jest wolniejszy).
             *
             * delete players[pl.id]:
             *   Usuń klucz z obiektu entirely.
             *   Bez delete: Object.keys(players).length nadal liczyłoby rozłączonego gracza.
             *   Pakiet 3 (lista graczy) wysyłany nowym graczom byłby błędny.
             *
             * data.player = null:
             *   Usuń referencję z danych socketu.
             *   Nawet jeśli uWS wywoła close() ponownie (edge case) → pl będzie null → return.
             *   Też pomaga GC: obiekt gracza nie ma już referencji → może być zbierany.
             */

 

            // ── Serwer opustoszał — wróć do stanu Ready ──

            if (player_length === 0) {
                if (is_allocated) {
                    is_allocated = false;  
                    console.log("Serwer opustoszał! Wracam do Ready, autoskaler zdecyduje co dalej...");
                    redis_update_player_count();  // zaktualizuj Redis z player_length=0

                if (USE_AGONES)   agonesSDK.ready().catch(console.error);
                // Powróć do stanu Ready — Agones autoskaler może teraz przydzielić serwer
                // do nowej sesji gry LUB go zamknąć jeśli jest za dużo idle serwerów.
                }
            } 

                       /*
             * PRZEJŚCIE AGONES: Allocated → Ready gdy serwer opustoszeje.
             *
             * player_length === 0:
             *   Sprawdzamy po dekrementacji — ten gracz był ostatni.
             *
             * is_allocated:
             *   Sprawdzamy czy byliśmy w stanie Allocated (czyli czy w ogóle byliśmy przydzieleni).
             *   Bez sprawdzenia: agonesSDK.ready() byłoby wywołane nawet jeśli nigdy nie było graczy.
             *
             * is_allocated = false:
             *   Resetuj flagę — przy kolejnym graczu allocate() zostanie wywołane ponownie.
             *
             * redis_update_player_count():
             *   Natychmiastowa aktualizacja Redis → lobby od razu widzi "0 graczy" →
             *   może wysyłać nowych graczy zamiast czekać na następny tik (co 60 klatek = ~1s).
             *
             * agonesSDK.ready():
             *   Powrót do stanu Ready w Agones.
             *   W stanie Ready: autoskaler może rozważyć usunięcie poda jeśli jest zbyt wiele
             *   pustych serwerów (skalowanie w dół = oszczędność kosztów chmury).
             *   Lub: lobby przydzieli nową sesję gry bez tworzenia nowego poda (szybsze!).
             *
             * Zakomentowany kod (redis_cleanup → ready):
             *   Poprzednie podejście: czyść Redis, dopiero potem sygnalizuj Ready.
             *   Porzucone bo redis_cleanup() jest zbyt agresywne — usuwa WSZYSTKIE dane serwera.
             *   Autoskaler może zdecydować "keep alive" → serwer znowu by potrzebował danych w Redis.
             *   Obecne podejście: zostaw dane w Redis, tylko zaktualizuj licznik graczy.
             */
        },

    }).listen(port, (token) => {
        // token jest zwracany przez uWS jeśli serwer poprawnie zaczął nasłuchiwać.
        if (token) {
            console.log('Game Server listening on port ' + port);
        } else {
            console.error('Game Server failed to listen on port ' + port);
        }
         /*
         * .listen(port, callback) — uruchom serwer HTTP/WebSocket na danym porcie.
         *
         * token: uchwyt serwera zwrócony przez uWS.
         *   Jeśli token jest   (niepusty) → serwer nasłuchuje pomyślnie.
         *   Jeśli token jest   (null/undefined) → błąd uruchomienia (port zajęty? brak uprawnień?).
         *
         */
    });
}









// ═══════════════════════════════════════════════════════════════════════════════
//  GŁÓWNA PĘTLA GRY
//  Serce całego serwera. Wywoływana co 16ms (~62.5 Hz).
//  Kolejność jest ważna: najpierw AI (boty), potem fizyka, potem pakiety.
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: GŁÓWNA PĘTLA GRY (Main Game Loop)
//
//  Serce serwera — wykonywana co SERVER_TICK_MS (16ms = ~62.5 razy na sekundę).
//  Każde wywołanie to jeden "tick" symulacji:
//    1. Inkrementacja licznika klatek
//    2. Czyszczenie wygasłych tokenów (co 10000 klatek)
//    3. Aktualizacja AI botów
//    4. Fizyka/ruch wszystkich żywych graczy
//    5. Generowanie i wysyłka pakietów do klientów
//    6. Synchronizacja licznika graczy z Redis (co 60 klatek ≈ 1s)
//
// ═══════════════════════════════════════════════════════════════════════════════
game_loop_interval = setInterval(function () {
    frame++;
    // Inkrementuj globalne "bicie serca" gry.
    // Cały timing gry oparty na frame (modulo zamiast osobnych timerów = mniej narzutu).
    /*
     * frame = globalny licznik ticków od startu serwera.
     * Używany do:
     *   1. Timerów "co N ticków" (modulo sprawdzenia: frame % N === 0)
     *   2. Logiki czasowej w grze (np. czas trwania efektów, timeout tokenów)
     *   3. Synchronizacji zdarzeń między różnymi systemami
     *
     * Dlaczego nie używamy Date.now()?
     *   Modulo na liczniku ticków jest deterministyczne i tanie obliczeniowo.
     *   Date.now() wywołuje syscall → wolniejsze, niedeterministyczne.
     *   Przy 62.5 tick/s: frame=62.5 ≈ 1 sekunda, frame=3750 ≈ 1 minuta.
     *
     * UWAGA: frame jest liczbą JS (float64 = do 2^53 precyzyjnie).
     *   Przy 62.5 tick/s serwer może działać ~4.5 miliona lat zanim overflow.
     *   Bezpieczne.
     */



    // ── Czyszczenie wygasłych tokenów (co 10000 ticków ≈ 160 sekund) ──
    if (!(frame % 10000)) {
        // !(x % 10000) === true tylko gdy x jest wielokrotnością 10000.
        // Czyszczenie co 160s jest wystarczające — tokeny ważne 10000 ticków.
        for (const i in tokens) {
            if (tokens[i].timelive < frame) {
                // Token "stary" — gracz nie zdążył się połączyć w ciągu 160 sekund.
                tokens[i] = null;
                delete tokens[i];
            }
        }
    }
        /*
     * CO 10000 TICKÓW (~2.7 minuty): Czyszczenie wygasłych tokenów dołączenia.
     *
     * !(frame % 10000) — trick "co N ticków":
     *   frame % 10000 = reszta z dzielenia przez 10000.
     *   Reszta = 0 tylko gdy frame jest wielokrotnością 10000.
     *   ! (NOT) odwraca: false → true gdy reszta = 0 → wejdź do bloku.
     *   Alternatywnie: (frame % 10000 === 0), ale !(...) jest krótsze.
     *
     * Tokeny dołączenia (tokens{}):
     *   Mother server (lobby) generuje token gdy gracz wybiera serwer.
     *   Token ma timelive = frame w którym wygasa.
     *   Gracz musi użyć tokenu PRZED wygaśnięciem — jednorazowy bilet wstępu.
     *
     * Dlaczego co 10000 ticków a nie co tick?
     *   Iteracja po całym tokens{} jest O(n). Co tick = ~62.5 razy/s = marnotrawstwo.
     *   Tokeny nie muszą wygasać co do milisekundy — co ~3 minuty wystarczy.
     *
     * tokens[i] = null + delete: podwójne usunięcie (patrz komentarz przy open()).
     */




    // ── Aktualizacja AI botów ──
    for (let i = bots.length; i--;) {
        const b = bots[i];

        if (b.move === 1 && b.time > 0) {
            b.player.x -= (Math.random() * 4) | 0;
            // Ruch w lewo o losowe 0–3 jednostki — nie jest precyzyjny, bot "idzie" nierówno.
            b.player.x &= 0x3ff; // wrap-around cylindra
        } else if (b.move === 2 && b.time > 0) {
            b.player.x += (Math.random() * 4) | 0; // ruch w prawo
            b.player.x &= 0x3ff;
        } else if (b.time < 0) {
            // Czas aktualnej akcji się skończył (b.time spadło do -1) → nowa decyzja.
            b.time = (Math.random() * 100) | 0; // nowy czas trwania: 0–99 ticków
            b.move = (Math.random() * 3)   | 0; // nowy kierunek: 0=stój, 1=lewo, 2=prawo
        }

        b.time--; // odliczaj czas do następnej zmiany kierunku
    }
      /*
     * AKTUALIZACJA AI BOTÓW — prosty automat stanów:
     *
     * Każdy bot ma:
     *   b.move  = kierunek ruchu: 0 = stój, 1 = w lewo, 2 = w prawo
     *   b.time  = licznik ticków do zmiany zachowania (timer)
     *   b.player = wewnętrzny obiekt gracza bota (ma .x, .y jak prawdziwy gracz)
     *
     * Logika (priorytet od góry):
     *
     *   if (b.move === 1 && b.time > 0):
     *     Bot idzie w lewo i ma jeszcze czas → porusz w lewo o losowe 0-3 jednostki.
     *     | 0 = szybkie obcięcie do całkowitej (floor dla wartości ≥0), szybsze niż Math.floor().
     *     &= 0x3ff = zawijaj pozycję X (cylindryczna mapa, jak gracze).
     *
     *   else if (b.move === 2 && b.time > 0):
     *     Bot idzie w prawo → to samo ale +X.
     *
     *   else if (b.time < 0):
     *     Czas dobiegł końca (b.time spadł poniżej 0) → wylosuj nowe zachowanie:
     *     b.time = losowe 0-99 ticków (nowy czas trwania ruchu)
     *     b.move = losowe 0, 1 lub 2 (nowy kierunek lub stój)
     *
     *   b.time-- (zawsze):
     *     Odliczaj timer w każdym tiku.
     *
     * To "głupi" ale skuteczny AI — boty chodzą w losowych kierunkach przez losowy czas.
     * Wyglądają naturalnie bo nie stoją w miejscu i nie poruszają się mechanicznie.
     * Nie wykrywają kolizji z innymi botami/graczami — po prostu chodzą.
     *
     * Iteracja od końca (i--): standard w tej bazie kodu (patrz uniq_push).
     */










    // ── Fizyka wszystkich żywych graczy (ludzie + boty) ──
    for (const i in players) {
        const pl = players[i];
        if (!pl.is_dead) pl.move();
        // is_dead=true → gracz jest martwy, czeka na respawn → skip fizyki.
        // Boty nigdy nie mają is_dead=true (respawnują się w move() od razu).
    }
 /*
     * AKTUALIZACJA FIZYKI WSZYSTKICH ŻYWYCH GRACZY:
     *
     * for...in po players{}: iteracja po kluczach (ID graczy).
     * if (!pl.is_dead): martwy gracz nie rusza się → pomijamy (też optymalizacja).
     *
     * pl.move():
     *   Metoda klasy player — przelicza fizykę gracza dla jednego ticka:
     *   - Grawitacja (zmniejsza prędkość pionową)
     *   - Aktualizacja pozycji Y
     *   - Wykrywanie lądowania na segmentach (wieżach innych graczy)
     *   - Wykrywanie kolizji z głowami graczy (zabójstwo)
     *   - Aktualizacja poziomu (lvl) na podstawie rozmiaru wieży
     *
     * Dlaczego boty są aktualizowane PRZED graczami?
     *   Boty też są obiektami gracza — mają segmenty w mapie kolizji.
     *   Gracze muszą "widzieć" zaktualizowane pozycje botów podczas własnego pl.move().
     *   Kolejność: boty → gracze → pakiety.
     */


    

 

     // ── Pakiety sieciowe ──
    gen_packet();
    // Buduj i wyślij pakiety do wszystkich podłączonych graczy.
    // Wywoływane co tick — klienci dostają pozycje co 16ms = płynna animacja.
    /*
     * Wygeneruj i wyślij pakiet stanu gry do WSZYSTKICH podłączonych klientów.
     *
     * gen_packet() to największa funkcja w serwerze — robi wiele naraz:
     *   1. Zbiera pozycje/stany wszystkich graczy i botów
     *   2. Przetwarza listy zdarzeń (joined_players, remove_players, respawned_players, itp.)
     *   3. Serializuje dane do formatu binarnego
     *   4. Wysyła "globalną" część pakietu do wszystkich (broadcast)
     *   5. Wysyła "indywidualną" część do każdego gracza osobno (per-player data)
     *
     * Wywoływana KAŻDY TICK (co 16ms) → 62.5 razy/s → to wąskie gardło serwera.
     * Dlatego tak ważna jest efektywność: binarne pakiety, buforowanie, minimalne alokacje.
     */



    // ── Heartbeat Redis (co 60 ticków ≈ 1 sekunda) ──

    // ← ZMIANA: zamiast ws_client.send(type 3) do mother
    // Co ~1 sekundę aktualizuj licznik graczy w Redis
    if (!(frame % 60)) {
        redis_update_player_count();
        // Zaktualizuj licznik graczy w Redis + odnów TTL klucza (5s).
        // Co 60 ticków = co ~1 sekundę. TTL klucza = 5s → bezpieczny margines × 5.
    }
    /*
     * CO 60 TICKÓW (~1 sekunda): Synchronizacja licznika graczy z Redis.
     *
     * frame % 60 = 0 co 60 ticków = co ~960ms ≈ 1 sekunda (przy 16ms/tick).
     *
     * redis_update_player_count():
     *   Zapisuje aktualny player_length do Redis.
     *   Lobby odczytuje tę wartość żeby wiedzieć ile jest wolnych miejsc.
     *
     * Dlaczego nie co tick?
     *   Redis to sieć (nawet localhost) → każde wywołanie = I/O = opóźnienie.
     *   Co tick (62.5x/s) = 62.5 requestów/s do Redis tylko dla licznika = marnotrawstwo.
     *   Co sekundę = 1 request/s → wystarczy dla lobby (gracze akceptują 1s opóźnienie
     *   w wyświetlaniu aktualnej liczby graczy na liście serwerów).
     */
}, SERVER_TICK_MS);
/*
 * setInterval(fn, SERVER_TICK_MS):
 *   Uruchamia fn() co SERVER_TICK_MS millisekund (16ms).
 *   Zwraca uchwyt (game_loop_interval) — gdybyśmy chcieli zatrzymać pętlę:
 *     clearInterval(game_loop_interval)
 *   Używane przy shutdown żeby nie wysyłać pakietów po zamknięciu serwera.
 *
 
 */



// ═══════════════════════════════════════════════════════════════════════════════
//
//  SEKCJA: STARTUP — inicjalizacja i uruchomienie serwera
//
// ═══════════════════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════════════════
//  INICJALIZACJA SERWERA
//  Kolejność: najpierw boty (żeby mapa była ożywiona od startu), potem WebSocket.
// ═══════════════════════════════════════════════════════════════════════════════

for (let g = BOT_COUNT; g--;) bots[g] = new bot();
// Utwórz wszystkie boty przed otwarciem socketa.
// Gracz który dołączy jako pierwszy zastanie już wypełnioną mapę.
/*
 * Utwórz BOT_COUNT (37) botów przy starcie serwera.
 *
 * for (let g = BOT_COUNT; g--;):
 *   Pętla od końca: g zaczyna od 37, maleje do 0.
 *   g-- = post-decrement: iteruje z g=36 do g=0 (37 iteracji).
 *   Indeksy bots[36], bots[35], ..., bots[0].
 *
 *   Dlaczego od końca a nie od 0?
 *   Przy wypełnianiu tablicy OD KOŃCA silnik JS (V8) może zoptymalizować alokację
 *   pamięci — wie że tworzy tablicę o stałym rozmiarze i może zarezerwować od razu.
 *   Wypełnianie od początku może triggerować wielokrotną realokację (resize tablicy).
 *
 * new bot():
 *   Konstruktor klasy bot — tworzy "gracza-bota" z losową pozycją startową.
 *   Bot ma własny obiekt player wewnętrznie i jest dodany do players{} i free_ids.
 *
 * Boty tworzone PRZED init_server_websocket() — muszą istnieć zanim gracze zaczną dołączać.
 * Gdyby gracz dołączył przed botami: zobaczyłby pustą mapę, potem nagle 37 botów.
 */




init_server_websocket(SERVER_PORT);
// Otwórz serwer WebSocket i zacznij nasłuchiwać połączeń.
// Od tej chwili serwer obsługuje graczy.

/*
 * Uruchom serwer WebSocket na SERVER_PORT.
 *
 * Ta funkcja (zdefiniowana wyżej w pliku) tworzy serwer uWS z obsługą:
 *   - HTTP upgrade → WebSocket handshake (walidacja tokenu)
 *   - WebSocket open  → inicjalizacja gracza
 *   - WebSocket message → obsługa poleceń gracza
 *   - WebSocket close  → sprzątanie po graczu
 *
 * Wywoływana NA KOŃCU pliku bo:
 *   1. Wszystkie funkcje (gen_packet, save_player_money, itp.) muszą być zdefiniowane.
 *   2. Boty muszą istnieć (bots[] wypełnione powyżej).
 *   3. Połączenie z Agones/Redis dzieje się asynchronicznie (connectAgones() wywołane wcześniej).
 *
 * Po tym wywołaniu serwer jest gotowy — uWS zaczyna akceptować połączenia TCP.
 * Jednocześnie setInterval pętli gry już tyka (uruchomiony powyżej).
 * Jeśli gracz dołączy zanim Agones/Redis skończy się łączyć — może dołączyć
 * bez rejestracji w Redis (edge case przy bardzo szybkim starcie).
 */
