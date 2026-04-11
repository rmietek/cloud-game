```js
/*
 * ============================================================
 * PRZEPŁYW: UŻYTKOWNIK ŁĄCZY SIĘ I WYBIERA GRĘ
 * (mother.js ↔ child.js)
 * ============================================================
 *
 * KROK 1 — Logowanie (HTTP)
 *   Klient wysyła POST /auth/login z { email, password }.
 *   mother.js weryfikuje hasło przez bcrypt.compare().
 *   Jeśli OK → zwraca { success: true, nick, ... } + zapisuje last_login w MongoDB.
 *
 * KROK 2 — Połączenie WebSocket z mother.js
 *   Klient otwiera połączenie WS na porcie 9876.
 *   mother.js przypisuje mu obiekt w ClientManager (userData, ws).
 *
 * KROK 3 — Pobranie danych konta (handleFetchAccount)
 *   Klient wysyła żądanie fetchAccount przez WS.
 *   mother.js odpytuje MongoDB → zwraca punkty, skiny, nick itp.
 *
 * KROK 4 — Lista dostępnych gier (buildGamesPacket)
 *   mother.js czyta z Redisa klucze aktywnych serwerów child.js (HGETALL).
 *   Każdy child.js rejestruje się w Redis przy starcie (HSET) z adresem i liczbą graczy.
 *   mother.js pakuje tę listę i wysyła klientowi → klient widzi lobby z grami.
 *
 * KROK 5 — Wybór gry przez użytkownika (handleJoinGame)
 *   Klient wysyła przez WS identyfikator wybranego serwera child.js.
 *   mother.js:
 *     a) Generuje unikalny token (losowy string).
 *     b) Publikuje token do Redisa (PUBLISH) na kanał nasłuchiwany przez wybrany child.js.
 *        Wiadomość zawiera: token + _id + nick + punkty + skiny użytkownika.
 *     c) Czeka 50 ms (setTimeout), żeby child.js zdążył zarejestrować token w swojej pamięci.
 *     d) Wysyła klientowi adres serwera child.js + token przez WS.
 *
 * KROK 6 — Połączenie WebSocket z child.js
 *   Klient otwiera nowe połączenie WS bezpośrednio z child.js,
 *   przesyłając token otrzymany od mother.js.
 *
 * KROK 7 — Weryfikacja tokenu w child.js
 *   child.js sprawdza czy token istnieje w swojej mapie tokenów (zarejestrowany przez Redis pub/sub).
 *   Jeśli token pasuje → użytkownik jest uwierzytelniony.
 *   Token zostaje usunięty (jednorazowy).
 *
 * KROK 8 — Inicjalizacja gracza w child.js
 *   child.js wysyła klientowi:
 *     - Pakiet typ 3: dane startowe (ID gracza, lista botów, aktualne poziomy itp.)
 *     - Pakiet typ 4: dane poziomów (10 poziomów na raz, tablice 128-elementowe)
 *     - Pakiet typ 9: aktualny ranking top 6
 *
 * KROK 9 — Pętla gry (game loop, tick co 16 ms)
 *   child.js przetwarza fizykę: grawitację, skoki, kolizje (gracz↔gracz, gracz↔teren).
 *   Rozsyła pozycje graczy (pakiet typ 0) do wszystkich klientów w zasięgu.
 *   Śmierć gracza → pakiet typ 5; respawn → pakiet typ 6.
 *   Zdobyte punkty → pakiet typ 12; child.js zapisuje je bezpośrednio do MongoDB.
 *
 * KROK 10 — Rozłączenie
 *   Gracz rozłącza się → child.js wysyła pakiet typ 2 (player left) do pozostałych.
 *   child.js aktualizuje licznik graczy w Redisie (HSET).
 *   mother.js nie uczestniczy w rozłączeniu z child.js — obsługuje tylko lobby.
 */
/*
 * ============================================================
 * INFRASTRUKTURA: PORTY, SKALOWANIE, LOAD BALANCING
 * ============================================================
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  PORT 9876  — HTTP (Express.js)                                     │
 * │  Obsługuje: POST /auth/login, POST /auth/register, pliki statyczne  │
 * │  W K8s: Service "mother" wystawia ten port jako LoadBalancer        │
 * │  Docelowo: zmienić na 80 (patrz CONFIG.HTTP_PORT)                   │
 * ├─────────────────────────────────────────────────────────────────────┤
 * │  PORT 3001  — WebSocket lobby (uWebSockets.js)                      │
 * │  Obsługuje: połączenia klientów do lobby (lista gier, join, skiny)  │
 * │  W K8s: Service "mother" wystawia ten port jako LoadBalancer        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * ── KTO PRZEKIEROWUJE RUCH? ──────────────────────────────────────────
 *
 *  Kubernetes Service typu LoadBalancer (prz-mother.yaml):
 *
 *    spec:
 *      type: LoadBalancer        <- Azure przydziela zewnętrzny IP
 *      ports:
 *        - name: http        port: 9876   -> pod:9876  (Express)
 *        - name: client-ws   port: 3001   -> pod:3001  (uWS)
 *
 *  Azure Load Balancer (tworzony automatycznie przez AKS) rozdziela
 *  ruch TCP round-robin między wszystkie repliki poda "mother".
 *  Oba porty (9876 i 3001) trafiają zawsze pod ten sam zewnętrzny IP,
 *  ale są routowane niezależnie.
 *
 * ── DLACZEGO WEBSOCKET JEST STATELESS I DA SIĘ SKALOWAĆ? ────────────
 *
 *  Klasyczny problem WS: klient podłączony do repliki A nie widzi
 *  zdarzeń z repliki B — load balancer nie może swobodnie przełączać.
 *
 *  Tu ten problem nie istnieje, bo:
 *   1. Każdy klient utrzymuje jedno połączenie WS z JEDNĄ repliką mother
 *      przez cały czas pobytu w lobby — nie ma potrzeby synchronizacji
 *      stanu sesji między replikami.
 *   2. Stan globalny (lista gier) żyje w Redisie, a NIE w pamięci poda.
 *      Każda replika mother czyta go z Redis (HGETALL) i może odpowiedzieć
 *      identycznie — żadna replika nie jest "specjalna".
 *   3. Aktualizacje listy gier (gdy child.js zmienia liczbę graczy)
 *      trafiają do Redisa (PUBLISH), a każda replika mother subskrybuje
 *      ten kanał osobno i rozsyła aktualizację do swoich klientów WS.
 *
 *  Schemat skalowania:
 *
 *    Klient 1 --WS--> mother-pod-A --Redis pub/sub--> child-pod-X
 *    Klient 2 --WS--> mother-pod-A  \
 *    Klient 3 --WS--> mother-pod-B   +== Redis (wspólna lista gier)
 *    Klient 4 --WS--> mother-pod-B  /
 *
 *  HPA (mother-hpa.yaml) skaluje liczbę podów mother od 1 do 10
 *  na podstawie zużycia CPU (próg: 10% średniej).
 *  Azure LB automatycznie dołącza nowe pody do puli bez przestojów.
 *
 * ──────────────────────────────────────────────────────────────────────
 *
 *  WS to długotrwałe połączenie TCP — po zestawieniu
 *  przez LB nie jest ponownie routowane. Klient siedzi na tej samej
 *  replice do rozłączenia. Przy reconnect może trafić na inną replikę —
 *  to jest OK, bo stan jest w Redisie, nie w pamięci poda.
 *
 * ── PODSUMOWANIE PORTÓW ───────────────────────────────────────────────
 *
 *  Zewnętrzny IP (Azure LB):
 *    :9876  -> HTTP  (logowanie, rejestracja)
 *    :3001  -> WS    (lobby: lista gier, dołączanie, skiny)
 *
 *  Wewnątrz klastra K8s (ClusterIP):
 *    redis:6379     -> Redis (stan gier, pub/sub)
 *    cosmos-db      -> MongoDB via secret MONGO_URL (konta, punkty)
 *
 *  Serwery gier (child.js) — osobne pody/NodePorty, adresy w Redisie:
 *    child-pod:PORT -> WS gry (klient łączy się bezpośrednio po tokenie)
 */

/*
 * ── JAK TO MOŻLIWE: JEDEN PORT, WIELE REPLIK? ────────────────────────
 *
 *  Z zewnątrz klient zawsze łączy się na TEN SAM adres i port,
 *  np. ws://20.10.5.123:3001 — ale każde połączenie trafia do INNEGO poda.
 *
 *  Jak to działa warstwami:
 *
 *  1. KAŻDY POD nasłuchuje na tym samym porcie (3001 / 9876)
 *     wewnątrz swojego izolowanego kontenera.
 *     Pod-A: 10.0.0.4:3001
 *     Pod-B: 10.0.0.5:3001   <- ten sam port, inny prywatny IP
 *     Pod-C: 10.0.0.6:3001
 *
 *  2. KUBERNETES SERVICE (ClusterIP wewnętrzna warstwa)
 *     Przypisuje jeden wirtualny IP (np. 10.1.0.20) do serwisu "mother".
 *     kube-proxy na każdym węźle tłumaczy ten VIP na losowy pod z puli
 *     (przez reguły iptables / IPVS) — to jest wewnętrzny load balancer K8s.
 *
 *  3. AZURE LOAD BALANCER (warstwa zewnętrzna)
 *     Dostaje zewnętrzny publiczny IP (np. 20.10.5.123).
 *     Przyjmuje TCP :3001 i forward'uje do węzłów klastra (NodePort).
 *     Stamtąd kube-proxy przekazuje dalej do konkretnego poda.
 *
 *  Schemat:
 *
 *    Klient
 *      |
 *      v  ws://20.10.5.123:3001  (zawsze ten sam adres)
 *    Azure Load Balancer  (zewnętrzny IP Azure, port 3001)
 *      |        |        |
 *      v        v        v    (round-robin TCP)
 *    węzeł-1  węzeł-2  węzeł-3  (VM-ki w AKS node pool)
 *      |
 *    kube-proxy (iptables/IPVS)
 *      |        |        |
 *      v        v        v
 *    pod-A    pod-B    pod-C   (każdy: :3001 ten sam port)
 *
 *  Dlaczego każdy pod może mieć TEN SAM port?
 *    Pody mają osobne przestrzenie sieciowe (network namespace).
 *    Port 3001 w pod-A i port 3001 w pod-B to dwa różne gniazda
 *    na dwóch różnych prywatnych IP — nie ma konfliktu.
 *    Dla systemu operacyjnego węzła to jakby dwie osobne maszyny.
 *
 *  Co widzi klient?
 *    Nic. Łączy się zawsze z 20.10.5.123:3001.
 *    Nie wie, do którego poda trafił. Nie musi wiedzieć.
 *    Połączenie WS jest długotrwałe — po zestawieniu LB już nie
 *    ingeruje, klient "siedzi" na jednym podzie aż do rozłączenia.
 */
```