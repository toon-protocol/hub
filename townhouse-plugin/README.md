# townhouse (Claude Code plugin)

One-step install of the **TOON Protocol Townhouse operator** for a Claude agent:
the `townhouse-operator` skill **plus** the `townhouse-mcp` MCP server, bundled
together. A Townhouse is the **revenue-earning** side of TOON — the apex
(connector) plus `town` / `mill` / `dvm` child nodes that clients pay to use.

After install, the `townhouse_*` tools are available and the `townhouse-operator`
skill auto-activates when you ask to run, configure, monitor, or take earnings
from a Townhouse node.

> For the **client** side (publishing/reading/paying), install the separate
> `toon` plugin (`toon-client` skill + `toon-mcp`).

## What's in here

| Part | Path | Role |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | Plugin name/version/metadata |
| Marketplace entry | `<repo-root>/.claude-plugin/marketplace.json` | Lets the `toon-protocol/town` repo act as a marketplace (lists this plugin with `source: ./townhouse-plugin`). A GitHub-repo marketplace is discovered at the **repo root**, not in the plugin subdir. |
| Skill | `skills/townhouse-operator/SKILL.md` (+ `references/`, `evals/`) | Teaches lifecycle / nodes / fees / chains / earnings / telemetry |
| MCP server | `.mcp.json` | Declares the `townhouse` MCP server, run via `npx @toon-protocol/hub-mcp` |

The MCP server is published separately to npm as
[`@toon-protocol/hub-mcp`](https://www.npmjs.com/package/@toon-protocol/hub-mcp)
(bin `townhouse-mcp`); this plugin just declares it, so the plugin stays tiny and
the heavy code is versioned on npm. There is **no second daemon** — the apex
(connector + Fastify API, started by `townhouse up`) is the long-lived layer.

## Install

**Try it locally (no marketplace):**

```bash
claude --plugin-dir /path/to/town/townhouse-plugin
```

**Via marketplace (this repo doubles as one):**

```text
/plugin marketplace add toon-protocol/town
/plugin install townhouse@toon
```

## Prerequisites

- Docker & Docker Compose (the apex + nodes run as containers).
- Node ≥ 20 (`npx` fetches `@toon-protocol/hub-mcp` on first run) and the
  `townhouse` CLI on PATH (or set `TOWNHOUSE_BIN`).
- An operator wallet seed via `TOWNHOUSE_MNEMONIC` (no password). On a cold start
  `townhouse_init` generates and returns one for you to custody.

Configure the MCP server via env (see the
[`@toon-protocol/hub-mcp` README](https://www.npmjs.com/package/@toon-protocol/hub-mcp)
for the full contract):

| Var | Default | Role |
|---|---|---|
| `TOWNHOUSE_API_URL` | `http://127.0.0.1:9400` | apex Fastify control API |
| `TOWNHOUSE_MNEMONIC` | — | operator wallet seed (no password) |
| `TOWNHOUSE_CONFIG_DIR` | `~/.townhouse` | config/wallet dir |
| `TOWNHOUSE_AUTOUP` | `1` | auto-`up` the apex on demand (`0` = explicit control) |
| `TOWNHOUSE_TRANSPORT_MODE` | `direct` | default boot transport (`direct` \| `hs`) |

## Tools (21)

Lifecycle: `townhouse_init`, `townhouse_up`, `townhouse_up_status`,
`townhouse_down`, `townhouse_status`.
Nodes: `townhouse_list_nodes`, `townhouse_add_node`, `townhouse_remove_node`,
`townhouse_set_node_fees`.
Chains/transport: `townhouse_chains`, `townhouse_transport`.
Earnings/$: `townhouse_balances`, `townhouse_earnings`, `townhouse_seed`,
`townhouse_withdraw`, `townhouse_credits`.
Telemetry: `townhouse_logs`, `townhouse_metrics`, `townhouse_channels`,
`townhouse_health`, `townhouse_version`.

Resources: `townhouse://status`, `townhouse://earnings`. Namespaced under the
plugin, e.g. the skill is invocable as `/townhouse:townhouse-operator`.

> **Note on schemas:** Claude Code's plugin/marketplace formats evolve; verify
> `plugin.json` / `marketplace.json` fields and the `/plugin` commands against
> the current docs (https://code.claude.com/docs) before publishing.
