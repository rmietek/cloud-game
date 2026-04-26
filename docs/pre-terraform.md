# Ręczna konfiguracja infrastruktury (przed Terraform)

> **Uwaga:** Poniższe polecenia były używane na etapie początkowym projektu, zanim infrastruktura została przeniesiona do Terraform (`infra/terraform/`). Obecnie całe środowisko Azure (AKS, ACR, CosmosDB, NSG, Agones, ArgoCD) jest tworzone automatycznie przez `terraform apply`. Polecenia poniżej zachowane są jako dokumentacja historyczna oraz punkt odniesienia przy ewentualnym ręcznym debugowaniu.

---

## Dostęp do klastra AKS

```bash
az login
az aks get-credentials --resource-group PRZ --name PRZAKSCluster --overwrite-existing
```

---

## Diagnostyka i monitoring

```bash
# Status serwisu Mother (zewnętrzny IP)
kubectl get svc mother
kubectl get svc mother -w

# Szczegóły serwisu
kubectl describe svc mother -n default

# Wszystkie serwisy w klastrze
kubectl get svc -A

# Pody w czasie rzeczywistym
kubectl get pods -w

# Logi konkretnego poda Child
kubectl logs <nazwa-poda> -c child

# Logi wielu podów jednocześnie (wymaga stern)
stern "mother-.*|prz-child-fleet-.*" > zrzut_wszystkich_logow.txt

# Obserwowanie HPA (auto-skalowanie Mother)
kubectl get hpa -w

# Test obciążenia HTTP (sprawdzenie progu HPA = 10% CPU)
ab -n 1000 -c 50 http://<EXTERNAL_IP>/
```




---

## Docker — budowanie i push obrazów

```bash
az acr login --name przacr

# Budowanie i push obu obrazów jedną komendą
docker build -f Dockerfile.mother -t przacr.azurecr.io/prz-mother:latest . \
  && docker push przacr.azurecr.io/prz-mother:latest \
  && docker build -f Dockerfile.child -t przacr.azurecr.io/prz-child:latest . \
  && docker push przacr.azurecr.io/prz-child:latest
```

---

## Wdrożenie manifestów Kubernetes

```bash
kubectl apply -f mother-hpa.yaml
kubectl apply -f prz-agones.yaml
```

### Restart wdrożeń

```bash
# Restart Deploymentu Mother
kubectl rollout restart deployment mother

# Restart Fleet Child (przez adnotację)
kubectl patch fleet prz-child-fleet --type=merge \
  -p "{\"spec\": {\"template\": {\"metadata\": {\"annotations\": {\"date\": \"$(date +%s)\"}}}}}"

# Usunięcie podów Child (Fleet automatycznie tworzy nowe)
kubectl delete pods -l agones.dev/fleet=prz-child-fleet
```

---

## Infrastruktura Azure — ręczne tworzenie (bez Terraform)

> Terraform w `infra/terraform/` automatyzuje poniższe kroki. Poniższe polecenia służą do ręcznego odtworzenia infrastruktury.

```bash
# Grupa zasobów
az group create --name PRZ --location polandcentral

# Azure Container Registry
az acr create \
    --resource-group PRZ \
    --name przacr \
    --sku Basic \
    --location polandcentral

# Klaster AKS
az aks create \
    --resource-group PRZ \
    --name PRZAKSCluster \
    --node-count 1 \
    --node-vm-size standard_b2s_v2 \
    --generate-ssh-keys \
    --attach-acr przacr \
    --location polandcentral \
    --enable-node-public-ip

az aks get-credentials --resource-group PRZ --name PRZAKSCluster --overwrite-existing
```

### Agones (Helm)

```bash
helm repo add agones https://agones.dev/site/charts
helm repo update
helm install my-release --namespace agones-system --create-namespace agones/agones

# Agones domyślnie tworzy serwisy z publicznym IP — zamiana na ClusterIP (brak zewnętrznego IP)
# Konto studenckie Azure ma limit 3 publicznych adresów IP — bez tej zmiany Agones zajmuje je swoimi serwisami,
# przez co Mother nie dostaje zewnętrznego IP.
kubectl patch svc agones-allocator -n agones-system -p '{"spec":{"type":"ClusterIP"}}'
kubectl patch svc agones-ping-http-service -n agones-system -p '{"spec":{"type":"ClusterIP"}}'
kubectl patch svc agones-ping-udp-service -n agones-system -p '{"spec":{"type":"ClusterIP"}}'
```

---

## NSG — reguła dla portów Agones (7000–8000)

```bash
NODE_RG=$(az aks show --resource-group PRZ --name PRZAKSCluster --query nodeResourceGroup -o tsv)
NSG_NAME=$(az network nsg list --resource-group $NODE_RG --query "[0].name" -o tsv)

az network nsg rule create \
    --resource-group $NODE_RG \
    --nsg-name $NSG_NAME \
    --name AllowAgonesPorts \
    --access Allow \
    --protocol Tcp \
    --direction Inbound \
    --priority 1000 \
    --source-address-prefix Internet \
    --source-port-range "*" \
    --destination-address-prefix "*" \
    --destination-port-range 7000-8000
```

---

## CosmosDB

```bash
az provider register --namespace Microsoft.DocumentDB

az cosmosdb create \
    --name prz-cosmos-db \
    --resource-group PRZ \
    --kind MongoDB \
    --server-version 6.0 \
    --locations regionName="polandcentral" failoverPriority=0 isZoneRedundant=False

# Pobranie connection string
az cosmosdb keys list \
    --name prz-cosmos-db \
    --resource-group PRZ \
    --type connection-strings \
    --query "connectionStrings[0].connectionString" \
    --output tsv

# Utworzenie Kubernetes Secret z connection stringiem
kubectl create secret generic cosmos-db-secret \
    --from-literal=MONGO_URL='<WKLEJ_CONNECTION_STRING>'
```

---

## Stan Terraform (Storage Account)

```bash
az group create --name PRZ-tfstate --location polandcentral

az storage account create \
  --name przterraformstate \
  --resource-group PRZ-tfstate \
  --location polandcentral \
  --sku Standard_LRS

az storage container create \
  --name tfstate \
  --account-name przterraformstate
```

---

## Usuwanie zasobów

```bash
# Usunięcie wszystkich grup zasobów projektu
for rg in PRZ PRZ-tfstate NetworkWatcherRG; do
  az group delete --name $rg --yes --no-wait
done

# Sprawdzenie czy grupy zostały usunięte
az group list --output table
```
