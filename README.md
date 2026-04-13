# cloud-game

## Struktura projektu

```
cloud-game/
├── apps/
│   ├── mother-lobby/              # Serwer lobby (logowanie, lista gier)
│   │   ├── public/                # Pliki statyczne serwowane graczom
│   │   │   ├── index.html
│   │   │   ├── ads.txt
│   │   │   ├── img/
│   │   │   ├── js/
│   │   │   └── obj/
│   │   ├── main.js
│   │   └── package.json
│   │
│   ├── child-gameserver/          # Serwer gry (właściwa rozgrywka, Agones)
│   │   ├── main.js
│   │   └── package.json
│   │
│   └── shared/                    # Współdzielony kod między serwerami
│       └── binary.js              # Binarny protokół sieciowy (serializacja pakietów)
│
├── docker/                        # Pliki Dockerfile
│   ├── mother.Dockerfile
│   └── child.Dockerfile
│
├── gitops/                        # Konfiguracja Kubernetes i GitOps
│   ├── argocd/
│   │   └── application.yaml       # Definicja aplikacji ArgoCD
│   ├── base/                      # Wspólna konfiguracja K8s dla wszystkich środowisk
│   │   ├── kustomization.yaml
│   │   ├── prz-mother.yaml
│   │   ├── prz-agones.yaml
│   │   ├── prz-redis.yaml
│   │   └── mother-hpa.yaml
│   └── overlays/
│       └── prod/                  # Nakładka produkcyjna (tagi obrazów Docker)
│           └── kustomization.yaml
│
├── infra/                         # Infrastruktura jako kod
│   └── terraform/                 # Tworzenie infrastruktury Azure
│       ├── providers.tf           # Konfiguracja providerów (Azure, Helm, K8s)
│       ├── aks.tf                 # Klaster Kubernetes (AKS)
│       ├── acr.tf                 # Rejestr obrazów Docker (ACR)
│       ├── agones.tf              # Instalacja Agones przez Helm
│       ├── argocd.tf              # Instalacja ArgoCD przez Helm
│       ├── argocd_repo.tf         # Połączenie ArgoCD z repozytorium Git
│       ├── cosmosdb.tf            # Baza danych (CosmosDB)
│       ├── kubernetes.tf          # Zasoby Kubernetes (Secrets, Namespaces)
│       ├── nsg.tf                 # Reguły sieciowe (Network Security Group)
│       ├── resource_group.tf      # Grupa zasobów Azure
│       ├── variables.tf           # Zmienne wejściowe
│       └── outputs.tf             # Wartości wyjściowe
│
├── docs/                          # Dokumentacja
│   ├── architektura-bazy-danych-i-redis.md
│   ├── frontend.md
│   ├── serializator.md
│   ├── terraform.md
│   ├── infrastruktura-skrot.txt
│   └── przydatne_polecenia.txt
│
├── .github/
│   └── workflows/
│       ├── ci.yml                 # Build obrazów Docker i deploy (przy push na master)
│       └── terraform.yml          # Zarządzanie infrastrukturą (ręczne uruchomienie)
│
└── .dockerignore
```
