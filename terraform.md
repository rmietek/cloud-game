# Infrastruktura — co i gdzie jest tworzone

## Kolejność tworzenia

```
resource_group  →  acr + cosmosdb + aks  →  nsg  →  helm (agones, argocd)  →  argocd_repo + kubernetes
```

---

## Zasoby Azure (Terraform `azurerm_*`)

| Co | Opis | Plik |
|----|------|------|
| **Resource Group** `PRZ` | "Folder" grupujący całą infrastrukturę. Usunięcie go usuwa wszystko. | `resource_group.tf` |
| **ACR** `przacr.azurecr.io` | Prywatny rejestr obrazów Docker. GitHub Actions pushuje tu obrazy, AKS pobiera je przy wdrożeniu. | `acr.tf` |
| **AKS** `PRZAKSCluster` | Klaster Kubernetes — maszyny wirtualne na których działają kontenery (Mother, Child, Redis, Agones, ArgoCD). | `aks.tf` |
| **Role Assignment** `AcrPull` | Uprawnienie dla klastra AKS do pobierania obrazów z ACR bez hasła. | `acr.tf` |
| **CosmosDB** `prz-cosmos-db` | Baza danych graczy z API MongoDB. Przechowuje konta, hasła, statystyki. | `cosmosdb.tf` |
| **NSG Rule** `AllowAgonesPorts` | Reguła firewall otwierająca porty 7000–8000 dla serwerów gry (Agones). | `nsg.tf` |
| **Klucz SSH** | Klucz RSA 4096-bit do ewentualnego dostępu SSH do węzłów klastra. | `aks.tf` |

---

## Paczki Helm (Terraform `helm_release`) jest w dwóch plikach:

| Co | Namespace | Opis | Plik |
|----|-----------|------|------|
| **Agones** `v*` | instaluje `agones-system` | Zarządza serwerami gry — automatycznie uruchamia i usuwa Pody Child gdy gracze dołączają/kończą gry. | `helm.tf` |
| **ArgoCD** `7.7.3` | instaluje `argocd` | Narzędzie GitOps — obserwuje repozytorium Git i automatycznie wdraża zmiany na klaster. | `argocd.tf` |

---

## Zasoby Kubernetes (Terraform `kubernetes_*`)

| Co | Namespace | Opis | Plik |
|----|-----------|------|------|
| **Secret** `cosmos-db-secret` | `default` | Przechowuje connection string do CosmosDB. Serwer Mother odczytuje go jako zmienną środowiskową `MONGO_URL`. | `kubernetes.tf` |
| **Secret** `prz-repo-secret` | `argocd` | Dane logowania do GitHub dla ArgoCD — token PAT pozwalający ArgoCD odczytywać repozytorium. | `argocd_repo.tf` |

---

## Pliki pomocnicze

| Plik | Rola |
|------|------|
| `providers.tf` | Konfiguracja Terraform: backend (stan w Azure Blob Storage), lista providerów, dane logowania do klastra. |
| `variables.tf` | Wszystkie zmienne z wartościami domyślnymi. Jedyna zmienna bez domyślnej to `github_pat` — musi być podana przez `TF_VAR_github_pat`. |
| `outputs.tf` | Wartości wypisywane po `terraform apply` — nazwy zasobów, adresy, wrażliwe dane (klucze, connection stringi). |

---

## Diagram zależności

```
Resource Group
├── ACR (rejestr obrazów)
│   └── Role Assignment → AKS może pobierać obrazy
├── CosmosDB
│   └── Secret cosmos-db-secret → Mother łączy się z bazą
└── AKS (klaster)
    ├── NSG Rule → gracze mogą łączyć się z serwerami gry
    ├── Helm: Agones → zarządza serwerami Child
    └── Helm: ArgoCD → wdraża aplikacje z Git
        └── Secret prz-repo-secret → ArgoCD ma dostęp do repo
```
