# @toon-protocol/townhouse

Host-native orchestrator and dashboard for Docker-containerized TOON nodes (Town, Mill, DVM) behind a shared standalone connector.

## Local Dev Loop (Townhouse Dev Stack)

Stories 21.9–21.13 (dashboard views) and 21.8.5 (design system) **must** be developed against the Townhouse dev stack, not against mocks or the SDK E2E topology (D21-009).

### One-command boot

```bash
./scripts/townhouse-dev-infra.sh up
```

This command:
1. Builds `toon:town`, `toon:mill`, `toon:dvm` Docker images (Docker layer cache applies on subsequent runs)
2. Starts Anvil (EVM), Solana test-validator, and Mina lightnet chain devnets
3. Deploys Mock USDC to Anvil and the Solana payment-channel program
4. Starts the standalone connector with all 5 child peers registered
5. Starts 5 child nodes with deterministic Nostr keys
6. Polls each child's `/health` endpoint until ready (60 s timeout per node)
7. Prints a success banner listing every endpoint URL
8. Writes `.env.townhouse-dev` at the workspace root

**First run** (no cached images): ~5 minutes (dominated by image pulls).
**Subsequent runs**: ~90 seconds (cached images, warm Docker daemon).

### Endpoint banner

On success, the script prints every endpoint grouped by category. Copy these URLs into your browser or `curl` to verify the stack manually:

```
Connector      http://127.0.0.1:28080
town-01 relay  ws://127.0.0.1:28700
town-01 health http://127.0.0.1:28100
town-02 relay  ws://127.0.0.1:28710
town-02 health http://127.0.0.1:28110
mill-01 health http://127.0.0.1:28200  (EVM↔Solana)
mill-02 health http://127.0.0.1:28210  (EVM↔Mina)
dvm-01 health  http://127.0.0.1:28400
Anvil RPC      http://127.0.0.1:28545
Solana RPC     http://127.0.0.1:28899
Mina GraphQL   http://127.0.0.1:28085
Mina Accounts  http://127.0.0.1:28181
SOCKS5         socks5://127.0.0.1:28050
```

### Host-Fastify integration via `.env.townhouse-dev`

The script writes `.env.townhouse-dev` at the workspace root. Story 21.8.5 wires a `pnpm dev:docker` script in `packages/townhouse-web` that sources this file at startup so the host-side Fastify API knows the connector admin URL and child node addresses without any manual configuration.

The contract (env var names the Fastify API reads):
- `TOWNHOUSE_CONNECTOR_ADMIN_URL` — connector admin base URL
- `TOWNHOUSE_DEV_TOWN_01_RELAY`, `TOWNHOUSE_DEV_TOWN_02_RELAY` — relay WebSocket URLs
- `TOWNHOUSE_DEV_TOWN_0{1,2}_HEALTH`, `TOWNHOUSE_DEV_MILL_0{1,2}_HEALTH`, `TOWNHOUSE_DEV_DVM_01_HEALTH` — BLS health URLs
- `TOWNHOUSE_DEV_ANVIL_RPC`, `TOWNHOUSE_DEV_SOLANA_RPC`, `TOWNHOUSE_DEV_MINA_GRAPHQL` — chain RPC URLs
- `SOLANA_PROGRAM_ID`, `MINA_ZKAPP_ADDRESS`, `TOON_USDC_ADDRESS` — deployed contract addresses
- `TOWNHOUSE_DEV_WALLET_MNEMONIC` — **DEV ONLY** BIP-39 test-vector-zero mnemonic (`abandon … about`); read by `api-server.mjs` to auto-initialize the `WalletManager` without running `townhouse init`. This is the publicly known test vector — NEVER use in production. The dev API loop **rejects any other value** at startup so a developer who pastes a real mnemonic by accident gets a loud error rather than silent address derivation.

When the dev mnemonic is loaded, the API loop also writes `~/.townhouse/wallet.enc` (if absent) encrypted with the documented dev password `townhouse-dev`. This makes `POST /wallet/reveal` exercisable against the live dev stack — open the wallet view, click "Reveal seed phrase", enter `townhouse-dev`, see the 12-word mnemonic. The on-disk file is never overwritten if it already exists, so an operator who later runs the production `townhouse init` flow keeps their real wallet.

`.env.townhouse-dev` is git-ignored. Never commit it.

### TURBO_TOKEN

`TURBO_TOKEN` is used by the DVM container for Arweave uploads via Turbo. It is passed through from the host environment.

- **Working on Town/Mill views (21.9–21.11):** No `TURBO_TOKEN` needed. The DVM starts in disabled-upload mode and its health endpoint still responds 200.
- **Working on DVM views (21.12) or upload flows:** Set `TURBO_TOKEN` in your shell before running `up`.

The script logs a warning (not an error) when `TURBO_TOKEN` is unset, then continues.

### Teardown

```bash
./scripts/townhouse-dev-infra.sh down     # Stop containers + remove .env.townhouse-dev
./scripts/townhouse-dev-infra.sh down-v   # Same + delete named volumes (fresh state next run)
./scripts/townhouse-dev-infra.sh status   # Show container state + health summary
```

Use `down-v` when you want a completely fresh channel/data state on the next `up`.

### Port allocation

All ports are `127.0.0.1` only (never `0.0.0.0`). Full table also in `CLAUDE.md` "Townhouse Dev Stack (28xxx)".

| Host Port | Service |
|-----------|---------|
| 28080 | Connector admin |
| 28050 | SOCKS5 proxy |
| 28100 | town-01 BLS health |
| 28110 | town-02 BLS health |
| 28200 | mill-01 BLS health (EVM↔Solana) |
| 28210 | mill-02 BLS health (EVM↔Mina) |
| 28400 | dvm-01 BLS health |
| 28700 | town-01 relay WebSocket |
| 28710 | town-02 relay WebSocket |
| 28545 | Anvil JSON-RPC |
| 28899 | Solana RPC |
| 28900 | Solana WebSocket |
| 28085 | Mina GraphQL |
| 28181 | Mina accounts manager |

### What this stack is NOT

- **Not a production deployment.** The Townhouse production compose (`docker-compose-townhouse.yml`) describes one operator's actual node. This file describes a contributor's rig. Do not confuse them.
- **Not the SDK E2E topology.** The SDK E2E stack (`docker-compose-sdk-e2e.yml` / `scripts/sdk-e2e-infra.sh`) uses embedded connectors inside SDK peers. The Townhouse dev stack uses a standalone connector fronting separate child nodes — the production Townhouse shape.
- **Not for performance testing.** Boot-and-smoke only. Performance tuning is out of scope for this stack; it belongs in a dedicated story.
- **Not multi-tenant.** The 5 child nodes use deterministic dev keys that never change across `up`/`down`/`up` cycles. They are NOT for use as real TOON nodes.

## Package overview

The `@toon-protocol/townhouse` package provides:

- **DockerOrchestrator** — manages container lifecycle for Town/Mill/DVM nodes
- **ConnectorConfigGenerator** — generates connector peer config from node identities
- **ConnectorAdminClient** — typed HTTP client for the connector admin API (`/health`, `/admin/peers`, `/admin/metrics.json`)
- **HD wallet management** — BIP-44 key derivation per node type (story 21.4)
- **Fastify REST/WebSocket metrics API** — host-side API for the dashboard (story 21.8)

See `packages/townhouse/src/index.ts` for the full public API surface.
