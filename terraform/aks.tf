
resource "azurerm_kubernetes_cluster" "main" {
  name                = var.aks_cluster_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  dns_prefix          = var.aks_dns_prefix

  linux_profile {
    admin_username = "azureuser"
    ssh_key {
      key_data = tls_private_key.aks_ssh.public_key_openssh
    }
  }

  default_node_pool {
    name                  = "default"
    node_count            = var.aks_node_count
    vm_size               = var.aks_node_vm_size

    node_public_ip_enabled = true

    os_disk_size_gb = 30
    type            = "VirtualMachineScaleSets"
  }

  identity {
    type = "SystemAssigned"
  }

  network_profile {
    network_plugin    = "kubenet"
    load_balancer_sku = "standard"
  }

  tags = {
    environment = "prz"
  }
}

resource "tls_private_key" "aks_ssh" {
  algorithm = "RSA"
  rsa_bits  = 4096
}
