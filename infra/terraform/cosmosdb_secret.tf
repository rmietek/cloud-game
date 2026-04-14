# ─── SECRET: CONNECTION STRING DO COSMOSDB ───────────────────────────────────
# Terraform po utworzeniu CosmosDB zna jego connection string (MONGO_URL).
# Ten zasób zapisuje go jako Secret w Kubernetes — czyli bezpieczny obiekt
# do przechowywania haseł i kluczy, niedostępny w zwykłych logach.
#
# Serwer Mother odczytuje ten Secret jako zmienną środowiskową MONGO_URL
# (patrz prz-mother.yaml — secretKeyRef: cosmos-db-secret).
# ─────────────────────────────────────────────────────────────────────────────

resource "kubernetes_secret" "cosmos_db" {
  metadata {
    name      = "cosmos-db-secret" # Nazwa pod którą Mother szuka tego Secretu
    namespace = "default"          # Ten sam namespace co Mother
  }

  data = {
    # Terraform automatycznie pobiera connection string z utworzonego CosmosDB.
    # Wygląda mniej więcej tak: mongodb://nazwa:hasło@host:port/?ssl=true&...
    MONGO_URL = azurerm_cosmosdb_account.main.primary_mongodb_connection_string
  }

  type = "Opaque" # Ogólny typ Secretu — dane binarne bez specjalnej interpretacji przez K8s
}
