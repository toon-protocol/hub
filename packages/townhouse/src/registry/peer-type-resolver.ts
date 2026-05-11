/**
 * `PeerTypeResolver` (Story 46.1).
 *
 * The connector is a generic ILP router — it has no concept of
 * `'town' | 'mill' | 'dvm'`. Townhouse owns the type concept entirely
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

export class PeerTypeResolver {
  private readonly map: Map<string, NodeType>;

  constructor(yaml: NodesYaml) {
    this.map = new Map(yaml.entries.map((e) => [e.peerId, e.type]));
  }

  /**
   * Resolve a connector `peerId` to its operator-declared node type.
   * Returns `'external'` for unknown peerIds (legitimate non-Townhouse
   * peers running through the same connector).
   */
  resolvePeerType(peerId: string): NodeType | 'external' {
    return this.map.get(peerId) ?? 'external';
  }
}
