# CI/CD i GitOps

## 1. Cel i achitektura

Pipeline CI/CD jest podzielony na dwie warstwy: **GitHub Actions** (CI) buduje i publikuje obrazy Docker, **ArgoCD** (CD) synchronizuje klaster K8s z repozytorium. Wzorzec GitOps: Stan repozytorium Git zawsze odzwierciedla to co działa na klastrze — żadnych ręcznych `kubectl apply` z maszyn deweloperów.

### Diagram pipeline

```
git push → master
    │
    ▼
GitHub Actions: ci.yml (automatyczny przy każdym push)
    ├─ build-and-push
    │   ├─ docker build -f docker/mother.Dockerfile → prz-mother:SHA8 + prz-mother:latest
    │   ├─ docker build -f docker/child.Dockerfile  → prz-child:SHA8  + prz-child:latest
    │   └─ docker push (oba tagi) → przacr.azurecr.io
    │
    ├─ update-gitops  (needs: build-and-push)
    │   ├─ kustomize edit set image (gitops/overlays/prod/kustomization.yaml)
    │   └─ git commit "chore: update image tags to SHA8 [skip ci]" → push
    │
    └─ apply-argocd   (needs: update-gitops)
        └─ kubectl apply -f gitops/argocd/application.yaml

ArgoCD (polling co ~3 min lub natychmiast po kubectl apply)
    └─ wykrywa zmianę kustomization.yaml
        ├─ Deployment prz-mother: rolling update
        └─ Fleet prz-child: Agones Fleet update
```

---

## 2. Kluczowa Logika i Przepływ

### Job 1: `build-and-push` — tag SHA[:8]

```yaml
# .github/workflows/ci.ym 
- name: Ustal tag obrazu (short SHA)
  id: meta
  run: echo "tag=${GITHUB_SHA::8}" >> $GITHUB_OUTPUT
  # GITHUB_SHA = "664b2919a3f5..." → tag = "664b2919"
  # SHA[:8] = 2^32 kombinacji, unikalny 

- name: Build i push — prz-mother
  run: |
    docker build -f docker/mother.Dockerfile \
      -t ${{ env.ACR_URL }}/prz-mother:${{ steps.meta.outputs.tag }} \
      -t ${{ env.ACR_URL }}/prz-mother:latest \
      .
    docker push ${{ env.ACR_URL }}/prz-mother:${{ steps.meta.outputs.tag }}
    docker push ${{ env.ACR_URL }}/prz-mother:latest

- name: Build i push — prz-child
  run: |
    docker build -f docker/child.Dockerfile \
      -t ${{ env.ACR_URL }}/prz-child:${{ steps.meta.outputs.tag }} \
      -t ${{ env.ACR_URL }}/prz-child:latest \
      .
    docker push ${{ env.ACR_URL }}/prz-child:${{ steps.meta.outputs.tag }}
    docker push ${{ env.ACR_URL }}/prz-child:latest
  # latest = dla ręcznych testów; SHA na produkcji (ArgoCD używa SHA)
```

### Job 2: `update-gitops` — commit bota z [skip ci]

```yaml
# .github/workflows/ci.yml 
- name: Zaktualizuj tag prz-mother
  working-directory: gitops/overlays/prod
  run: |
    kustomize edit set image \
      ${{ env.ACR_URL }}/prz-mother=${{ env.ACR_URL }}/prz-mother:${{ needs.build-and-push.outputs.image_tag }}

- name: Zaktualizuj tag prz-child
  working-directory: gitops/overlays/prod
  run: |
    kustomize edit set image \
      ${{ env.ACR_URL }}/prz-child=${{ env.ACR_URL }}/prz-child:${{ needs.build-and-push.outputs.image_tag }}

- name: Commit i push
  run: |
    git config user.name  "github-actions[bot]"
    git config user.email "github-actions[bot]@users.noreply.github.com"
    git add gitops/overlays/prod/kustomization.yaml
    git diff --staged --quiet || git commit -m \
      "chore: update image tags to ${{ needs.build-and-push.outputs.image_tag }} [skip ci]"
    git push
# [skip ci] KRYTYCZNE: bez tego commit bota uruchomiłby ponownie ci.yml → pętla nieskończona
```

### Job 3: `apply-argocd` — rejestracja Application

```yaml
# .github/workflows/ci.yml 
- name: Azure Login
  uses: azure/login@v3.0.0
  with:
    creds: ${{ secrets.AZURE_CREDENTIALS }}

- name: Pobierz kubeconfig AKS
  run: |
    az aks get-credentials \
      --resource-group PRZ \
      --name PRZAKSCluster \
      --overwrite-existing

- name: Apply ArgoCD Application
  run: kubectl apply -f gitops/argocd/application.yaml
# jeśli Application istnieje → tylko aktualizuje zmiany
# Jeśli ktoś ręcznie usunie Application → następny push przywróci ją
```

### ArgoCD synchronizacja

```yaml
# gitops/argocd/application.yaml
metadata:
  name: prz-app
  namespace: argocd
  finalizers:
    - resources-finalizer.argocd.argoproj.io  # przy usunięciu Application usuwa też zasoby z klastra
spec:
  project: default
  source:
    repoURL:        https://github.com/rmietek/cloud-game.git
    targetRevision: master
    path:           gitops/overlays/prod
  destination:
    server:    https://kubernetes.default.svc  # ten sam klaster gdzie działa ArgoCD
    namespace: default
  syncPolicy:
    automated:
      prune:    true   # usuń z klastra to czego nie ma w repo
      selfHeal: true   # przywróć gdy ktoś zmieni ręcznie
    syncOptions:
      - CreateNamespace=true   # utwórz namespace jeśli nie istnieje
      - ServerSideApply=true   # K8s śledzi "właściciela" pól (ArgoCD vs Agones)
```

---

## 3. Przykłady z kodu (implementacja)

### Kustomize overlay — nadpisywanie tagów

```yaml
# gitops/overlays/prod/kustomization.yaml (aktualizowany przez CI bot)
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
images:
- name: przacr.azurecr.io/prz-child
  newName: przacr.azurecr.io/prz-child
  newTag: 664b2919        # ← SHA commita, aktualizowany przez CI
- name: przacr.azurecr.io/prz-mother
  newName: przacr.azurecr.io/prz-mother
  newTag: 664b2919
resources:
- ../../base               # wszystkie pliki z gitops/base/
```

### Dlaczego Kustomize zamiast Helm

Helm wymaga przepisania wszystkich manifestów jako szablony z placeholderami (`{{ .Values.image.tag }}`), co komplikuje pliki i utrudnia ich czytanie. Kustomize działa inaczej — pliki w `gitops/base/` to czysty YAML bez żadnego templatingu, a zmiany (np. nowy tag obrazu) są nakładane osobno przez "overlay". CI bot aktualizuje tag jedną komendą:

```bash
kustomize edit set image \
  przacr.azurecr.io/prz-mother=przacr.azurecr.io/prz-mother:9ca9ee27
# modyfikuje tylko pole newTag w gitops/overlays/prod/kustomization.yaml
# pliki w base/ pozostają niezmienione — czytelne, bez szablonów
```

### Pipeline Terraform (osobny workflow)

```yaml
# .github/workflows/terraform.yml
on:
  workflow_dispatch:          # RĘCZNE uruchomienie — nie przy każdym push
    inputs:
      action: { type: choice, options: ['plan', 'apply', 'destroy'] }

env:
  ARM_CLIENT_ID:       ${{ secrets.AZURE_CLIENT_ID }}
  ARM_CLIENT_SECRET:   ${{ secrets.AZURE_CLIENT_SECRET }}
  ARM_TENANT_ID:       ${{ secrets.AZURE_TENANT_ID }}
  ARM_SUBSCRIPTION_ID: ${{ secrets.AZURE_SUBSCRIPTION_ID }}
  TF_VAR_github_pat:   ${{ secrets.GH_PAT }}   # przekazywany do variables.tf jako github_pat

steps:
  - Azure Login
  - Utwórz backend storage    # Azure Storage Account na stan Terraform (idempotentne)
  - Setup Terraform (~1.7)
  - Terraform Init             # working-directory: infra/terraform
  - Terraform Plan             # zawsze — nawet przy apply; wynik zapisany jako tfplan
  - Terraform Apply            # tylko gdy action == 'apply': terraform apply -auto-approve tfplan
  - Terraform Destroy          # tylko gdy action == 'destroy': terraform destroy -auto-approve
  - Pobierz kubeconfig AKS     # tylko po apply
  - Apply ArgoCD Application   # tylko po apply: kubectl apply -f gitops/argocd/application.yaml
# Infrastruktura zmienia się rzadko i wymaga świadomej decyzji
# Połączenie z ci.yml byłoby niebezpieczne: push kodu → terraform apply na infrastrukturze
```

--- 

### Sekrety GitHub Actions

| Secret | Używany w | Cel |
|---|---|---|
| `AZURE_CREDENTIALS` | `ci.yml`, `terraform.yml` | Login do Azure (JSON z danymi service principal) |
| `AZURE_CLIENT_ID` | `terraform.yml` | ID service principal — Terraform loguje się do Azure |
| `AZURE_CLIENT_SECRET` | `terraform.yml` | Hasło service principal |
| `AZURE_TENANT_ID` | `terraform.yml` | ID organizacji w Azure |
| `AZURE_SUBSCRIPTION_ID` | `terraform.yml` | ID subskrypcji Azure |
| `GITHUB_TOKEN` | `ci.yml` | Automatyczny token do commit bota (wstrzykiwany przez GitHub Actions, nie wymaga ręcznego ustawienia) |
| `GH_PAT` | `terraform.yml` | ArgoCD dostęp do repo GitHub (read-only), przekazywany jako `TF_VAR_github_pat` |

---


## 5.Pliki GitOps

```
gitops/
  base/
    kustomization.yaml    — lista zasobów base
    prz-mother.yaml       — Deployment + Service Mother
    prz-agones.yaml       — Fleet + FleetAutoscaler
    prz-redis.yaml        — Deployment + Service Redis
    mother-hpa.yaml       — HPA (1-10 replik, 10% CPU)
  overlays/prod/
    kustomization.yaml    — newTag: SHA8 (aktualizowany przez CI)
  argocd/
    application.yaml      — ArgoCD Application (source: overlays/prod)
```

 
