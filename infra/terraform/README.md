# `infra/terraform` — TOON apex hub on Linode

Provisions one Linode instance + a persistent Block Storage volume + an egress-only
firewall, and bootstraps it (Docker, Node 20, the pinned `@toon-protocol/hub` CLI) via
cloud-init. The box then runs `townhouse up`, which pulls the GHCR node images and
orchestrates the apex stack.

This is normally driven by `.github/workflows/deploy-hub.yml`. The notes below are for
running it locally.

## Inputs

| Variable | Default | Notes |
| --- | --- | --- |
| `region` | `us-ord` | Must support Metadata/cloud-init + Block Storage. |
| `instance_type` | `g6-standard-2` | 4 GB demo default; `g6-standard-4` if memory-pressured. |
| `volume_size` | `30` | GiB; holds `TOWNHOUSE_HOME` (config, `wallet.enc`, `.anon`, settlement DB). |
| `hub_version` | `0.34.3` | Keep in sync with `infra/hub-version.txt`. |
| `ssh_pubkey` | — | **Required.** Public half of the CI deploy key (`HUB_SSH_KEY`). |
| `allowed_ssh_cidr` | — | **Required.** Restrict SSH to CI/operator IP. |
| `allowed_client_cidr` | `0.0.0.0/0` | Phase 1 BTP `3000` + relay WS `7100` source; restrict where possible. |
| `transport` | `direct` | `direct` opens client ports; `hs` closes all protocol inbound. |

## Auth & state

- **Provider:** export `LINODE_TOKEN` (Linode API token, scopes: Linodes R/W, Volumes
  R/W, Firewalls R/W).
- **State:** Linode Object Storage (S3-compatible). The static skip flags live in
  `main.tf`; supply the dynamic parts at init. The S3 backend reads credentials from
  `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — set those to your Linode Object
  Storage access key/secret.

```bash
export LINODE_TOKEN=...                  # Linode API token
export AWS_ACCESS_KEY_ID=...             # Linode Object Storage access key
export AWS_SECRET_ACCESS_KEY=...         # Linode Object Storage secret key

terraform init \
  -backend-config="bucket=toon-tfstate" \
  -backend-config="key=hub/terraform.tfstate" \
  -backend-config="region=us-ord-1" \
  -backend-config="endpoints={s3=\"https://us-ord-1.linodeobjects.com\"}"

terraform apply \
  -var="ssh_pubkey=$(cat ~/.ssh/hub_deploy.pub)" \
  -var="allowed_ssh_cidr=203.0.113.4/32" \
  -var="allowed_client_cidr=203.0.113.4/32"
```

## After apply

`terraform output -raw instance_ip`, then complete the **one-time wallet bootstrap** in
[`docs/deploy-linode.md`](../../docs/deploy-linode.md) before the first CI deploy.

> The Block Storage volume is the durable root of the wallet + `.anon` identity.
> **Snapshot it before destroying anything.**
