---
name: townhouse-operator
description: Operate a TOON Protocol Townhouse (the apex + town/mill/dvm nodes)
  from a Claude agent via the townhouse_* MCP tools. Covers lifecycle ("start/
  boot my townhouse apex", "shut down my nodes", townhouse_init/up/up_status/
  down/status, direct vs hidden-service transport), node provisioning ("add or
  remove a town/mill/dvm node", townhouse_add_node/remove_node/list_nodes), fee
  tuning ("set my relay fee", townhouse_set_node_fees, feePerEvent/
  feeBasisPoints/feePerJob/kindPricing), settlement chains (townhouse_chains,
  townhouse_transport), earnings & money ("how much has my node earned?",
  "withdraw my earnings", "what are my balances?", townhouse_earnings/balances/
  withdraw/credits/seed), and observability ("are my nodes healthy?", "show node
  logs/metrics", "what channels are open?", townhouse_health/logs/metrics/
  channels/version). Use whenever the user wants to run, configure, monitor, or
  take earnings from a Townhouse operator node through the townhouse_* tools.
---

# Townhouse Operator (agent surface)

This skill lets a Claude agent act as a **Townhouse operator** — running the
revenue-earning side of TOON Protocol — through the `townhouse_*` MCP tools. A
**Townhouse** is an **apex** (the connector, nodeId `g.townhouse`) plus its
**child nodes**: a **town** (pay-per-event Nostr relay), a **mill** (multi-chain
swap peer), and a **dvm** (NIP-90 compute, e.g. Arweave blob storage). Clients
pay the apex over BTP; the apex validates their payment-channel claim, takes its
fee, and forwards to the child **for free** (settled in aggregate). The operator
earns the fees.

Composes with the operator runbook in `packages/townhouse/RUNBOOK.md` (recovery
playbooks) and `docs/architecture.md` (apex/child topology). For the *client*
side (publishing/reading/paying), see the separate `toon-client` skill.

## Mental model: the apex IS the long-lived layer

Unlike the client (which has a `toon-clientd` daemon), the operator has **no
second daemon**. The apex — the connector + a Fastify control API on
`127.0.0.1:9400`, started by `townhouse up` — IS the always-on layer. Each
`townhouse_*` tool maps to either:

- the **apex API** (live telemetry + money/topology: balances, earnings,
  add/remove node, withdraw, transport), or
- the **`townhouse` CLI** (lifecycle/config that must work *before* the apex is
  up: init, up, down, status, chains, credits, seed, logs, metrics, channels,
  health).

The MCP server **holds no chain keys** — the operator seed lives at the townhouse
layer (`TOWNHOUSE_MNEMONIC`), and the apex owns the wallet.

## First calls: status, then up

1. `townhouse_status` — apex / connector / node / transport snapshot. Prefers the
   live API; falls back to the CLI when the apex is down.
2. If the apex isn't running and `TOWNHOUSE_AUTOUP=1` (default), telemetry/money
   tools transparently kick off `up` and return a **"booting — retry"** result —
   poll `townhouse_up_status` and retry. Operators who want explicit control set
   `TOWNHOUSE_AUTOUP=0` (then a down apex yields `apex_not_running`).

`townhouse_health` probes apex / api / nodes / `.anyone` and returns the full
breakdown even when a probe is unhealthy (the underlying CLI exits non-zero but
still reports).

## Lifecycle

- `townhouse_init({ preset?, network? })` — create config. If `TOWNHOUSE_MNEMONIC`
  is set, it loads that seed; otherwise it **generates and returns a fresh
  operator mnemonic** for the agent to custody (cold start — back it up, it is
  shown once). With `TOWNHOUSE_MNEMONIC` set **and no password**, `init`
  scaffolds config only (no encrypted wallet; `walletMode:'mnemonic'`).
- `townhouse_up({ transport? })` — boot the apex. Returns a handle
  **immediately**; the boot itself takes minutes (image pulls, HS bootstrap, the
  ~20s town inbound-session warm-up). Poll `townhouse_up_status` for per-step
  NDJSON progress until a terminal `done`/`error`. `transport` is `direct`
  (default — clients dial `ws://host:3000/btp`) or `hs` (anonymous `.anon` hidden
  service). Do **not** hold a tool call open waiting for boot.
- `townhouse_down({ hs? })` — stop the stack (`hs:true` for a hidden-service apex).

Direct and HS stacks are port-mutually-exclusive; switching transports tears one
down before bringing the other up.

## Nodes

- `townhouse_list_nodes()` — provisioned nodes (id, type, ilpAddress, status).
- `townhouse_add_node({ type, relays?, turboToken? })` — provision a
  `town | mill | dvm` child (an atomic multi-step pipeline: derive keys →
  register child peer → tag the apex as parent → start). A child must be
  registered `relation:'child'` **and** tag the apex (`g.townhouse`) as its
  parent, or paid traffic is rejected (T00/F06) — the pipeline handles this; if a
  publish to the child is rejected, suspect this. **mill requires `relays`**
  (Nostr relay URLs) — pass them here (or set `nodes.mill.relays`/`MILL_RELAYS`);
  without any, add returns a `preflight` 400. **dvm** optionally takes
  `turboToken` (Arweave Turbo JWK) for larger uploads. Passing these in the call
  avoids the trap where env vars exported *after* the apex booted are never seen.
- `townhouse_remove_node({ id })` — deprovision by id.
- `townhouse_set_node_fees({ type, feePerEvent?, feeBasisPoints?, feePerJob?, kindPricing?, enabled? })`
  — tune fees (town `feePerEvent`, mill `feeBasisPoints`, dvm `feePerJob` +
  `kindPricing`) or toggle `enabled`. A fee change **restarts the connector**,
  which transiently drops routes (see RUNBOOK) — expect a brief blip.

> **Child fee = 0 for a free-forward apex.** The apex forwards parent→child
> packets without a per-packet claim, so the child's own fee should be 0; the
> apex's fee is what the operator earns. A non-zero town fee on a child apex
> double-charges and rejects.

## Settlement chains & transport

- `townhouse_chains({ op, args? })` — `list` (API), or `add`/`remove` (CLI, with
  passthrough flags in `args`, e.g. `--chain-type evm --chain-id 8453 ...`).
- `townhouse_transport({ set? })` — get transport status, or flip it
  (`set: 'direct' | 'hs'`).

## Earnings & money

- `townhouse_earnings()` — apex + per-peer earnings with today/month/year deltas.
- `townhouse_balances()` — EVM / Solana / Arweave balances per node.
- `townhouse_withdraw({ nodeType, chainFamily, token, recipient, amount, dryRun? })`
  — withdraw earnings to a recipient (EVM in v1). **Always run `dryRun:true`
  first** for a gas/fee estimate, confirm the recipient + amount with the user,
  then withdraw for real. This moves real on-chain funds and is irreversible.
- `townhouse_credits({ op, token?, amount?, quoteOnly? })` — buy (`op:'buy'`,
  on-chain; `quoteOnly:true` for a quote) or check (`op:'balance'`) Arweave upload
  credits used by the dvm.
- `townhouse_seed()` — reveal the operator mnemonic for backup. This is the
  **master key** to every node's funds — only surface it when the user explicitly
  asks to back up, and treat the output as a secret (never log it elsewhere).

## Observability

- `townhouse_logs({ service?, level?, maxLines? })` — bounded log tail. Prefers
  the live SSE stream, falls back to recent CLI history; the result's `source`
  field says which.
- `townhouse_metrics()` — connector metrics snapshot (live WS, CLI fallback;
  carries `source`).
- `townhouse_channels()` — open payment channels (nonce watermark + transferred).
- `townhouse_version()` — this MCP package version, the pinned `townhouse` range,
  and the detected CLI version; `satisfies:false`/`null` flags **version skew**
  (a too-old CLI) before a tool misbehaves — check this if tools act oddly.

Resources mirror the two cheap reads for clients that prefer resource fetches:
`townhouse://status` and `townhouse://earnings`.

## Failure & retry guidance

- **booting / apex unreachable** → not an error under `TOWNHOUSE_AUTOUP=1`; poll
  `townhouse_up_status` (and `~/.townhouse/up.log`) and retry. A boot can take
  minutes.
- **`node_lifecycle_in_flight` (409)** → another node op is running; wait and
  retry — do not fire a second add/remove concurrently.
- **CLI non-zero exit** → surface the stderr + failing command verbatim; don't
  silently retry a config mutation.
- **API typed errors** (`insufficient_balance`, `invalid_recipient`,
  `unknown_node_type`, …) → pass through with their status; fix the input rather
  than retrying.
- **a publish to a child is rejected (T00/F06)** → parent/child mis-tagging or a
  non-zero child fee — re-check `townhouse_list_nodes` relation/parent and the
  child fee.
- Never fabricate an address, balance, earnings figure, nonce, or txHash — read
  them from tool results.

## Social Context

Operating a Townhouse means running revenue infrastructure that clients pay real
(testnet or mainnet) value to use, and custodying the keys that hold those
earnings. That raises the stakes above a read-only dashboard:

- **The seed and withdrawals are real money.** `townhouse_seed` reveals the
  master key; `townhouse_withdraw` moves funds on-chain irreversibly. Confirm
  recipient + amount, dry-run withdrawals first, and treat the seed as a secret —
  surface it only on an explicit backup request.
- **Config changes affect a live, paying network.** A fee change or transport
  flip restarts the connector and briefly drops routes (RUNBOOK); a chain
  add/remove changes what clients can settle. Tell the user what a mutation will
  disrupt before you make it, and don't tune fees in a loop.
- **Boots and lifecycle ops take time — poll, don't block.** `up`/`hs up` run for
  minutes; return the handle and poll `townhouse_up_status` rather than holding a
  call open. Run one node lifecycle op at a time.
- **Report the operator's financial state faithfully.** Earnings, balances, and
  channel watermarks are the user's books — read them from the tools, never
  invent them, and flag anything that looks like unexpected spend or a stuck
  settlement (see the RUNBOOK's `IN_PROGRESS` wedge).
