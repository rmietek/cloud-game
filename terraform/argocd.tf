# ─── ARGOCD — INSTALACJA PRZEZ HELM ──────────────────────────────────────────
# Instaluje ArgoCD na klastrze Kubernetes używając Helm (menedżer pakietów dla K8s).
# ArgoCD  — obserwuje repozytorium Git i automatycznie
# wdraża zmiany na klaster gdy pojawi się nowy commit.
# ─────────────────────────────────────────────────────────────────────────────

resource "helm_release" "argocd" {
  name             = "argocd"                                  # Nazwa instalacji w klastrze
  repository       = "https://argoproj.github.io/argo-helm"    # Oficjalne repozytorium Helm ArgoCD
  chart            = "argo-cd"                                 # Nazwa paczki Helm do zainstalowania
  namespace        = "argocd"                                  # Namespace w którym zostanie zainstalowany
  create_namespace = true                                      # Utwórz namespace jeśli nie istnieje
  version          = "7.7.3"                                   # Przypięta wersja — żeby uniknąć niespodzianek przy update

  timeout = 300  # Czekaj max 5 minut na uruchomienie — ArgoCD ma dużo komponentów
  wait    = true # Nie kończ dopóki wszystkie pody nie są gotowe (Running)

  # ArgoCD domyślnie wystawia panel jako LoadBalancer (zewnętrzny IP).
  # ClusterIP oznacza że panel jest dostępny tylko wewnątrz klastra —
  # dostęp przez `kubectl port-forward` zamiast publicznego IP - ZABIERA PULE ADRESOW IP DLATEGO WYŁĄCZAMY
  set {
    name  = "server.service.type"
    value = "ClusterIP"
  }

  # Wyłącza wymuszanie HTTPS w panelu ArgoCD.
  # Bez tego ArgoCD przekierowuje HTTP → HTTPS, co przy braku certyfikatu
  # skutkuje błędem w przeglądarce. Na potrzeby projektu HTTP wystarczy.
  set {
    name  = "configs.params.server\\.insecure"
    value = "true"
  }

  # ArgoCD musi być zainstalowany po klastrze i Agones —
  # klaster musi istnieć żeby cokolwiek na nim zainstalować,
  # a Agones jest wymagany przez aplikację którą ArgoCD będzie wdrażał.
  depends_on = [
    azurerm_kubernetes_cluster.main,
    helm_release.agones,
  ]
}

# Wypisuje komendę do pobrania IP panelu ArgoCD po zakończeniu `terraform apply`.
output "argocd_server_ip" {
  description = "IP serwera ArgoCD (dostępne po ~2 min od apply)"
  value       = "Pobierz przez: kubectl -n argocd get svc argocd-server -o jsonpath='{.status.loadBalancer.ingress[0].ip}'"
}
