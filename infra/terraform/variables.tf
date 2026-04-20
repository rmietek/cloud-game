# ─── ZMIENNE TERRAFORM ────────────────────────────────────────────────────────
# Zmienne pozwalają nie wpisywać wartości na stałe w kodzie.
# Wartości domyślne (default) działają od razu bez żadnej konfiguracji.
# Zmienne bez default (np. github_pat) muszą być podane przy uruchomieniu —
# przez plik terraform.tfvars lub zmienne środowiskowe TF_VAR_*.
# ─────────────────────────────────────────────────────────────────────────────

variable "resource_group_name" {
  description = "Nazwa grupy zasobów Azure grupującej całą infrastrukturę projektu"
  type        = string
  default     = "PRZ"
}

variable "location" {
  description = "Region Azure gdzie tworzone są wszystkie zasoby"
  type        = string
  default     = "polandcentral" # Polska — najmniejsze opóźnienia dla graczy z PL
}

# ---------- ACR — rejestr obrazów Docker ----------
variable "acr_name" {
  description = "Nazwa rejestru obrazów Docker (musi być globalnie unikalna w całym Azure, tylko małe litery i cyfry)"
  type        = string
  default     = "przacr"
}

variable "acr_sku" {
  description = "Plan cenowy ACR — Basic wystarczy na potrzeby projektu (tańszy, mniejsze limity)"
  type        = string
  default     = "Basic"
}

# ---------- AKS — klaster Kubernetes ----------
variable "aks_cluster_name" {
  description = "Nazwa klastra Kubernetes na Azure"
  type        = string
  default     = "PRZAKSCluster"
}

variable "aks_node_count" {
  description = "Liczba maszyn wirtualnych w klastrze (węzłów) — 1 wystarczy na projekt"
  type        = number
  default     = 1
}

variable "aks_node_vm_size" {
  description = "Rozmiar maszyny wirtualnej węzła (CPU/RAM) — standard_b2s_v2 to 2 CPU / 4 GB RAM"
  type        = string
  default     = "standard_b2s_v2"
}

variable "aks_dns_prefix" {
  description = "Prefix DNS dla adresu API klastra (musi być unikalny w regionie)"
  type        = string
  default     = "przakscluster"
}

# ---------- CosmosDB — baza danych graczy ----------
variable "cosmosdb_account_name" {
  description = "Nazwa konta CosmosDB (musi być globalnie unikalna w całym Azure)"
  type        = string
  default     = "prz-cosmos-db"
}

variable "cosmosdb_mongo_version" {
  description = "Wersja API MongoDB emulowana przez CosmosDB"
  type        = string
  default     = "6.0"
}

# ---------- Agones — porty serwerów gry ----------
# Agones przydziela każdemu serwerowi Child port z tego zakresu.
# Zakres 7000-8000 daje 1000  możliwych portów do serwerów
variable "agones_port_range_start" {
  description = "Początek zakresu portów dla serwerów gry Agones"
  type        = number
  default     = 7000
}

variable "agones_port_range_end" {
  description = "Koniec zakresu portów dla serwerów gry Agones"
  type        = number
  default     = 8000
}

# ---------- GitHub — konto używane przez GitHub Actions ----------
variable "github_org" {
  description = "Nazwa użytkownika lub organizacji GitHub (właściciel repozytorium)"
  type        = string
  default     = "rmietek"
}

variable "github_repo" {
  description = "Nazwa repozytorium GitHub"
  type        = string
  default     = "test"
}

# ---------- GitHub PAT — token dostępu dla ArgoCD ----------
# sensitive = true — wartość nie jest wypisywana w logach ani terminalu.
# Przekazywany przez zmienną środowiskową TF_VAR_github_pat lub terraform.tfvars.
variable "github_pat" {
  description = "GitHub Personal Access Token z uprawnieniem repo (read) — ArgoCD używa go do odczytu repozytorium"
  type        = string
  sensitive   = true
}
