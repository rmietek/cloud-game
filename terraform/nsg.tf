# ─── FIREWALL DLA SERWERÓW GRY (AGONES) ──────────────────────────────────────
# Agones uruchamia serwery Child na losowych portach UDP/TCP z określonego zakresu.
# Gracze łączą się z serwerem gry bezpośrednio przez te porty.
# Domyślnie Azure blokuje ruch przychodzący — ten plik otwiera te porty w firewallu.
# ─────────────────────────────────────────────────────────────────────────────

# Pobiera istniejącą grupę bezpieczeństwa sieci (NSG — firewall węzłów klastra).
# AKS tworzy ją automatycznie przy tworzeniu klastra w osobnej resource group.
# Nie tworzymy nowej NSG — tylko do niej dopisujemy regułę poniżej.
data "azurerm_resources" "node_nsg" {
  resource_group_name = azurerm_kubernetes_cluster.main.node_resource_group # Resource group zarządzana przez AKS (nie nasza)
  type                = "Microsoft.Network/networkSecurityGroups"

  depends_on = [azurerm_kubernetes_cluster.main] # NSG istnieje dopiero po utworzeniu klastra
}

# Dodaje regułę do firewall'a która otwiera zakres portów dla serwerów gry.
# Bez tej reguły gracze nie mogliby połączyć się z serwerem Child.
resource "azurerm_network_security_rule" "allow_agones_ports" {
  name      = "AllowAgonesPorts"
  priority  = 1000        # Im niższy numer tym wyższy priorytet reguły (1000 = standardowy)
  direction = "Inbound"   # Ruch przychodzący — od gracza do serwera
  access    = "Allow"     # Zezwól (nie blokuj)
  protocol  = "Tcp"

  source_port_range     = "*"        # Dowolny port źródłowy po stronie gracza
  source_address_prefix = "Internet" # Ruch może przyjść z dowolnego miejsca w internecie

  # Zakres portów na których Agones uruchamia serwery gry (np. 7000-8000).
  # Każdy serwer Child dostaje jeden port z tego zakresu.
  destination_port_range     = "${var.agones_port_range_start}-${var.agones_port_range_end}"
  destination_address_prefix = "*" # Do dowolnego węzła klastra

  resource_group_name         = azurerm_kubernetes_cluster.main.node_resource_group
  network_security_group_name = data.azurerm_resources.node_nsg.resources[0].name # Nazwa NSG pobrana wyżej

  depends_on = [data.azurerm_resources.node_nsg]
}
