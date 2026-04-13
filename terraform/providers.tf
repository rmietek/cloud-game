# ─── KONFIGURACJA TERRAFORM ───────────────────────────────────────────────────
# Ten plik definiuje:
#   1. Gdzie Terraform przechowuje swój stan (backend)
#   2. Jakich pluginów (providerów) używa i w jakich wersjach
#   3. Jak providerzy łączą się z zewnętrznymi serwisami (Azure, klaster K8s)
# ─────────────────────────────────────────────────────────────────────────────

terraform {
  required_version = ">= 1.5.0" # Minimalna wersja Terraform wymagana do uruchomienia

  # Backend — miejsce gdzie Terraform przechowuje plik stanu (terraform.tfstate).
  # Stan to "pamięć" Terraforma — wie co już zostało utworzone i co trzeba zmienić.
  # Przechowujemy go w Azure Blob Storage (nie lokalnie) żeby cały zespół
  # i GitHub Actions miały dostęp do tego samego stanu.
  backend "azurerm" {
    resource_group_name  = "PRZ-tfstate"         # Resource group z kontem storage
    storage_account_name = "przterraformstate"   # Konto storage na Azure
    container_name       = "tfstate"             # Kontener (folder) w storage
    key                  = "prz.terraform.tfstate" # Nazwa pliku stanu
  }

  # Providerzy to pluginy które Terraform pobiera przy `terraform init`.
  # Każdy provider "wie jak rozmawiać" z danym serwisem (Azure, Helm, K8s itd.).
  # Wersje są przypięte (~> 4.0 = dowolna 4.x) żeby uniknąć niespodzianek przy update.
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0" # Tworzy zasoby Azure (AKS, ACR, CosmosDB, NSG itd.)
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 2.47" # Zarządza tożsamościami i uprawnieniami w Azure Active Directory
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.12" # Instaluje paczki Helm na klastrze (Agones, ArgoCD)
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.25" # Tworzy zasoby Kubernetes (Secrets, Namespaces itd.)
    }
    tls = {
      source  = "hashicorp/tls"
      version = "~> 4.0" # Generuje klucze SSH i certyfikaty (używany do klucza SSH węzłów AKS)
    }
  }
}

# Provider Azure — loguje się do Azure używając zmiennych środowiskowych
# (ARM_CLIENT_ID, ARM_CLIENT_SECRET itd.) ustawianych przez GitHub Actions.
provider "azurerm" {
  features {}
}

# Provider Azure Active Directory — używany do zarządzania uprawnieniami.
provider "azuread" {}

# Provider Helm — łączy się z klastrem AKS żeby instalować paczki Helm.
# Dane do połączenia (host, certyfikaty) pobierane są z utworzonego klastra AKS.
# base64decode — bo Kubernetes zwraca certyfikaty zakodowane w base64.
provider "helm" {
  kubernetes {
    host                   = azurerm_kubernetes_cluster.main.kube_config[0].host
    client_certificate     = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].client_certificate)
    client_key             = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].client_key)
    cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].cluster_ca_certificate)
  }
}

# Provider Kubernetes — łączy się z klastrem AKS żeby tworzyć zasoby K8s (np. Secrets).
# Identyczne dane do połączenia co provider Helm powyżej.
provider "kubernetes" {
  host                   = azurerm_kubernetes_cluster.main.kube_config[0].host
  client_certificate     = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].client_certificate)
  client_key             = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].client_key)
  cluster_ca_certificate = base64decode(azurerm_kubernetes_cluster.main.kube_config[0].cluster_ca_certificate)
}
