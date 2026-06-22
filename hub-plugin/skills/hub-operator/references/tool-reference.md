# hub-* MCP tool reference

Each MCP tool maps to either the apex Fastify control API (`127.0.0.1:9400`,
started by `hub up`) or the `hub` CLI. The MCP server holds no chain
keys — the apex owns the wallet and the operator seed lives at the hub
layer (`TOWNHOUSE_MNEMONIC`). There is **no separate daemon**: the apex is the
long-lived layer.

| MCP tool | Backing | Arguments | Returns / notes |
|---|---|---|---|
| `hub_init` | CLI `init` | `{ preset?, network? }` | `{ created, configPath, walletPath?, mnemonic?, addresses }` — cold start returns the generated `mnemonic`; mnemonic-mode returns `{ walletMode:'mnemonic' }` (no wallet written). |
| `hub_up` | CLI `up` (detached) | `{ transport? }` (`direct`\|`hs`) | `{ started, pid, transport, poll:'hub_up_status' }` — returns immediately. |
| `hub_up_status` | reads `up.log` job record | — | `{ events[], done, failed }` — per-step NDJSON boot progress. |
| `hub_down` | CLI `down` / `hs down` | `{ hs? }` | `{ stopped, nodes }`. |
| `hub_status` | API `/api/nodes`+`/api/transport`, CLI fallback | — | `{ source:'api'\|'cli', nodes, transport, … }`. |
| `hub_list_nodes` | API `GET /api/nodes` | — | `{ nodes:[…] }` (id, type, ilpAddress, status). |
| `hub_add_node` | API `POST /api/nodes` | `{ type }` (`town`\|`mill`\|`dvm`); mill also takes `relays` (string[], **required** unless in config/`MILL_RELAYS` env); dvm optionally `turboToken` (Arweave JWK string). | atomic provision pipeline result. Pass `relays`/`turboToken` here rather than exporting env before the apex started. |
| `hub_remove_node` | API `DELETE /api/nodes/:id` | `{ id }` | deprovision result. |
| `hub_set_node_fees` | API `PATCH /nodes/:type/config` | `{ type, feePerEvent?, feeBasisPoints?, feePerJob?, kindPricing?, enabled? }` | restarts the connector (brief route drop). |
| `hub_chains` | API `list` / CLI `add`,`remove` | `{ op, args? }` | `op:'list'` reads API; `add`/`remove` pass `args` to the CLI. |
| `hub_transport` | API `/api/transport` | `{ set? }` (`direct`\|`hs`) | get status, or flip transport. |
| `hub_balances` | API `GET /wallet/balances` | — | EVM / Solana / Arweave balances per node. |
| `hub_earnings` | API `GET /api/earnings` | — | apex + per-peer earnings with today/month/year deltas. |
| `hub_seed` | CLI `wallet seed --confirm` | — | `{ mnemonic }` — the master key; secret. |
| `hub_withdraw` | API `POST /wallet/withdraw` | `{ nodeType, chainFamily, token, recipient, amount, dryRun? }` | `dryRun:true` = gas/fee estimate, no broadcast. |
| `hub_credits` | CLI `credits buy`/`balance` | `{ op, token?, amount?, quoteOnly? }` | buy (on-chain) or check Arweave upload credits. |
| `hub_logs` | SSE `/api/logs/stream`, CLI fallback | `{ service?, level?, maxLines? }` | `{ source:'sse'\|'cli', count, events }`. |
| `hub_metrics` | WS `/metrics`, CLI fallback | — | `{ source:'ws'\|'cli', packetsForwarded, packetsRejected, bytesSent, … }`. |
| `hub_channels` | CLI `channels` | — | open payment channels (nonce watermark + transferred). |
| `hub_health` | CLI `health` (lenient) | — | apex / api / nodes / `.anyone` breakdown (reported even when unhealthy). |
| `hub_version` | CLI `version` + package pin | — | `{ mcpVersion, expectedHubRange, detectedCliVersion, satisfies, note }`. |

## Resources

| URI | Mirrors | Body |
|---|---|---|
| `hub://status` | `hub_status` | apex/connector/node/transport snapshot (JSON) |
| `hub://earnings` | `hub_earnings` | apex + per-peer earnings with deltas (JSON) |

## Environment contract

| Var | Default | Role |
|---|---|---|
| `TOWNHOUSE_API_URL` | `http://127.0.0.1:9400` | apex Fastify control API base URL |
| `TOWNHOUSE_MNEMONIC` | — | operator wallet seed; loaded directly, no password. On cold start `hub_init` generates + returns one. |
| `TOWNHOUSE_CONFIG_DIR` | `~/.hub` | where `init`/`up` read & write config |
| `TOWNHOUSE_AUTOUP` | `1` | auto-`up` the apex on demand with a "booting — retry" response; `0` = explicit control (`apex_not_running`) |
| `TOWNHOUSE_TRANSPORT_MODE` | `direct` | default boot transport (`direct` \| `hs`) |
| `TOWNHOUSE_BIN` | `hub` | path/override for the `hub` CLI |

## Boot & auto-up semantics

`hub_up` spawns the boot detached and returns a handle; the boot takes
minutes (image pulls, HS bootstrap, the ~20s town inbound-session warm-up). Poll
`hub_up_status` until a terminal `done`/`error`. When a telemetry/money
tool needs a live apex and `:9400` is unreachable, with `TOWNHOUSE_AUTOUP=1` the
server kicks off `up` and returns a `booting` result the agent retries against;
with `0` it returns `apex_not_running`. Telemetry tools fall back to the CLI when
the API is unreachable.

## Money safety

`hub_withdraw` moves real on-chain funds — run `dryRun:true` first and
confirm recipient + amount. `hub_seed` reveals the master mnemonic for
every node's funds — surface only on an explicit backup request. `hub_set_node_fees`
and a transport flip restart the connector and briefly drop routes (see
`packages/hub/RUNBOOK.md`).
