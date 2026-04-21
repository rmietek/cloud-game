# Security — Bezpieczeństwo Systemu

## 1. Cel i architektura

Dokument opisuje mechanizmy bezpieczeństwa implementowane w systemie. Obejmuje: uwierzytelnianie użytkowników, autoryzację połączeń z serwerem gry, walidację danych wejściowych, ochronę przed race condition w transakcjach, i konfigurację sieciową K8s.

### Warstwy bezpieczeństwa

```
Warstwa sieciowa:
  NSG: AllowAgonesPorts (7000-8000 TCP inbound) — tylko potrzebne porty
  LoadBalancer: tylko porty 80 i 3001 dla Mother
  Redis: ClusterIP — niedostępny z zewnątrz klastra

Warstwa uwierzytelniania:
  bcrypt (10 rounds): hashowanie haseł
  Anti-enumeration: identyczny błąd dla braku użytkownika i złego hasła
  MongoDB ObjectId: accountId gracza (trudny do zgadnięcia, 24-znakowy hex)

Warstwa autoryzacji:
  Token jednorazowy (uint32): dostęp do serwera gry
  Weryfikacja skina po stronie serwera: zapobieganie cheatingowi
  WebSocket token w URL: walidacja PRZED handshake (HTTP 401)

Warstwa aplikacji:
  Atomic MongoDB operations: $inc, $push, $ne w jednej operacji
  Walidacja długości nicku
  Backpressure kontrola: ochrona przed flood atakami
```

---

## 2. Kluczowa logika i przepływ

### Hashowanie haseł — bcrypt

```javascript
// apps/mother-lobby/main.js
const CONFIG = { BCRYPT_ROUNDS: 10 };

// Rejestracja
const hash = await bcrypt.hash(password, CONFIG.BCRYPT_ROUNDS);
// 10 rounds ≈ 100ms CPU per hash
// Efekt: atakujący bruteforcując 10000 haseł czeka ~1000s (zamiast ~0.1s z MD5)

// Logowanie
const match = await bcrypt.compare(password, user.password_hash);
// compare() jest też wolny (~100ms) → ochrona przed timing attack
```

### Anti-enumeration

```javascript
// apps/mother-lobby/main.js
const user = await db_users.findOne({ email });
if (!user) return res.status(401).json({ error: 'Nieprawidłowa nazwa użytkownika lub haslo.' });
const match = await bcrypt.compare(password, user.password_hash);
if (!match) return res.status(401).json({ error: 'Nieprawidłowa nazwa użytkownika lub haslo.' });
// IDENTYCZNY komunikat błędu: atakujący nie wie czy email istnieje
// Bez tego: { error: 'User not found' } vs { error: 'Wrong password' }
//   = możliwa enumeracja użytkowników przez atakującego
```

### Token autoryzacji do serwera gry

```javascript
// Mother: generowanie — sztuczka z Uint32Array, żeby nie alokować tablicy za każdym razem
const gen_id = function() {
    this[0] = Math.random() * 0xffffffff;  // przypisanie do Uint32Array rzutuje na uint32
    return this[0];
}.bind(new Uint32Array(1));
const token = gen_id();
// uint32 = ~4.3 miliarda możliwości
// Losowy, jednorazowy, TTL ~160s

// Child: weryfikacja PRZED handshake
upgrade: (res, req, context) => {
    const token_id = req.getUrl().slice(1);
    if (!have_token(token_id)) {
        res.writeStatus('401 Unauthorized').end();
        return;
    }
    // Odrzucenie na etapie upgrade = tańsze niż po open()
    // Nie ma stanu gracza, nie ma alokacji zasobów
}

// Child: jednorazowość tokena
tokens[token_id] = null;
delete tokens[token_id];
// Drugi request z tym samym tokenem → have_token() = false → 401
```

### Weryfikacja skina po stronie serwera

```javascript
// apps/mother-lobby/main.js
if (skinId >= 1 && skinId <= 5) {
    doAddPlayer().catch(console.error);  // darmowe skiny: bez weryfikacji
} else {
    db_users.findOne({ _id: accountId, skin: skinId })
        .then(result => { if (result) doAddPlayer(); });
    // MongoDB: sprawdź czy skin jest w tablicy zakupionych przez gracza
    // Klient NIE może podesłać skinId którego nie kupił → odmowa dołączenia
}
```

### Atomowe transakcje MongoDB — zapobieganie race condition

```javascript
// apps/mother-lobby/main.js — handleBuySkin
// Zakup skina — atomowe (nie możliwe double-spend):
db_users.findOneAndUpdate(
    {
        _id:    accountId,
        skin:   { $ne: buyId },                // nie kupił jeszcze
        points: { $gt: SKIN_COSTS[buyId] },    // ma wystarczająco punktów
    },
    {
        $inc:  { points: -SKIN_COSTS[buyId] },
        $push: { skin: buyId },
    },
    { returnDocument: 'after' }
);
// Bez atomowości: dwa równoległe requesty mogą oba przejść warunek "ma punkty"
// i oba odjąć punkty → ujemne saldo (double-spend)
// Z atomowością: MongoDB wykonuje filtr+update atomowo w jednej operacji
```

---

## 3. Przykłady z kodu (implementacja)

### Walidacja wejść

```javascript
// apps/mother-lobby/main.js
// Nick w grze
if (name == null || name.length > 9) return;
// max 9 znaków — UI nie obsługuje więcej, atakujący nie może przepełnić bufora

// Nick konta
if (!name || name.length >= 20) return;
// max 19 znaków

// Parsowanie danych binarnych — try/catch
try {
    gameId    = p.g_uint32();
    name      = p.g_string16();
    skinId    = p.g_uint8();
    accountId = new ObjectId(p.g_string());
} catch (e) { return; }
// Nieprawidłowy format → wyjątek → return (pomiń, nie crashuj)
```

### Ochrona przed flood / DoS

```javascript
// apps/child-gameserver/main.js
// uWS konfiguracja
maxPayloadLength: 16 * 1024 * 1024,  // max 16MB per wiadomość
idleTimeout: 0,                        // brak timeout (AFK gracze)
maxBackpressure: 1024 * 1024,          // 1MB bufor → disconnect przy overflow

// Backpressure soft limit (w gen_packet)
if (pl.socket.getBufferedAmount() < 256 * 1024) {
    pl.socket.send(p.get_uniq_buf(), true);
} else {
    p.clear_uniq_buf();  // pomiń ten tick
}
// Powolny klient nie blokuje serwera
```

### Respawn protection

```javascript
// apps/child-gameserver/main.js — message() case 8 (respawn)
if (pl.is_dead) {
    // Sprawdzamy is_dead — ochrona przed "podwójnym respawnem"
    // Złośliwy klient wysyłający pakiet 8 gdy gracz żyje
    // Bez sprawdzenia: punkty byłyby resetowane, pozycja losowana = exploit
    pl.is_dead = false;
    // ... respawn logic
}
```

---

## 4. Zależności i Protokoły

### Przepływ credentiali

```
GitHub Secrets → terraform.yml → Terraform → Azure
  AZURE_CLIENT_ID     → ARM_CLIENT_ID    → Service Principal
  AZURE_CLIENT_SECRET → ARM_CLIENT_SECRET

GitHub Secrets → ci.yml → az login → ACR/AKS
  AZURE_CREDENTIALS  (JSON z client_id/secret/tenant/subscription)

GitHub Secrets → Terraform → K8s
  GH_PAT → TF_VAR_github_pat → argocd_repo.tf → K8s Secret
           ArgoCD używa do klonowania repo (read-only)

Terraform → K8s
  CosmosDB.primary_mongodb_connection_string → kubernetes_secret "cosmos-db-secret"
  Zawiera hasło w plaintext wewnątrz K8s Secret (Opaque type, base64 encoded)
```

### Znane ograniczenia bezpieczeństwa

1. **K8s Secrets nie szyfrowane at-rest**: Azure domyślnie nie szyfruje etcd. Dla CosmosDB connection string (zawiera hasło) wymaga Azure Key Vault lub etcd encryption.

2. **Token matchmakingu to uint32**: ~4.3 miliarda możliwości i TTL 160s. Przy 1000 tokenów/s attacker miałby ~0.023% szans trafienia w 1s. Niskie ryzyko w praktyce, ale nie kryptograficznie bezpieczne.

3. **Brak rate limitingu**: Mother nie limituje liczby requestów per IP. Możliwy flood /auth/register lub /auth/login.

4. **Brak HTTPS**: połączenia HTTP/WebSocket nie są szyfrowane (brak TLS termination). Wymaga dodania cert-manager + ingress controller.

5. **Brak walidacji treści nicku**: serwer sprawdza tylko długość, nie filtruje wulgaryzmów/XSS.

---

## 5. Konfiguracja Wdrożeniowa

### NSG — dostęp sieciowy

```hcl
# infra/terraform/nsg.tf
resource "azurerm_network_security_rule" "allow_agones_ports" {
  name                       = "AllowAgonesPorts"
  priority                   = 1000
  direction                  = "Inbound"
  access                     = "Allow"
  protocol                   = "Tcp"
  source_port_range          = "*"
  source_address_prefix      = "Internet"
  destination_port_range     = "${var.agones_port_range_start}-${var.agones_port_range_end}"
  destination_address_prefix = "*"
}
# WYMAGANE dla Agones (NodePort)
# Domyślnie AKS blokuje zewnętrzny dostęp do NodePortów
```

### Redis izolacja

```yaml
# gitops/base/prz-redis.yaml
kind: Service
spec:
  # type nie jest jawnie ustawione — K8s używa domyślnego ClusterIP,
  # czyli Service dostaje wewnętrzny adres IP widoczny tylko w klastrze.
  # NIE LoadBalancer — Redis niedostępny z zewnątrz.
  ports:
  - port: 6379
# Redis dostępny tylko dla podów wewnątrz klastra
# Mother i Child łączą się przez DNS: redis://redis:6379
```

### Sekrety zarządzane przez Terraform

```hcl
# Sekrety NIE są w repo Git — tworzone przez Terraform:
resource "kubernetes_secret" "cosmos_db" {
  data = { MONGO_URL = azurerm_cosmosdb_account.main.primary_mongodb_connection_string }
}
# Terraform state (przechowywany w Azure Blob) zawiera te wartości w plaintext
# Dostęp do state = dostęp do haseł → storage account wymaga odpowiedniej ochrony
```
