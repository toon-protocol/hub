# TOON apex hub — Linode (Akamai Connected Cloud) infrastructure.
#
# Provisions one always-on VPS + a persistent Block Storage volume + an egress-only
# firewall. The box runs the `@toon-protocol/hub` CLI (`hub up`), which pulls the
# pinned GHCR node images and orchestrates the apex stack. State for the wallet,
# config, and (Phase 2) the `.anon` hidden-service identity lives on the volume.
#
# Auth: the Linode API token is read from the LINODE_TOKEN environment variable.
# State: Linode Object Storage (S3-compatible). The dynamic backend settings
#        (bucket / key / region / endpoint / credentials) are supplied at
#        `terraform init` time via -backend-config and AWS_* env vars — see
#        infra/terraform/README.md and .github/workflows/deploy-hub.yml.

terraform {
  required_version = ">= 1.6"

  required_providers {
    linode = {
      source  = "linode/linode"
      version = "~> 2.13"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Linode Object Storage is S3-compatible but not real AWS, so the validations and
  # AWS-specific behaviors are skipped. bucket/key/region/endpoint + access keys are
  # passed via `-backend-config` (CI) or a local backend.hcl (see README).
  backend "s3" {
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
    use_path_style              = true
  }
}

provider "linode" {
  # token sourced from LINODE_TOKEN
}

# Linode requires a root password. We set a strong random one we never print or use —
# no SSH access is configured at all (the box is operated via cloud-init + the status
# push). Break-glass is the Linode LISH console with an API-driven password reset.
resource "random_password" "root" {
  length  = 32
  special = true
}
