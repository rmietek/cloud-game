# ─── KLASTER KUBERNETES (AKS) ────────────────────────────────────────────────
# Tworzy klaster Kubernetes na Azure — zestaw maszyn wirtualnych które
# uruchamiają kontenery (Mother, Child, Redis, Agones, ArgoCD).
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_kubernetes_cluster" "main" {
  name                = var.aks_cluster_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = var.aks_dns_prefix # Prefix dla adresu API klastra (np. prz-aks.eastus.azmk8s.io)

  # Dostęp SSH do węzłów klastra — przydatny przy debugowaniu maszyn wirtualnych.
  # Klucz generowany jest przez Terraform (zasób tls_private_key poniżej).
  linux_profile {
    admin_username = "azureuser"
    ssh_key {
      key_data = tls_private_key.aks_ssh.public_key_openssh
    }
  }

  # Pula węzłów (node pool) — maszyny wirtualne na których działają kontenery.
  # Wszystkie kontenery w klastrze są rozdzielane między te węzły.
  default_node_pool {
    name       = "default"
    node_count = var.aks_node_count  # Liczba maszyn wirtualnych w klastrze
    vm_size    = var.aks_node_vm_size # Rozmiar maszyny (CPU/RAM), np. Standard_B2s

    node_public_ip_enabled = true # Każdy węzeł dostaje publiczny IP — wymagane przez Agones (serwery gry)

    os_disk_size_gb = 30                        # Dysk systemowy węzła
    type            = "VirtualMachineScaleSets" # Typ puli — pozwala na autoskalowanie węzłów
  }

  # Tożsamość klastra w Azure — konto serwisowe zarządzane przez Azure.
  # Używane m.in. do nadania AKS uprawnień do pobierania obrazów z ACR (patrz acr.tf).
  identity {
    type = "SystemAssigned"
  }

  # Konfiguracja sieci wewnątrz klastra.
  network_profile {
    network_plugin    = "kubenet"  # Najprostszy plugin sieciowy — każdy Pod dostaje IP z prywatnej puli
    load_balancer_sku = "standard" # Load Balancer Azure w wersji Standard — wymagany dla publicznych IP
  }

  tags = {
    environment = "prz"
  }
}

# Klucz SSH generowany automatycznie przez Terraform.
# Publiczna część trafia do linux_profile powyżej,
# prywatna jest zapisywana w Terraform state (do ewentualnego dostępu SSH do węzłów).
resource "tls_private_key" "aks_ssh" {
  algorithm = "RSA"
  rsa_bits  = 4096
}
