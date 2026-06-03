# @toon-protocol/townhouse

**The operator CLI for running a TOON Protocol node stack on your own machine.**

TOON Protocol is a **pay-to-write, free-to-read** [Nostr](https://nostr.com) network over [Interledger](https://interledger.org): writers attach a tiny signed payment to publish an event, and anyone reads for free. `townhouse` is the command-line tool an **operator** uses to stand up and run that infrastructure — it generates your keys, boots the stack in Docker, and publishes a private hidden-service address so paying clients can reach you without exposing anything to the public internet.

```bash
npx @toon-protocol/townhouse init     # 1. create your config + wallet (one time)
npx @toon-protocol/townhouse hs up    # 2. boot your apex (connector + hidden service)
npx @toon-protocol/townhouse node add # 3. add a service node that earns fees (default: a town relay)
```

`hs up` prints `Apex live at <your-address>.anon` once the stack is reachable. Share that address with clients; they pay you over it.

> **Are you trying to _publish_ events, not run a node?** You want [`@toon-protocol/client`](https://www.npmjs.com/package/@toon-protocol/client) instead — the client library that pays a townhouse apex and publishes to it. `townhouse` (this package) is the **operator** side; `@toon-protocol/client` is the **client** side.

---

## What is a townhouse? (vocabulary)

This package uses a few terms precisely. Getting them straight up front prevents a lot of confusion:

| Term | What it is |
| --- | --- |
| **TOON Protocol** | The pay-to-write Nostr-over-ILP network. Writes cost a signed off-chain payment claim; reads are free. |
| **townhouse** | This CLI — the **operator product**. It runs one **apex** plus the service nodes you attach to it. |
| **apex** | What `hs up` boots: the **ILP connector** (node id `g.townhouse`, the *parent*) **+ an `.anon` hidden service**. The apex is the front door — it validates incoming client payments, takes its fee, and forwards traffic to your service nodes. It earns routing fees but is **not** itself a relay/swap/compute node. |
| **service node** (a **child** of the apex) | What `node add` provisions. Three types **earn fees**: **town** = a Nostr relay (pay-per-event publish); **mill** = a multi-chain token-swap node; **dvm** = a [NIP-90](https://github.com/nostr-protocol/nips/blob/master/90.md) compute node (e.g. Arweave blob storage — the job request *is* the payment). Clients pay at the apex edge; the apex then forwards to the child **for free** (parent→child packets carry no per-packet claim, settled in aggregate). |
| **operator** (you) | Runs `townhouse`, owns the wallet, earns the fees. |
| **client** | An end-user or app using [`@toon-protocol/client`](https://www.npmjs.com/package/@toon-protocol/client) to pay your apex and publish. Not this package. |

**`town` is one service node; `townhouse` is the whole operator product** (the apex plus every node you attach). Adding a town relay is just `townhouse node add town`.

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
npx @toon-protocol/townhouse init
```

This creates `~/.townhouse/config.yaml` and an encrypted wallet, then **shows your seed phrase once**:

```text
Config created at ~/.townhouse/config.yaml

=== IMPORTANT: Back up your seed phrase ===

  snake juice eternal vendor remove ladder aisle crumble match hockey weasel guide

This is the ONLY time your seed phrase will be shown.
Store it safely. You will need it to recover your node keys.
============================================

Wallet saved to ~/.townhouse/wallet.enc

Derived Node Addresses:
-----------------------
  town   Nostr: 5eb3ba2d...   EVM: 0x90bd2F2f...
  mill   Nostr: 47838cd5...   EVM: 0xAAE12f6B...
  dvm    Nostr: 1b52a745...   EVM: 0x18Ac7427...

Next — start your node:
  npx @toon-protocol/townhouse hs up
```

**Write the seed phrase down.** It is shown only once and is the only way to recover your keys.

`init` needs a password to encrypt the wallet. Provide it with the `--password` flag or the `TOWNHOUSE_WALLET_PASSWORD` env var:

```bash
npx @toon-protocol/townhouse init --password "<your-password>"
# or: export TOWNHOUSE_WALLET_PASSWORD=...  then run init
```

### 2. Boot your apex — `hs up`

```bash
npx @toon-protocol/townhouse hs up
```

This starts the **apex** (the ILP connector plus its `.anon` hidden service) — the front door that clients pay. The first run pulls images and bootstraps the hidden service, narrating each stage:

```text
Pulling 2 apex images...
  [1/2] ghcr.io/toon-protocol/connector@sha256:...
  [2/2] ghcr.io/toon-protocol/townhouse-api@sha256:...
Bootstrapping hidden service (this takes 30–90s)…
Apex live at uagxuabpuvm6mf4l4zptgth2442sbct5lvtur2nffpqnouesgawyv2ad.anon
```

The address on the final line is **your apex's `.anon` hidden-service address** — share it with clients, who pay you over BTP at `wss://<your-address>.anon/btp` (through a SOCKS5h proxy). It's also saved to `~/.townhouse/host.json`. On a cold image cache the first boot can take a few minutes; later boots are faster.

If you run it in an interactive terminal, a live dashboard opens once the apex is up. Press `Ctrl-C` to exit the dashboard — your apex keeps running.

### 3. Add a service node — `node add`

The apex on its own only routes and takes a fee. To actually **earn**, attach a service node (a *child* of the apex). The default is a `town` Nostr relay:

```bash
npx @toon-protocol/townhouse node add        # provision a town relay (default)
npx @toon-protocol/townhouse node add mill   # or a multi-chain swap node
npx @toon-protocol/townhouse node add dvm    # or a NIP-90 compute / Arweave node
```

`node add` provisions the container, registers it as a child of your apex, and routes paid client traffic to it for free. List and remove nodes with `node list` and `node remove <id>`.

### 4. Stop your apex — `hs down`

```bash
npx @toon-protocol/townhouse hs down
```

```text
Apex stopped. Volumes preserved — your .anyone address is stable.
```

Your hidden-service address stays the same across stop/start. To deliberately rotate to a brand-new address, use `npx @toon-protocol/townhouse hs down --rotate-keys` (this **deletes** the current keypair, so the next `hs up` publishes a different address).

---

## Everyday commands

| Command                                            | What it does                                                 |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `townhouse init`                                   | Create config + wallet (one time)                            |
| `townhouse hs up`                                  | Boot the apex (connector + `.anon` hidden service)           |
| `townhouse hs down`                                | Stop the apex (address preserved)                            |
| `townhouse node add [town\|mill\|dvm]`             | Provision a service node (child of the apex; default `town`) |
| `townhouse node list` / `node remove <id>`         | List / deprovision service nodes                             |
| `townhouse status`                                 | Show apex + node status and connector metrics                |
| `townhouse health`                                 | Probe apex / API / nodes / `.anon` health                    |
| `townhouse logs <node-id> [-f]`                    | Tail a node's logs (`-f` accepted; follow is the default)    |
| `townhouse wallet show`                            | Show derived addresses for each node                         |
| `townhouse wallet seed --confirm`                  | Reprint your BIP-39 seed phrase (password-gated)             |
| `townhouse credits buy` / `credits balance`        | Fund / check Arweave upload credits (for the DVM node)       |
| `townhouse --help`                                 | Full command list                                            |

(Prefix each with `npx @toon-protocol/townhouse`, or install once and call `townhouse` directly.)

> Running with a config outside the default `~/.townhouse`? Pass `-c <path-to-config.yaml>` (the path to the **config file**, not its directory) on any command. When you initialize with `init --config-dir <dir>`, `init`'s printed next-step already includes the matching `-c` flag.

---

## Troubleshooting

| Symptom                                                  | Fix                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cannot start — host ports already in use`               | Another stack is using the canonical ports. Stop it (the message tells you how), or run `hs up --skip-preflight` if you know the conflict is harmless.                                                    |
| Boot fails pulling images                                | Check your network and that you can reach `ghcr.io`, then retry.                                                                                                                                          |
| `Docker daemon unreachable`                              | Start Docker and re-run.                                                                                                                                                                                  |
| `Wallet password required, but no interactive terminal…` | In CI/SSH there's no prompt — pass `--password` or set `TOWNHOUSE_WALLET_PASSWORD`.                                                                                                                       |
| `Wallet not found … Run \`townhouse init\` first.`       | Run `init` before `hs up`.                                                                                                                                                                                |
| Forgot your password                                     | The wallet is encrypted and can't be recovered without it. Re-run `init --force` to regenerate (this **replaces** your keys — only do this if you've backed up the seed elsewhere or are starting fresh). |

For verbose logs on any failure, re-run with `DEBUG=townhouse:*`.

---

## Using it as a library

The package also exports its building blocks for programmatic use — `DockerOrchestrator`, `ConnectorAdminClient`, wallet helpers, and the Compose-template loaders:

```typescript
import {
  materializeComposeTemplate,
  DockerOrchestrator,
} from '@toon-protocol/townhouse';
```

See [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full API surface and internals.

## Contributing / local development

The local multi-node dev stack, the E2E test harnesses, Compose-template internals, and advanced docker-compose operator paths are documented in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## License

MIT
