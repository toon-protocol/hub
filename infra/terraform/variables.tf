variable "label" {
  description = "Name prefix for the Linode instance, volume, and firewall."
  type        = string
  default     = "townhouse-hub"
}

variable "region" {
  description = "Linode region (must support Metadata/cloud-init + Block Storage)."
  type        = string
  default     = "us-ord"
}

variable "instance_type" {
  description = "Linode plan. g6-standard-2 = 4GB/2vCPU (demo default); bump to g6-standard-4 (8GB) if memory-pressured by all children + the anon sidecar."
  type        = string
  default     = "g6-standard-2"
}

variable "volume_size" {
  description = "Persistent Block Storage volume size in GiB (holds TOWNHOUSE_HOME: config.yaml, the .anon identity, and the SQLite settlement DB)."
  type        = number
  default     = 30
}

variable "hub_version" {
  description = "Pinned @toon-protocol/hub npm version installed on the box. Keep in sync with infra/hub-version.txt."
  type        = string
  default     = "0.34.3"
}

variable "network" {
  description = "Network tier the apex initializes with (testnet | devnet | mainnet | custom)."
  type        = string
  default     = "testnet"
}

variable "operator_mnemonic" {
  description = "Operator/treasury seed phrase. Runs the apex in mnemonic mode (no wallet file, no password) — the identity + settlement keys derive deterministically from it. Travels via cloud-init user-data (API-token-gated); lands in TF state, so the state bucket must stay private. Testnet/tiny-funds only."
  type        = string
  sensitive   = true
}

variable "allowed_client_cidr" {
  description = "CIDR allowed to reach the apex client-facing ports (BTP 3000 + relay WS 7100) in Phase 1 direct mode. Restrict to the demo client IP where possible."
  type        = string
  default     = "0.0.0.0/0"
}

variable "transport" {
  description = "BTP transport. 'direct' opens inbound BTP 3000 + relay WS 7100 to allowed_client_cidr. 'hs' (anyone proxy) closes all protocol inbound — rendezvous is over the onion network."
  type        = string
  default     = "direct"

  validation {
    condition     = contains(["direct", "hs"], var.transport)
    error_message = "transport must be 'direct' or 'hs'."
  }
}

# --- Status sink (no-SSH observability) -------------------------------------------
# The control API is loopback-only by design, so instead of exposing it the box pushes
# `townhouse status --json` to Object Storage on a timer. Read the object to see health
# + funding addresses without ever touching the box. Leave the keys blank to disable.

variable "status_bucket" {
  description = "Object Storage bucket the box pushes status JSON to (e.g. the TF state bucket). Empty disables the status push."
  type        = string
  default     = ""
}

variable "status_endpoint" {
  description = "Object Storage S3 endpoint (e.g. https://us-ord-1.linodeobjects.com)."
  type        = string
  default     = ""
}

variable "status_access_key" {
  description = "Object Storage access key for the status push (write-only use)."
  type        = string
  default     = ""
  sensitive   = true
}

variable "status_secret_key" {
  description = "Object Storage secret key for the status push."
  type        = string
  default     = ""
  sensitive   = true
}
