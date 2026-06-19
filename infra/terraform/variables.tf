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
  description = "Persistent Block Storage volume size in GiB (holds TOWNHOUSE_HOME: config.yaml, wallet.enc, the .anon identity, and the SQLite settlement DB)."
  type        = number
  default     = 30
}

variable "hub_version" {
  description = "Pinned @toon-protocol/hub npm version installed on the box. Keep in sync with infra/hub-version.txt."
  type        = string
  default     = "0.34.3"
}

variable "ssh_pubkey" {
  description = "Public half of the CI deploy key (HUB_SSH_KEY). Installed for the 'deploy' user via cloud-init."
  type        = string
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to reach SSH (port 22). Restrict to the CI egress / operator IP — never 0.0.0.0/0 in production."
  type        = string
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
