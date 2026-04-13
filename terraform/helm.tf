# ─── AGONES — INSTALACJA PRZEZ HELM ──────────────────────────────────────────
# Agones to rozszerzenie Kubernetesa do zarządzania serwerami gier.
# Zamiast ręcznie tworzyć Pody dla każdej rozgrywki, Agones automatycznie
# uruchamia i usuwa serwery Child gdy gracze dołączają i kończą gry.
# ─────────────────────────────────────────────────────────────────────────────

resource "helm_release" "agones" {
  name             = "agones"
  repository       = "https://agones.dev/chart/stable" # Oficjalne repozytorium Helm Agones
  chart            = "agones"
  namespace        = "agones-system"                   # Agones instaluje się we własnym namespace
  create_namespace = true

  timeout       = 600   # 10 minut — Agones instaluje wiele komponentów, potrzebuje czasu
  atomic        = false # Nie cofaj instalacji przy błędzie — łatwiej debugować co poszło nie tak
  wait          = true  # Czekaj aż wszystkie pody Agones będą gotowe przed kontynuacją
  wait_for_jobs = false # Nie czekaj na jednorazowe Joby (nie są wymagane do działania)

  # Agones Controller zarządza cyklem życia serwerów gry (tworzy/usuwa Game Servery).
  # 1 replika wystarczy — to komponent zarządzający, nie obsługuje ruchu graczy.
  set {
    name  = "agones.controller.replicas"
    value = "1"
  }

  # Agones Extensions obsługuje webhooki Kubernetesa (walidacja obiektów Agones).
  # 1 replika wystarczy na potrzeby projektu.
  set {
    name  = "agones.extensions.replicas"
    value = "1"
  }

  # Allocator to serwis przydzielający wolne serwery gry do graczy.
  # ClusterIP — dostępny tylko wewnątrz klastra (Mother woła go po HTTP wewnętrznie).
  # ZABIERALO NAM ADRES IP Z PULI WOLNYCH
  set {
    name  = "agones.allocator.service.serviceType"
    value = "ClusterIP"
  }

  # Ping HTTP/UDP — serwisy do mierzenia latencji graczy (znajdowanie najbliższego serwera).
  # ClusterIP — nie potrzebują publicznego IP, używane tylko wewnętrznie.
  # ZABIERALO NAM ADRES IP Z PULI WOLNYCH
  set {
    name  = "agones.ping.http.serviceType"
    value = "ClusterIP"
  }

  set {
    name  = "agones.ping.udp.serviceType"
    value = "ClusterIP"
  }

  # Klaster musi istnieć zanim zainstalujemy na nim Agones.
  depends_on = [azurerm_kubernetes_cluster.main]
}
