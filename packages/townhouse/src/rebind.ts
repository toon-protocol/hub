/**
 * Boot rebinder — recreate provisioned child node containers from nodes.yaml on
 * `townhouse hs up`.
 *
 * `hs down` runs `docker compose down` (removing child containers) and `hs up`'s
 * `orchestrator.up([])` only boots the apex (connector + townhouse-api). Without
 * this, a restart leaves previously-added town/mill/dvm children stopped, and
 * the BootReconciler would re-register peers pointing at containers that no
 * longer exist. This module rebuilds each child's full env from the wallet +
 * config and (re)starts it via `startNodeViaCompose`, which is idempotent:
 *   - container already running with identical env → docker compose no-ops;
 *   - config changed since last start (e.g. mill relays edited) → recreated.
 * That second case is the "auto-rebind from config" behaviour: edit config.yaml,
 * `hs up`, and the children pick up the change.
 *
 * Run this BEFORE the BootReconciler so containers exist when peers re-register.
 * Every step is non-fatal — a failure to rebind one node is logged and the rest
 * proceed; apex boot is never blocked.
 */

import { bytesToHex } from '@noble/hashes/utils';

import type { TownhouseConfig } from './config/schema.js';
import type { WalletManager } from './wallet/index.js';
import type { DockerOrchestrator } from './docker/orchestrator.js';
import type { NodeType } from './api/types.js';
import { readNodesYaml } from './state/nodes-yaml.js';
import { assembleNodeEnv, resolveMillRelays } from './state/node-env.js';

/** Minimal wallet surface the rebinder needs (keeps it test-stubbable). */
export type RebindWallet = Pick<
  WalletManager,
  'deriveNodeKey' | 'getMnemonic' | 'getNodeKeys'
>;

/** Minimal orchestrator surface the rebinder needs. */
export type RebindOrchestrator = Pick<
  DockerOrchestrator,
  'startNodeViaCompose'
>;

export interface RebindDeps {
  nodesYamlPath: string;
  wallet: RebindWallet;
  orchestrator: RebindOrchestrator;
  config: TownhouseConfig;
  /**
   * Apex public BTP URL injected into the town's env so its kind:10032
   * advertises a reachable endpoint (resolved by the caller from
   * config/host.json — see resolvePublicBtpUrl). Omit for non-town or when the
   * hostname isn't resolved yet (town falls back to its default).
   */
  publicBtpUrl?: string;
  /** Optional progress sink (defaults to no-op). */
  log?: (line: string) => void;
}

export interface RebindSummary {
  /** Node ids whose `startNodeViaCompose` was invoked successfully. */
  started: string[];
  /** Node ids deliberately not started, with the reason. */
  skipped: { id: string; reason: string }[];
  /** Node ids whose rebind threw, with the error message. */
  failed: { id: string; err: string }[];
}

/**
 * Read nodes.yaml and (re)start every recorded child container with env
 * reconstructed from the wallet + config. Returns a summary; never throws for
 * per-node failures (those are captured in `failed`). Only a failure to READ
 * nodes.yaml propagates — the caller treats that as non-fatal too.
 */
export async function rebindChildContainers(
  deps: RebindDeps
): Promise<RebindSummary> {
  const log = deps.log ?? (() => undefined);
  const summary: RebindSummary = { started: [], skipped: [], failed: [] };

  const yaml = await readNodesYaml(deps.nodesYamlPath);
  if (yaml.entries.length === 0) return summary;

  // The wallet must be unlocked to derive node keys; capture once so a mid-loop
  // lock is reported consistently rather than half the nodes silently skipped.
  const mnemonic = deps.wallet.getMnemonic();
  if (mnemonic === null) {
    for (const entry of yaml.entries) {
      summary.skipped.push({ id: entry.id, reason: 'wallet locked' });
    }
    log(
      `wallet locked — skipped rebinding ${yaml.entries.length} child node(s)`
    );
    return summary;
  }
  const apexEvmAddress = deps.wallet.getNodeKeys('town').evmAddress;

  for (const entry of yaml.entries) {
    const type = entry.type as NodeType;
    try {
      // mill won't boot without at least one relay (its validateConfig throws on
      // an empty relayUrls → crash-loop). If relays didn't persist to config and
      // no MILL_RELAYS env is set, skip rather than start a doomed container.
      if (
        type === 'mill' &&
        resolveMillRelays(undefined, deps.config).length === 0
      ) {
        summary.skipped.push({
          id: entry.id,
          reason:
            'no relays in config.yaml or MILL_RELAYS — rerun `townhouse node add mill --relays …`',
        });
        continue;
      }

      const keys = await deps.wallet.deriveNodeKey(type, entry.derivationIndex);
      const env = assembleNodeEnv({
        type,
        nostrSecretKeyHex: bytesToHex(keys.nostrSecretKey),
        nostrPubkey: keys.nostrPubkey,
        evmPrivateKeyHex: bytesToHex(keys.evmPrivateKey),
        mnemonic,
        apexEvmAddress,
        config: deps.config,
        publicBtpUrl: deps.publicBtpUrl,
      });
      await deps.orchestrator.startNodeViaCompose(type, env);
      summary.started.push(entry.id);
    } catch (err: unknown) {
      summary.failed.push({
        id: entry.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (summary.started.length > 0) {
    log(`rebound ${summary.started.length} child container(s) from nodes.yaml`);
  }
  return summary;
}
