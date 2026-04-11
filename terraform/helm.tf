
resource "helm_release" "agones" {
  name             = "agones"
  repository       = "https://agones.dev/chart/stable"
  chart            = "agones"
  namespace        = "agones-system"
  create_namespace = true

  timeout          = 600   
  atomic           = false 
  wait             = true
  wait_for_jobs    = false

  set {
    name  = "agones.controller.replicas"
    value = "1"
  }

  set {
    name  = "agones.extensions.replicas"
    value = "1"
  }

  set {
    name  = "agones.allocator.service.serviceType"
    value = "ClusterIP"
  }

  set {
    name  = "agones.ping.http.serviceType"
    value = "ClusterIP"
  }

  set {
    name  = "agones.ping.udp.serviceType"
    value = "ClusterIP"
  }

  depends_on = [azurerm_kubernetes_cluster.main]
}
