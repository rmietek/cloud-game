variable "resource_group_name" {
  description = "Name of the Azure Resource Group"
  type        = string
  default     = "PRZ"
}

variable "location" {
  description = "Azure region for all resources"
  type        = string
  default     = "polandcentral"
}

# ---------- ACR ----------
variable "acr_name" {
  description = "Name of the Azure Container Registry (globally unique, lowercase, alphanumeric)"
  type        = string
  default     = "przacr"
}

variable "acr_sku" {
  description = "SKU of the Azure Container Registry"
  type        = string
  default     = "Basic"
}

# ---------- AKS ----------
variable "aks_cluster_name" {
  description = "Name of the AKS cluster"
  type        = string
  default     = "PRZAKSCluster"
}

variable "aks_node_count" {
  description = "Number of nodes in the default node pool"
  type        = number
  default     = 1
}

variable "aks_node_vm_size" {
  description = "VM size for AKS nodes"
  type        = string
  default     = "standard_b2s_v2"
}

variable "aks_dns_prefix" {
  description = "DNS prefix for the AKS cluster"
  type        = string
  default     = "przakscluster"
}

# ---------- CosmosDB ----------
variable "cosmosdb_account_name" {
  description = "Name of the Cosmos DB account (globally unique)"
  type        = string
  default     = "prz-cosmos-db"
}

variable "cosmosdb_mongo_version" {
  description = "MongoDB server version for Cosmos DB"
  type        = string
  default     = "6.0"
}

# ---------- Agones NSG ----------
variable "agones_port_range_start" {
  description = "Start of the Agones game server port range"
  type        = number
  default     = 7000
}

variable "agones_port_range_end" {
  description = "End of the Agones game server port range"
  type        = number
  default     = 8000
}

# ---------- GitHub (OIDC) ----------
variable "github_org" {
  description = "GitHub organization or username (owner of the repo)"
  type        = string
  default     = "dw-droid"   
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "test"      
}

# ---------- GitHub PAT (dla ArgoCD) ----------
variable "github_pat" {
  description = "GitHub Personal Access Token z uprawnieniem repo (read) — dla ArgoCD"
  type        = string
  sensitive   = true
}