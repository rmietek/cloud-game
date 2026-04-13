# ─── AZURE CONTAINER REGISTRY (ACR) ─────────────────────────────────────────
# Prywatny rejestr obrazów Docker — odpowiednik Docker Hub ale w Azure.
# GitHub Actions pushuje tu zbudowane obrazy (prz-mother, prz-child),
# a Kubernetes pobiera je stamtąd przy wdrożeniu.
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_container_registry" "main" {
  name                = var.acr_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location
  sku                 = var.acr_sku

  admin_enabled = false # Wyłączamy logowanie hasłem — dostęp tylko przez role Azure (bezpieczniejsze)
}

# ─── UPRAWNIENIA: AKS → ACR ──────────────────────────────────────────────────
# Kubernetes (AKS) musi mieć prawo pobierać obrazy z rejestru ACR.
# Bez tego klaster dostanie błąd "unauthorized" przy próbie uruchomienia kontenera.
#
# Jak to działa:
#   - Każdy klaster AKS ma tożsamość (kubelet_identity) — konto serwisowe w Azure
#   - Nadajemy tej tożsamości rolę "AcrPull" na rejestrze ACR
#   - Dzięki temu AKS może pobierać obrazy bez hasła — przez token Azure
# ─────────────────────────────────────────────────────────────────────────────
resource "azurerm_role_assignment" "aks_acr_pull" {
  principal_id                     = azurerm_kubernetes_cluster.main.kubelet_identity[0].object_id # Tożsamość klastra AKS
  role_definition_name             = "AcrPull"  # Rola tylko do pobierania obrazów (nie do pushowania)
  scope                            = azurerm_container_registry.main.id # Zakres: tylko ten rejestr
  skip_service_principal_aad_check = true # Przyspiesza tworzenie — pomija wolną weryfikację AAD

  depends_on = [azurerm_kubernetes_cluster.main] # Klaster musi istnieć zanim nadamy mu uprawnienia
}
