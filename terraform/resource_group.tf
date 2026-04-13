# ─── RESOURCE GROUP ───────────────────────────────────────────────────────────
# Resource group to "folder" w Azure — kontener grupujący wszystkie zasoby projektu.
# Wszystkie inne zasoby (AKS, ACR, CosmosDB itd.) są tworzone wewnątrz tej grupy.
# Usunięcie resource group usuwa automatycznie wszystko co się w niej znajduje.
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_resource_group" "main" {
  name     = var.resource_group_name # Nazwa grupy, np. "PRZ"
  location = var.location            # Region Azure gdzie tworzone są zasoby, np. "polandcentral"
}
