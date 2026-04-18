# Terraform — Infrastruktura Azure

## 1. Cel i architektura

Terraform opisuje całą infrastrukturę jako kod — zamiast klikać w panelu Azure, piszemy plik `.tf` i Terraform sam tworzy, modyfikuje lub usuwa zasoby. Dzięki temu infrastruktura jest powtarzalna i wersjonowana w Git.

Terraform zarządza tutaj:
- **Azure** — Resource Group, klaster AKS, Container Registry (ACR), CosmosDB, reguła NSG (porty Agones 7000–8000), rola AcrPull (AKS może pobierać obrazy z ACR bez hasła)
- **Kubernetes** — dwa Secrety: connection string do CosmosDB (`cosmos-db-secret`) i token GitHub dla ArgoCD (`prz-repo-secret`)
- **Helm** — instalacja Agones i ArgoCD na klastrze AKS

Stan Terraform (lista tego co już zostało stworzone) jest przechowywany w Azure Blob Storage (`przterraformstate/tfstate/prz.terraform.tfstate`) — nie lokalnie, żeby GitHub Actions i wszyscy w zespole widzieli ten sam stan.

Infrastruktura zmienia się rzadko, dlatego workflow Terraform jest uruchamiany **ręcznie** z GitHub Actions (`workflow_dispatch`) — nie przy każdym `git push`.

### Pliki Terraform

```
infra/terraform/
  providers.tf          — backend Azure Blob, providery (azurerm, helm, kubernetes, tls)
  variables.tf          — zmienne (nazwy zasobów, rozmiary VM, lokalizacje)
  resource_group.tf     — Azure Resource Group PRZ
  aks.tf                — Klaster AKS (1 węzeł standard_b2s_v2)
  acr.tf                — Azure Container Registry (przacr)
  nsg.tf                — Network Security Group (AllowAgonesPorts 7000-8000)
  cosmosdb.tf           — CosmosDB (MongoDB API, db=gra)
  cosmosdb_secret.tf    — K8s Secret z connection stringiem CosmosDB
  agones.tf             — Helm: instalacja Agones
  argocd.tf             — Helm: instalacja ArgoCD
  argocd_repo.tf        — K8s Secret: dostęp ArgoCD do repo GitHub
  outputs.tf            — Outputy (ACR URL, kubeconfig, CosmosDB conn string)
```

---

## 2. Kluczowa logika i przepływ

### Gdzie Terraform przechowuje stan infrastruktury

Terraform przechowuje stan infrastruktury w pliku (`tfstate`) — musi on istnieć zanim Terraform zacznie działać. Nie można go stworzyć Terraformem (bo Terraform potrzebuje stanu żeby cokolwiek tworzyć), więc Storage Account jest tworzony raz przez `az` CLI przed pierwszym `terraform init`. Jeśli zasoby już istnieją, `az create` nic nie robi.


```yaml
# .github/workflows/terraform.yml
- name: Utwórz backend storage
  run: |
    az group create \
      --name PRZ-tfstate \
      --location polandcentral \
      --output none

    az storage account create \
      --name przterraformstate \
      --resource-group PRZ-tfstate \
      --location polandcentral \
      --sku Standard_LRS \
      --allow-blob-public-access false \
      --output none

    az storage container create \
      --name tfstate \
      --account-name przterraformstate \
      --auth-mode login \
      --output none
```

### Konfiguracja providerów (`providers.tf`)

Providerzy to pluginy które Terraform pobiera przy `terraform init`. Każdy provider to "adapter" do konkretnego serwisu — `azurerm` wie jak tworzyć zasoby Azure, `helm` wie jak instalować paczki na Kubernetes, `kubernetes` wie jak tworzyć obiekty K8s (Secrety itd.).

`providers.tf` konfiguruje pięć providerów:
- `azurerm` / `azuread` — logują się do Azure przez zmienne środowiskowe `ARM_*` ustawiane z GitHub Secrets
- `helm` / `kubernetes` — żeby zainstalować Agones czy stworzyć Secret, muszą się połączyć z klastrem AKS; biorą adres klastra i certyfikaty bezpośrednio z tworzonego zasobu AKS (`kube_config`) — Terraform automatycznie wie, że klaster musi powstać wcześniej
- `tls` — generuje klucz SSH dla węzłów AKS

```hcl
# infra/terraform/providers.tf
terraform {
  required_version = ">= 1.5.0"

  backend "azurerm" {
    resource_group_name  = "PRZ-tfstate"           # resource group ze storage account
    storage_account_name = "przterraformstate"     # konto storage na Azure
    container_name       = "tfstate"               # kontener (folder) w storage
    key                  = "prz.terraform.tfstate" # nazwa pliku stanu
  }

  required_providers {
    azurerm    = { source = "hashicorp/azurerm",    version = "~> 4.0"  }  # zasoby Azure
    azuread    = { source = "hashicorp/azuread",    version = "~> 2.47" }  # uprawnienia AAD
    helm       = { source = "hashicorp/helm",       version = "~> 2.12" }  # Agones, ArgoCD
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.25" }  # K8s Secrets
    tls        = { source = "hashicorp/tls",        version = "~> 4.0"  }  # klucz SSH węzłów AKS
  }
}

provider "azurerm" { features {} }  # loguje się przez ARM_* zmienne środowiskowe z GitHub Secrets
provider "azuread" {}

# Providerzy helm i kubernetes łączą się z klastrem AKS bezpośrednio przez jego kube_config.
# Certyfikaty są zakodowane w base64 — base64decode() dekoduje je przed użyciem.
provider "helm" {
  kubernetes {
    host                   = azurerm_kubernetes_cluster.main.kube_config[0].host
    client_certificate     = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].client_certificate)
    client_key             = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].client_key)
    cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].cluster_ca_certificate)
  }
}

provider "kubernetes" {
  host                   = azurerm_kubernetes_cluster.main.kube_config[0].host
  client_certificate     = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].client_certificate)
  client_key             = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].client_key)
  cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].cluster_ca_certificate)
}
```

---

## 3. Przykłady z kodu (implementacja)

### AKS Klaster (`aks.tf`)

AKS (Azure Kubernetes Service) to zarządzany klaster Kubernetes — Azure stawia maszyny wirtualne i zarządza nimi, a my deklarujemy ile ich chcemy i jakiego rozmiaru. Wszystkie kontenery projektu (Mother, Child, Redis, Agones, ArgoCD) działają na węzłach tego klastra.

`node_public_ip_enabled = true` jest wymagane przez Agones — serwery Child komunikują się z graczami przez NodePort, więc węzeł musi mieć publiczny IP dostępny z internetu.

Klucz SSH do węzłów generuje Terraform automatycznie (`tls_private_key`) i zapisuje w pliku stanu w Azure Blob Storage — można go odczytać przez `terraform output -raw aks_ssh_private_key` gdy potrzeba wejść SSH na maszynę.

```hcl
# infra/terraform/aks.tf
resource "azurerm_kubernetes_cluster" "main" {
  name                = var.aks_cluster_name   # "PRZAKSCluster"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = var.aks_dns_prefix     # prefix adresu API klastra

  linux_profile {
    admin_username = "azureuser"
    ssh_key { key_data = tls_private_key.aks_ssh.public_key_openssh }
  }

  default_node_pool {
    name                   = "default"
    node_count             = var.aks_node_count   # 1
    vm_size                = var.aks_node_vm_size # "standard_b2s_v2"
    node_public_ip_enabled = true                 # WYMAGANE przez Agones NodePort
    os_disk_size_gb        = 30
    type                   = "VirtualMachineScaleSets"
  }

  identity { type = "SystemAssigned" }  # tożsamość używana do uprawnień AcrPull

  network_profile {
    network_plugin    = "kubenet"   # każdy Pod dostaje IP z prywatnej puli
    load_balancer_sku = "standard"  # wymagany dla publicznych IP
  }

  tags = { environment = "prz" }
}

# Klucz SSH generowany przez Terraform — publiczna część trafia do linux_profile,
# prywatna jest w Terraform state (output: aks_ssh_private_key)
resource "tls_private_key" "aks_ssh" {
  algorithm = "RSA"
  rsa_bits  = 4096
}
```

### ACR — Container Registry (`acr.tf`)

Tworzy prywatny rejestr obrazów Docker (odpowiednik Docker Hub, ale w Azure). GitHub Actions pushuje tu zbudowane obrazy, a AKS pobiera je przy wdrożeniu. Zamiast logowania hasłem, AKS ma nadaną rolę `AcrPull` — dzięki temu klaster może pobierać obrazy bez żadnych credentiali w manifestach.

```hcl
# infra/terraform/acr.tf
resource "azurerm_container_registry" "main" {
  name                = var.acr_name   # "przacr" → przacr.azurecr.io
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = var.acr_sku    # "Basic"
  admin_enabled       = false          # dostęp tylko przez role Azure (nie hasło admina)
}

resource "azurerm_role_assignment" "aks_acr_pull" {
  principal_id                     = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id
  role_definition_name             = "AcrPull"                  # tylko pobieranie, bez pushowania
  scope                            = azurerm_container_registry.main.id
  skip_service_principal_aad_check = true                       # przyspiesza tworzenie
  depends_on                       = [azurerm_kubernetes_cluster.main]
}
```

### CosmosDB (`cosmosdb.tf`)

Baza danych graczy z API kompatybilnym z MongoDB — aplikacja używa standardowego sterownika MongoDB bez żadnych zmian w kodzie. Przechowuje konta graczy, hasła (bcrypt), statystyki i skiny.

```hcl
# infra/terraform/cosmosdb.tf
resource "azurerm_cosmosdb_account" "main" {
  name                = var.cosmosdb_account_name  # "prz-cosmos-db"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  offer_type          = "Standard"
  kind                = "MongoDB"  # tryb MongoDB — aplikacja łączy się standardowym sterownikiem

  mongo_server_version       = var.cosmosdb_mongo_version  # "6.0"
  automatic_failover_enabled = false  # wyłączone — failover wymaga wielu regionów

  consistency_policy {
    consistency_level = "Session"
    # każdy gracz zawsze widzi swoje własne zapisy od razu;
    # różni gracze mogą chwilowo widzieć różne wersje — dla gry to wystarczy
  }

  geo_location {
    location          = azurerm_resource_group.main.location  # "polandcentral"
    failover_priority = 0      # region główny
    zone_redundant    = false  # brak redundancji między strefami (tańsze)
  }

  tags = { environment = "prz" }
}
```

### K8s Secret z connection stringiem (`cosmosdb_secret.tf`)

Po utworzeniu CosmosDB Terraform zna jego connection string (zawiera hasło) i od razu zapisuje go jako K8s Secret `cosmos-db-secret`. Pody Mother i Child odczytują go jako zmienną środowiskową `MONGO_URL` przez `secretKeyRef` w manifeście — hasło nigdy nie trafia do kodu ani plików GitOps, bo Secret jest tworzony przez Terraform poza repozytorium.

```hcl
# infra/terraform/cosmosdb_secret.tf
resource "kubernetes_secret" "cosmos_db" {
  metadata {
    name      = "cosmos-db-secret"
    namespace = "default"
  }
  data = {
    MONGO_URL = azurerm_cosmosdb_account.main.primary_mongodb_connection_string
    # Automatycznie pobierany po utworzeniu CosmosDB przez Terraform
    # Format: mongodb://prz-cosmos-db:PASS@prz-cosmos-db.mongo.cosmos.azure.com:10255/?ssl=true&...
  }
  type = "Opaque"
}
```

### NSG — reguła dla Agones (`nsg.tf`)

Gdy gracz dołącza do gry, przeglądarka łączy się bezpośrednio z serwerem Child na losowym porcie z zakresu 7000–8000 (przydzielanym przez Agones). Azure domyślnie blokuje cały ruch przychodzący, więc bez tej reguły gracze nie mogliby w ogóle połączyć się z serwerem gry.

AKS przy tworzeniu klastra automatycznie zakłada własną NSG (firewall węzłów) w osobnej, zarządzanej przez Azure resource group. Terraform nie tworzy nowej NSG — odczytuje jej nazwę i dopisuje do niej regułę otwierającą te porty.

```hcl
# infra/terraform/nsg.tf

# Pobiera NSG (firewall) automatycznie stworzoną przez AKS — musi istnieć przed odczytem
data "azurerm_resources" "node_nsg" {
  resource_group_name = azurerm_kubernetes_cluster.main.node_resource_group
  type                = "Microsoft.Network/networkSecurityGroups"
  depends_on          = [azurerm_kubernetes_cluster.main]
}

# Otwiera porty Agones w firewallu — bez tego gracze nie połączą się z serwerem gry
resource "azurerm_network_security_rule" "allow_agones_ports" {
  name      = "AllowAgonesPorts"
  priority  = 1000
  direction = "Inbound"
  access    = "Allow"
  protocol  = "Tcp"

  source_port_range          = "*"
  source_address_prefix      = "Internet"
  destination_port_range     = "${var.agones_port_range_start}-${var.agones_port_range_end}"  # "7000-8000"
  destination_address_prefix = "*"

  resource_group_name         = azurerm_kubernetes_cluster.main.node_resource_group
  network_security_group_name = data.azurerm_resources.node_nsg.resources[0].name
  depends_on                  = [data.azurerm_resources.node_nsg]
}
```

### Agones przez Helm (`agones.tf`)

Agones to rozszerzenie Kubernetes do zarządzania serwerami gier. Instalacja przez Helm dodaje do klastra nowe typy zasobów K8s (`Fleet`, `GameServer`, `FleetAutoscaler`) których nie ma w standardowym Kubernetes i zarządza cyklem życia serwerów Child (Ready/Allocated/Shutdown).

Serwisy `allocator` i `ping` są ustawione na `ClusterIP` zamiast domyślnego `LoadBalancer` — każdy `LoadBalancer` w Azure zajmuje jeden publiczny IP z puli, a projekt ma ich ograniczoną liczbę. Serwisy allocator i ping są ustawione na `ClusterIP` zamiast domyślnego `LoadBalancer` — bez tego każdy z nich zajmowałby osobny publiczny IP z puli Azure.

```hcl
# infra/terraform/agones.tf
resource "helm_release" "agones" {
  name             = "agones"
  repository       = "https://agones.dev/chart/stable"
  chart            = "agones"
  namespace        = "agones-system"
  create_namespace = true
  timeout          = 600   # 10 min — Agones instaluje dużo komponentów (CRD, webhooki)
  atomic        = false # nie cofaj przy błędzie — łatwiej debugować co poszło nie tak
  wait          = true  # czekaj aż wszystkie pody Agones będą gotowe przed kontynuacją
  wait_for_jobs = false # nie czekaj na jednorazowe Joby (nie są wymagane do działania)

  set { name = "agones.controller.replicas";           value = "1" }  # zarządza cyklem życia GameServerów
  set { name = "agones.extensions.replicas";           value = "1" }  # webhooki walidacji
  set { name = "agones.allocator.service.serviceType"; value = "ClusterIP" }  # tylko wewnętrzny dostęp
  set { name = "agones.ping.http.serviceType";         value = "ClusterIP" }  # nie potrzebuje publicznego IP
  set { name = "agones.ping.udp.serviceType";          value = "ClusterIP" }

  depends_on = [azurerm_kubernetes_cluster.main]
}
```

### ArgoCD przez Helm (`argocd.tf`)

ArgoCD to narzędzie GitOps — obserwuje repozytorium Git i automatycznie wdraża zmiany na klaster gdy pojawi się nowy commit. Instalowane przez Helm po Agones (bo Agones musi być gotowy zanim ArgoCD zacznie wdrażać aplikację, która go używa).

Panel ArgoCD jest ustawiony na `ClusterIP` i tryb HTTP (bez wymuszania HTTPS) — dostęp przez `kubectl port-forward`, bez zajmowania publicznego IP.

```hcl
# infra/terraform/argocd.tf
resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  namespace        = "argocd"
  create_namespace = true
  version          = "7.7.3"  # przypięta wersja — żeby uniknąć niespodzianek przy update
  timeout          = 300       # 5 min — ArgoCD ma dużo komponentów
  wait             = true

  set { name = "server.service.type";               value = "ClusterIP" }  # bez publicznego IP
  set { name = "configs.params.server\\.insecure";  value = "true"      }  # wyłącza wymuszanie HTTPS

  depends_on = [
    azurerm_kubernetes_cluster.main,
    helm_release.agones,  # Agones musi być gotowy przed wdrożeniem aplikacji przez ArgoCD
  ]
}
```

### Secret z dostępem ArgoCD do GitHub (`argocd_repo.tf`)

ArgoCD musi mieć dostęp do prywatnego repozytorium GitHub żeby móc obserwować zmiany. Terraform tworzy K8s Secret z tokenem GitHub — etykieta `argocd.argoproj.io/secret-type: repository` mówi ArgoCD że to dane dostępowe do repo, nie zwykły Secret.

Secret musi być w namespace `argocd` który istnieje dopiero po instalacji ArgoCD — stąd `depends_on`.

```hcl
# infra/terraform/argocd_repo.tf
resource "kubernetes_secret" "argocd_repo" {
  metadata {
    name      = "prz-repo-secret"
    namespace = "argocd"
    labels = {
      "argocd.argoproj.io/secret-type" = "repository"  # ArgoCD ignoruje Secrety bez tej etykiety
    }
  }
  data = {
    type     = "git"
    url      = "https://github.com/rmietek/cloud-game.git"
    username = "rmietek"
    password = var.github_pat  # token z GitHub Secrets, przekazywany przez TF_VAR_github_pat
  }
  depends_on = [helm_release.argocd]  # namespace "argocd" istnieje dopiero po instalacji ArgoCD
}
```

---

## 4. Zależności i Protokoły

### Kolejność tworzenia zasobów

Terraform sam wykrywa kolejność na podstawie odwołań między zasobami. Poniżej jawne i niejawne zależności:

```
resource_group
  ├─► aks (używa klucza publicznego tls_private_key.aks_ssh)
  │     ├─► agones (depends_on: aks)
  │     │     └─► argocd (depends_on: aks + agones)
  │     │           └─► argocd_repo secret (depends_on: argocd)
  │     ├─► helm + kubernetes providers (czytają kube_config z aks)
  │     └─► nsg rule (czyta node_resource_group z aks)
  ├─► acr
  │     └─► role_assignment aks_acr_pull (depends_on: acr + aks)
  └─► cosmosdb
        └─► cosmosdb_secret (czyta connection string z cosmosdb)
```

### GitHub Actions Secrets → Terraform

| Secret | Terraform zmienna | Cel |
|---|---|---|
| `AZURE_CREDENTIALS` | _(brak — używany przez `azure/login`)_ | JSON z danymi service principal — logowanie `az` CLI (kroki: `az group create`, `az storage`, `az aks get-credentials`, `kubectl apply`) |
| `AZURE_CLIENT_ID` | `ARM_CLIENT_ID` | ID service principal — Terraform loguje się do Azure |
| `AZURE_CLIENT_SECRET` | `ARM_CLIENT_SECRET` | Hasło service principal |
| `AZURE_TENANT_ID` | `ARM_TENANT_ID` | ID organizacji Azure |
| `AZURE_SUBSCRIPTION_ID` | `ARM_SUBSCRIPTION_ID` | ID subskrypcji Azure |
| `GH_PAT` | `TF_VAR_github_pat` | Token GitHub dla ArgoCD (read-only repo access) |

---

## 5. Zmienne, outputy i triggery

### Jak uruchomić workflow Terraform

Workflow Terraform **nie uruchamia się automatycznie przy `git push`** — tylko ręcznie z GitHub → Actions → "Terraform" → "Run workflow". Przed uruchomieniem wybierasz jedną z trzech opcji:

```yaml
# .github/workflows/terraform.yml
on:
  workflow_dispatch:
    inputs:
      action:
        description: 'Co wykonać?'
        required: true
        default: 'plan'
        type: choice
        options:
          - plan    # TYLKO podgląd — pokazuje co by się zmieniło, nic nie tworzy
          - apply   # tworzy/aktualizuje całą infrastrukturę (~5 min)
          - destroy # usuwa WSZYSTKO — klaster, bazę, rejestr; dane przepadają
```

`plan` jest bezpieczny i można go uruchamiać wielokrotnie. `apply` jest potrzebny tylko gdy infrastruktura nie istnieje lub się zmieniła. `destroy` jest nieodwracalny.

### Zmienne (`variables.tf`)

| Zmienna | Wartość domyślna | Opis |
|---|---|---|
| `resource_group_name` | `"PRZ"` | Azure Resource Group |
| `location` | `"polandcentral"` | Region Azure |
| `acr_name` | `"przacr"` | Nazwa Container Registry (→ `przacr.azurecr.io`) |
| `acr_sku` | `"Basic"` | Plan cenowy ACR |
| `aks_cluster_name` | `"PRZAKSCluster"` | Nazwa klastra AKS |
| `aks_dns_prefix` | `"przakscluster"` | Prefix DNS adresu API klastra |
| `aks_node_count` | `1` | Liczba węzłów |
| `aks_node_vm_size` | `"standard_b2s_v2"` | Rozmiar VM (2 CPU / 4 GB RAM) |
| `cosmosdb_account_name` | `"prz-cosmos-db"` | Nazwa konta CosmosDB |
| `cosmosdb_mongo_version` | `"6.0"` | Wersja API MongoDB |
| `agones_port_range_start` | `7000` | Początek zakresu portów serwerów gry |
| `agones_port_range_end` | `8000` | Koniec zakresu portów serwerów gry |
| `github_org` | `"rmietek"` | Właściciel repozytorium GitHub |
| `github_repo` | `"test"` | Nazwa repozytorium GitHub |
| `github_pat` | _(sensitive)_ | Token GitHub dla ArgoCD (read-only) |

### Outputy (`outputs.tf`, `argocd.tf`)

Po `terraform apply` Terraform wypisuje wartości zdefiniowane w `outputs.tf` (oraz w innych plikach .tf — np. `argocd.tf` też definiuje jeden output). Outputy to wygodny sposób żeby po zakończeniu `apply` od razu zobaczyć najważniejsze dane bez szukania ich w panelu Azure.

Outputy bez `sensitive` są widoczne wprost w logach GitHub Actions. Outputy z `sensitive = true` są ukryte w logach (żeby hasła nie wyciekły) — odczytuje się je lokalnie komendą `terraform output -raw <nazwa>`.

| Output | Sensitive | Co to jest i kiedy używać |
|---|---|---|
| `resource_group_name` | nie | Nazwa resource group w Azure (`PRZ`) — pomocna do sprawdzenia w panelu Azure że wszystkie zasoby zostały stworzone w odpowiednim miejscu |
| `acr_login_server` | nie | Adres rejestru obrazów Docker (`przacr.azurecr.io`) — potrzebny do konfiguracji CI gdy chcemy wiedzieć pod jaki adres pushować obrazy |
| `aks_cluster_name` | nie | Nazwa klastra AKS (`PRZAKSCluster`) — używana w komendzie `az aks get-credentials --name PRZAKSCluster` żeby pobrać kubeconfig i połączyć się z klastrem przez `kubectl` |
| `aks_node_resource_group` | nie | Nazwa drugiej resource group tworzonej automatycznie przez Azure dla węzłów klastra (zawiera VM, dyski, NSG) — przydatna do ręcznego przeglądania maszyn w panelu Azure |
| `aks_kube_config_raw` | **tak** | Plik kubeconfig z adresem API klastra i certyfikatami — bez niego `kubectl` nie wie jak połączyć się z AKS. Odczyt: `terraform output -raw aks_kube_config_raw > ~/.kube/config` |
| `cosmosdb_endpoint` | nie | Publiczny adres panelu CosmosDB w Azure (np. `https://prz-cosmos-db.documents.azure.com`) — do podglądu bazy w przeglądarce lub Azure Portal |
| `cosmosdb_primary_mongodb_connection_string` | **tak** | Pełny connection string do bazy z hasłem — ten sam który Terraform zapisuje w K8s Secret `cosmos-db-secret`. Odczyt: `terraform output -raw cosmosdb_primary_mongodb_connection_string` |
| `aks_ssh_private_key` | **tak** | Prywatny klucz RSA do logowania SSH na węzły klastra — przydatny gdy trzeba wejść na maszynę i debugować bezpośrednio. Odczyt: `terraform output -raw aks_ssh_private_key > ~/.ssh/aks_key && chmod 600 ~/.ssh/aks_key` |
| `argocd_server_ip` _(argocd.tf)_ | nie | Gotowa komenda do sprawdzenia publicznego IP panelu ArgoCD po apply: `kubectl -n argocd get svc argocd-server -o jsonpath='{.status.loadBalancer.ingress[0].ip}'` — IP pojawia się ~2 min po zakończeniu instalacji |
