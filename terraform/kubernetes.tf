resource "kubernetes_secret" "cosmos_db" {
  metadata {
    name      = "cosmos-db-secret"
    namespace = "default"
  }

  data = {
    MONGO_URL = azurerm_cosmosdb_account.main.primary_mongodb_connection_string
  }

  type = "Opaque"
}
