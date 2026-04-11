data "azurerm_resources" "node_nsg" {
  resource_group_name = azurerm_kubernetes_cluster.main.node_resource_group
  type                = "Microsoft.Network/networkSecurityGroups"

  depends_on = [azurerm_kubernetes_cluster.main]
}

resource "azurerm_network_security_rule" "allow_agones_ports" {
  name      = "AllowAgonesPorts"
  priority  = 1000
  direction = "Inbound"
  access    = "Allow"
  protocol  = "Tcp"

  source_port_range     = "*"
  source_address_prefix = "Internet"

  destination_port_range     = "${var.agones_port_range_start}-${var.agones_port_range_end}"
  destination_address_prefix = "*"

  resource_group_name         = azurerm_kubernetes_cluster.main.node_resource_group
  network_security_group_name = data.azurerm_resources.node_nsg.resources[0].name

  depends_on = [data.azurerm_resources.node_nsg]
}
