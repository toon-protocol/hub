# @toon-protocol/townhouse-mcp

Let a Claude agent — **Claude Desktop or Claude Code** — act as a full **Townhouse operator**: `init`/`up`, provision town/mill/dvm nodes, tune fees, manage settlement chains and Arweave credits, inspect earnings/balances/logs, and withdraw.

The agent surface is an **MCP server** — bin **`townhouse-mcp`**, registered under the server name **`townhouse-operator`** (the name in Claude's MCP list and the `initialize` handshake; `mcpServers.townhouse` in config is just your local alias).

Unlike [`@toon-protocol/client-mcp`](../client-mcp) there is **no second daemon**: the Townhouse **apex** (the connector + Fastify control API on `:9400`, started by `townhouse up`) _is_ the always-on stateful layer that owns the wallet. This server is a thin stdio proxy that drives the existing `townhouse` **CLI** (lifecycle/config) and **API** (live telemetry), and **holds no chain keys**.

|                             | Name                           |
| --------------------------- | ------------------------------ |
| npm package                 | `@toon-protocol/townhouse-mcp` |
| MCP server name (handshake) | `townhouse-operator`           |
| MCP server bin              | `townhouse-mcp`                |

> **Trust model:** the agent _is_ the operator and owns the funds — there is no read-only mode and no confirmation gating. See `docs/townhouse-mcp-design.md`.

## Install

```bash
pnpm add -g @toon-protocol/townhouse-mcp   # or use npx / pnpm dlx
```

Requires the `townhouse` CLI on `PATH` (or set `TOWNHOUSE_BIN`) and Docker.

## Register

### Claude Code

```bash
claude mcp add townhouse -e TOWNHOUSE_MNEMONIC="word1 … word12" -- townhouse-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`, then restart:

```json
{
  "mcpServers": {
    "townhouse": {
      "command": "townhouse-mcp",
      "env": {
        "TOWNHOUSE_MNEMONIC": "word1 … word12",
        "TOWNHOUSE_API_URL": "http://127.0.0.1:9400"
      }
    }
  }
}
```

## Environment

| Var                        | Default                 | Purpose                                                                                                       |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| `TOWNHOUSE_MNEMONIC`       | —                       | Operator wallet seed; loaded directly, no password. On cold start `townhouse_init` generates and returns one. |
| `TOWNHOUSE_API_URL`        | `http://127.0.0.1:9400` | Apex Fastify control API.                                                                                     |
| `TOWNHOUSE_CONFIG_DIR`     | `~/.townhouse`          | Config + wallet + boot log (`up.log`).                                                                        |
| `TOWNHOUSE_AUTOUP`         | `1`                     | Auto-`up` the apex on demand; tools report "booting — retry" while it boots. `0` to disable.                  |
| `TOWNHOUSE_TRANSPORT_MODE` | `direct`                | Default boot transport (`direct` \| `hs`).                                                                    |
| `TOWNHOUSE_BIN`            | `townhouse`             | Path to the CLI. **Required for CLI-backed tools** (see below) when `townhouse` isn't on `PATH` — e.g. `node_modules/@toon-protocol/townhouse/dist/cli.js`. |

## Tools

Lifecycle: `townhouse_init`, `townhouse_up`, `townhouse_up_status`, `townhouse_down`, `townhouse_status`.
Nodes: `townhouse_list_nodes`, `townhouse_add_node`, `townhouse_remove_node`, `townhouse_set_node_fees`.
Chains/transport: `townhouse_chains`, `townhouse_transport`.
Wallet/$: `townhouse_balances`, `townhouse_earnings`, `townhouse_seed`, `townhouse_withdraw`, `townhouse_credits`.
Telemetry: `townhouse_logs`, `townhouse_metrics`, `townhouse_channels`, `townhouse_health`.
Meta: `townhouse_version` (reports this package version, the pinned `townhouse` range, and the detected CLI version — flags version skew).

`townhouse_up` returns immediately with a handle — poll `townhouse_up_status` for per-step boot progress (a boot can take minutes; image pulls / HS bootstrap). Withdraw supports `dryRun:true` for a gas/fee estimate.

`townhouse_metrics` and `townhouse_logs` prefer the apex's live streams (WS `/metrics`, SSE `/api/logs/stream`) and fall back to the `townhouse` CLI JSON path; each result carries a `source` field.

**CLI-backed tools require a resolvable CLI.** Most read tools (`status`, `list_nodes`, `earnings`, `balances`, `metrics`, `logs`, `transport`, `chains list`) are served by the apex API / streams and need no CLI. But `townhouse_health`, `townhouse_channels`, `townhouse_seed`, `townhouse_withdraw`, `townhouse_credits`, `townhouse_set_node_fees`, `townhouse_chains add/remove`, the lifecycle commands, and the CLI-probe half of `townhouse_version` shell out to `townhouse`. If it isn't on `PATH`, set `TOWNHOUSE_BIN` (and usually `TOWNHOUSE_CONFIG_DIR`) — otherwise those tools fail with an actionable "CLI not found — set TOWNHOUSE_BIN" error (and `townhouse_version` reports the same hint in its `note`).

## Resources

Two cheap read views are also exposed as MCP resources for clients that prefer resource reads:

- `townhouse://status` — apex / connector / node / transport snapshot (mirrors `townhouse_status`).
- `townhouse://earnings` — apex + per-peer earnings with deltas (mirrors `townhouse_earnings`).

## Status

Code-complete; pending end-to-end live validation against a real apex (see issue #229). The upstream prerequisites and deferred package items have landed:

- **P1/P1b** — `TOWNHOUSE_MNEMONIC` direct-load path (CLI + `townhouse-api` container), no encrypted-wallet password.
- **P2/P2b** — `--json` / NDJSON across every command this server consumes (`init` / `up` / `hs up` / `hs enable` / `status` / `down` / `wallet seed` / `credits`).
- Streams adapter (WS `/metrics` + SSE `/api/logs/stream`), MCP resources, and a `townhouse_version` skew probe (pinned via `peerDependencies` on `@toon-protocol/townhouse`).

This package pins `@toon-protocol/townhouse` as an optional `peerDependency`; `townhouse_version` surfaces any skew at runtime.

The companion **`townhouse-operator` skill** (mirroring client-mcp's `toon-client`) ships in `townhouse-plugin/` (and `.claude/skills/townhouse-operator/`), bundling this MCP server with an operator skill + evals. Remaining: end-to-end live validation against a real apex (issue #232).

See `docs/townhouse-mcp-design.md` and `docs/townhouse-mcp-skeleton.md`.

## Develop

```bash
pnpm --filter @toon-protocol/townhouse-mcp build
pnpm --filter @toon-protocol/townhouse-mcp test
RUN_LIVE_OPERATOR_E2E=1 pnpm --filter @toon-protocol/townhouse-mcp test:integration
```
