# Agones i Kubernetes — Zarządzanie Serwerami Gry

## 1. Cel i architektura

Agones rozszerza Kubernetes o świadomość cyklu życia serwerów gier. Problem: standardowy K8s Deployment może ubić pod z trwającą sesją gry przy update lub skalowaniu. Agones Fleet gwarantuje, że pod w stanie `Allocated` (trwa gra) jest nietykalny.

Standardowy Kubernetes nie wie czym są serwery gier — dla niego każdy pod to bezstanowa replika — można ją w dowolnym momencie usunąć i zastąpić nową bez żadnych konsekwencji. To jest problem: jeśli 10 graczy jest w środku rozgrywki, a K8s zdecyduje się usunąć pod (np. przy skalowaniu w dół gdy ruch spada), wszyscy gracze są rozłączeni bez ostrzeżenia.

Agones rozwiązuje ten problem dodając do K8s pojęcie **cyklu życia serwera gry**. Każdy Child pod przechodzi przez stany: `Starting` → `Ready` (pusty, czeka na graczy) → `Allocated` (trwa gra) → `Shutdown` (zakończono). Agones gwarantuje że pod w stanie `Allocated` jest **nietykalny** — skalowanie w dół go nie dotknie. Dopiero gdy sam wywoła `agonesSDK.shutdown()` (wszyscy gracze rozłączeni), Kubernetes może go usunąć.

### Diagram cyklu życia GameServera

```
[Pod startuje]
     │
     ▼
  Starting ──► agonesSDK.connect()
     │          getGameServer() → pobierz IP + port zewnętrzny
     ▼
   Ready ◄──── agonesSDK.ready()
     │          FleetAutoscaler widzi: bufferSize spełniony
     │          Mother może wysyłać graczy
     ▼ (pierwszy gracz dołącza → open())
 Allocated ◄── agonesSDK.allocate()
     │          FleetAutoscaler NIE usunie tego poda
     │          Gra trwa
     ▼ (wszyscy gracze wyszli → close())
   Ready ◄──── agonesSDK.ready()
     │          serwer znowu wolny — lobby może go przydzielić ponownie
     │          FleetAutoscaler może go usunąć jeśli jest za dużo pustych
     ▼ (FleetAutoscaler skaluje w dół → K8s wysyła SIGTERM)
  Shutdown ──► redis_cleanup() → usuń z Redis
     │          process.exit(0)
     ▼
[Pod usunięty przez Fleet → Fleet tworzy nowy jeśli bufferSize niezachowany]
```

---

## 2. Kluczowa logika i przepływ

### Porównanie K8s Deployment vs Agones Fleet

| Właściwość | K8s Deployment | Agones Fleet |
|---|---|---|
| Ochrona aktywnej sesji | Brak — pod może zostać usunięty w dowolnym momencie, np. przy skalowaniu w dół | Pod w stanie `Allocated` jest nietykalny — K8s nie może go usunąć dopóki trwa gra |
| Przydzielanie portów | Każdy pod dostaje stały port — wymaga ręcznej konfiguracji i pilnowania konfliktów | Agones automatycznie przydziela wolny port z puli 7000–8000 przy każdym starcie poda |
| Sygnalizacja gotowości | K8s odpytuje endpoint HTTP (`readinessProbe`) co kilka sekund — pod jest "gotowy" gdy odpowie 200 | Serwer sam woła `agonesSDK.ready()` po pobraniu publicznego IP węzła i przydzielonego portu z Agones oraz rejestracji w Redis — zgłasza gotowość dokładnie wtedy gdy jest w stanie przyjąć graczy |
| Cykl życia poda | Tylko dwa stany: działa (`Running`) lub nie działa (`Terminated`) | Cztery stany: `Starting` → `Ready` → `Allocated` → `Shutdown` — K8s wie co się dzieje w grze |

### FleetAutoscaler — polityka Buffer

FleetAutoscaler pilnuje żeby zawsze była odpowiednia liczba wolnych serwerów w stanie `Ready`. Polityka `Buffer` oznacza: "utrzymuj stały bufor wolnych serwerów".

```yaml
# gitops/base/prz-agones.yaml
policy:
  type: Buffer
  buffer:
    bufferSize: 1    # ile serwerów w stanie Ready musi zawsze czekać na gracza
                     # 1 = zawsze jeden wolny serwer gotowy natychmiast
    minReplicas: 1   # nigdy nie zejdź poniżej 1 poda — nawet gdy nikt nie gra
    maxReplicas: 20  # nigdy nie twórz więcej niż 20 podów jednocześnie (limit kosztów)
```

**Jak to działa w praktyce:**

Gdy gracz dołącza do serwera, serwer przechodzi ze stanu `Ready` do `Allocated`. FleetAutoscaler w tym momencie zauważa że liczba wolnych serwerów (`Ready`) spadła poniżej `bufferSize = 1` — czyli nie ma żadnego wolnego serwera na kolejnego gracza. Reaguje zwiększając `Fleet.spec.replicas` o 1. Fleet controller (nie FleetAutoscaler — to ważne rozróżnienie) tworzy nowy pod, który przechodzi przez `Starting → Ready`.

To samo działa w drugą stronę: gdy gracze wychodzą i serwer wraca do `Ready`, FleetAutoscaler sprawdza czy wolnych serwerów nie jest za dużo. Jeśli jest ich więcej niż `bufferSize`, redukuje `Fleet.spec.replicas` — Fleet controller wysyła SIGTERM do nadmiarowych podów, które sprzątają po sobie (redis_cleanup) i kończą proces.

**Kroki w skrócie:**
1. Gracz dołącza → serwer: `Ready → Allocated`
2. FleetAutoscaler: `Ready = 0 < bufferSize = 1`
3. Mówi Fleet: `spec.replicas++`
4. Fleet tworzy nowy pod → nowy serwer: `Starting → Ready`
5. Mamy kolejny pusty serwer w stanie `Ready` do którego mogą dołączyć kolejni gracze.

**Ważne:** FleetAutoscaler NIE tworzy podów. Zmienia `Fleet.spec.replicas`. Fleet controller tworzy/usuwa pody.


### Lokalizacja portów

Każdy Child pod nasłuchuje wewnętrznie na porcie 5000. Ten port jest niedostępny z zewnątrz — pod ma prywatny adres IP widoczny tylko wewnątrz klastra. Żeby gracz mógł się połączyć z internetu, Agones tworzy **NodePort mapping**: przydziela losowy port z puli 7000–8000 na węźle K8s (fizycznej maszynie) i przekierowuje ruch na port 5000 poda. Każdy serwer gry dostaje inny port z tej puli — dzięki temu wiele serwerów może działać na tym samym węźle bez konfliktów.

Po starcie Child odczytuje przydzielony port i publiczne IP węzła z Agones SDK (`gs.status.portsList`, `gs.status.address`) i rejestruje się w Redis z tymi danymi. Mother przekazuje je klientowi, który łączy się bezpośrednio z węzłem.

```
Kontener child-gameserver:
  uWS.listen(5000, ...)            ← wewnętrzny port poda (niedostępny z zewnątrz)

Agones NodePort mapping:
  Węzeł K8s :7423  →  Pod :5000   ← port z puli 7000–8000, przydzielany losowo przez Agones
  (czytany z gs.status.portsList[0].port lub gs.status.ports[0].port)

Klient łączy się z:
  ws://34.89.123.45:7423           ← publiczny IP węzła K8s + port Agones

NIE z:
  ws://10.0.0.5:5000               ← prywatny IP poda — niedostępny spoza klastra
```

---

## 3. Przykłady z kodu (implementacja)

### SDK — inicjalizacja (`connectAgones`)

`connectAgones()` to pierwsza funkcja wywoływana przy starcie poda. Jej zadanie: pobrać od Agones publiczny port i IP węzła, a dopiero potem zgłosić gotowość i zarejestrować serwer w Redis. Kolejność kroków jest tu krytyczna — gdyby `ready()` zostało wywołane przed pobraniem IP i portu, lobby zobaczyłoby serwer z błędnymi danymi i gracze nie mogliby się połączyć.

W trybie lokalnym (`USE_AGONES=false`) cały blok Agones jest pomijany — serwer rejestruje się od razu z domyślnymi wartościami (`localhost:5000`).

```javascript
// apps/child-gameserver/main.js :
async function connectAgones() {
    if (!USE_AGONES) {
        await redis_connect();  // tryb lokalny: pomiń Agones, zarejestruj od razu
        return;
    }

    // Krok 1: połącz z sidecar kontenerem Agones działającym w tym samym podzie
    await agonesSDK.connect();

    // Krok 2: pobierz metadane GameServera z Kubernetes API
    // (gs.status zawiera: publiczny IP węzła, przydzielone porty, aktualny stan)
    const gs = await agonesSDK.getGameServer();

    // Krok 3: wyciągnij port zewnętrzny z puli 7000–8000
    // portsList (nowe API) || ports (stare API) — kompatybilność z różnymi wersjami Agones
    const allocatedPorts = gs.status.portsList || gs.status.ports;
    if (allocatedPorts && allocatedPorts.length > 0) {
        AGONES_PORT = allocatedPorts[0].port;  // bierzemy pierwszy port (WebSocket = TCP)
    }

    // Krok 4: pobierz publiczne IP węzła K8s
    // To IP maszyny wirtualnej (węzła), NIE prywatne IP poda (10.x.x.x)
    if (gs.status.address) {
        AGONES_IP = gs.status.address;
    }

    // Krok 5: zgłoś gotowość — DOPIERO po pobraniu IP i portu
    // Bez tego serwer pozostaje w stanie "Starting" i lobby go nie widzi
    await agonesSDK.ready();

    // Krok 6: heartbeat co 2s — "watchdog"
    // Jeśli przez ~30s Agones nie dostanie health() → uzna serwer za martwy → restart poda
    health_interval = setInterval(() => {
        try { agonesSDK.health(); } catch (_) {}
        // try/catch: jeden pominięty heartbeat nie zabija serwera — ignorujemy chwilowe błędy
    }, 2000);

    // Krok 7: zarejestruj w Redis z już poprawnymi danymi (IP + port)
    // Mother odczyta te dane i przekaże klientom którzy chcą dołączyć
    await redis_connect();
}
```

### Przejście Ready → Allocated (pierwszy gracz)

Gdy pierwszy gracz dołącza do serwera, kod wywołuje `agonesSDK.allocate()` — informuje Agones że na tym serwerze trwa teraz sesja gry. Agones zmienia stan GameServera z `Ready` na `Allocated`, co oznacza że FleetAutoscaler nie może usunąć tego poda nawet jeśli klaster jest przeciążony lub trwa skalowanie w dół.

Warunek `player_length === 1` sprawdza dokładnie jedynkę, bo `player_length` jest już zinkrementowany w tym momencie — wartość 1 oznacza że właśnie dołączył pierwszy gracz. Flaga `is_allocated` zabezpiecza przed wywołaniem `allocate()` wielokrotnie — np. gdyby drugi gracz dołączył zanim serwer zdążył zmienić stan w Agones. Błąd `allocate()` jest tylko logowany (`.catch(console.log)`) i nie przerywa działania serwera — gracz może grać normalnie nawet jeśli Agones chwilowo nie odpowiada.

```javascript
// apps/child-gameserver/main.j 
if (player_length === 1 && !is_allocated) {
    is_allocated = true;                                  // ustaw flagę — blokuj kolejne wywołania
    if (USE_AGONES) agonesSDK.allocate().catch(console.log);
    // allocate(): Ready → Allocated — serwer z graczami jest nietykalny dla autoskalera
    // .catch(console.log): błąd Agones nie crashuje serwera — gra toczy się dalej
}
```

### Powrót do Ready (ostatni gracz wychodzi)

Gdy ostatni gracz rozłącza się, serwer **nie jest zamykany** — wraca do stanu `Ready` i czeka na kolejnych graczy. Jest to celowa decyzja: uruchomienie nowego poda od zera zajmuje kilka sekund (`Starting → Ready`), a serwer który już działa może natychmiast przyjąć nową sesję. FleetAutoscaler sam zdecyduje czy ten serwer jest potrzebny — jeśli pustych serwerów jest za dużo (`Ready > bufferSize`), wyśle SIGTERM i pod się zamknie.

`redis_update_player_count()` jest wywoływane natychmiast po wyjściu ostatniego gracza, żeby lobby od razu widziało "0 graczy".

Flaga `is_allocated` jest resetowana do `false` — dzięki temu gdy przyjdzie kolejny gracz, `allocate()` zostanie wywołane ponownie i serwer wróci do stanu `Allocated`.

```javascript
// apps/child-gameserver/main.js
if (player_length === 0) {
    if (is_allocated) {
        is_allocated = false;             // resetuj — przy kolejnym graczu allocate() znów zadziała
        redis_update_player_count();      // natychmiastowa aktualizacja Redis: "0 graczy"

        if (USE_AGONES) agonesSDK.ready().catch(console.error);
        // Allocated → Ready: serwer znowu wolny
        // FleetAutoscaler zdecyduje: przydzielić nową sesję LUB usunąć pod (jeśli za dużo pustych)
    }
}
```

---

## 4. Zależności i Protokoły

### Agones Fleet YAML

```yaml
# gitops/base/prz-agones.yaml
apiVersion: "agones.dev/v1"
kind: Fleet
metadata:
  name: prz-child-fleet
spec:
  scheduling: Packed         # skupiaj na jednym węźle (oszczędność kosztów)
  template:
    spec:
      ports:
      - name: default
        containerPort: 5000  # wewnętrzny port poda
        protocol: TCP        # NodePort z puli 7000-8000 przydzielany automatycznie
      template:
        spec:
          terminationGracePeriodSeconds: 15
          restartPolicy: Never
          containers:
          - name: child
            image: przacr.azurecr.io/prz-child:latest
            env:
            - name: USE_AGONES
              value: "true"
```

### Agones FleetAutoscaler YAML

```yaml
apiVersion: "autoscaling.agones.dev/v1"
kind: FleetAutoscaler
metadata:
  name: prz-child-autoscaler
spec:
  fleetName: prz-child-fleet
  policy:
    type: Buffer
    buffer:
      bufferSize: 1
      minReplicas: 1
      maxReplicas: 20
```

### Terraform: instalacja Agones przez Helm

```hcl
# infra/terraform/agones.tf
resource "helm_release" "agones" {
  name             = "agones"
  repository       = "https://agones.dev/chart/stable"
  chart            = "agones"
  namespace        = "agones-system"
  create_namespace = true
  timeout          = 600
  wait             = true

  set { name = "gameservers.namespaces"; value = "default" }
  # Instaluje CRDs: Fleet, FleetAutoscaler, GameServer, GameServerAllocation
  depends_on = [azurerm_kubernetes_cluster.main]
}
```

### NSG dla portów Agones

```hcl
# infra/terraform/nsg.tf
resource "azurerm_network_security_rule" "agones_ports" {
  name                       = "AllowAgonesPorts"
  priority                   = 1000
  direction                  = "Inbound"
  access                     = "Allow"
  protocol                   = "Tcp"
  source_port_range          = "*"
  destination_port_range     = "7000-8000"
  source_address_prefix      = "Internet"
  destination_address_prefix = "*"
}
# Bez tej reguły: klienci nie mogą połączyć się z Child serverami
```

---

## 5. Konfiguracja Wdrożeniowa

### Zmienne środowiskowe Child

| Zmienna | Wartość | Skąd |
|---|---|---|
| `USE_AGONES` | `"true"` | Fleet spec env |
| `REDIS_URL` | `redis://redis:6379` | Fleet spec env |
| `MONGO_URL` | connection string | K8s Secret `cosmos-db-secret` |

### AKS wymagania dla Agones

```hcl
# infra/terraform/aks.tf
default_node_pool {
  node_count               = var.aks_node_count  # 1
  vm_size                  = "standard_b2s_v2"   # 2CPU/4GB RAM
  node_public_ip_enabled   = true                # WYMAGANE przez Agones NodePort
  type                     = "VirtualMachineScaleSets"
}
```

`node_public_ip_enabled = true` jest krytyczne: bez publicznego IP węzła K8s, klienci nie mogą połączyć się z serwerami gry przez NodePort (Agones podaje `gs.status.address` = publiczny IP węzła).

### Scheduling: Packed vs Distributed

Konfiguracja `scheduling: Packed` (Fleet spec) oznacza, że Agones najpierw zapełnia jeden węzeł K8s zanim przejdzie do kolejnego.
 
