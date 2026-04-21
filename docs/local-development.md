# Local Development — Uruchomienie Projektu

## 1. Cel i architektura

Projekt można uruchomić na trzy sposoby — od najprostszego do pełnego środowiska produkcyjnego:

1. **Lokalnie, natywnie** — Node.js + Redis + MongoDB bezpośrednio na swoim komputerze
2. **Lokalnie z Dockerem** — Node.js natywnie, ale Redis i MongoDB w kontenerach Docker
3. **Produkcja** — GitHub Actions + Azure + Kubernetes (AKS) + ArgoCD

Wszystkie trzy ścieżki używają tego samego kodu Node.js (`apps/mother-lobby/main.js` i `apps/child-gameserver/main.js`). Różnica leży w **otoczeniu** — skąd biorą się Redis i MongoDB, jak Child rejestruje swój adres IP i port, jak klient łączy się z serwerem.

### Co robi każdy komponent

- **Mother** (`apps/mother-lobby`) — lobby: rejestracja/logowanie, lista serwerów gry, generowanie tokenów wstępu. HTTP na porcie 9876, WebSocket na 3001.
- **Child** (`apps/child-gameserver`) — serwer gry: fizyka, kolizje, broadcast pozycji graczy. WebSocket na porcie 5000 (lokalnie) lub w zakresie 7000–8000 (K8s/Agones).
- **Redis** — pośrednik: Mother rejestruje dostępne serwery Child, kolejkuje graczy, przekazuje tokeny.
- **MongoDB / CosmosDB** — baza graczy: konta, hasła (bcrypt), punkty, kupione skiny.

### Wymagania wspólne

- Node.js 20+ (wszystkie ścieżki)
- Git (lokalnie i w CI)
- Dla ścieżki 2: Docker Desktop (Windows/Mac) lub `docker` na Linuxie
- Dla ścieżki 3: konto Azure z aktywną subskrypcją, dostęp do repozytorium GitHub

---

## 2. Ścieżka A — Lokalnie, natywnie

Wszystko działa bezpośrednio na hoście. Najlżejszy tryb — bez Dockera, bez wirtualizacji. Wymaga zainstalowania Redis i MongoDB natywnie.

### 2.1 Instalacja zależności

**Linux (Ubuntu/Debian):**

```bash
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Redis
sudo apt install -y redis-server
sudo service redis-server start

# MongoDB 6.0
wget -qO - https://www.mongodb.org/static/pgp/server-6.0.asc | sudo apt-key add -
echo "deb [ arch=amd64,arm64 ] https://repo.mongodb.org/apt/ubuntu $(lsb_release -cs)/mongodb-org/6.0 multiverse" \
  | sudo tee /etc/apt/sources.list.d/mongodb-org-6.0.list
sudo apt update
sudo apt install -y mongodb-org
sudo mkdir -p /data/db
sudo service mongod start
```

**Windows (WSL2 zalecane):**

```powershell
# W PowerShell jako administrator (jednorazowo):
wsl --install
# Instaluje WSL2 + Ubuntu. Po zakończeniu — restart Windows.
```

Po restarcie uruchom Ubuntu z menu Start i wewnątrz WSL użyj tych samych komend co dla Linuxa. Porty WSL są widoczne z Windows przez `localhost` — nie trzeba nic konfigurować.

> WSL nie uruchamia serwisów automatycznie przy starcie. Dodaj do `~/.bashrc`:
> ```bash
> echo "sudo service redis-server start > /dev/null 2>&1" >> ~/.bashrc
> echo "sudo service mongod start      > /dev/null 2>&1" >> ~/.bashrc
> ```

**Weryfikacja:**

```bash
node -v                                           # v20.x.x
redis-cli ping                                    # PONG
mongosh --eval "db.runCommand({ ping: 1 })"       # { ok: 1 }
```

### 2.2 Sklonowanie repo i instalacja zależności npm

```bash
cd ~
git clone https://github.com/rmietek/cloud-game.git
cd cloud-game

cd apps/mother-lobby     && npm install && cd ../..
cd apps/child-gameserver && npm install && cd ../..
```

> Pakiet `uWebSockets.js` pobierany jest z GitHuba (stąd wymagany Git). Na niektórych systemach może być potrzebny `build-essential` / `python3` do kompilacji natywnych addonów.

### 2.3 Uruchomienie

Potrzebne są cztery terminale:

```bash
# Terminal 1 — Redis (jeśli jeszcze nie uruchomiony)
sudo service redis-server start

# Terminal 2 — MongoDB (jeśli jeszcze nie uruchomione)
sudo service mongod start

# Terminal 3 — Mother (lobby)
cd ~/cloud-game/apps/mother-lobby
node main.js
# HTTP:       http://localhost:9876
# WebSocket:  ws://localhost:3001

# Terminal 4 — Child (serwer gry)
cd ~/cloud-game/apps/child-gameserver
node main.js
# Child startuje na porcie 5000 (domyślny)
# Rejestruje się w Redis z IP=localhost, PORT=5000 — Mother widzi go w lobby
```

> **Domyślne wartości zmiennych — lokalnie można uruchamiać całkiem bez env.** Kod ma fallbacki na wszystkich czterech zmiennych:
> - `REDIS_URL` → `redis://localhost:6379` ([mother-lobby/main.js:195](cloud-game/apps/mother-lobby/main.js#L195), [child-gameserver/main.js:249](cloud-game/apps/child-gameserver/main.js#L249))
> - `MONGO_URL` → `mongodb://localhost:27017` ([mother-lobby/main.js:188](cloud-game/apps/mother-lobby/main.js#L188), [child-gameserver/main.js:250](cloud-game/apps/child-gameserver/main.js#L250))
> - `USE_AGONES` → `false` (kod sprawdza `=== 'true'`, więc brak zmiennej = tryb lokalny)
> - `PORT` → `5000` ([child-gameserver/main.js:64](cloud-game/apps/child-gameserver/main.js#L64): `process.env.PORT || process.argv[2] || 5000`)
>
> Zmienne są potrzebne dopiero w produkcji: `REDIS_URL` wskazuje na nazwę serwisu K8s, `MONGO_URL` jest pobierany z Kubernetes Secret, `USE_AGONES=true` ustawiane w [gitops/base/prz-agones.yaml](cloud-game/gitops/base/prz-agones.yaml). Port przydziela Agones dynamicznie z zakresu 7000–8000.

**W przeglądarce:** otwórz `http://localhost:9876`. Powinieneś zobaczyć stronę logowania, a po zalogowaniu listę serwerów gry — jedną pozycję na `localhost:5000`.

### 2.4 Uruchomienie wielu Childów

Każda instancja Child potrzebuje innego portu. Mother widzi każdą jako osobny serwer w lobby. Port można podać dwoma sposobami:

```bash
# Drugi Child na porcie 5001 — przez zmienną środowiskową:
PORT=5001 node main.js

# Lub przez argument wiersza poleceń (wygodniejsze przy developmencie):
node main.js 5001
```

Kod sprawdza kolejno: `process.env.PORT` → `process.argv[2]` → `5000` ([child-gameserver/main.js:64](cloud-game/apps/child-gameserver/main.js#L64)).

---

## 3. Ścieżka B — Lokalnie z Dockerem

Redis i MongoDB uruchamiamy w kontenerach zamiast instalować natywnie. Node.js (Mother, Child) nadal działa bezpośrednio na hoście — Docker służy tylko do odseparowania baz danych.

**Dlaczego tak?** Instalacja Redis/Mongo natywnie wymaga uprawnień administratora, konfiguracji serwisów systemowych, zaśmieca system. Docker to jedna komenda na kontener — uruchom, używaj, skasuj.

### 3.1 Uruchomienie Redis i MongoDB

```bash
# Redis — bez persystencji (pamięć znika po restarcie kontenera, OK dla dev)
docker run -d --name redis-local -p 6379:6379 redis:7-alpine redis-server --save ""

# MongoDB — dane w wolumenie Docker (przetrwają restart)
docker run -d --name mongo-local -p 27017:27017 -v mongo-data:/data/db mongo:6
```

**Weryfikacja:**

```bash
docker ps
# Powinieneś zobaczyć oba kontenery w stanie "Up"

docker exec redis-local redis-cli ping                                # PONG
docker exec mongo-local mongosh --eval "db.adminCommand({ping:1})"    # { ok: 1 }
```

### 3.2 Uruchomienie Mother i Child

Identycznie jak w ścieżce A — kontenery eksponują porty 6379 i 27017 na `localhost`, więc korzystamy z domyślnych wartości w kodzie:

```bash
# Mother
cd apps/mother-lobby
node main.js

# Child
cd apps/child-gameserver
node main.js
```

### 3.3 Zatrzymanie i wyczyszczenie

```bash
docker stop redis-local mongo-local       # zatrzymaj kontenery
docker rm   redis-local mongo-local       # usuń (dane Redis znikają, Mongo zostają w wolumenie)
docker volume rm mongo-data               # usuń też dane Mongo
```

### 3.4 Konteneryzacja całego stosu (opcjonalnie)

Projekt ma gotowe Dockerfile dla Mother ([docker/mother.Dockerfile](cloud-game/docker/mother.Dockerfile)) i Child ([docker/child.Dockerfile](cloud-game/docker/child.Dockerfile)). Używane są głównie przez CI do budowania obrazów wrzucanych do Azure Container Registry, ale można je też uruchomić lokalnie:

```bash
# Z katalogu głównego repo (gdzie jest `apps/`):
docker build -f docker/mother.Dockerfile -t prz-mother:local .
docker build -f docker/child.Dockerfile  -t prz-child:local  .

# Uruchom (--network host żeby widzieć localhost:6379 / 27017)
docker run --network host prz-mother:local
docker run --network host prz-child:local
```

> `--network host` działa tylko na Linuxie. Na Windows/Mac użyj `host.docker.internal` zamiast `localhost` w URL-ach.

---

## 4. Ścieżka C — Produkcja (GitHub + Azure + Kubernetes)

Produkcyjne wdrożenie składa się z dwóch niezależnych faz: **jednorazowe postawienie infrastruktury** (Terraform) i **ciągłe wdrażanie nowych wersji kodu** (CI/CD + ArgoCD).

```
Faza 1 — jednorazowo                    Faza 2 — co push na master
┌──────────────────────┐                ┌─────────────────────────┐
│ GitHub Actions       │                │ GitHub Actions          │
│  terraform.yml       │                │  ci.yml                 │
│  (ręcznie: apply)    │                │  (auto: push)           │
└──────────┬───────────┘                └────────────┬────────────┘
           │                                         │
           ↓                                         ↓
     tworzy w Azure:                        buduje obrazy Docker,
     • Resource Group                       pushuje do ACR,
     • AKS (Kubernetes)                     aktualizuje tag w gitops/,
     • CosmosDB                             commituje do repo
     • ACR (registry)                                │
     • Agones (w AKS)                                │
     • ArgoCD (w AKS)                                ↓
           │                                 ArgoCD w klastrze
           └─────────────────────→           zauważa zmianę w repo
                                             i wdraża nową wersję
                                             (kubectl apply pod maską)
```

### 4.1 Konfiguracja sekretów GitHub

Przed pierwszym uruchomieniem trzeba ustawić sekrety w **GitHub → Settings → Secrets and variables → Actions**:

| Sekret | Do czego | Jak zdobyć |
|---|---|---|
| `AZURE_CLIENT_ID` | Service Principal — ID konta technicznego | `az ad sp create-for-rbac` |
| `AZURE_CLIENT_SECRET` | hasło Service Principal | wygenerowane przy SP |
| `AZURE_TENANT_ID` | ID organizacji Azure | `az account show` |
| `AZURE_SUBSCRIPTION_ID` | ID subskrypcji Azure | `az account show` |
| `AZURE_CREDENTIALS` | te same dane w formacie JSON | z `--sdk-auth` |
| `GH_PAT` | GitHub Personal Access Token (uprawnienie `repo:read`) | GitHub → Settings → Developer settings |

**Polecenie tworzące Service Principal** (z [terraform.yml](cloud-game/.github/workflows/terraform.yml)):

```bash
az ad sp create-for-rbac \
  --name "github-actions-prz" \
  --role AcrPush \
  --scopes /subscriptions/<ID>/resourceGroups/PRZ/providers/Microsoft.ContainerRegistry/registries/przacr \
  --sdk-auth
```

### 4.2 Faza 1 — postawienie infrastruktury (Terraform)

W **GitHub → Actions → Terraform → Run workflow**, wybierz akcję:

- **`plan`** — podgląd: pokazuje co by się zmieniło, niczego nie tworzy (bezpieczne, można puszczać wielokrotnie)
- **`apply`** — faktyczne tworzenie infrastruktury (~5 min)
- **`destroy`** — usunięcie wszystkiego (NIEODWRACALNE, dane graczy przepadają)

Co robi `apply` (z [infra/terraform/](cloud-game/infra/terraform/)):

1. Tworzy **backend storage** w Azure Blob (przechowuje stan Terraforma)
2. Tworzy **Resource Group** `PRZ` w regionie `polandcentral`
3. Tworzy **ACR** (`przacr.azurecr.io`) — rejestr obrazów Docker
4. Tworzy **AKS** (`PRZAKSCluster`) — klaster Kubernetes z 1 nodem
5. Tworzy **CosmosDB** (API MongoDB 6.0) — baza graczy
6. Tworzy **NSG rule** dla portów Agones (7000–8000 TCP inbound)
7. Instaluje **Agones** w AKS (przez Helm)
8. Instaluje **ArgoCD** w AKS i konfiguruje go do obserwowania tego repozytorium

Weryfikacja:

```bash
# Pobierz kubeconfig
az aks get-credentials --resource-group PRZ --name PRZAKSCluster

kubectl get pods -A
# Powinieneś zobaczyć pody w namespace: agones-system, argocd, default
```

### 4.3 Faza 2 — wdrożenie nowej wersji kodu

Wystarczy `git push origin master`. Pipeline [ci.yml](cloud-game/.github/workflows/ci.yml) uruchamia trzy kroki:

**Krok 1 — `build-and-push`:**
- Buduje obraz `prz-mother` z `docker/mother.Dockerfile`
- Buduje obraz `prz-child` z `docker/child.Dockerfile`
- Taguje oba obrazy dwukrotnie: pierwszymi 8 znakami SHA commita oraz `latest`
- Pushuje do ACR (`przacr.azurecr.io`)

**Krok 2 — `update-gitops`:**
- W `gitops/overlays/prod/kustomization.yaml` aktualizuje tagi obrazów na nowy SHA
- Commituje zmianę z komunikatem `[skip ci]` (żeby nie zapętlić pipeline)
- Pushuje z powrotem do repo

**Krok 3 — `apply-argocd`:**
- `kubectl apply -f gitops/argocd/application.yaml` (gwarantuje że ArgoCD widzi aplikację)
- ArgoCD wykrywa commit z Kroku 2 i rozpoczyna synchronizację

**W rezultacie:**

```
developer push → GitHub Actions → ACR (nowy obraz)
              → gitops/overlays/prod/kustomization.yaml (nowy tag)
              → ArgoCD w klastrze zauważa zmianę
              → kubectl apply (rolling update)
              → nowa wersja Mother i Child w produkcji
```

### 4.4 Weryfikacja wdrożenia

```bash
# Status synchronizacji ArgoCD
kubectl -n argocd get applications
# Szukaj: SYNCED=True HEALTHY=Healthy

# Pody Mother i Child
kubectl get pods
# prz-mother-xxx (Deployment z HPA)
# prz-child-xxx  (GameServer z Agones)

# Publiczne IP Mothera
kubectl get svc prz-mother
# EXTERNAL-IP to adres do którego łączy się przeglądarka gracza
```

### 4.5 Zatrzymanie produkcji

Aby zatrzymać wszystko i uniknąć kosztów Azure — uruchom **Terraform → destroy** w GitHub Actions. To kasuje klaster, bazę danych i rejestr. Dane graczy przepadają (brak backupu).

---

## 5. Różnice między ścieżkami

| Aspekt | A: natywnie | B: Docker | C: produkcja (K8s) |
|---|---|---|---|
| Redis | apt/service | kontener | Service ClusterIP w AKS |
| MongoDB | apt/service | kontener | CosmosDB (API Mongo) |
| Agones SDK | `USE_AGONES=false` | `USE_AGONES=false` | `USE_AGONES=true` |
| Port Child | `PORT=5000` (zmienna) | `PORT=5000` | Agones NodePort (7000–8000) |
| IP Child (rejestracja) | `localhost` | `localhost` | `gs.status.address` (node IP) |
| Redis URL | `redis://localhost:6379` | `redis://localhost:6379` | `redis://redis:6379` (DNS K8s) |
| Skalowanie Mother | 1 instancja | 1 instancja | HPA 1–N ([mother-hpa.yaml](cloud-game/gitops/base/mother-hpa.yaml)) |
| SIGTERM / graceful shutdown | brak (Ctrl+C) | brak (Ctrl+C) | wysyłany przez Agones przy zwalnianiu poda |
| Persystencja Redis | brak (`--save ""`) | brak | brak (Redis jest tylko pamięcią podręczną) |
| HTTPS / TLS | brak | brak | brak (do dodania przez cert-manager) |

### Flaga `USE_AGONES`

Jedna zmienna decyduje który tryb startu wybiera Child ([apps/child-gameserver/main.js](cloud-game/apps/child-gameserver/main.js)):

```javascript
const USE_AGONES = process.env.USE_AGONES === 'true';

async function connectAgones() {
    if (!USE_AGONES) {
        // Tryb lokalny: pomiń SDK, weź adres/port ze zmiennych środowiskowych
        await redis_connect();
        return;
    }
    // Tryb K8s: połącz się z Agones SDK (sidecar w tym samym podzie)
    await agonesSDK.connect();
    // Pobierz przypisany NodePort i IP node'a z Agones
    // ...
}
```

### Co "nie działa" bez Agones

- **Brak buffer policy** — Agones utrzymuje zawsze N wolnych serwerów; lokalnie musisz ręcznie uruchamiać kolejnego Childa
- **Brak rolling replace** — produkcja: nowy pod Child, stary dokończy mecze i znika. Lokalnie: Ctrl+C i uruchom od nowa
- **Brak health checków** — Agones restartuje zawieszone pody, lokalnie nic ci nie przyjdzie na pomoc

---

## 6. Struktura katalogów

```
cloud-game/
├── apps/
│   ├── shared/binary.js          ← protokół binarny (używany przez Mother i Child)
│   ├── mother-lobby/
│   │   ├── main.js
│   │   └── public/
│   │       ├── index.html        ← frontend gry (serwowany przez Express)
│   │       └── js/binary.js      ← kopia z shared/
│   └── child-gameserver/
│       └── main.js
├── docker/
│   ├── mother.Dockerfile
│   └── child.Dockerfile
├── infra/terraform/              ← Faza 1: tworzenie infrastruktury
│   ├── aks.tf, acr.tf, cosmosdb.tf, agones.tf, argocd.tf, nsg.tf, ...
│   └── variables.tf
├── gitops/
│   ├── base/                     ← manifesty K8s (Mother, Child, Redis, Agones fleet)
│   ├── overlays/prod/            ← kustomization z tagami obrazów (aktualizowany przez CI)
│   └── argocd/application.yaml   ← definicja aplikacji ArgoCD
└── .github/workflows/
    ├── terraform.yml             ← Faza 1: ręczne plan/apply/destroy
    └── ci.yml                    ← Faza 2: auto na push do master
```
