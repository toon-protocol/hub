# @toon-protocol/hub-mcp

Let a Claude agent — **Claude Desktop or Claude Code** — act as a full **Hub operator**: `init`/`up`, provision town/mill/dvm nodes, tune fees, manage settlement chains and Arweave credits, inspect earnings/balances/logs, and withdraw.

The agent surface is an **MCP server** — bin **`hub-mcp`**, registered under the server name **`hub-operator`** (the name in Claude's MCP list and the `initialize` handshake; `mcpServers.hub` in config is just your local alias).

Unlike [`@toon-protocol/client-mcp`](../client-mcp) there is **no second daemon**: the Hub **apex** (the connector + Fastify control API on `:9400`, started by `hub up`) _is_ the always-on stateful layer that owns the wallet. This server is a thin stdio proxy that drives the existing `hub` **CLI** (lifecycle/config) and **API** (live telemetry), and **holds no chain keys**.

|                             | Name                           |
| --------------------------- | ------------------------------ |
| npm package                 | `@toon-protocol/hub-mcp` |
| MCP server name (handshake) | `hub-operator`           |
| MCP server bin              | `hub-mcp`                |

> **Trust model:** the agent _is_ the operator and owns the funds — there is no read-only mode and no confirmation gating. See `docs/hub-mcp-design.md`.

## Install

```bash
pnpm add -g @toon-protocol/hub-mcp   # or use npx / pnpm dlx
```

Requires the `hub` CLI on `PATH` (or set `TOWNHOUSE_BIN`) and Docker.

## Register

### Claude Code

```bash
claude mcp add hub -e TOWNHOUSE_MNEMONIC="word1 … word12" -- hub-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`, then restart:

```json
{
  "mcpServers": {
    "hub": {
      "command": "hub-mcp",
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
| `TOWNHOUSE_MNEMONIC`       | —                       | Operator wallet seed; loaded directly, no password. On cold start `hub_init` generates and returns one. |
| `TOWNHOUSE_API_URL`        | `http://127.0.0.1:9400` | Apex Fastify control API.                                                                                     |
| `TOWNHOUSE_CONFIG_DIR`     | `~/.hub`          | Config + wallet + boot log (`up.log`).                                                                        |
| `TOWNHOUSE_AUTOUP`         | `1`                     | Auto-`up` the apex on demand; tools report "booting — retry" while it boots. `0` to disable.                  |
| `TOWNHOUSE_TRANSPORT_MODE` | `direct`                | Default boot transport (`direct` \| `hs`).                                                                    |
| `TOWNHOUSE_BIN`            | `hub`             | Path to the CLI. **Required for CLI-backed tools** (see below) when `hub` isn't on `PATH` — e.g. `node_modules/@toon-protocol/hub/dist/cli.js`. |

## Tools

Lifecycle: `hub_init`, `hub_up`, `hub_up_status`, `hub_down`, `hub_status`.
Nodes: `hub_list_nodes`, `hub_add_node`, `hub_remove_node`, `hub_set_node_fees`.
Chains/transport: `hub_chains`, `hub_transport`.
Wallet/$: `hub_balances`, `hub_earnings`, `hub_seed`, `hub_withdraw`, `hub_credits`.
Telemetry: `hub_logs`, `hub_metrics`, `hub_channels`, `hub_health`.
Meta: `hub_version` (reports this package version, the pinned `hub` range, and the detected CLI version — flags version skew).

`hub_up` returns immediately with a handle — poll `hub_up_status` for per-step boot progress (a boot can take minutes; image pulls / HS bootstrap). Withdraw supports `dryRun:true` for a gas/fee estimate.

`hub_metrics` and `hub_logs` prefer the apex's live streams (WS `/metrics`, SSE `/api/logs/stream`) and fall back to the `hub` CLI JSON path; each result carries a `source` field.

**CLI-backed tools require a resolvable CLI.** Most read tools (`status`, `list_nodes`, `earnings`, `balances`, `metrics`, `logs`, `transport`, `chains list`) are served by the apex API / streams and need no CLI. But `hub_health`, `hub_channels`, `hub_seed`, `hub_withdraw`, `hub_credits`, `hub_set_node_fees`, `hub_chains add/remove`, the lifecycle commands, and the CLI-probe half of `hub_version` shell out to `hub`. If it isn't on `PATH`, set `TOWNHOUSE_BIN` (and usually `TOWNHOUSE_CONFIG_DIR`) — otherwise those tools fail with an actionable "CLI not found — set TOWNHOUSE_BIN" error (and `hub_version` reports the same hint in its `note`).

## Resources

Two cheap read views are also exposed as MCP resources for clients that prefer resource reads:

- `hub://status` — apex / connector / node / transport snapshot (mirrors `hub_status`).
- `hub://earnings` — apex + per-peer earnings with deltas (mirrors `hub_earnings`).

## Status

Code-complete; pending end-to-end live validation against a real apex (see issue #229). The upstream prerequisites and deferred package items have landed:

- **P1/P1b** — `TOWNHOUSE_MNEMONIC` direct-load path (CLI + `hub-api` container), no encrypted-wallet password.
- **P2/P2b** — `--json` / NDJSON across every command this server consumes (`init` / `up` / `hs up` / `hs enable` / `status` / `down` / `wallet seed` / `credits`).
- Streams adapter (WS `/metrics` + SSE `/api/logs/stream`), MCP resources, and a `hub_version` skew probe (pinned via `peerDependencies` on `@toon-protocol/hub`).

This package pins `@toon-protocol/hub` as an optional `peerDependency`; `hub_version` surfaces any skew at runtime.

The companion **`hub-operator` skill** (mirroring client-mcp's `toon-client`) ships in `hub-plugin/` (and `.claude/skills/hub-operator/`), bundling this MCP server with an operator skill + evals. Remaining: end-to-end live validation against a real apex (issue #232).

See `docs/hub-mcp-design.md` and `docs/hub-mcp-skeleton.md`.

## Develop

```bash
pnpm --filter @toon-protocol/hub-mcp build
pnpm --filter @toon-protocol/hub-mcp test
RUN_LIVE_OPERATOR_E2E=1 pnpm --filter @toon-protocol/hub-mcp test:integration
```
