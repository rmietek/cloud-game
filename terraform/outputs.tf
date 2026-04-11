output "resource_group_name" {
  description = "Nazwa grupy zasobów"
  value       = azurerm_resource_group.main.name
}

output "acr_login_server" {
  description = "Adres serwera logowania ACR (przacr.azurecr.io)"
  value       = azurerm_container_registry.main.login_server
}

output "aks_cluster_name" {
  description = "Nazwa klastra AKS"
  value       = azurerm_kubernetes_cluster.main.name
}

output "aks_node_resource_group" {
  description = "Automatycznie utworzona grupa zasobów dla infrastruktury węzłów AKS"
  value       = azurerm_kubernetes_cluster.main.node_resource_group
}

output "aks_kube_config_raw" {
  description = "Surowy kubeconfig klastra AKS (wrażliwe)"
  value       = azurerm_kubernetes_cluster.main.kube_config_raw
  sensitive   = true
}

output "cosmosdb_endpoint" {
  description = "Endpoint konta Cosmos DB"
  value       = azurerm_cosmosdb_account.main.endpoint
}

output "cosmosdb_primary_mongodb_connection_string" {
  description = "Główny connection string MongoDB (pobierany automatycznie po utworzeniu Cosmos DB, wrażliwe)"
  value       = azurerm_cosmosdb_account.main.primary_mongodb_connection_string
  sensitive   = true
}

output "aks_ssh_private_key" {
  description = "Prywatny klucz SSH do węzłów AKS (wrażliwe)"
  value       = tls_private_key.aks_ssh.private_key_pem
  sensitive   = true
}