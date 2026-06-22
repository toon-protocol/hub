# Hub Operator Runbook — Multi-Chain On-Chain Settlement

**Recovery procedures for the known failure modes when running a mill / town apex with on-chain settlement on Solana and Mina.**

This runbook is for an **operator** who has already booted an apex (`hub up` or `hs up`) and added a service node (`hub node add`), and is now running paid traffic that settles on-chain. Multi-chain settlement (Solana + Mina) works end-to-end, but it has a handful of operator-hostile sharp edges. Each section below gives you the **symptom you see**, **why it happens**, and the **concrete recovery steps**.

> If you are still trying to get the apex up at all, you want the [README](./README.md) and its Troubleshooting table first. This document covers what goes wrong *after* paid, settling traffic is flowing.

All host bindings in these procedures are on `127.0.0.1` only. The connector admin API is reachable at **`http://127.0.0.1:9401`** by default (constant `HS_CONNECTOR_ADMIN_URL`; `adminPort: 9401` in config). The apex's ILP node id is **`g.townhouse`**, and each child node routes under `g.townhouse.<type>` (e.g. `g.townhouse.town`).

---

## Quick-reference table

| Symptom | Likely cause | Jump to |
| --- | --- | --- |
| Paid client traffic to the town child starts rejecting (`T00` / `F06`) right after the connector/apex container restarted | Connector restart wiped the in-memory child route | [§1 Connector restart wipes the child route](#1-connector-restart-wipes-the-child-route) |
| A "fresh" restart still rejects a replayed/re-issued claim as non-advancing | Nonce watermark persisted in SQLite + memory; restart does **not** reset it | [§2 Nonce watermark survives restart](#2-nonce-watermark-survives-restart) |
| Claims keep arriving and FULFILL, but settlements stop landing on-chain | SettlementMonitor wedged at `IN_PROGRESS` after a non-retryable abort | [§3 SettlementMonitor wedged at IN_PROGRESS](#3-settlementmonitor-wedged-at-in_progress) |
| The **first** publish right after `/health` goes green returns 503 / reject | Town inbound BTP session not yet authenticated; `/health` ≠ link up | [§4 Town inbound BTP session auth race](#4-town-inbound-btp-session-auth-race) |
| After redeploying a Mina channel zkApp, settlement nonce expectations are off | Mina zkApp `nonceField` reset to 0 on redeploy vs. connector's persisted watermark | [§5 Mina reset gotcha — bare-zkApp precondition](#5-mina-reset-gotcha--bare-zkapp-precondition) |

---

## 1. Connector restart wipes the child route

### Symptom

You restart the connector/apex container (`docker restart …connector`, an image swap, a host reboot, etc.). The connector comes back healthy, but **paid client traffic to your town child now gets rejected** with a `T00`-class error (often surfaced to the client as `T00 No payment channel available for peer`) or an `F06`-class routing rejection. Reads still work; mill traffic may recover on its own (see note below); only the town child is dead.

### Why it happens

A child node's route and peer relation are **dynamic connector state held in memory**, not persisted into the connector's static `connector.yaml` (which ships `peers: []`). `hub node add` registers the child at runtime via the connector admin API. When the connector process restarts, that runtime registration is gone. Until the child is re-registered:

- The connector has **no route** for `g.townhouse.town`, so it cannot forward the client's PREPARE to the town container.
- Even if a route existed, the peer would default to relation `'peer'` (not `'child'`), so the connector's `requiresSettlementClaim()` would return `true` and demand a per-packet settlement claim on the parent→child hop — which the apex never attaches (parent→child is free, settled in aggregate). That is the `T00` you see.

Two things must both be true for paid traffic to reach the child:

1. The child is registered with **`relation: 'child'`** (so the parent→child hop is free), **and**
2. The child container tags the apex node id `g.townhouse` as its parent (`TOON_PARENT_PEER_ID` in the compose template) so the child applies the parent relation on its side.

Get either wrong and paid traffic to the child is rejected.

### Recovery

**Preferred (let hub re-converge):** re-run `hub hs up`. It now performs a two-stage auto-rebind from `~/.hub/nodes.yaml` (the source of truth):

1. **Boot rebinder** (`src/rebind.ts`) — for each recorded child it rebuilds the full container env from the wallet + `config.yaml` (including persisted mill `relays` / dvm `turboToken`) and (re)starts the container via `startNodeViaCompose`. This handles the case where `hs down` removed the child containers, and also picks up config edits (change `nodes.mill.relays`, `hs up`, the mill is recreated). `startNodeViaCompose` is idempotent — an unchanged, already-running child is a no-op.
2. **Boot reconciler** (`src/reconciler.ts`) — diffs `nodes.yaml` against the connector's live `GET /admin/peers` roster and re-registers any missing child with exactly the right shape:

```jsonc
// what the reconciler POSTs to /admin/peers per missing child:
{
  "id": "town",                                  // matches nodes.yaml peerId
  "url": "ws://hub-…-town:3000",           // child's internal BTP URL
  "authToken": "",                               // internal peers: no auth
  "routes": [{ "prefix": "g.townhouse.town", "priority": 0 }],
  "relation": "child",                           // <- makes parent->child FREE
  "transport": "direct"                          // <- bypass SOCKS5 for Docker-internal hostname
}
```

(Source: `packages/hub/src/reconciler.ts` and `packages/hub/src/api/routes/nodes-lifecycle.ts` step 6 `register-peer`.)

**Manual recovery (two connector-admin POSTs).** If you need to re-add the route by hand against a running connector — e.g. after a bare `docker restart` where the reconciler did not run — register the route and the child peer directly against the admin API on `:9401`:

```bash
# 1. Register the ILP route for the child prefix -> the child peer.
curl -fsS -X POST http://127.0.0.1:9401/admin/routes \
  -H 'content-type: application/json' \
  -d '{"prefix":"g.townhouse.town","nextHop":"town","priority":0}'

# 2. Register the child peer with relation=child so the parent->child hop is free.
curl -fsS -X POST http://127.0.0.1:9401/admin/peers \
  -H 'content-type: application/json' \
  -d '{"id":"town","url":"ws://town-inbound-only.invalid:3000","relation":"child","authToken":""}'
```

> **Confirm against your connector version.** The hub `ConnectorAdminClient.registerPeer()` registers the route *through* `POST /admin/peers` (its `routes` field) rather than a separate `/admin/routes` call. The standalone `POST /admin/routes {prefix, nextHop, priority}` shape above is the lower-level connector admin form captured from live recovery runs against connector 3.10.x. If your connector rejects the separate `/admin/routes` call, fold the route into the `/admin/peers` body instead:
>
> ```bash
> curl -fsS -X POST http://127.0.0.1:9401/admin/peers \
>   -H 'content-type: application/json' \
>   -d '{"id":"town","url":"ws://town-inbound-only.invalid:3000","relation":"child","authToken":"","routes":[{"prefix":"g.townhouse.town","priority":0}],"transport":"direct"}'
> ```
>
> The `url` for an inbound-only child can be a sentinel (`ws://…invalid:3000`) — the town child dials the apex, so the apex never needs to dial back out; the forward rides the town's existing inbound session. The load-bearing parts are `relation:'child'`, the `g.townhouse.town` route prefix, and (in HS/SOCKS5 mode) `transport:'direct'`.

After re-registering, verify the route is live before declaring victory — see [§4](#4-town-inbound-btp-session-auth-race) for the inbound-session race that can make the *first* publish fail even once the route exists.

> **Mill children usually self-recover.** A mill's connector dials its parent (the apex) on an **outbound** BTP session and retries that dial in the background, so after a connector restart the mill re-establishes its link without operator action (`packages/mill/src/mill.ts` — "the BTP peer dial retries in the background"). The **town** child is the one that needs manual re-registration, because the connector restart drops the route the apex uses to reach it.

---

## 2. Nonce watermark survives restart

### Symptom

You restart the connector expecting channel/settlement state to "reset," then replay or re-issue a payment-channel claim at a nonce you've used before. The connector **rejects it as non-advancing** (the claim's nonce is at or below the stored watermark). A bare `docker restart` does **not** clear this.

### Why it happens

This is **by design** — monotonic nonce enforcement is the anti-replay guarantee of an off-chain payment channel. The connector tracks the highest consumed nonce per channel as a **watermark**, and it persists that watermark in **two places**:

- The connector's SQLite claims store (e.g. `/app/data/received-claims-g.townhouse.db`, `received_claims` table), which lives on the container's writable layer and therefore **survives `docker restart`**, and
- the connector's **in-memory** state for the running peer.

So a restart neither clears the DB row nor (for a volume-preserving teardown) the on-disk file. The watermark is sticky on purpose.

### Operator implication and reset

- **Do not expect a restart to reset channel state.** Re-using a consumed nonce will always be rejected. Normal operation is fine — the client advances the nonce on every claim — this only bites you when you try to replay or to "start over" on the same channel.
- **To genuinely reset**, you must clear the connector's claims DB for that chain/channel *and* drop the in-memory state (restart after clearing), or use a **fresh channel** (new on-chain deposit / new channel id). For example, to reset a Mina channel's watermark you clear the persisted row **and** restart so the in-memory copy is rebuilt:

  ```bash
  # Clear the persisted watermark for one chain, then restart so memory is rebuilt.
  docker exec <connector-container> \
    sqlite3 /app/data/received-claims-g.townhouse.db \
    "DELETE FROM received_claims WHERE blockchain='mina';"
  docker restart <connector-container>
  ```

  Clearing only the DB (without the restart) leaves the in-memory watermark in place; restarting only (without clearing the DB) reloads the old watermark. You need **both**.

> **Confirm against your connector version.** The DB path (`/app/data/received-claims-g.townhouse.db`), table name (`received_claims`), and the `blockchain` column value (`'mina'`, `'solana'`, `'evm'`) are the connector's schema, observed on connector 3.10.x. Verify them on your image before running destructive SQL — a fresh container with no data volume already starts with a clean claims DB, so swapping to a fresh container is the safest reset of all.

---

## 3. SettlementMonitor wedged at IN_PROGRESS

### Symptom

Claims keep arriving and the connector keeps returning FULFILL (publishes succeed from the client's point of view), but **on-chain settlements stop landing**. The on-chain channel state (e.g. Mina `nonceField`, the Solana channel balance) stops advancing even though paid traffic continues. There is no loud error — settlement just goes quiet for that channel.

### Why it happens

The connector's **SettlementMonitor** drives the on-chain settlement of accumulated claims (the `claimFromChannel` / settle transaction). On a **non-retryable abort** during a settlement attempt, the monitor does **not** reset its state machine back to `IDLE` — it stays stuck at `IN_PROGRESS` (a peer/channel state of `SETTLEMENT_IN_PROGRESS`). While wedged in that state it treats the channel as "a settlement is already running" and **silently skips** further settlement events for that channel. Claims still validate and FULFILL at the ILP layer (that path is independent), which is why publishes keep succeeding while nothing lands on-chain.

This is a connector-side robustness gap (the monitor lacks an automatic transition out of `IN_PROGRESS` on a non-retryable failure), not a hub-side bug. The state lives entirely inside the connector process.

### Recovery

The operator-level mitigation is to **re-arm the monitor by restarting the connector**, then re-establish the route:

1. Restart the connector container so the SettlementMonitor re-initializes its state machine from a clean `IDLE` and re-reads channel state:

   ```bash
   docker restart <connector-container>
   ```

2. **Re-add the child route**, because the restart wiped it — follow [§1](#1-connector-restart-wipes-the-child-route). This is the catch: the very restart that un-wedges the monitor also drops the town route, so the two recoveries are coupled. Do §1 immediately after the restart or your town child will reject paid traffic.

3. Watch the connector logs for the next settlement to land (e.g. `Settlement completed`, and for Mina the on-chain `nonceField` advancing). If settlements resume, the wedge cleared.

> Because the underlying abort was non-retryable, also investigate *why* the original settlement aborted (insufficient gas/fee on the settlement chain, a stale channel, an on-chain precondition mismatch — for Mina see [§5](#5-mina-reset-gotcha--bare-zkapp-precondition)). A restart un-wedges the monitor, but if the root cause persists the next settlement may abort and re-wedge it.

---

## 4. Town inbound BTP session auth race

### Symptom

You add or boot a town child, wait for its `/health` to report ready, then immediately send the first paid publish — and it returns **503 / reject**. The *second* attempt a few seconds later succeeds. It looks like a flaky first packet.

### Why it happens

The town child's **inbound BTP session authenticates with the apex roughly 20 seconds AFTER** the town's `/health` endpoint reports green. `/health` readiness means the town's HTTP server and relay are up — it does **not** mean the BTP link between the apex connector and the town has authenticated. The apex can only forward a paid PREPARE to the town once that inbound session is live; a publish issued in the gap races an un-authenticated link and is rejected.

In other words: **`/health` green ≠ BTP link authenticated.** A blind `sleep` after health is a coin-flip, and was the actual root cause behind an intermittent "first publish 503" that looked like a transport regression but was a pure timing race.

### Operator / automation guidance

- **Do not** gate the first paid packet on `/health` alone, and **do not** rely on a fixed `sleep`.
- **Do** wait for the connector log line that confirms the town's inbound session has authenticated — the connector emits a `btp_auth` (inbound session authenticated) event for the town peer. Poll the connector logs for that signal before sending the first paid packet:

  ```bash
  # Wait until the connector reports the town's inbound BTP session authenticated.
  until docker logs <connector-container> 2>&1 | grep -q 'btp_auth.*town'; do
    sleep 2
  done
  # now it is safe to send the first paid publish to g.townhouse.town
  ```

  (Match the exact log shape your connector version emits — the signal you want is "the **town** peer's **inbound** BTP session **authenticated**.")

- This race is specific to children that the apex reaches over the child's **inbound** session (the town). It interacts with [§1](#1-connector-restart-wipes-the-child-route): after re-registering the route post-restart, you still have to wait for the inbound session to re-authenticate before the first publish will land.

---

## 5. Mina reset gotcha — bare-zkApp precondition

### Symptom

You reset or redeploy a Mina payment-channel zkApp (e.g. to start a channel over), and afterwards the connector's settlement expectations don't line up with the on-chain channel — settlements that should advance behave as if the nonce is wrong.

### Why it happens

When the Mina payment-channel zkApp is freshly (re)deployed, the account-update **precondition is the bare-zkApp form**: the channel's on-chain `nonceField` starts at **0**, and it advances to **1** on the first on-chain `claimFromChannel`. A redeploy therefore **resets `nonceField` to 0**.

The operator-visible problem is the interaction with [§2](#2-nonce-watermark-survives-restart): the connector's **off-chain nonce watermark persists** across restarts, but a Mina **redeploy resets the on-chain nonce to 0**. If you redeploy the zkApp without also clearing the connector's persisted Mina watermark, the connector still believes it has consumed higher nonces, and the two halves disagree.

### Operator implication

- A Mina zkApp **redeploy resets `nonceField` to 0**; the first successful on-chain claim moves it `0 → 1`. That `0 → 1` transition is the signal a Mina-settled publish actually landed on-chain.
- If you redeploy the channel zkApp, you almost always also need to **clear the connector's persisted Mina claim watermark** (see [§2](#2-nonce-watermark-survives-restart): `DELETE FROM received_claims WHERE blockchain='mina'` **and** restart), so the connector's off-chain watermark and the on-chain `nonceField` both start from a clean baseline. Resetting one without the other leaves them inconsistent.
- A stale, partially-open zkApp can also cause the **client** to skip channel initialization (idempotency), so a genuine reset means the zkApp is bare (`channelState = 0`) at the start of the run, not merely redeployed over a previous channel.
- **The zkApp must be deployed BARE, not deployer-initialized.** A zkApp deployed *with* init writes `channelHash = Poseidon(deployer, deployer, 0)`, which the connector's `claimFromChannel` (`Poseidon(apex, client, 0)`) can never reproduce — settlement fails with "Supplied participant keys do not match the on-chain channelHash". Deploy bare (`MINA_SKIP_INIT=1`) so the **client**'s `openMinaChannel` writes the correct `(client, apex)` channelHash on-chain. For the public-testnet E2E this is reproducible via `node scripts/deploy-e2e-mina-zkapp-bare.mjs` (dedicated zkApp index, default 98; rewrites `e2e/testnets.json` `mina.zkAppAddress`). See [`docs/e2e-testnets.md`](../../docs/e2e-testnets.md) and issue #185.

> **Confirm against your connector / circuit version.** The `nonceField 0 → 1` behavior and the bare-zkApp precondition are observed on the proven Mina settle path (connector **3.10.3**, the pinned `DEFAULT_CONNECTOR_IMAGE`). The exact ledger/zkApp reset procedure for your devnet or mainnet deployment is environment-specific — verify the on-chain channel is genuinely bare before relying on the `0 → 1` signal.

---

## Appendix — the coupling you must remember

These failure modes are not independent. The one that bites operators repeatedly is this chain:

1. A settlement aborts and wedges the SettlementMonitor at `IN_PROGRESS` ([§3](#3-settlementmonitor-wedged-at-in_progress)).
2. You restart the connector to un-wedge it — **but that restart also wipes the town child route** ([§1](#1-connector-restart-wipes-the-child-route)) and reloads the persisted nonce watermark ([§2](#2-nonce-watermark-survives-restart)).
3. So after the restart you must **re-add the route** (§1), and only then **wait for the town's inbound BTP session to re-authenticate** ([§4](#4-town-inbound-btp-session-auth-race)) before the first paid publish will land.

A clean recovery is therefore: **restart connector → re-register town child (route + `relation:'child'`) → wait for `btp_auth` on the town peer → send a probe publish → confirm on-chain settlement advances** (for Mina, `nonceField` increments).

---

For all other (non-settlement) operational issues — boot failures, port conflicts, wallet/password problems — see the [README Troubleshooting table](./README.md#troubleshooting). For verbose logs on any failure, re-run the failing command with `DEBUG=hub:*`.
