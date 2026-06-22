# `infra/terraform` — TOON apex hub on Linode

Provisions one Linode instance + a persistent Block Storage volume + a firewall, and
hands the (seed-free) config to cloud-init. The box then brings itself up — **no SSH**:
installs Docker, Node 20, the pinned `@toon-protocol/hub` CLI, **generates + persists its
own encrypted wallet on the volume**, and runs `hub up` (pulling the public GHCR node
images) via systemd, then publishes its funding addresses to Object Storage.

Normally driven by `.github/workflows/deploy-hub.yml`. The notes below are for local runs.

## Inputs

| Variable | Default | Notes |
| --- | --- | --- |
| `region` | `us-ord` | Must support Metadata/cloud-init + Block Storage. |
| `instance_type` | `g6-standard-2` | 4 GB demo default; `g6-standard-4` if memory-pressured. |
| `volume_size` | `30` | GiB; holds `TOWNHOUSE_HOME` (config, `.anon` identity, settlement DB). |
| `hub_version` | `0.34.3` | Keep in sync with `infra/hub-version.txt`. |
| `network` | `testnet` | Network tier the apex initializes with. |
| `allowed_client_cidr` | `0.0.0.0/0` | Phase 1 BTP `3000` + relay WS `7100` source; restrict where possible. |
| `transport` | `direct` | `direct` opens client ports; `hs` closes all protocol inbound. |
| `status_bucket` / `status_endpoint` | `""` | Object Storage target for the status push (leave blank to disable). |
| `status_access_key` / `status_secret_key` | `""` | OBJ creds for the status push (sensitive). |

There is **no** `ssh_pubkey` / `allowed_ssh_cidr` — the box is config-driven and never
shelled into.

## Auth & state

- **Provider:** export `LINODE_TOKEN` (scopes: Linodes / Volumes / Firewalls R/W).
- **State:** Linode Object Storage (S3). Static skip flags live in `main.tf`; the S3
  backend reads `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (your OBJ access/secret).

```bash
export LINODE_TOKEN=...
export AWS_ACCESS_KEY_ID=...             # Object Storage access key
export AWS_SECRET_ACCESS_KEY=...         # Object Storage secret key

terraform init \
  -backend-config="bucket=toon-tfstate" \
  -backend-config="key=hub/terraform.tfstate" \
  -backend-config="region=us-ord-1" \
  -backend-config="endpoints={s3=\"https://us-ord-1.linodeobjects.com\"}"

terraform apply \
  -var="allowed_client_cidr=0.0.0.0/0" \
  -var="status_bucket=toon-tfstate" \
  -var="status_endpoint=https://us-ord-1.linodeobjects.com" \
  -var="status_access_key=$AWS_ACCESS_KEY_ID" \
  -var="status_secret_key=$AWS_SECRET_ACCESS_KEY"
```

## After apply

The box self-configures via cloud-init (a few minutes). Read health from
`s3://<status_bucket>/hub/status.json` and the self-generated funding addresses from
`s3://<status_bucket>/hub/wallet.json` — see [`docs/deploy-linode.md`](../../docs/deploy-linode.md).

> No seed or wallet password transits CI or lands in TF state — the box self-generates its
> wallet and persists it (`wallet.enc` + `wallet.pass`) on the volume. The Block Storage
> volume is therefore the durable root of **both** identity and keys — **snapshot it before
> destroying anything**, and treat snapshots as secret. Testnet/tiny-funds only.
