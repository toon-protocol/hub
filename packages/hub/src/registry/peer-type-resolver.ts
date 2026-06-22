/**
 * `PeerTypeResolver` (Story 46.1).
 *
 * The connector is a generic ILP router — it has no concept of
 * `'town' | 'mill' | 'dvm'`. Hub owns the type concept entirely
 * via this resolver, which is the single translation layer between
 * connector `peerId` values and operator-meaningful node types.
 *
 * Architectural rule (Epic 46 planning §Architectural Layering):
 * downstream consumers (Epic 47 aggregator, Epic 48 TUI, Epic 49 telemetry)
 * MUST call through this resolver — they never hardcode peer-to-type
 * mappings.
 *
 * The resolver is rebuilt from a `NodesYaml` snapshot — prefer immutable
 * rebuild (re-instantiate) over mutable update for testability.
 */

import type { NodesYaml } from '../state/nodes-yaml.js';
import type { NodeType } from '../docker/types.js';

const NODE_TYPES: readonly NodeType[] = ['town', 'mill', 'dvm'];

/**
 * Minimal shape of a peer entry from the connector's `GET /admin/peers`
 * response (mirrors `PeerStatus` in `../connector/types.ts`). Only the fields
 * the type-inference heuristic reads are required, so callers can pass the
 * connector response verbatim.
 */
export interface ConnectorPeerLike {
  /** Connector `peerId` (the value the peer authenticates as on its BTP session). */
  id: string;
  /** ILP route prefixes registered against this peer as nextHop. */
  ilpAddresses?: string[];
}

/**
 * Infer the Hub node type for a connector peer that was registered via
 * the `hub hs up` compose-render path (which does NOT write
 * `nodes.yaml`). The harness registers each child peer with a meaningful `id`
 * (`town` / `mill` / `dvm`) and an ILP route under `g.townhouse.<type>` (e.g.
 * the local-HS harness POSTs `/admin/peers {id:'town', routes:[{prefix:
 * 'g.townhouse.town'}]}`). We recover the type from either signal:
 *   1. the bare `id` (or its `<type>-NN` / `<type>_NN` form, matching the
 *      `node add` naming), or
 *   2. the node-type label immediately after the `…townhouse.` apex prefix in
 *      any `g.townhouse.<type>[...]` ILP route prefix.
 * Returns `null` when neither signal matches a known node type — the caller
 * treats such peers as `'external'`.
 */
function inferTypeFromConnectorPeer(peer: ConnectorPeerLike): NodeType | null {
  const id = peer.id.toLowerCase();
  for (const t of NODE_TYPES) {
    if (id === t || id.startsWith(`${t}-`) || id.startsWith(`${t}_`)) return t;
  }
  for (const addr of peer.ilpAddresses ?? []) {
    // Match `g.townhouse.town`, `g.townhouse.town.<...>`, etc. The node-type
    // label is the segment immediately after the `…townhouse.` apex prefix
    // (the on-wire ILP nodeId `g.townhouse` is deliberately unchanged).
    const m = /(?:^|\.)townhouse\.([a-z0-9]+)(?:\.|$)/i.exec(addr);
    if (m && m[1]) {
      const label = m[1].toLowerCase();
      if ((NODE_TYPES as readonly string[]).includes(label)) {
        return label as NodeType;
      }
    }
  }
  return null;
}

export class PeerTypeResolver {
  private readonly map: Map<string, NodeType>;

  constructor(yaml: NodesYaml) {
    this.map = new Map(yaml.entries.map((e) => [e.peerId, e.type]));
  }

  /**
   * Build a resolver from the connector's `GET /admin/peers` roster instead of
   * `nodes.yaml`. This is the resolution path for compose-rendered deployments
   * (`hub hs up`), where the connector knows its child peers but no
   * `nodes.yaml` was ever written (only the `hub node add` provisioning
   * path writes one). The node type is inferred from each peer's `id` /
   * `ilpAddresses` (see `inferTypeFromConnectorPeer`); peers whose type cannot
   * be inferred are simply omitted from the map and therefore resolve to
   * `'external'`.
   */
  static fromConnectorPeers(peers: ConnectorPeerLike[]): PeerTypeResolver {
    const resolver = new PeerTypeResolver({ entries: [] });
    for (const peer of peers) {
      const type = inferTypeFromConnectorPeer(peer);
      if (type) resolver.map.set(peer.id, type);
    }
    return resolver;
  }

  /**
   * Resolve a connector `peerId` to its operator-declared node type.
   * Returns `'external'` for unknown peerIds (legitimate non-Hub
   * peers running through the same connector).
   */
  resolvePeerType(peerId: string): NodeType | 'external' {
    return this.map.get(peerId) ?? 'external';
  }
}
