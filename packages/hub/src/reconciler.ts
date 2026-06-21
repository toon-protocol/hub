/**
 * Boot reconciler (Story 46.1).
 *
 * Converges connector peer state to `~/.hub/nodes.yaml` (truth) on
 * every `hub hs up`. Reads yaml + connector peers, diffs them,
 * re-registers any yaml entries missing from the connector, and logs
 * connector peers without yaml entries as `'external'` (left alone).
 *
 * Container lifecycle is OUT of scope — that lives in Epic 46.2.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';

import type { ConnectorAdminClient } from './connector/admin-client.js';
import type { PeerStatus } from './connector/types.js';
import { CONTAINER_PREFIX, NODE_BTP_PORT } from './constants.js';
import {
  readNodesYaml,
  type NodesYaml,
  type NodesYamlEntry,
} from './state/nodes-yaml.js';

/** Action recorded for a single divergence. */
export type DivergenceAction =
  | 'reregistered'
  | 'reregister-failed'
  | 'external';

/** A single divergence record for the reconciler log. */
export interface DivergenceLog {
  timestamp: string;
  peerId: string;
  action: DivergenceAction;
  detail?: string;
}

/** Per-divergence intent computed by `diff()` — converted to a `DivergenceLog` at action time. */
interface DivergencePlan {
  peerId: string;
  intent: 'reregister' | 'external';
}

/** Summary returned by `reconcile()` so callers can surface partial-failure counts. */
export interface ReconcileSummary {
  reregistered: number;
  failed: number;
  external: number;
}

export class BootReconciler {
  private logDirEnsured = false;
  private logFileChmodEnsured = false;

  constructor(
    private readonly adminClient: Pick<
      ConnectorAdminClient,
      'getPeers' | 'registerPeer'
    >,
    private readonly nodesYamlPath: string,
    private readonly reconcilerLogPath: string
  ) {}

  /**
   * Diff `nodes.yaml` (truth) against `GET /admin/peers` (derived state)
   * and converge.
   *
   * Ordering rule (Epic 46.2 dependency — load-bearing):
   *   `nodes.yaml` write happens BEFORE connector registration
   *   (`POST /admin/peers`).
   *
   * The drift window resolves in the safe direction:
   *   - yaml entry without a connector peer = harmless. The reconciler
   *     re-registers it on next `hs up` (this method does that).
   *   - connector peer without a yaml entry = treated as `'external'` and
   *     left alone (operators may legitimately route non-Hub peers
   *     through the same connector).
   *
   * The unsafe direction (register first, then write yaml) creates a
   * window where the connector routes to a peer Hub cannot clean
   * up. Epic 46.2's provisioning pipeline MUST honor the yaml-first rule.
   *
   * Failures fetching `getPeers()` are surfaced (not swallowed) so the
   * caller in `handleHsUp` can decide whether to treat reconciler
   * divergence as fatal. (Today: non-fatal — see cli.ts wire point.)
   *
   * Per-divergence appendLog failures are caught so a single log-write
   * failure does not abort the rest of the reconciliation pass.
   */
  async reconcile(): Promise<ReconcileSummary> {
    const yaml = await readNodesYaml(this.nodesYamlPath);
    const peers = await this.adminClient.getPeers();
    const plans = this.diff(yaml, peers);

    const summary: ReconcileSummary = {
      reregistered: 0,
      failed: 0,
      external: 0,
    };

    for (const plan of plans) {
      if (plan.intent === 'reregister') {
        const entry = yaml.entries.find((e) => e.peerId === plan.peerId);
        if (!entry) continue;
        try {
          await this.adminClient.registerPeer({
            id: entry.peerId,
            url: deriveBtpUrl(entry),
            authToken: '',
            routes: [{ prefix: entry.ilpAddress, priority: 0 }],
            // Re-registration must mirror the provisioning-path peer config
            // (nodes-lifecycle.ts), or a connector restart silently restores
            // peers as settlement 'peer's (paid packets → T00) dialled over the
            // global SOCKS5 transport (Docker-internal hostnames → HostUnreachable).
            // Every nodes.yaml entry is an apex-owned child.
            relation: 'child',
            transport: 'direct',
          });
          summary.reregistered++;
          await this.tryAppendLog({
            timestamp: new Date().toISOString(),
            peerId: plan.peerId,
            action: 'reregistered',
          });
        } catch (err: unknown) {
          summary.failed++;
          const msg = err instanceof Error ? err.message : String(err);
          await this.tryAppendLog({
            timestamp: new Date().toISOString(),
            peerId: plan.peerId,
            action: 'reregister-failed',
            detail: msg,
          });
        }
      } else {
        summary.external++;
        await this.tryAppendLog({
          timestamp: new Date().toISOString(),
          peerId: plan.peerId,
          action: 'external',
        });
      }
    }

    return summary;
  }

  /**
   * Compute divergences without mutating the connector. Exposed for
   * testability — production callers use `reconcile()`.
   */
  private diff(yaml: NodesYaml, peers: PeerStatus[]): DivergencePlan[] {
    const peerIds = new Set(peers.map((p) => p.id));
    const yamlPeerIds = new Set(yaml.entries.map((e) => e.peerId));
    const out: DivergencePlan[] = [];

    for (const entry of yaml.entries) {
      if (!peerIds.has(entry.peerId)) {
        out.push({ peerId: entry.peerId, intent: 'reregister' });
      }
    }
    for (const peer of peers) {
      if (!yamlPeerIds.has(peer.id)) {
        out.push({ peerId: peer.id, intent: 'external' });
      }
    }
    return out;
  }

  /**
   * Append one divergence record without aborting the whole reconciliation
   * pass on a single log-write failure (disk full, EACCES, etc.). Failures
   * are themselves logged to stderr — not silently swallowed — so the
   * operator can see them in the same `hs up` session.
   */
  private async tryAppendLog(div: DivergenceLog): Promise<void> {
    try {
      await this.appendLog(div);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[hub boot-reconciler] failed to append divergence log: ${msg}`
      );
    }
  }

  /**
   * Append one divergence record to the reconciler log as a single line of
   * JSON (jsonl-style — easy to grep, easy to parse).
   *
   * `mkdir` runs once per reconciler instance. `chmod 0o600` on the log file
   * also runs once — `fs.appendFile`'s `mode` option only applies on
   * creation, so without a post-create chmod a pre-existing log file with
   * permissive mode would never be tightened.
   */
  private async appendLog(div: DivergenceLog): Promise<void> {
    const line = JSON.stringify(div) + '\n';
    if (!this.logDirEnsured) {
      await fs.mkdir(dirname(this.reconcilerLogPath), {
        recursive: true,
        mode: 0o700,
      });
      this.logDirEnsured = true;
    }
    await fs.appendFile(this.reconcilerLogPath, line, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    if (!this.logFileChmodEnsured) {
      try {
        await fs.chmod(this.reconcilerLogPath, 0o600);
      } catch {
        /* best-effort: file may have been removed; next call retries */
      }
      this.logFileChmodEnsured = true;
    }
  }
}

/**
 * Derive the BTP WebSocket URL for a Hub internal peer.
 *
 * Convention: `ws://${CONTAINER_PREFIX}${type}:${NODE_BTP_PORT}` — matches
 * the URL used by `ConnectorConfigGenerator` at boot, minus the `btp+`
 * scheme prefix (the connector's POST /admin/peers requires `ws://` or
 * `wss://`, while the static yaml config uses `btp+ws://`).
 *
 * Epic 46.2 may persist the URL into `nodes.yaml` directly when the
 * provisioning pipeline supports operator-defined peer URLs; until then,
 * convention is sufficient because the only producer of yaml entries is
 * Hub itself.
 */
function deriveBtpUrl(entry: NodesYamlEntry): string {
  return `ws://${CONTAINER_PREFIX}${entry.type}:${NODE_BTP_PORT}`;
}
