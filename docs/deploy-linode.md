# Deploying the TOON apex hub to Linode

Stands the operator hub up on a Linode (Akamai Connected Cloud) VPS with reproducible
Terraform infra and a GitHub Actions deploy pipeline. The box runs the
`@toon-protocol/hub` CLI (`townhouse up`), which pulls the pinned GHCR node images
(`connector`, `townhouse-api`, `town`, `mill`, `dvm` — all public) and orchestrates the
apex stack.

- **Phase 1 — direct BTP:** the apex exposes BTP `3000` (pay-to-write) and the Nostr
  relay WS `7100` (free reads); a client dials them directly.
- **Phase 2 — anyone proxy (HS):** the apex is reached over its `.anon` hidden service;
  no protocol inbound is open.

## What lives where

| Concern | Location |
| --- | --- |
| Infra (instance, volume, firewall, cloud-init) | [`infra/terraform/`](../infra/terraform/) |
| Deploy pipeline | [`.github/workflows/deploy-hub.yml`](../.github/workflows/deploy-hub.yml) |
| Pinned hub version | [`infra/hub-version.txt`](../infra/hub-version.txt) |
| Durable state (config, `wallet.enc`, `.anon`, settlement DB) | Block Storage volume → `/mnt/townhouse` |

## 1. Org secrets & variables (one-time)

Create these in **org → Settings → Secrets and variables → Actions** (or repo-scoped).

**Secrets**

| Name | Purpose |
| --- | --- |
| `LINODE_TOKEN` | Linode API token (Linodes / Volumes / Firewalls R/W). |
| `LINODE_OBJ_ACCESS_KEY` / `LINODE_OBJ_SECRET_KEY` | Linode Object Storage keys for Terraform S3 state. |
| `HUB_SSH_KEY` | **Private** half of the CI deploy key. |
| `TOWNHOUSE_WALLET_PASSWORD` | Unlocks `wallet.enc` at `townhouse up`. |

**Variables**

| Name | Example | Purpose |
| --- | --- | --- |
| `HUB_SSH_PUBKEY` | `ssh-ed25519 AAAA...` | Public half of `HUB_SSH_KEY` → cloud-init. |
| `ALLOWED_SSH_CIDR` | `203.0.113.4/32` | Who may SSH. |
| `ALLOWED_CLIENT_CIDR` | `203.0.113.4/32` | Phase 1 BTP/relay source CIDR. |
| `LINODE_REGION` | `us-ord` | Region. |
| `TF_STATE_BUCKET` | `toon-tfstate` | Object Storage bucket for TF state. |
| `TF_STATE_REGION` | `us-ord-1` | Object Storage region. |
| `TF_STATE_ENDPOINT` | `https://us-ord-1.linodeobjects.com` | Object Storage S3 endpoint. |

Generate the deploy key with `ssh-keygen -t ed25519 -f hub_deploy -N ''` → private into
`HUB_SSH_KEY`, public into `HUB_SSH_PUBKEY`. Create the Object Storage bucket once
(Cloud Manager or `linode-cli obj mb`).

## 2. Provision the box

Run the **Deploy Hub (Linode)** workflow with `apply_infra = true` (or `terraform apply`
locally — see [`infra/terraform/README.md`](../infra/terraform/README.md)). This creates
the instance, attaches the volume (mounted at `/mnt/townhouse`), and applies the
firewall. Grab the IP from the run logs or `terraform output -raw instance_ip`.

## 3. One-time wallet bootstrap (seed stays off CI)

SSH in as `deploy` and initialize the wallet **once**, interactively. The seed and
`wallet.enc` live only on the volume — never in CI or Terraform state.

```bash
ssh deploy@<IP>
townhouse init --preset demo        # generates/loads the mnemonic; set the wallet password
                                     #   (must equal the TOWNHOUSE_WALLET_PASSWORD secret)
townhouse seed                       # record the mnemonic offline; back it up
townhouse balances                   # print the EVM/Solana/Mina + Arweave addresses
```

Fund the printed treasury addresses with **small** testnet/devnet amounts only
(Base Sepolia USDC + a little ETH for gas; Solana devnet SOL; Mina devnet MINA). Keep
balances tiny so a mistake can't drain real value.

## 4. Deploy

- **Automatic:** pushing changes under `infra/**` (or bumping `infra/hub-version.txt`)
  triggers the pipeline → `townhouse up` over SSH → health gate.
- **Manual:** run the workflow with `transport = direct` (Phase 1). The deploy step
  refuses to run if `wallet.enc` is missing (forces step 3 first).

The deploy is idempotent: re-running re-pulls the pinned images and recreates the stack;
the volume preserves identity and channel state.

## 5. Phase 2 — behind the anyone proxy

Once the direct demo passes, re-run the workflow with `apply_infra = true` and
`transport = hs`. Terraform closes inbound `3000`/`7100` (HS rendezvous needs no inbound)
and `townhouse up --transport hs` brings up the `anon` sidecar. Confirm a stable `.anon`
hostname with `townhouse status --json`, and hand that endpoint to the client.

> Requires the hub-side ATOR plumbing (epic `toon-protocol/toon-meta#22`, WS1 / hub
> ATOR ticket). Until that lands, `--transport hs` is provisioned-for but not functional.

## 6. Teardown & safety

- **The Block Storage volume is the durable root of the wallet + `.anon` identity.**
  Snapshot it (Cloud Manager → Volumes → clone, or an image) before `terraform destroy`.
- `terraform destroy` removes the instance + firewall; detach (don't delete) the volume
  if you intend to redeploy onto the same identity.
- Rotate `HUB_SSH_KEY` and `TOWNHOUSE_WALLET_PASSWORD` per the org's secret-rotation
  policy.
