# Testowanie obciążenia

## 1. Co testujemy i dlaczego

System składa się z dwóch warstw, które reagują na obciążenie inaczej:

- **Mother (lobby)** — skaluje się horyzontalnie przez HPA (1–10 replik). Przyjmuje HTTP (logowanie, rejestracja) i WebSocket (lobby). Testem obciążeniowym sprawdzamy, czy HPA poprawnie reaguje na wzrost ruchu i czy Load Balancer równomiernie rozkłada żądania między repliki.
- **Child (serwery gry)** — zarządzany przez Agones Fleet (1–20 GameServerów). Każdy pod to osobna sesja gry z maksymalnie 15 graczami. Nie skaluje się przez HPA — Agones tworzy nowe pody automatycznie gdy wszystkie istniejące są zajęte (`Allocated`).

---

## 2. Konfiguracja Service LoadBalancer

```yaml
# gitops/base/prz-mother.yaml
kind: Service
apiVersion: v1
metadata:
  name: mother
  namespace: default
spec:
  type: LoadBalancer
  selector:
    app: mother
  ports:
  - name: http
    port: 80
    targetPort: 9876   # Express: logowanie, rejestracja, pliki statyczne
  - name: websocket
    port: 3001
    targetPort: 3001   # uWS: lobby, lista gier, dołączanie
```

- `type: LoadBalancer` — AKS automatycznie tworzy Azure Load Balancer i przydziela publiczny IP. Ruch HTTP/WS rozdzielany jest round-robin między zdrowe pody Mother.
- Po ustanowieniu połączenia WebSocket klient pozostaje przypisany do tej samej repliki do rozłączenia. Reconnect jest bezpieczny — stan lobby (lista gier, tokeny) żyje w Redis, nie w pamięci poda.

Pobierz aktualny publiczny IP:
```bash
kubectl get svc mother
```

---

## 3. Testowanie obciążenia Mother (HTTP)

Testy HTTP sprawdzają poniżej endpoint główny, serwowanie plików statycznych. Na tej podstawie HPA podejmuje decyzje o skalowaniu.

Zastąpiliśmy `EXTERNAL_IP` adresem z `kubectl get svc mother`.

### Apache Benchmark (`ab`)
```bash
# 2000 żądań, 100 jednocześnie — test endpointu głównego
ab -n 2000 -c 100 http://EXTERNAL_IP/
```

### Hey
```bash
# 1000 żądań, 50 jednoczesnych — raport z percentylami opóźnień
hey -n 1000 -c 50 http://EXTERNAL_IP/
```

### Wrk
```bash
# 4 wątki, 200 połączeń, 30 sekund — test limitu przepustowości
wrk -t4 -c200 -d30s http://EXTERNAL_IP/
```

---
### Oczekiwane zachowanie HPA

Mother skonfigurowany jest z bardzo agresywnym progiem skalowania:

```
requests.cpu = 100m  (0,1 rdzenia)
averageUtilization = 10%  →  próg = 10m CPU na pod
```

Przy umiarkowanym ruchu (kilkaset żądań/s) HPA powinien szybko dodać repliki. Zmniejszanie liczby replik następuje z opóźnieniem ~5 minut.

```bash
# Obserwuj decyzje HPA na żywo
kubectl get hpa mother-hpa -w

# NAME        REFERENCE           TARGETS        MINPODS   MAXPODS   REPLICAS
# mother-hpa  Deployment/mother   cpu: 4%/10%    1         10        1
# mother-hpa  Deployment/mother   cpu: 13%/10%   1         10        1       ← przekroczony próg
# mother-hpa  Deployment/mother   cpu: 13%/10%   1         10        2       ← HPA dodał replikę
```

---

## 4. Testowanie Child (serwery gry)

Child nie ma HTTP — testy połączeń do serwerów gry wymagają ważnego tokenu (wygenerowanego przez Mother). Nie można ich testować bezpośrednio narzędziami HTTP.

Najprostszy sposób ręcznego testu: otwórz kilka zakładek przeglądarki i dołącz do gry. Na początku lista w lobby pokazuje jeden serwer w stanie `0/15` (gotowy, czeka na graczy — stan `Ready`). Po dołączeniu pierwszego gracza licznik zmienia się na `1/15`, a serwer przechodzi w stan `Allocated` (zajęty). Agones FleetAutoscaler widzi, że nie ma już żadnego wolnego serwera `Ready`, więc uruchamia nowy pod — ten startuje ze stanem `0/15` i pojawia się jako drugi serwer na liście w lobby.

```
Zakładka 1 dołącza → serwer A: 0/15 → 1/15, stan: Ready → Allocated
                    → FleetAutoscaler tworzy nowy serwer B: 0/15, stan: Ready
                    → frontend w lobby wyświetla teraz dwa serwery na liście
```

Zamiast tego monitoruj stan Agones Fleet:

```bash
# Ile serwerów gry jest gotowych / zajętych / się wyłącza
kubectl get fleet prz-child-fleet
NAME              SCHEDULING   DESIRED   CURRENT   ALLOCATED   READY   
prz-child-fleet   Packed       2         2         1           1       

# Szczegółowy stan każdego GameServera
kubectl get gameservers
NAME                          STATE       ADDRESS         PORT   NODE                               
prz-child-fleet-5gp6v-pdtgv   Allocated   20.215.59.127   7460   aks-default-29743959-vmss000000   
prz-child-fleet-ghvml-n7t4g   Ready       20.215.59.127   7112   aks-default-29743959-vmss000000  

# Autoscaler Agones (analogiczny do HPA, ale dla serwerów gry)
kubectl get fleetautoscaler
NAME                    
prz-child-autoscaler   
```

Agones tworzy nowy pod gdy wszystkie istniejące są w stanie `Allocated` (grają gracze). Pody w stanie `Ready` czekają na nowych graczy. Gdy ostatni gracz się rozłącza, Child wywołuje `agonesSDK.shutdown()` i pod jest usuwany. FleetAutoscaler pilnuje żeby zawsze był co najmniej jeden pod `Ready`.

---
## 5. Monitorowanie reakcji klastra podczas testu

Uruchom w osobnym oknie terminala podczas testu obciążeniowego:

| Polecenie | Co pokazuje |
|---|---|
| `kubectl get hpa -w` | wzrost CPU i decyzje HPA o dodaniu/usunięciu replik Mother |
| `kubectl get pods -w` | uruchamianie nowych podów w czasie rzeczywistym |
| `kubectl top pods` | aktualne zużycie CPU i RAM przez każdy pod |
| `kubectl get gameservers` | stan serwerów gry Agones (Ready / Allocated / Shutdown) |
| `kubectl describe hpa mother-hpa` | szczegóły ostatniej decyzji skalowania |
