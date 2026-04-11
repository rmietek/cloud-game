resource "helm_release" "argocd" {
  name             = "argocd"
  repository       = "https://argoproj.github.io/argo-helm"
  chart            = "argo-cd"
  namespace        = "argocd"
  create_namespace = true
  version          = "7.7.3"

  timeout = 300
  wait    = true

  set {
    name  = "server.service.type"
    value = "ClusterIP"
  }

  set {
    name  = "configs.params.server\\.insecure"
    value = "true"
  }

  depends_on = [
    azurerm_kubernetes_cluster.main,
    helm_release.agones,
  ]
}

output "argocd_server_ip" {
  description = "IP serwera ArgoCD (dostępne po ~2 min od apply)"
  value       = "Pobierz przez: kubectl -n argocd get svc argocd-server -o jsonpath='{.status.loadBalancer.ingress[0].ip}'"
}
