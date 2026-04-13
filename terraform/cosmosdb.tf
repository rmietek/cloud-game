# ─── COSMOSDB — BAZA DANYCH GRACZY ───────────────────────────────────────────
# CosmosDB to baza danych Azure z API kompatybilnym z MongoDB.
# Przechowuje dane graczy: konta, hasła, statystyki.
# Serwer Mother łączy się z nią przez standardowy MongoDB connection string.
# ─────────────────────────────────────────────────────────────────────────────

resource "azurerm_cosmosdb_account" "main" {
  name                = var.cosmosdb_account_name
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name

  offer_type = "Standard" # Jedyny dostępny plan dla CosmosDB w AZURE
  kind       = "MongoDB"  # Tryb MongoDB — aplikacja używa sterownika MongoDB bez zmian w kodzie

  mongo_server_version = var.cosmosdb_mongo_version # Wersja API MongoDB (np. "4.2")

  automatic_failover_enabled = false # Wyłączone — failover wymaga wielu regionów, tu mamy jeden

  # Polityka spójności danych — kompromis między wydajnością a gwarancją aktualności danych.
  # "Session" oznacza że każdy użytkownik zawsze widzi swoje własne zapisy natychmiast,
  # ale różni użytkownicy mogą chwilowo widzieć różne wersje danych.
  # Dla gry to wystarczy — gracz zawsze widzi swój własny wynik poprawnie.
  consistency_policy {
    consistency_level = "Session"
  }

  # CosmosDB wymaga zdefiniowania co najmniej jednego regionu.
  # failover_priority = 0 oznacza że to region główny (primary).
  # zone_redundant = false — brak redundancji między strefami dostępności (tańsze).
  geo_location {
    location          = azurerm_resource_group.main.location
    failover_priority = 0
    zone_redundant    = false
  }

  tags = {
    environment = "prz"
  }
}
