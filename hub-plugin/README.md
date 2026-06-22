# hub (Claude Code plugin)

One-step install of the **TOON Protocol Hub operator** for a Claude agent:
the `hub-operator` skill **plus** the `hub-mcp` MCP server, bundled
together. A Hub is the **revenue-earning** side of TOON — the apex
(connector) plus `town` / `mill` / `dvm` child nodes that clients pay to use.

After install, the `hub_*` tools are available and the `hub-operator`
skill auto-activates when you ask to run, configure, monitor, or take earnings
from a Hub node.

> For the **client** side (publishing/reading/paying), install the separate
> `toon` plugin (`toon-client` skill + `toon-mcp`).

## What's in here

| Part | Path | Role |
|---|---|---|
| Manifest | `.claude-plugin/plugin.json` | Plugin name/version/metadata |
| Marketplace entry | `<repo-root>/.claude-plugin/marketplace.json` | Lets the `toon-protocol/hub` repo act as a marketplace (lists this plugin with `source: ./hub-plugin`). A GitHub-repo marketplace is discovered at the **repo root**, not in the plugin subdir. |
| Skill | `skills/hub-operator/SKILL.md` (+ `references/`, `evals/`) | Teaches lifecycle / nodes / fees / chains / earnings / telemetry |
| MCP server | `.mcp.json` | Declares the `hub` MCP server, run via `npx @toon-protocol/hub-mcp` |

The MCP server is published separately to npm as
[`@toon-protocol/hub-mcp`](https://www.npmjs.com/package/@toon-protocol/hub-mcp)
(bin `hub-mcp`); this plugin just declares it, so the plugin stays tiny and
the heavy code is versioned on npm. There is **no second daemon** — the apex
(connector + Fastify API, started by `hub up`) is the long-lived layer.

## Install

**Try it locally (no marketplace):**

```bash
claude --plugin-dir /path/to/town/hub-plugin
```

**Via marketplace (this repo doubles as one):**

```text
/plugin marketplace add toon-protocol/hub
/plugin install hub@toon
```

## Prerequisites

- Docker & Docker Compose (the apex + nodes run as containers).
- Node ≥ 20 (`npx` fetches `@toon-protocol/hub-mcp` on first run) and the
  `hub` CLI on PATH (or set `TOWNHOUSE_BIN`).
- An operator wallet seed via `TOWNHOUSE_MNEMONIC` (no password). On a cold start
  `hub_init` generates and returns one for you to custody.

Configure the MCP server via env (see the
[`@toon-protocol/hub-mcp` README](https://www.npmjs.com/package/@toon-protocol/hub-mcp)
for the full contract):

| Var | Default | Role |
|---|---|---|
| `TOWNHOUSE_API_URL` | `http://127.0.0.1:9400` | apex Fastify control API |
| `TOWNHOUSE_MNEMONIC` | — | operator wallet seed (no password) |
| `TOWNHOUSE_CONFIG_DIR` | `~/.hub` | config/wallet dir |
| `TOWNHOUSE_AUTOUP` | `1` | auto-`up` the apex on demand (`0` = explicit control) |
| `TOWNHOUSE_TRANSPORT_MODE` | `direct` | default boot transport (`direct` \| `hs`) |

## Tools (21)

Lifecycle: `hub_init`, `hub_up`, `hub_up_status`,
`hub_down`, `hub_status`.
Nodes: `hub_list_nodes`, `hub_add_node`, `hub_remove_node`,
`hub_set_node_fees`.
Chains/transport: `hub_chains`, `hub_transport`.
Earnings/$: `hub_balances`, `hub_earnings`, `hub_seed`,
`hub_withdraw`, `hub_credits`.
Telemetry: `hub_logs`, `hub_metrics`, `hub_channels`,
`hub_health`, `hub_version`.

Resources: `hub://status`, `hub://earnings`. Namespaced under the
plugin, e.g. the skill is invocable as `/hub:hub-operator`.

> **Note on schemas:** Claude Code's plugin/marketplace formats evolve; verify
> `plugin.json` / `marketplace.json` fields and the `/plugin` commands against
> the current docs (https://code.claude.com/docs) before publishing.
