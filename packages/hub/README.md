# @toon-protocol/hub

**The operator CLI for running a TOON Protocol node stack on your own machine.**

TOON Protocol is a **pay-to-write, free-to-read** [Nostr](https://nostr.com) network over [Interledger](https://interledger.org): writers attach a tiny signed payment to publish an event, and anyone reads for free. `hub` is the command-line tool an **operator** uses to stand up and run that infrastructure — it generates your keys and boots the stack in Docker so paying clients can reach you over BTP.

```bash
npx @toon-protocol/hub init     # 1. create your config + wallet (one time)
npx @toon-protocol/hub up       # 2. boot your apex (direct BTP, default) + children
npx @toon-protocol/hub node add # 3. add a service node that earns fees (default: a town relay)
```

`up` boots a **direct-BTP apex** by default and prints `Apex live (direct BTP) at ws://127.0.0.1:3000/btp` once reachable. Clients dial that BTP endpoint directly. Want anonymity instead? `npx @toon-protocol/hub hs up` is the privacy opt-in: it boots the same apex behind an `.anon` hidden service (no public host port) and prints `Apex live at <your-address>.anon`. Either way, share the address with clients; they pay you over it.

> **Are you trying to _publish_ events, not run a node?** You want [`@toon-protocol/client`](https://www.npmjs.com/package/@toon-protocol/client) instead — the client library that pays a hub apex and publishes to it. `hub` (this package) is the **operator** side; `@toon-protocol/client` is the **client** side.

---

## What is a hub? (vocabulary)

This package uses a few terms precisely. Getting them straight up front prevents a lot of confusion:

| Term | What it is |
| --- | --- |
| **TOON Protocol** | The pay-to-write Nostr-over-ILP network. Writes cost a signed off-chain payment claim; reads are free. |
| **hub** | This CLI — the **operator product**. It runs one **apex** plus the service nodes you attach to it. |
| **apex** | What `up` boots: the **ILP connector** (node id `g.townhouse`, the *parent*) + your service nodes. By default it exposes its BTP port (`ws://host:3000/btp`) directly to clients (**direct transport**); `hs up` instead fronts it with an **`.anon` hidden service** (**HS transport**, the privacy opt-in). The apex is the front door — it validates incoming client payments, takes its fee, and forwards traffic to your service nodes. It earns routing fees but is **not** itself a relay/swap/compute node. |
| **service node** (a **child** of the apex) | What `node add` provisions. Three types **earn fees**: **town** = a Nostr relay (pay-per-event publish); **mill** = a multi-chain token-swap node; **dvm** = a [NIP-90](https://github.com/nostr-protocol/nips/blob/master/90.md) compute node (e.g. Arweave blob storage — the job request *is* the payment). Clients pay at the apex edge; the apex then forwards to the child **for free** (parent→child packets carry no per-packet claim, settled in aggregate). |
| **operator** (you) | Runs `hub`, owns the wallet, earns the fees. |
| **client** | An end-user or app using [`@toon-protocol/client`](https://www.npmjs.com/package/@toon-protocol/client) to pay your apex and publish. Not this package. |

**`town` is one service node; `hub` is the whole operator product** (the apex plus every node you attach). Adding a town relay is just `hub node add town`.

---

## Before you start

You'll need:

- [ ] **Docker** running — verify with `docker version` (it pulls and runs the apex and node containers)
- [ ] **Node.js 20+** — verify with `node --version`
- [ ] **Network access to `ghcr.io`** — container images are pulled from there
- [ ] **A few free ports on `127.0.0.1`** — `9401`, `28090`, `7100`, `3100`, `3200`, `3400` (all loopback-only)
- [ ] A little disk space for container images

> Supported on Linux and macOS (including WSL2). Everything binds to `127.0.0.1` only — nothing is exposed to the public internet except your apex's `.anon` hidden-service address.

---

## Quickstart

### 1. Initialize — `init`

```bash
npx @toon-protocol/hub init
```

This creates `~/.hub/config.yaml` and an encrypted wallet, then **shows your seed phrase once**:

```text
Config created at ~/.hub/config.yaml

=== IMPORTANT: Back up your seed phrase ===

  snake juice eternal vendor remove ladder aisle crumble match hockey weasel guide

This is the ONLY time your seed phrase will be shown.
Store it safely. You will need it to recover your node keys.
============================================

Wallet saved to ~/.hub/wallet.enc

Derived Node Addresses:
-----------------------
  town   Nostr: 5eb3ba2d...   EVM: 0x90bd2F2f...
  mill   Nostr: 47838cd5...   EVM: 0xAAE12f6B...
  dvm    Nostr: 1b52a745...   EVM: 0x18Ac7427...

Next — start your node:
  npx @toon-protocol/hub up
```

**Write the seed phrase down.** It is shown only once and is the only way to recover your keys.

`init` needs a password to encrypt the wallet. Provide it with the `--password` flag or the `TOWNHOUSE_WALLET_PASSWORD` env var:

```bash
npx @toon-protocol/hub init --password "<your-password>"
# or: export TOWNHOUSE_WALLET_PASSWORD=...  then run init
```

### 2. Boot your apex — `up` (direct BTP, default)

```bash
npx @toon-protocol/hub up
```

This starts the **apex** (the ILP connector + the hub API) — the front door that clients pay — with the connector's BTP port exposed directly to the host. The first run pulls images and narrates each stage:

```text
Pulling 2 apex images...
  [1/2] ghcr.io/toon-protocol/connector@sha256:...
  [2/2] ghcr.io/toon-protocol/hub-api@sha256:...
Apex live (direct BTP) at ws://127.0.0.1:3000/btp
```

The final line is **your apex's BTP dial address** — share it with clients, who pay you over BTP at `ws://<host>:3000/btp`. By default the port binds to `127.0.0.1` only; to accept clients from other machines, **bind it explicitly** with `TOWNHOUSE_BTP_BIND=0.0.0.0 hub up` (only do this if you mean to expose the port publicly). On a cold image cache the first boot can take a few minutes; later boots are faster.

#### Privacy opt-in: `hs up` (hidden-service apex)

Prefer to stay off the public internet entirely? `hs up` boots the same apex behind an **`.anon` v3 hidden service** (no host port exposed) and bootstraps the hidden service, narrating each stage:

```bash
npx @toon-protocol/hub hs up
```

```text
Bootstrapping hidden service (this takes 30–90s)…
Apex live at uagxuabpuvm6mf4l4zptgth2442sbct5lvtur2nffpqnouesgawyv2ad.anon
```

Clients pay you over BTP at `wss://<your-address>.anon/btp` (through a SOCKS5h proxy); the address is saved to `~/.hub/host.json`. Direct and HS apexes are **mutually exclusive** (they contend for the same canonical ports / data) — running `up` on a machine that already has an HS apex is refused; tear the HS apex down (`hs down --rotate-keys`) first, or use `hs enable` to switch a running direct apex to HS. If you run `up`/`hs up` in an interactive terminal, a live dashboard opens once the apex is up. Press `Ctrl-C` to exit the dashboard — your apex keeps running.

### 3. Add a service node — `node add`

The apex on its own only routes and takes a fee. To actually **earn**, attach a service node (a *child* of the apex). The default is a `town` Nostr relay:

```bash
npx @toon-protocol/hub node add        # provision a town relay (default)
npx @toon-protocol/hub node add mill --relays wss://relay.damus.io,wss://nos.lol   # multi-chain swap node
npx @toon-protocol/hub node add dvm --turbo-token "$(cat arweave.json)"            # NIP-90 compute / Arweave node
```

`node add` provisions the container, registers it as a child of your apex, and routes paid client traffic to it for free. List and remove nodes with `node list` and `node remove <id>`.

**Per-node configuration.** Operator-supplied inputs are resolved in the order **flag → `config.yaml` → environment variable**:

| Node   | Input                  | How to supply it                                                                                   |
| ------ | ---------------------- | ------------------------------------------------------------------------------------------------- |
| `town` | Settlement chain + token (optional) | `--settlement-chain evm:84532 --asset ETH` · or `nodes.town.settlementChainId`/`assetCode` in `config.yaml` |
| `mill` | Nostr relay URLs (**required**) | `--relays wss://a,wss://b` · or `nodes.mill.relays` in `config.yaml` · or `MILL_RELAYS` env        |
| `dvm`  | Arweave Turbo credential (optional) | `--turbo-token '<jwk>'` · or `TURBO_TOKEN` env (free-tier <100KB uploads work without it)   |

**Town settlement token/chain.** The town advertises a settlement asset in its kind:10032 so clients know what it prices in. Choose from the chains your deployment supports — run `hub chains supported` to list them — and a token that chain supports (EVM: `USDC`/`ETH` · Solana: `USDC`/`SOL` · Mina: `MINA` only). `assetScale` is derived (USDC 6, ETH 18, SOL 9, MINA 9). Unsupported selections are rejected with the list of valid options. Defaults to USDC on the deployment's first supported chain (the native token where USDC isn't available, e.g. Mina).

Prefer the flags — they travel with the `node add` request, so you don't have to export `MILL_RELAYS`/`TURBO_TOKEN` **before** `up`/`hs up` (the API container's environment is fixed at boot, so a variable exported afterward is never seen). Mill relays you pass are persisted to `config.yaml`, so a later `node remove && node add` doesn't need the flag again. The DVM Turbo credential is a secret and is **not** written to `config.yaml` — pass it via `--turbo-token` (or `TURBO_TOKEN`) each time.

**Restart = auto-rebind.** Your provisioned nodes are recorded in `~/.hub/nodes.yaml`. On every `hub hs up`, hub rebuilds each child's env from the wallet + `config.yaml` and restarts its container, then re-registers it with the apex — so after `hs down && hs up` (or a host reboot followed by `hs up`) your town/mill/dvm come back automatically, no `node add` needed. Editing a value in `config.yaml` (e.g. `nodes.mill.relays`) and re-running `hs up` recreates that child with the new config. The DVM Turbo token isn't persisted, so re-export `TURBO_TOKEN` before `hs up` if you rely on it for large uploads.

### 4. Stop your apex — `hs down`

```bash
npx @toon-protocol/hub hs down
```

```text
Apex stopped. Volumes preserved — your .anyone address is stable.
```

Your hidden-service address stays the same across stop/start. To deliberately rotate to a brand-new address, use `npx @toon-protocol/hub hs down --rotate-keys` (this **deletes** the current keypair, so the next `hs up` publishes a different address).

---

## Everyday commands

| Command                                            | What it does                                                 |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `hub init`                                   | Create config + wallet (one time)                            |
| `hub up`                                     | Boot a **direct-BTP** apex + children (default; clients dial `ws://host:3000/btp`). `--dev` = contributor children-only dev stack |
| `hub hs up`                                  | Boot a **hidden-service** apex (opt-in; anonymous `.anon`)   |
| `hub hs enable`                              | Switch a running direct apex to hidden-service mode          |
| `hub hs down`                                | Stop the apex (address preserved)                            |
| `hub node add [town\|mill\|dvm]`             | Provision a service node (child of the apex; default `town`) |
| `hub node list` / `node remove <id>`         | List / deprovision service nodes                             |
| `hub status`                                 | Show apex + node status and connector metrics                |
| `hub health`                                 | Probe apex / API / nodes / `.anon` health                    |
| `hub logs <node-id> [-f]`                    | Tail a node's logs (`-f` accepted; follow is the default)    |
| `hub wallet show`                            | Show derived addresses for each node                         |
| `hub wallet seed --confirm`                  | Reprint your BIP-39 seed phrase (password-gated)             |
| `hub credits buy` / `credits balance`        | Fund / check Arweave upload credits (for the DVM node)       |
| `hub --help`                                 | Full command list                                            |

(Prefix each with `npx @toon-protocol/hub`, or install once and call `hub` directly.)

> Running with a config outside the default `~/.hub`? Pass `-c <path-to-config.yaml>` (the path to the **config file**, not its directory) on any command. When you initialize with `init --config-dir <dir>`, `init`'s printed next-step already includes the matching `-c` flag.

---

## Troubleshooting

| Symptom                                                  | Fix                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cannot start — host ports already in use`               | Another stack is using the canonical ports. Stop it (the message tells you how), or run `hs up --skip-preflight` if you know the conflict is harmless.                                                    |
| Boot fails pulling images                                | Check your network and that you can reach `ghcr.io`, then retry.                                                                                                                                          |
| `Docker daemon unreachable`                              | Start Docker and re-run.                                                                                                                                                                                  |
| `Wallet password required, but no interactive terminal…` | In CI/SSH there's no prompt — pass `--password` or set `TOWNHOUSE_WALLET_PASSWORD`.                                                                                                                       |
| `Wallet not found … Run \`hub init\` first.`       | Run `init` before `up` / `hs up`.                                                                                                                                                                         |
| `Existing hidden-service apex detected…`                 | `hub up` (direct) won't downgrade a running HS apex. Use `hs up` to keep HS, or `hs down --rotate-keys && up` (or `hs enable`'s inverse) to switch to direct.                                       |
| Forgot your password                                     | The wallet is encrypted and can't be recovered without it. Re-run `init --force` to regenerate (this **replaces** your keys — only do this if you've backed up the seed elsewhere or are starting fresh). |

For verbose logs on any failure, re-run with `DEBUG=hub:*`.

For multi-chain settlement operational issues (Solana + Mina on-chain settle — connector-restart route loss, nonce-watermark persistence, a wedged settlement monitor, the town inbound-session race, and Mina zkApp resets), see [`RUNBOOK.md`](./RUNBOOK.md).

---

## Using it as a library

The package also exports its building blocks for programmatic use — `DockerOrchestrator`, `ConnectorAdminClient`, wallet helpers, and the Compose-template loaders:

```typescript
import {
  materializeComposeTemplate,
  DockerOrchestrator,
} from '@toon-protocol/hub';
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full API surface and internals.

## Contributing / local development

The local multi-node dev stack, the E2E test harnesses, Compose-template internals, and advanced docker-compose operator paths are documented in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT
