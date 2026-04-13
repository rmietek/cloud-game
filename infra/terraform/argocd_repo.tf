# ─── DOSTĘP ARGOCD DO REPOZYTORIUM GIT ───────────────────────────────────────
# ArgoCD musi mieć dostęp do prywatnego repozytorium GitHub żeby móc
# obserwować zmiany i wdrażać nowe wersje aplikacji.
# Ten zasób tworzy Secret w Kubernetes z danymi logowania do GitHub.
# ─────────────────────────────────────────────────────────────────────────────

resource "kubernetes_secret" "argocd_repo" {
  metadata {
    name      = "prz-repo-secret"
    namespace = "argocd" # Musi być w tym samym namespace co ArgoCD
    labels = {
      # Ta etykieta mówi ArgoCD że ten Secret to dane dostępowe do repo —
      # bez niej ArgoCD zignoruje ten Secret.
      "argocd.argoproj.io/secret-type" = "repository"
    }
  }

  data = {
    type     = "git"
    url      = "https://github.com/rmietek/cloud-game.git"  # Adres repozytorium do obserwowania
    username = "rmietek"                                    # Konto GitHub bota 
    password = var.github_pat                               # Personal Access Token z GitHub — przekazywany przez zmienną (nie wpisany na stałe)
  }

  # ArgoCD musi już działać zanim stworzymy ten Secret —
  # bo namespace "argocd" istnieje dopiero po instalacji ArgoCD.
  depends_on = [helm_release.argocd]
}
