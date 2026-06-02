# Contributing to `@toon-protocol/townhouse` — Dev Stack & Internals

> This is the **contributor/maintainer** reference: the local dev stack, the E2E
> harnesses, the Compose-template internals, the orchestrator profiles, and the
> advanced docker-compose operator paths. It is intentionally **not** shipped in
> the npm tarball.
>
> If you just want to **run a node**, see [`README.md`](./README.md) — the
> two-command quickstart.

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

| Host Port | Service                         |
| --------- | ------------------------------- |
| 28080     | Connector admin                 |
| 28050     | SOCKS5 proxy                    |
| 28100     | town-01 BLS health              |
| 28110     | town-02 BLS health              |
| 28200     | mill-01 BLS health (EVM↔Solana) |
| 28210     | mill-02 BLS health (EVM↔Mina)   |
| 28400     | dvm-01 BLS health               |
| 28700     | town-01 relay WebSocket         |
| 28710     | town-02 relay WebSocket         |
| 28545     | Anvil JSON-RPC                  |
| 28899     | Solana RPC                      |
| 28900     | Solana WebSocket                |
| 28085     | Mina GraphQL                    |
| 28181     | Mina accounts manager           |

### What this stack is NOT

- **Not a production deployment.** The Townhouse production compose (`docker-compose-townhouse.yml`) describes one operator's actual node. This file describes a contributor's rig. Do not confuse them.
- **Not the SDK E2E topology.** The SDK E2E stack (`docker-compose-sdk-e2e.yml` / `scripts/sdk-e2e-infra.sh`) uses embedded connectors inside SDK peers. The Townhouse dev stack uses a standalone connector fronting separate child nodes — the production Townhouse shape.
- **Not for performance testing.** Boot-and-smoke only. Performance tuning is out of scope for this stack; it belongs in a dedicated story.
- **Not multi-tenant.** The 5 child nodes use deterministic dev keys that never change across `up`/`down`/`up` cycles. They are NOT for use as real TOON nodes.

## Running E2E Tests (Story 21.16)

There are two test harnesses with different purposes:

### 1. Dev stack integration (contributor dev loop)

Uses `townhouse-dev-infra.sh` (multi-peer fixtures, deterministic keys, 28xxx ports).
See "Local Dev Loop" above.

```bash
./scripts/townhouse-dev-infra.sh up
pnpm --filter @toon-protocol/townhouse test:integration -- dev-stack-smoke
```

### 2. Real-CLI E2E (operator-facing lifecycle — Story 21.16)

Uses `townhouse-test-infra.sh` (image pre-warm only; tests run the real CLI).

```bash
# One-time image cache warm-up (pulls connector image + builds toon:{town,mill,dvm})
bash scripts/townhouse-test-infra.sh up

# Run the integration suite (CLI lifecycle + config propagation)
RUN_DOCKER_INTEGRATION=1 pnpm --filter @toon-protocol/townhouse test:integration

# Or: combined script (up + test + down)
pnpm --filter @toon-protocol/townhouse test:e2e:docker
```

**Key differences from the dev stack:**

|                    | Dev stack (`townhouse-dev-infra.sh`) | Real-CLI E2E (`townhouse-test-infra.sh`) |
| ------------------ | ------------------------------------ | ---------------------------------------- |
| Starts containers? | Yes (multi-peer compose)             | No (tests run the real CLI)              |
| Keys               | Deterministic dev keys               | Fresh wallet per test (mkdtempSync)      |
| Topology           | 2 Town + 2 Mill + 1 DVM + SOCKS5     | 1 Town + 1 Mill + 1 DVM                  |
| Port range         | 28xxx                                | 9400 (API), 9401 (connector admin)       |
| Audience           | Dashboard developers                 | CI / publish gate validation             |

**Diagnostic runbook:** see the header comment in `scripts/townhouse-test-infra.sh`.

**Playwright SPA tests (mock-driven + real-stack):**

```bash
# Mock-driven specs (transport flip, config change) — no real stack needed
pnpm --filter @toon-protocol/townhouse-web e2e

# Real-stack lifecycle spec — requires townhouse up to be running
TOWNHOUSE_E2E_REAL_STACK=1 pnpm --filter @toon-protocol/townhouse-web e2e:real
```

## Compose Templates (npm tarball, Story 45.2)

The published `@toon-protocol/townhouse` package ships two Docker Compose templates:

| Profile | File in tarball                  | Purpose                                               |
| ------- | -------------------------------- | ----------------------------------------------------- |
| `hs`    | `dist/compose/townhouse-hs.yml`  | Operator-facing apex boot — digest-pinned GHCR images |
| `dev`   | `dist/compose/townhouse-dev.yml` | Contributor dev stack — local `toon:*` build images   |

> **Port collision warning.** The HS template binds canonical ports
> (`127.0.0.1:9401`, `:28090`, `:7100`, `:3100`, `:3200`, `:3400`); the
> contributor dev stack binds 28xxx-namespaced equivalents (28080:9401,
> 28100:3100, 28110:3100, 28200:3200, 28210:3200, 28400:3400, 28700:7100,
> 28710:7100). HS-mode and the dev stack (`scripts/townhouse-dev-infra.sh`)
> **must not run concurrently on the same machine** — host:9401, host:3100,
> host:3200, host:3400, host:7100 will conflict. The HS template's
> single-tenant defaults are intentional for the apex operator path
> (Story 45.4 `townhouse hs up`); open an enhancement issue if multi-tenant
> bindings become a real need.

### API

```typescript
import {
  loadComposeTemplate,
  materializeComposeTemplate,
} from '@toon-protocol/townhouse';

// Read the rendered YAML for a profile (read-only, returns a string).
const yaml = loadComposeTemplate('hs');

// Write the compose file + image-manifest.json to ~/.townhouse/ (side-effecting).
// Both output files are written with mode 0o600 (NFR8 — operator-secret).
const { composePath, manifestPath } = materializeComposeTemplate('hs');
// composePath → ~/.townhouse/compose/townhouse-hs.yml
// manifestPath → ~/.townhouse/image-manifest.json
```

Both functions accept an optional `options` object:

```typescript
interface ComposeLoaderOptions {
  townhouseHome?: string; // Override ~/.townhouse/ write target (useful in tests)
  distDir?: string; // Override dist/ read root (useful in tests)
}
```

### `image-manifest.json` schema

The manifest pinning every image to a content-addressed `sha256:` digest:

```json
{
  "schemaVersion": 1,
  "townhouseVersion": "0.1.0",
  "builtAt": "<ISO timestamp>",
  "images": {
    "townhouse-api": {
      "name": "ghcr.io/toon-protocol/townhouse-api",
      "tag": "0.1.0",
      "digest": "sha256:..."
    },
    "town": {
      "name": "ghcr.io/toon-protocol/town",
      "tag": "0.1.0",
      "digest": "sha256:..."
    },
    "mill": {
      "name": "ghcr.io/toon-protocol/mill",
      "tag": "0.1.0",
      "digest": "sha256:..."
    },
    "dvm": {
      "name": "ghcr.io/toon-protocol/dvm",
      "tag": "0.1.0",
      "digest": "sha256:..."
    },
    "connector": {
      "name": "ghcr.io/toon-protocol/connector",
      "tag": "3.4.1",
      "digest": "sha256:..."
    }
  }
}
```

Full schema source: `scripts/build-image-manifest.mjs` (lines 44–67).

### Dev stack compose (canonical source)

The package-local `packages/townhouse/compose/townhouse-dev.yml` is the canonical source of the dev template. It is shipped verbatim in the npm tarball (no digest substitution — uses local `toon:*` image tags).

For backward compatibility, `docker-compose-townhouse-dev.yml` at the repo root is preserved and continues to be used by `scripts/townhouse-dev-infra.sh`. A follow-up story will route the script through the package-local copy.

## DockerOrchestrator Profiles

The `DockerOrchestrator` class drives both the contributor dev stack and
the operator HS-mode apex stack via a single `profile: 'dev' | 'hs'`
parameter:

- **`profile: 'dev'`** (default) — uses `dockerode` for fine-grained
  programmatic control. Matches the lifecycle the existing `townhouse up`
  CLI has shipped since Epic 21. No `composePath` required.
- **`profile: 'hs'`** — shells out to `docker compose -f <composePath> up -d`
  with `--profile <type>` flags for each enabled peer. Waits on the
  connector's `GET /admin/hs-hostname` endpoint (connector v3.5.0+) until
  the `.anyone` hostname is published. Requires `composePath` (typically
  the path returned by `materializeComposeTemplate('hs')`).

Example (HS-mode caller, as Story 45.4's `townhouse hs up` will use):

```typescript
import {
  materializeComposeTemplate,
  DockerOrchestrator,
} from '@toon-protocol/townhouse';
import Docker from 'dockerode';

const { composePath } = materializeComposeTemplate('hs');
const docker = new Docker();
const orch = new DockerOrchestrator(docker, config, walletManager, {
  profile: 'hs',
  composePath,
});
await orch.up([]); // apex-only (connector + townhouse-api)
```

### Connector Anon Requirement (HS Profile)

The HS profile's readiness gate calls `GET /admin/hs-hostname`. The
connector container MUST be configured with `anon.enabled: true` —
if anon is disabled, the endpoint returns 503 and the orchestrator
throws `OrchestratorError("connector is anon-disabled — set
anon.enabled: true in the connector config")`. Story 45.4's
`townhouse hs up` generates the connector config with `anon.enabled: true`
by default; manual configurations should mirror that setting.

## HS Mode internals (Apex Install)

`townhouse hs up` is the one-command install for homelab operators. It boots the
apex stack (connector + townhouse-api) and publishes a `.anyone` hidden-service
address, writing the address to `~/.townhouse/host.json` as the final step.

### Files written by `hs up`

| File                                    | Mode  | Purpose                                     |
| --------------------------------------- | ----- | ------------------------------------------- |
| `~/.townhouse/config.yaml`              | 0o600 | Townhouse config (written by `init`)        |
| `~/.townhouse/wallet.enc`               | 0o600 | Encrypted BIP-39 wallet (written by `init`) |
| `~/.townhouse/compose/townhouse-hs.yml` | 0o600 | Materialised HS compose template            |
| `~/.townhouse/image-manifest.json`      | 0o600 | Digest-pinned image manifest                |
| `~/.townhouse/connector.yaml`           | 0o600 | Connector config with `anon.enabled: true`  |
| `~/.townhouse/host.json`                | 0o600 | Published hostname + metadata               |

`host.json` schema:

```json
{
  "hostname": "<onion>.anyone",
  "publishedAt": "<ISO-8601>",
  "connectorAdminUrl": "http://127.0.0.1:9401",
  "townhouseApiUrl": "http://127.0.0.1:28090",
  "writtenAt": "<ISO-8601>"
}
```

### Idempotent re-run

Re-running `townhouse hs up` against an already-running apex detects the
running connector, re-prints the hostname, and exits 0 without pulling images
or restarting containers. `~/.townhouse/host.json` is refreshed.

### `hs down` vs. `hs down --rotate-keys`

| Command                           | Volumes                             | `host.json` | Next `hs up`               |
| --------------------------------- | ----------------------------------- | ----------- | -------------------------- |
| `townhouse hs down`               | **Preserved** (`townhouse-hs-anon`) | Kept        | **Same** `.anyone` address |
| `townhouse hs down --rotate-keys` | **Deleted**                         | Deleted     | **New** `.anyone` address  |

`--rotate-keys` prompts for confirmation when stdin is a TTY. When stdin is not
a TTY (CI, scripted), it proceeds without prompting.

### Password sourcing

Resolution order:

1. `--password <pw>` flag
2. `TOWNHOUSE_WALLET_PASSWORD` environment variable
3. Interactive prompt (only when `process.stdin.isTTY === true`)
4. Exit 1 with an error message (non-interactive, no password provided)

### Failure-state copy (UX-DR5)

| Class               | Detection                                                        | Next step shown                                 |
| ------------------- | ---------------------------------------------------------------- | ----------------------------------------------- |
| anon-timeout        | `HS hostname publication timeout` in error                       | `Re-run with DEBUG=townhouse:*`                 |
| anon-disabled       | `anon-disabled (HTTP 503)` from probe                            | Edit `connector.yaml`, set `anon.enabled: true` |
| image-pull-failure  | `failed to pull` / `pull access denied` in stderr                | Check your network                              |
| port-collision      | `address already in use` / `port is already allocated` in stderr | Stop the conflicting service                    |
| missing-docker-sock | `Cannot connect to the Docker daemon` / `docker CLI not found`   | Start Docker                                    |
| generic             | Any other error                                                  | `Run with DEBUG=townhouse:*`                    |

## Running the townhouse as a hidden service (laptop, manual compose)

`docker-compose-townhouse-hs.yml` brings up the full operator stack —
apex connector + town + mill + dvm + (optional) Anvil + Solana + EVM
faucet — with the connector publishing a `.anyone` hidden service via
the Anyone Protocol overlay. External peers reach the townhouse only
through that `.anyone` address; the laptop never exposes anything to
the public clearnet.

```bash
# 1. Build the local node images (one-time, until they're on ghcr)
docker compose -f docker-compose-townhouse.yml --profile town --profile mill --profile dvm build

# 2. Pick a chain profile (localnet is the default — copy when ready to switch)
cp .env.townhouse-hs.example .env

# 3. Boot the HS stack. Profiles select what runs:
#    --profile localnet       bundles anvil + solana (skip for real testnets)
#    --profile town/mill/dvm  child nodes
#    --profile faucet         EVM ETH + Mock USDC faucet UI on :3500
docker compose -f docker-compose-townhouse-hs.yml \
  --profile localnet --profile town --profile mill --profile dvm --profile faucet up -d

# 4. Wait ~30-90s for anon to bootstrap and publish the descriptor.
#    Then read your published .anyone address:
docker compose -f docker-compose-townhouse-hs.yml exec connector \
  cat /var/lib/anon/hs/hostname
# → eag2qnhil4vpvfo2eu3qtqj3rzzkrzbmboivwwbbgzr4svfvjigoxpad.anyone

# 5. Share that address with peers. They reach you over Tor at:
#      wss://<address>.anyone/btp
```

### Chain configuration

Mill and the faucet read chain endpoints from environment variables, with
localnet defaults. Override via `.env` to switch profiles — see
`.env.townhouse-hs.example` for the four supported shapes:

| Profile                | EVM                                               | Solana                             | Mock USDC                                                                     |
| ---------------------- | ------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- |
| **localnet** (default) | bundled Anvil at `anvil:8545`                     | bundled validator at `solana:8899` | pre-deployed in both bundled images                                           |
| **Akash devnet**       | `anvil` lease URL from `deploy/akash/leases.json` | `solana` lease URL from same       | baked into `akash-anvil` + `akash-solana` images (same addresses as localnet) |
| **Public testnet**     | Sepolia (`infura.io/v3/<KEY>`)                    | `api.devnet.solana.com`            | real Circle testnet USDC contracts                                            |
| **Mainnet**            | mainnet RPC                                       | `api.mainnet-beta.solana.com`      | real Circle mainnet USDC — **disable the faucet profile**                     |

Variables consumed: `EVM_RPC_URL`, `EVM_CHAIN_ID`, `EVM_USDC_ADDRESS`,
`SOLANA_RPC_URL`, `SOLANA_USDC_MINT`. Setting these in `.env` configures
the laptop compose AND the Akash deploy (`scripts/akash-deploy.sh
townhouse`) identically.

### Faucet workflow

**EVM ETH + Mock USDC** — bundled `faucet` service runs at
`http://127.0.0.1:3500`. Operator pastes their address, gets ETH for gas
and Mock USDC for transfers. Rate-limited 1 request per address per hour
by default (override via `FAUCET_RATE_LIMIT_HOURS`). The faucet uses
well-known Anvil dev keys — only meaningful against localnet or the
Akash devnet; harmless against testnets/mainnet (transactions just fail).

**Solana SOL + Mock USDC** — the standalone EVM faucet container does
NOT yet handle Solana. Two paths until that gap closes:

1. **Dashboard panel**: the townhouse host API (`pnpm --filter
@toon-protocol/townhouse-web dev` + the host-side townhouse API)
   exposes a Faucet panel that does both EVM and Solana drips through
   `POST /api/faucet`. Best for live operator use.
2. **Script**: `scripts/faucet-sol-usdc.mjs <recipient>` from the host —
   talks to whatever `SOLANA_RPC_URL` resolves to in `leases.json`.

Both options use the bootstrap-baked Mock USDC mint
(`6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q`) and faucet authority
keypair at `infra/solana/keys/faucet-authority.json`.

### Persistence

The `townhouse-hs-anon` named docker volume preserves
`hs_ed25519_secret_key` across `docker compose down` cycles — the
`.anyone` address is stable for as long as the volume exists. Delete the
volume to rotate the address.

### What's exposed on the host (loopback only)

- Connector admin: `127.0.0.1:9401` — no auth, **never expose publicly**
- Anvil RPC: `127.0.0.1:8545` (localnet profile)
- Solana RPC: `127.0.0.1:8899`, WS `127.0.0.1:8900` (localnet profile)
- Town Nostr relay clearnet: `127.0.0.1:7100` — direct local clients
  bypass the HS, handy for debugging
- EVM faucet UI: `127.0.0.1:3500` (faucet profile)

### Akash deployment of the same stack

`deploy/akash/townhouse.sdl.yaml` deploys apex + town + mill + dvm +
faucet to Akash with the same architecture. Chain devnets stay as
separate Akash leases (clearnet) — see `scripts/akash-deploy.sh`'s
`cmd_townhouse` (TODO) for the leases.json wiring. The faucet's HTTP
port is the SDL's "one global service" validator scaffolding;
operationally, external peers reach the townhouse only via the `.anyone`
hidden service.

## Package overview (public API)

The `@toon-protocol/townhouse` package exports:

- **DockerOrchestrator** — manages container lifecycle for Town/Mill/DVM nodes
- **ConnectorConfigGenerator** — generates connector peer config from node identities
- **ConnectorAdminClient** — typed HTTP client for the connector admin API (`/health`, `/admin/peers`, `/admin/metrics.json`)
- **HD wallet management** — BIP-44 key derivation per node type (story 21.4)
- **Fastify REST/WebSocket metrics API** — host-side API for the dashboard (story 21.8)

See `packages/townhouse/src/index.ts` for the full public API surface.

## Transport configuration

The `transport` block selects how the connector reaches peers (outbound) and
how peers reach the connector (inbound).

```yaml
transport:
  mode: direct # 'direct' | 'ator'
  socksProxy: socks5h://proxy.ator.io:9050 # required when mode='ator'
  externalUrl: wss://my-connector.example/btp # see below
  hiddenService: # optional — connector publishes its own .anyone HS
    dir: /var/lib/anon/hs
    port: 3000
    startupTimeoutMs: 60000 # optional
    stopTimeoutMs: 10000 # optional
    externalUrl: wss://forced.anyone/btp # optional override of "auto"
```

**`mode: 'direct'`** — clearnet TCP, no overlay. Default for development.

**`mode: 'ator'`** — outbound BTP through the Anyone Protocol (ATOR) overlay
via SOCKS5. Requires either `externalUrl` (operator-managed anon binary
external to the connector) OR `hiddenService` (connector manages its own
anon binary in-process and publishes a `.anyone` hidden service). Without
one of these the connector rejects the manifest at boot — the validator
catches this case before deploy.

**`hiddenService` (Story 35.5 of the connector repo)** — when set, the
connector boots `@anyone-protocol/anyone-client` in-process, spawns the
`anon` binary, and publishes a v3 hidden service. The keypair lives at
`dir`; persist that path on a mounted volume to keep the `.anyone` address
stable across redeploys, or delete it to rotate. The connector reads
`${dir}/hostname` after publish and advertises `wss://<hostname>.anyone/btp`
to peers (you can override with an explicit `externalUrl` if needed).

**Wire-format note (silent-bug fix in this story):** the previous shape
emitted `transport: { mode: 'ator', socksProxy }` to the connector image,
but the connector at 3.3.x reads a discriminated union keyed on `type`
(`'direct' | 'socks5'`). The unknown `mode` field was silently discarded,
defaulting to direct — operators toggling ATOR got direct traffic anyway.
The current generator emits the correct `type: 'socks5'` shape with
`externalUrl`, `managed`, and `managedOptions` per the connector contract.

## Notes

`townhouse status --units=sats` exists as an undocumented power-user flag for Bitcoin-native operators. It converts the earnings block to integer sats using a CLI-supplied rate (`--rate <sats-per-usdc>`) or the `TOWNHOUSE_SATS_PER_USDC` environment variable; if neither is set, the command exits 1. There is no built-in price oracle — this is intentionally a manual conversion. USDC remains the canonical denomination across every other Townhouse surface (TUI hero band, drill subcommands like `townhouse peer` and `townhouse channels`); this flag is absent from `townhouse --help` per design decision D44-002.
