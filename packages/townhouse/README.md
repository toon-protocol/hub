# @toon-protocol/townhouse

**Run a TOON node on your own machine with two commands.**

TOON is a pay-to-write, free-to-read [Nostr](https://nostr.com) relay network: writers pay a tiny per-byte fee to publish, anyone reads for free. `townhouse` is the command-line installer and dashboard for running your own node. It sets up your keys, starts the node in Docker, and publishes it as a private hidden-service address so peers can reach you without exposing anything to the public internet.

```bash
npx @toon-protocol/townhouse init     # 1. create your config + wallet (one time)
npx @toon-protocol/townhouse hs up     # 2. start your node
```

That's it — `hs up` prints `Apex live at <your-address>` when your node is running.

---

## Before you start

You'll need:

- [ ] **Docker** running — verify with `docker version` (it pulls and runs your node's containers)
- [ ] **Node.js 20+** — verify with `node --version`
- [ ] **Network access to `ghcr.io`** — your node's container images are pulled from there
- [ ] **A few free ports on `127.0.0.1`** — `9401`, `28090`, `7100`, `3100`, `3200`, `3400` (all loopback-only)
- [ ] A little disk space for container images

> Supported on Linux and macOS (including WSL2). Everything binds to `127.0.0.1` only — nothing is exposed to the public internet except your node's hidden-service address.

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

`init` needs a password to encrypt the wallet. It will prompt you when run in a terminal, or you can pass one non-interactively:

```bash
npx @toon-protocol/townhouse init --password "<your-password>"
# or: export TOWNHOUSE_WALLET_PASSWORD=...  then run init
```

### 2. Start your node — `hs up`

```bash
npx @toon-protocol/townhouse hs up
```

The first run pulls images and bootstraps the hidden service, narrating each stage:

```text
Pulling 2 apex images...
  [1/2] ghcr.io/toon-protocol/connector@sha256:...
  [2/2] ghcr.io/toon-protocol/townhouse-api@sha256:...
Bootstrapping hidden service (this takes 30–90s)…
Apex live at uagxuabpuvm6mf4l4zptgth2442sbct5lvtur2nffpqnouesgawyv2ad.anon
```

The address on the final line is **your node's hidden-service address** — share it with peers, who reach you at `wss://<your-address>/btp`. It's also saved to `~/.townhouse/host.json`. On a cold image cache the first boot can take a few minutes; later boots are faster.

If you run it in an interactive terminal, a live dashboard opens after the node is up. Press `Ctrl-C` to exit the dashboard — your node keeps running.

### 3. Stop your node — `hs down`

```bash
npx @toon-protocol/townhouse hs down
```

```text
Apex stopped. Volumes preserved — your .anyone address is stable.
```

Your hidden-service address stays the same across stop/start. To deliberately rotate to a brand-new address, use `npx @toon-protocol/townhouse hs down --rotate-keys`.

---

## Everyday commands

| Command                                            | What it does                                           |
| -------------------------------------------------- | ------------------------------------------------------ |
| `townhouse init`                                   | Create config + wallet (one time)                      |
| `townhouse hs up`                                  | Start your node and publish its hidden-service address |
| `townhouse hs down`                                | Stop your node (address preserved)                     |
| `townhouse status`                                 | Show node status                                       |
| `townhouse health`                                 | Health summary                                         |
| `townhouse logs <node-id> [-f]`                    | Tail a node's logs                                     |
| `townhouse wallet show`                            | Show your derived addresses                            |
| `townhouse node list` / `node add` / `node remove` | Manage child nodes                                     |
| `townhouse --help`                                 | Full command list                                      |

(Prefix each with `npx @toon-protocol/townhouse`, or install once and call `townhouse` directly.)

> Running with a config in a non-default location? Add `-c <path-to-config.yaml>` to any command. `init`'s next-step hint includes the right `-c` flag automatically when you use `--config-dir`.

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
