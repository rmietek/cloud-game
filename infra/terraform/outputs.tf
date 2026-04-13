# ─── OUTPUTS ──────────────────────────────────────────────────────────────────
# Outputs to wartości które Terraform wypisuje po `terraform apply`.
# Przydatne do ręcznego sprawdzenia co zostało utworzone,
# oraz do odczytania wrażliwych danych (np. haseł) przez `terraform output <nazwa>`.
# ─────────────────────────────────────────────────────────────────────────────

output "resource_group_name" {
  description = "Nazwa grupy zasobów"
  value       = azurerm_resource_group.main.name
}

output "acr_login_server" {
  description = "Adres rejestru obrazów Docker (np. przacr.azurecr.io) — potrzebny do `docker push`"
  value       = azurerm_container_registry.main.login_server
}

output "aks_cluster_name" {
  description = "Nazwa klastra AKS — potrzebna do `az aks get-credentials`"
  value       = azurerm_kubernetes_cluster.main.name
}

output "aks_node_resource_group" {
  description = "Resource group węzłów AKS tworzona automatycznie przez Azure (zawiera maszyny wirtualne, NSG, dyski)"
  value       = azurerm_kubernetes_cluster.main.node_resource_group
}

# sensitive = true — wartość nie jest wypisywana w logach ani terminalu.
# Aby odczytać: terraform output -raw aks_kube_config_raw > ~/.kube/config
output "aks_kube_config_raw" {
  description = "Plik kubeconfig do połączenia z klastrem przez kubectl (wrażliwe)"
  value       = azurerm_kubernetes_cluster.main.kube_config_raw
  sensitive   = true
}

output "cosmosdb_endpoint" {
  description = "Publiczny endpoint CosmosDB (adres HTTP do panelu Azure)"
  value       = azurerm_cosmosdb_account.main.endpoint
}

# sensitive = true — connection string zawiera hasło do bazy danych.
# Aby odczytać: terraform output -raw cosmosdb_primary_mongodb_connection_string
output "cosmosdb_primary_mongodb_connection_string" {
  description = "Connection string do CosmosDB (zawiera hasło — wrażliwe)"
  value       = azurerm_cosmosdb_account.main.primary_mongodb_connection_string
  sensitive   = true
}

# sensitive = true — klucz prywatny SSH daje pełny dostęp do węzłów klastra.
# Aby odczytać: terraform output -raw aks_ssh_private_key > ~/.ssh/aks_key && chmod 600 ~/.ssh/aks_key
output "aks_ssh_private_key" {
  description = "Prywatny klucz SSH do węzłów AKS — do debugowania maszyn wirtualnych (wrażliwe)"
  value       = tls_private_key.aks_ssh.private_key_pem
  sensitive   = true
}
