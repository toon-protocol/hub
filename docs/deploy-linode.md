# Deploying the TOON apex hub to Linode

Stands the operator hub up on a Linode (Akamai Connected Cloud) VPS with reproducible
Terraform infra. **There is no SSH.** Terraform creates the box; the box brings *itself*
up via cloud-init: it installs the `@toon-protocol/hub` CLI, initializes in **mnemonic
mode** (identity derives from the treasury seed — no wallet file, no password), and runs
`townhouse up` (which pulls the pinned, public GHCR node images: `connector`,
`townhouse-api`, `town`, `mill`, `dvm`). Health + funding addresses are pushed to Object
Storage, so you observe the box without ever opening a shell.

- **Phase 1 — direct BTP:** the apex exposes BTP `3000` (pay-to-write) and the relay WS
  `7100` (reads); clients dial them directly.
- **Phase 2 — anyone proxy (HS):** reached over the `.anon` hidden service; no inbound.

## What lives where

| Concern | Location |
| --- | --- |
| Infra (instance, volume, firewall, cloud-init) | [`infra/terraform/`](../infra/terraform/) |
| Provision pipeline | [`.github/workflows/deploy-hub.yml`](../.github/workflows/deploy-hub.yml) |
| Pinned hub version | [`infra/hub-version.txt`](../infra/hub-version.txt) |
| Durable state (config, `.anon` identity, settlement DB) | Block Storage volume → `/mnt/townhouse` |
| Health + funding addresses (no SSH) | `s3://<state-bucket>/hub/status.json` |

## 1. Org secrets & variables (one-time)

**Secrets**

| Name | Purpose |
| --- | --- |
| `LINODE_TOKEN` | Linode API token (Linodes / Volumes / Firewalls R/W). |
| `LINODE_OBJ_ACCESS_KEY` / `LINODE_OBJ_SECRET_KEY` | Object Storage keys — Terraform state **and** the box's status push. |
| `TREASURY_MNEMONIC` | Seed the apex derives its identity + settlement keys from (mnemonic mode). The same org secret the client journey uses (different derivation account). |

**Variables**

| Name | Example | Purpose |
| --- | --- | --- |
| `ALLOWED_CLIENT_CIDR` | `0.0.0.0/0` | Phase 1 BTP/relay source CIDR (restrict if you can). |
| `LINODE_REGION` | `us-ord` | Region. |
| `TF_STATE_BUCKET` | `toon-tfstate` | Object Storage bucket (TF state + the status object). |
| `TF_STATE_REGION` | `us-ord-1` | Object Storage region. |
| `TF_STATE_ENDPOINT` | `https://us-ord-1.linodeobjects.com` | Object Storage S3 endpoint. |

> No SSH key, no `ALLOWED_SSH_CIDR`, no wallet password — the box is config-driven and
> never shelled into.

## 2. Provision (one step)

Run the **Deploy Hub (Linode)** workflow with `apply_infra = true` (or `terraform apply`
locally — see [`infra/terraform/README.md`](../infra/terraform/README.md)). The workflow
**creates the Object Storage state bucket if it doesn't exist** (idempotent, using the OBJ
keys), then Terraform creates the instance + volume + firewall and hands the seed + config
to cloud-init. The
box then self-installs, self-initializes (mnemonic mode), and starts the apex via the
`townhouse.service` systemd unit. The workflow polls `hub/status.json` and prints it when
the apex reports in (cloud-init takes a few minutes for image pulls).

## 3. Fund the apex (no box access)

The apex identity is **deterministic** from `TREASURY_MNEMONIC` (settlement keys at
account index 3), so you can derive the funding addresses off-box — or just read them
from the pushed status object:

```bash
aws s3 cp "s3://<state-bucket>/hub/status.json" - \
  --endpoint-url "https://<region>.linodeobjects.com" | jq .
```

Fund the EVM/Solana/Mina addresses with **small** testnet/devnet amounts only (Base
Sepolia USDC + a little gas; Solana devnet SOL; Mina devnet MINA). Keep balances tiny.

## 4. Observe / redeploy

- **Logs & health:** read `s3://<state-bucket>/hub/status.json` (refreshed every ~5 min
  by the box). No SSH, no exposed control API (it stays loopback-only by design).
- **Update the pinned version / config:** bump `infra/hub-version.txt` (or edit the
  Terraform) and re-run the workflow. cloud-init re-runs on a fresh instance; the volume
  preserves the identity + settlement state. (Immutable-style: replace the box, keep the
  volume.)

## 5. Phase 2 — behind the anyone proxy

Re-run with `apply_infra = true`, `transport = hs`. Terraform closes inbound `3000`/`7100`
and the boot brings up the `anon` sidecar; the `.anon` hostname appears in the status
object. Hand that endpoint to the client.

> Requires the hub-side ATOR plumbing (epic `toon-protocol/toon-meta#22`, WS1). Until that
> lands, `--transport hs` is provisioned-for but not functional.

## 6. Teardown & safety

- **The Block Storage volume is the durable root of the apex identity.** Snapshot it
  before `terraform destroy`; detach (don't delete) it to redeploy onto the same identity.
- The treasury seed travels via cloud-init user-data and lands in Terraform state — keep
  the **state bucket private**, and use this for **testnet/tiny-funds only**. Rotate the
  seed if the bucket is ever exposed.
- Break-glass (rare): the Linode **LISH console** (Cloud Manager / API) gives serial
  access with no open port — reset the root password via the API if you ever need in.
