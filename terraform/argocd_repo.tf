resource "kubernetes_secret" "argocd_repo" {
  metadata {
    name      = "prz-repo-secret"
    namespace = "argocd"
    labels = {
      "argocd.argoproj.io/secret-type" = "repository"
    }
  }

  data = {
    type     = "git"
    url      = "https://github.com/rmietek/cloud-game.git"
    username = "dw-droid"
    password = var.github_pat
  }

  depends_on = [helm_release.argocd]
}
