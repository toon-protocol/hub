/**
 * Earnings aggregator (Story D4).
 *
 * Pulls real per-source earnings from the four data paths the operator cares
 * about: relay, mill, dvm, connector. The aggregator is a pure(ish) function
 * over `connectorAdmin` + `orchestrator` + an optional `leasesPath`; the
 * route handler `/api/earnings` is a thin wrapper.
 *
 * ## Source-by-source honesty notes
 *
 * - **relay** (town): real. The connector packet log records every paid
 *   `kind:1`/event publish that flows through the connector, attributed to
 *   the town peer's ILP address. `amount` is the ILP unit (interpreted as
 *   sats for v1 — TOON's pricing scale matches BTC sats, see
 *   `_bmad-output/planning-artifacts/research/party-mode-prepaid-protocol-decisions-2026-03-20.md`).
 *
 * - **mill**: partially real. The connector packet log has the swap-fee
 *   ILP volume going through the mill peer. The `SettlementEvent` type
 *   landed in D3 but the live emission path on the mill side is not yet
 *   wired (see `packages/mill/src/settlement-event.ts` module doc and the
 *   D3 agent's note in the build sheet). Until that lands, the `items`
 *   array will not contain `txHash` / `explorerUrl` for mill rows — they
 *   render as plain "settlement attributed via ILP packet log" entries.
 *   When live emission ships, this aggregator will read the mill's
 *   settlement-event log and merge it into the items array. Search for
 *   `TODO(D4-mill-settlement)` to find the wiring point.
 *
 * - **dvm**: real. Same connector-packet-log basis as relay. The DVM peer
 *   ILP address attributes job-payment packets.
 *
 * - **connector**: zero-by-design. The standalone connector v1 does not
 *   take a routing fee — it only forwards packets between child peers
 *   that are all owned by the same operator. The connector source is
 *   surfaced in the response shape (AC-D4-1 requires it), but its sats
 *   total is always "0" and items array always empty until the
 *   per-hop-fee feature ships. Search for `TODO(D4-connector-fees)`.
 *
 * @module
 * @since D4
 */

import type { ConnectorAdminClient } from '../connector/index.js';
import type { DockerOrchestrator } from '../docker/orchestrator.js';
import type { PacketLogEntry } from '../connector/types.js';
import type { SettlementChain } from '@toon-protocol/mill';

import {
  buildExplorerUrl,
  loadLeases,
  type AkashLeasesForExplorer,
} from './explorer-links.js';

/**
 * One of the four canonical earnings sources surfaced by `/api/earnings`.
 * `'connector'` is included for shape-completeness even though v1 always
 * reports zero (see module doc).
 */
export type EarningsSource = 'relay' | 'mill' | 'dvm' | 'connector';

/**
 * Per-asset bucket. `amount` is a BigInt-safe decimal string in raw
 * micro-units (matches the rest of the townhouse API surface — see
 * `WalletBalanceEntry.balance`). `decimals` and `symbol` give the dashboard
 * what it needs to format without re-deriving from a registry.
 *
 * For v1 the `'sats'` ILP unit is the only asset in `tokens` for relay /
 * mill / dvm / connector — token-denominated settlement events on EVM /
 * Solana arrive on a separate path (see {@link EarningsItem}). When mill's
 * live SettlementEvent emission ships, we'll start populating per-token
 * buckets keyed by `${chain}:${symbol}`.
 */
export interface AssetBucket {
  /** BigInt-safe decimal string in raw micro-units. */
  amount: string;
  /** Decimal places (e.g. 0 for sats, 6 for USDC, 18 for ETH). */
  decimals: number;
  /** Short asset code rendered in the dashboard (e.g. 'sats', 'USDC'). */
  symbol: string;
  /** Optional chain hint (e.g. 'evm', 'solana') for cross-chain disambiguation. */
  chain?: string;
}

export interface PerSourceTotals {
  /** Sats accumulated through the ILP packet log, BigInt-safe decimal string. */
  sats: string;
  /** Per-token totals from on-chain settlement events (keyed by `${chain}:${symbol}` or just `symbol`). */
  tokens: Record<string, AssetBucket>;
}

export interface EarningsItem {
  /** ISO8601 timestamp of the event. */
  ts: string;
  source: EarningsSource;
  /** Asset descriptor for amount interpretation. */
  asset: { symbol: string; decimals: number; chain?: string };
  /** BigInt-safe decimal string in raw micro-units. */
  amount: string;
  /** On-chain transaction hash, present only for chain-settled rows. */
  txHash?: string;
  /** Block-explorer URL — present iff `txHash` is set AND a lease URL resolves. */
  explorerUrl?: string;
}

export interface EarningsPayload {
  /** ISO8601 — the lower bound of the aggregation window. */
  since: string;
  totals: {
    /** Sum of all `by_source.*.sats` as a BigInt-safe decimal string. */
    sats: string;
    /** Sum of all `by_source.*.tokens` keyed identically. */
    tokens: Record<string, AssetBucket>;
  };
  by_source: Record<EarningsSource, PerSourceTotals>;
  /** Recent items for the breakdown drilldown. Capped at `MAX_ITEMS`. */
  items: EarningsItem[];
}

/** Cap on the items array — keeps response size bounded under heavy load. */
export const MAX_ITEMS = 200;

/** Default aggregation window when caller doesn't pass `?since=`. */
export const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Inputs the aggregator needs. Concrete deps (connector, orchestrator) are
 * read from `ApiDeps` in the route layer — this struct is what the route
 * passes through.
 */
export interface AggregateEarningsInput {
  connectorAdmin: ConnectorAdminClient;
  orchestrator: DockerOrchestrator;
  /** Absolute path to leases.json. `null` skips lease loading entirely. */
  leasesPath: string | null;
  /** ms-epoch lower bound. Defaults to `Date.now() - DEFAULT_SINCE_MS`. */
  sinceMs?: number;
}

interface PeerByType {
  /** ILP address of the town peer (if any) */
  town?: string;
  /** ILP address of the mill peer (if any) */
  mill?: string;
  /** ILP address of the dvm peer (if any) */
  dvm?: string;
}

/** Map a peer.id like 'townhouse-dev-mill-01' to its NodeType, or null. */
function peerIdToNodeType(id: string, type?: string): EarningsSource | null {
  // Prefer the orchestrator-supplied `type` when available — it's the
  // ground truth. Container-name parsing is the fallback for peer-only
  // discovery (orchestrator status omits short-lived peers).
  if (type === 'town' || type === 'mill' || type === 'dvm') return type;
  if (id.includes('town')) return 'relay';
  if (id.includes('mill')) return 'mill';
  if (id.includes('dvm')) return 'dvm';
  return null;
}

/**
 * Resolve which connector peer ILP addresses correspond to which node type.
 * Cross-references peers against the orchestrator's status snapshot for
 * type attribution, falling back to container-name heuristics for peers
 * the orchestrator doesn't report.
 */
async function resolvePeerIlpAddresses(
  connectorAdmin: ConnectorAdminClient,
  orchestrator: DockerOrchestrator
): Promise<PeerByType> {
  let peers: { id: string; ilpAddresses: string[] }[];
  try {
    peers = await connectorAdmin.getPeers();
  } catch {
    return {};
  }

  let statusByName = new Map<string, string>();
  try {
    const statuses = await orchestrator.status();
    statusByName = new Map(
      statuses.map((s: { name: string; type: string }) => [s.name, s.type])
    );
  } catch {
    /* orchestrator unreachable — fall through to name heuristics */
  }

  const result: PeerByType = {};
  for (const peer of peers) {
    const ilp = peer.ilpAddresses[0];
    if (!ilp) continue;
    const orchestratorType = statusByName.get(peer.id);
    const source = peerIdToNodeType(peer.id, orchestratorType);
    if (source === 'relay' || source === 'town') result.town ??= ilp;
    else if (source === 'mill') result.mill ??= ilp;
    else if (source === 'dvm') result.dvm ??= ilp;
  }
  return result;
}

/**
 * Compute the source totals from a slice of the connector packet log.
 * Each fulfilled packet's `amount` is treated as sats (the v1 ILP unit).
 * Rejected/timed-out packets do NOT count toward earnings — the operator
 * was paid only for fulfilled forwards.
 */
function packetsToBucket(packets: PacketLogEntry[]): {
  sats: bigint;
  count: number;
} {
  let sats = 0n;
  let count = 0;
  for (const p of packets) {
    if (p.result !== 'fulfill') continue;
    try {
      sats += BigInt(p.amount ?? 0);
      count += 1;
    } catch {
      /* malformed amount — skip, don't crash */
    }
  }
  return { sats, count };
}

/** Convert a packet log entry into an item the dashboard can render. */
function packetToItem(
  source: EarningsSource,
  packet: PacketLogEntry
): EarningsItem {
  return {
    ts: new Date(packet.ts).toISOString(),
    source,
    asset: { symbol: 'sats', decimals: 0 },
    amount: String(packet.amount ?? '0'),
    // ILP-layer rows have no on-chain txHash — only mill SettlementEvent
    // rows do, and those don't flow through this path yet.
  };
}

/** Build an empty per-source bucket. */
function emptyBucket(): PerSourceTotals {
  return { sats: '0', tokens: {} };
}

/**
 * Pull per-peer earnings from the connector packet log for one peer ILP
 * address. Returns the bucket + items. Tolerates connector errors by
 * returning empty results.
 */
async function fetchPacketLogForPeer(
  connectorAdmin: ConnectorAdminClient,
  ilpAddress: string,
  sinceMs: number
): Promise<{ bucket: PerSourceTotals; packets: PacketLogEntry[] }> {
  try {
    const packets = await connectorAdmin.getPacketLog({
      ilpAddress,
      since: sinceMs,
      limit: 10_000,
    });
    const { sats } = packetsToBucket(packets);
    return {
      bucket: { sats: sats.toString(), tokens: {} },
      packets,
    };
  } catch {
    return { bucket: emptyBucket(), packets: [] };
  }
}

/**
 * The main aggregator. Stitches together the four sources into the response
 * shape contracted by AC-D4-1.
 *
 * Failure mode philosophy: every source is independently try/catch'd so
 * that one source going down doesn't blank the whole panel. A connector
 * outage zeros relay/mill/dvm; a missing leases.json zeros explorerUrl on
 * items but keeps the rest intact.
 */
export async function aggregateEarnings(
  input: AggregateEarningsInput
): Promise<EarningsPayload> {
  const sinceMs = input.sinceMs ?? Date.now() - DEFAULT_SINCE_MS;
  const since = new Date(sinceMs).toISOString();

  const leases: AkashLeasesForExplorer | null = loadLeases(input.leasesPath);

  // Resolve ILP peer addresses by node type.
  const peerIlp = await resolvePeerIlpAddresses(
    input.connectorAdmin,
    input.orchestrator
  );

  // Per-source packet-log fetches.
  const items: EarningsItem[] = [];

  let relayBucket = emptyBucket();
  if (peerIlp.town) {
    const { bucket, packets } = await fetchPacketLogForPeer(
      input.connectorAdmin,
      peerIlp.town,
      sinceMs
    );
    relayBucket = bucket;
    for (const p of packets) {
      if (p.result === 'fulfill') items.push(packetToItem('relay', p));
    }
  }

  let millBucket = emptyBucket();
  if (peerIlp.mill) {
    const { bucket, packets } = await fetchPacketLogForPeer(
      input.connectorAdmin,
      peerIlp.mill,
      sinceMs
    );
    millBucket = bucket;
    for (const p of packets) {
      if (p.result === 'fulfill') items.push(packetToItem('mill', p));
    }
    // TODO(D4-mill-settlement): when mill emits live SettlementEvents
    // (D3 type is locked, live wiring is downstream — see settlement-event.ts
    // module doc), read them here and merge into items with txHash +
    // explorerUrl populated. For now, leases is loaded but unused on the
    // mill path; reference it to keep TS happy and document the wiring.
    void leases;
  }

  let dvmBucket = emptyBucket();
  if (peerIlp.dvm) {
    const { bucket, packets } = await fetchPacketLogForPeer(
      input.connectorAdmin,
      peerIlp.dvm,
      sinceMs
    );
    dvmBucket = bucket;
    for (const p of packets) {
      if (p.result === 'fulfill') items.push(packetToItem('dvm', p));
    }
  }

  // TODO(D4-connector-fees): the v1 connector does not collect routing fees —
  // it forwards between child peers all owned by the same operator. When a
  // routing-fee feature ships (or when a /admin/settlement endpoint exposes
  // per-peer settle deltas), populate this bucket. We surface the source
  // for shape-completeness so the dashboard layout is stable.
  const connectorBucket = emptyBucket();

  // Sort items newest-first and cap. The connector returns packets in
  // insertion order, which we don't fully trust to be timestamp-sorted
  // across multiple peers, so re-sort.
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;

  // Annotate items with explorer URLs only when txHash + chain present
  // (currently never, but the loop is here for D4-mill-settlement).
  for (const item of items) {
    const chain = (item as { chain?: SettlementChain }).chain;
    if (item.txHash && chain) {
      const url = buildExplorerUrl(chain, item.txHash, leases);
      if (url) item.explorerUrl = url;
    }
  }

  // Totals — sum sats across all sources. BigInt sum to avoid precision loss
  // on long-running operators.
  const totalSats =
    BigInt(relayBucket.sats) +
    BigInt(millBucket.sats) +
    BigInt(dvmBucket.sats) +
    BigInt(connectorBucket.sats);

  return {
    since,
    totals: { sats: totalSats.toString(), tokens: {} },
    by_source: {
      relay: relayBucket,
      mill: millBucket,
      dvm: dvmBucket,
      connector: connectorBucket,
    },
    items,
  };
}
