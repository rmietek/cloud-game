# Scaling — Skalowanie Systemu

## 1. Cel i architektura

System skaluje się na trzech niezależnych poziomach, z których każdy rozwiązuje inny problem:

1. **Agones FleetAutoscaler** — pilnuje, żeby zawsze był wolny serwer gry dla nowego gracza. Gdy brakuje wolnego Childa, tworzy kolejny pod. Polityka Buffer, limit 20 replik.
2. **Kubernetes HPA** — skaluje Mother (lobby i logowanie) w zależności od obciążenia CPU. Próg 10%, od 1 do 10 replik.
3. **AKS Virtual Machine Scale Set** — fizyczne węzły klastra. Obecnie jeden węzeł `standard_b2s_v2`, zmieniany ręcznie przez Terraform.

Każdy z tych mechanizmów działa niezależnie i reaguje na inny sygnał: FleetAutoscaler patrzy na liczbę wolnych `GameServer`ów, HPA na CPU podów Mother, a rozmiar klastra zmienia dopiero operator przez Terraform.

### Diagram: jak rośnie system pod obciążeniem

```
Rośnie liczba graczy
    │
    ▼
1. Skalowanie Child (Agones FleetAutoscaler)
   Gracz wchodzi do gry → jego GameServer przechodzi z Ready w Allocated
   FleetAutoscaler widzi: Ready = 0, bufferSize = 1 → brakuje wolnego serwera
   Zwiększa Fleet.spec.replicas o 1
   Fleet controller tworzy kolejny pod → Starting → Ready
   Twardy limit: maxReplicas = 20 → teoretycznie 20 × 15 = 300 graczy naraz

    ▼
2. Skalowanie Mother (HPA)
   Więcej graczy w lobby → więcej połączeń WebSocket → rośnie obciążenie CPU
   HPA mierzy średnie CPU co ~15 sekund
   CPU > 10% wartości "requests" → HPA zwiększa liczbę replik Mother
   Azure Load Balancer rozdziela ruch między wszystkie repliki
   Granice: minReplicas = 1, maxReplicas = 10

    ▼
3. TODO: Skalowanie węzłów AKS
   Gdy liczba podów przekroczy pojemność pojedynczego węzła, K8s Scheduler
   nie ma gdzie postawić nowego poda — pod zostaje w stanie Pending.
   Cluster Autoscaler mógłby wtedy dodać węzeł, ale nie jest włączony.
   Jedyna droga: zmienić aks_node_count w Terraform i uruchomić terraform apply.
   Domyślnie: 1 węzeł standard_b2s_v2 (2 rdzenie CPU, 4 GB RAM) <- ograniczenia konta studneckiego.
```

---

## 2. Kluczowa logika i przepływ

### Agones FleetAutoscaler — polityka Buffer

FleetAutoscaler nie tworzy podów samodzielnie. Jedyne co robi, to zmienia pole `Fleet.spec.replicas`, a właściwe tworzenie podów leży po stronie Fleet controllera. Polityka Buffer mówi mu, żeby utrzymywał stały zapas wolnych (`Ready`) serwerów.

```yaml
# gitops/base/prz-agones.yaml
policy:
  type: Buffer
  buffer:
    bufferSize: 1     # zawsze co najmniej 1 wolny (Ready) serwer
    minReplicas: 1    # dolna granica — nawet bez graczy zostaje 1 pod
    maxReplicas: 20   # górna granica — twardy sufit skalowania
```

**Co dzieje się przy skalowaniu w górę:**

1. Gracz dołącza do gry — jego `GameServer` przechodzi z `Ready` w `Allocated`.
2. FleetAutoscaler widzi, że liczba `Ready` spadła do zera, a `bufferSize = 1` wymaga przynajmniej jednego wolnego serwera.
3. Zwiększa `Fleet.spec.replicas` o jeden.
4. Fleet controller tworzy nowy pod z Childem. Pod startuje, przechodzi w `Starting`, a po zgłoszeniu gotowości przez SDK — w `Ready`.
5. Nowy pod zgłasza gotowość i przechodzi w `Ready` — bufor jest odtworzony. Następny gracz, który kliknie „Dołącz do gry", dostaje ten gotowy serwer natychmiast, bez czekania na start poda.

**Co dzieje się przy skalowaniu w dół:**

1. Ostatni gracz opuszcza serwer. Child wywołuje `agonesSDK.ready()` i `GameServer` wraca ze stanu `Allocated` do `Ready` — pod **nie jest kasowany**, ten sam proces może obsłużyć kolejną sesję.
2. Po tym powrocie w klastrze może być więcej `Ready` serwerów niż wymaga `bufferSize = 1` (np. jeden pusty, który właśnie wrócił, plus jeden trzymany w zapasie).
3. Jeśli nadmiar się utrzymuje, FleetAutoscaler zmniejsza `Fleet.spec.replicas`, a Fleet kasuje jeden z `Ready` podów.
4. Skalowanie w dół zatrzymuje się na `minReplicas = 1` — klaster nigdy nie zostaje bez ani jednego Childa.

Dzięki przejściu `Allocated → Ready` (zamiast typowego dla Agones `Allocated → Shutdown`) ten sam pod może obsłużyć wiele sesji po kolei. Nowa gra nie wymaga startu świeżego poda, więc gracz dostaje serwer natychmiast, a klaster oszczędza zasoby. Jeśli jednak po powrocie do `Ready` w klastrze jest więcej wolnych serwerów, niż wymaga `bufferSize = 1`, FleetAutoscaler zmniejsza `Fleet.spec.replicas`, a Fleet controller ubija nadmiarowe pody — aż do dolnej granicy `minReplicas = 1`.

### Mother HPA — skalowanie na podstawie CPU

HPA skaluje Mother według średniego zużycia CPU we wszystkich replikach. Próg został świadomie ustawiony nisko (10%), a nie na typowe 70–80%, **żeby dało się zaobserwować skalowanie podczas testów** — przy realistycznym progu 70% w warunkach projektowych (kilku graczy na raz) HPA nigdy by nie uruchomił drugiej repliki i nie byłoby jak sprawdzić, czy mechanizm w ogóle działa.

```yaml
# gitops/base/mother-hpa.yaml
spec:
  minReplicas: 1
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 10   # próg skalowania: 10% CPU względem requests
```

**Dlaczego tak niski próg:**

- Cel jest demonstracyjny — w projekcie zaliczeniowym nie da się wygenerować realnego ruchu produkcyjnego, więc próg musi być na tyle niski, żeby drugą replikę dało się sprowokować ręcznie (np. kilka równoczesnych połączeń do lobby albo prosty skrypt obciążeniowy).
- Mother i tak jest głównie I/O-bound (Redis + MongoDB), więc nawet pod większym ruchem CPU rośnie powoli — przy progu 70% HPA praktycznie nigdy by się nie aktywował w warunkach projektu.

**Zasoby pojedynczej repliki Mother:**

```yaml
resources:
  requests: { cpu: "100m", memory: "128Mi" }
  limits:   { cpu: "500m", memory: "256Mi" }
```

Jeden węzeł `standard_b2s_v2` dostarcza 2000m CPU, więc teoretycznie zmieści 20 replik Mother po 100m każda. Realny limit narzuca HPA (`maxReplicas = 10`), a dodatkowo na tym samym węźle działają Child (Agones), Redis i ArgoCD, więc faktycznie dostępnych zasobów jest mniej.

---

## 3. Przykłady z kodu (implementacja)

### Dlaczego maxReplicas = 20

Limit 20 replik dla Childów nie jest przypadkowy — bierze się z pojemności pojedynczego węzła klastra:

```
20 GameServerów × 15 graczy (MAX_PLAYERS)   = 300 graczy jednocześnie
Szacowane zużycie zasobów per Child         = ~50–100m CPU, ~64 MiB RAM
20 Childów w sumie                          = ~1–2 rdzenie CPU, ~1.2 GB RAM
Węzeł standard_b2s_v2                       = 2 CPU, 4 GB RAM

Wniosek: 20 Childów zmieści się na jednym węźle, ale brakuje zapasu na Mother,
Redis, ArgoCD i komponenty Agones. Przy próbie skalowania powyżej 20 należy
najpierw dodać drugi węzeł w Terraform (aks_node_count = 2).
```

### Backpressure w Child — ochrona przed przeciążeniem klienta

Child wysyła pozycje graczy co takt (16 ms) niezależnie od tego, czy klient zdąży je odebrać. Gracz na słabym łączu zaczyna się zapychać — kolejne pakiety lądują w wewnętrznym buforze wysyłkowym uWebSockets i czekają, aż TCP potwierdzi poprzednie. Bufor rośnie z każdą pominiętą klatką gry, a po przekroczeniu twardego limitu `maxBackpressure = 1 MB` uWS uznaje klienta za nie do uratowania i rozłącza połączenie. Żeby nie dopuścić do tego scenariusza, Child przed każdym `socket.send()` woła `getBufferedAmount()` i porównuje wynik z własnym progiem ostrzegawczym `256 * 1024` bajtów (256 KB). Jeśli w kolejce wisi już więcej, ten takt jest pomijany — per-gracz część paczki trafia do `clear_uniq_buf()`, a globalna część poczeka na następną klatkę. Gracz zobaczy krótkie "przeskoczenie" pozycji innych postaci, ale zachowa połączenie.

```javascript
// apps/child-gameserver/main.js
if (pl.socket.getBufferedAmount() < 256 * 1024) {
    pl.socket.send(p.get_uniq_buf(), true);
    // klient nadąża — wyślij paczkę (globalną + per-gracz)
} else {
    p.clear_uniq_buf();
    // klient nie nadąża — wyrzuć per-gracz część, żeby nie wyciekła do następnego
}
```

Kontrola działa w dwóch warstwach: własny próg ostrzegawczy Childa (256 KB) i twardy limit uWS ustawiony na `maxBackpressure: 1024 * 1024` (1 MB). Twardy limit jest siatką bezpieczeństwa na wypadek, gdyby próg ostrzegawczy zawiódł — uWS sam wtedy rozłączy klienta, zamiast w nieskończoność zużywać pamięć serwera.

### Ręczne skalowanie węzłów AKS przez Terraform

Klaster nie ma włączonego Cluster Autoscalera — liczbę węzłów zmienia się ręcznie w Terraform:

```hcl
# infra/terraform/variables.tf
variable "aks_node_count" {
  description = "Liczba maszyn wirtualnych w klastrze (węzłów) — 1 wystarczy na projekt"
  type        = number
  default     = 1
}
```

```hcl
# infra/terraform/aks.tf
default_node_pool {
  name       = "default"
  node_count = var.aks_node_count
  vm_size    = var.aks_node_vm_size
  type       = "VirtualMachineScaleSets"   # wymagane do dodawania/usuwania węzłów
}
```

Żeby dodać węzeł, zmienia się wartość `aks_node_count` (np. na 2) i uruchamia workflow `terraform.yml` z akcją `apply`. Azure VMSS tworzy nową maszynę i dokłada ją do puli, K8s automatycznie wykrywa ją i zaczyna planować na niej pody.

---

## 4. Zależności i protokoły

### Limity skalowania

| Komponent | Min | Max | Mechanizm |
|---|---|---|---|
| Repliki Mother | 1 | 10 | HPA (próg CPU 10%) |
| GameServery Child | 1 | 20 | Agones FleetAutoscaler (Buffer = 1) |
| Węzły AKS | 1 | ∞ (ręcznie) | Terraform apply |
| Gracze na Child | 1 | 15 (`MAX_PLAYERS`) | stała w kodzie aplikacji |
| Gracze w całym systemie | — | ~300 (20 × 15) | `maxReplicas` Agones |

 
### Broadcast listy gier przy wielu replikach Mother

Przy jednej replice Mother sprawa jest prosta: klienci subskrybują kanał uWebSockets `'lobby'` (topic w terminologii uWS), a `app.publish('lobby', buf)` rozsyła do nich aktualizację. Problem pojawia się dopiero przy kilku replikach — każda z nich trzyma własną instancję uWS i własną listę subskrybentów, więc `publish` dociera wyłącznie do klientów podłączonych do tej konkretnej repliki, a nie do wszystkich graczy w lobby.

Rozwiązaniem w projekcie jest Redis pub/sub jako wspólna szyna: Child publikuje jedną wiadomość na kanał `lobby_update`, a każda replika Mother ma własną subskrypcję tego kanału i po otrzymaniu powiadomienia broadcastuje listę do swoich lokalnych klientów.

```javascript
// apps/mother-lobby/main.js
await redisSub.subscribe('lobby_update', () => {
    if (c_man) c_man.broadcast_games().catch(console.error);
    // c_man może być null, jeśli Redis dostarczy powiadomienie
    // zanim ClientManager zdąży się zainicjalizować (race przy starcie).
});
```

```javascript
// apps/mother-lobby/main.js — ClientManager.broadcast_games
this.broadcast_games = async function () {
    const buf = await buildGamesPacket();
    self.app.publish('lobby', buf, true);
    // publish() wysyła do wszystkich klientów subskrybujących 'lobby'
    // w TEJ instancji uWS — czyli tylko do podłączonych do tej repliki Mother.
};
```

Efekt końcowy: klient podłączony do repliki A dostaje aktualizację od repliki A, klient z repliki B od repliki B, a wszyscy widzą tę samą listę, bo źródłem danych jest wspólny Redis.

---

## 5. Konfiguracja wdrożeniowa

### Dodawanie węzłów AKS

```bash
# Ręcznie przez Terraform (workflow_dispatch, action = apply):
# 1. Zmień w infra/terraform/variables.tf: aks_node_count = 2
# 2. Uruchom workflow terraform.yml z action = apply
# 3. VMSS tworzy nowy węzeł, K8s zaczyna na nim planować pody

# Cluster Autoscaler (obecnie wyłączony — wymagałby zmiany w aks.tf):
# default_node_pool {
#   enable_auto_scaling = true
#   min_count = 1
#   max_count = 5
# }
```

### Monitorowanie stanu skalowania

```bash
# Status FleetAutoscalera (aktualna liczba Ready/Allocated, decyzje bufora)
kubectl get fleetautoscaler prz-child-autoscaler -o yaml

# Lista GameServerów z ich stanami (Ready / Allocated / Shutdown)
kubectl get gameservers

# Stan HPA dla Mother — aktualne CPU, bieżąca liczba replik
kubectl get hpa mother-hpa

# Zasoby na poziomie węzłów i podów
kubectl describe node
kubectl top nodes
kubectl top pods
```

### Parametry do zmiany przy większym ruchu

| Parametr | Obecna wartość | Sugestia przy 1000+ graczach |
|---|---|---|
| `maxReplicas` (Agones) | 20 | ~70 (1000 / 15 = 67) |
| `aks_node_count` | 1 | 3–5 |
| `maxReplicas` (HPA Mother) | 10 | 20–30 |
| `averageUtilization` (HPA) | 10 | 60–70 (przy wyższym ruchu stabilność ważniejsza od czasu reakcji) |
| `aks_node_vm_size` | `standard_b2s_v2` (2 CPU / 4 GB) | `Standard_D4s_v3` (4 CPU / 16 GB) |
