# Deploying the TOON apex hub to Linode

Stands the operator hub up on a Linode (Akamai Connected Cloud) VPS with reproducible
Terraform infra. **There is no SSH.** Terraform creates the box; the box brings *itself*
up via cloud-init: it installs the `@toon-protocol/hub` CLI, **generates its own encrypted
wallet and persists it (+ its password) on the volume** — no seed or password ever transits
CI or Terraform state — and runs `hub up` (which pulls the pinned, public GHCR node
images: `connector`, `hub-api`, `town`, `mill`, `dvm`). The box then **publishes its
funding addresses** to Object Storage, so the treasury can fund it and you can observe it
without ever opening a shell.

- **Phase 1 — direct BTP:** the apex exposes BTP `3000` (pay-to-write) and the relay WS
  `7100` (reads); clients dial them directly.
- **Phase 2 — anyone proxy (HS):** reached over the `.anon` hidden service; no inbound.

## What lives where

| Concern | Location |
| --- | --- |
| Infra (instance, volume, firewall, cloud-init) | [`infra/terraform/`](../infra/terraform/) |
| Provision pipeline | [`.github/workflows/deploy-hub.yml`](../.github/workflows/deploy-hub.yml) |
| Pinned hub version | [`infra/hub-version.txt`](../infra/hub-version.txt) |
| Durable state (config, **wallet + password**, `.anon` identity, settlement DB) | Block Storage volume → `/mnt/hub` |
| Health (no SSH) | `s3://<state-bucket>/hub/status.json` |
| Self-generated funding addresses | `s3://<state-bucket>/hub/wallet.json` |

## 1. Org secrets & variables (one-time)

**Secrets**

| Name | Purpose |
| --- | --- |
| `LINODE_TOKEN` | Linode API token (Linodes / Volumes / Firewalls R/W). |
| `LINODE_OBJ_ACCESS_KEY` / `LINODE_OBJ_SECRET_KEY` | Object Storage keys — Terraform state **and** the box's status push. |
| `TREASURY_MNEMONIC` | Treasury seed. Used **only on the runner** to sign the funding transfer to the apex's self-generated address — it never reaches the box or Terraform state. (Same org secret the client journey uses.) |

**Variables**

| Name | Example | Purpose |
| --- | --- | --- |
| `ALLOWED_CLIENT_CIDR` | `0.0.0.0/0` | Phase 1 BTP/relay source CIDR (restrict if you can). |
| `LINODE_REGION` | `us-ord` | Region. |
| `TF_STATE_BUCKET` | `toon-tfstate` | Object Storage bucket (TF state + the status object). |
| `TF_STATE_REGION` | `us-ord-1` | Object Storage region. |
| `TF_STATE_ENDPOINT` | `https://us-ord-1.linodeobjects.com` | Object Storage S3 endpoint. |

> No SSH key, no `ALLOWED_SSH_CIDR`, no wallet seed/password in CI — the box self-generates
> and persists its wallet on the volume, and is never shelled into.

## 2. Provision (one step)

Run the **Deploy Hub (Linode)** workflow with `apply_infra = true` (or `terraform apply`
locally — see [`infra/terraform/README.md`](../infra/terraform/README.md)). The workflow
**creates the Object Storage state bucket if it doesn't exist** (idempotent, using the OBJ
keys), then Terraform creates the instance + volume + firewall and hands the (seed-free)
config to cloud-init. The box then self-installs, **self-generates + persists its wallet**,
starts the apex via the `hub.service` systemd unit, and **publishes its funding
addresses** to `hub/wallet.json`. The workflow polls for that object, reads the apex
address, and **auto-funds it** from the treasury (cloud-init takes a few minutes for image
pulls).

## 3. Funding (automatic; treasury seed never touches the box)

The apex address is **not** seed-derived — the box generates its own wallet and publishes
the address. The deploy workflow reads it from `hub/wallet.json` and sends a small Base
Sepolia top-up from `TREASURY_MNEMONIC` (signed on the runner). To check or fund manually:

```bash
aws s3 cp "s3://<state-bucket>/hub/wallet.json" - \
  --endpoint-url "https://<region>.linodeobjects.com" | jq -r '.town.evm.address'
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

- **The Block Storage volume is the durable root of the apex identity *and* its wallet**
  (`wallet.enc` + `wallet.pass` live there). Snapshot it before `terraform destroy`; detach
  (don't delete) it to redeploy onto the same identity. Treat a volume snapshot as secret.
- No seed/password transits CI or lands in Terraform state. Still **testnet/tiny-funds
  only**: deleting the volume loses the keys, and the wallet password sits beside the wallet
  on the volume (self-unlock by design). The state bucket also holds `wallet.json` (public
  addresses only) — keep it private regardless.
- Break-glass (rare): the Linode **LISH console** (Cloud Manager / API) gives serial
  access with no open port — reset the root password via the API if you ever need in.
