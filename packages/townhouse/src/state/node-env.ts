/**
 * Per-node container environment assembly — shared by the provisioning route
 * (`POST /api/nodes`, src/api/routes/nodes-lifecycle.ts) and the boot rebinder
 * (src/rebind.ts), so a node started at `node add` time and the same node
 * restarted on `hs up` get byte-identical env. Keeping this in `state/` (not the
 * routes layer) lets the CLI rebind path import it without pulling Fastify.
 *
 * NEVER log the *_SECRET_KEY / *_SETTLEMENT_PRIVATE_KEY / *_MNEMONIC / TURBO_TOKEN
 * values produced here — they are secrets.
 */

import { resolveConfigNetworkProfile } from '../config/network-profile.js';
import { resolveTownSettlementAsset } from '../config/supported-tokens.js';
import type { TownhouseConfig } from '../config/schema.js';
import type { NodeType } from '../api/types.js';

/**
 * Virtual ports the `.anyone` hidden services publish, and therefore the ports
 * clients MUST dial on the `.anyone` hostname. These mirror the fixed values in
 * the HS plumbing and must stay in sync:
 *   - BTP   → `hs-config-writer.ts` `HS_PORT` (the connector's BTP server).
 *   - relay → `docker/orchestrator.ts` `TOWN_RELAY_PORT` (the relay sidecar's
 *             `HS_PORT`, forwarding to the town's Nostr WebSocket).
 *
 * ATOR hidden services tunnel plaintext WebSocket through the encrypted circuit
 * (no TLS), so the advertised scheme is `ws://` — NOT `wss://` — and the port is
 * explicit. Advertising `wss://<host>.anyone/btp` (implicit `:443`, TLS) was
 * unreachable and broke client auto-discovery (issue #259).
 */
const HS_BTP_PORT = 3000;
const HS_RELAY_PORT = 7100;

/**
 * Resolve the network-mode chain env (EVM_CHAIN/EVM_RPC_URL/EVM_CHAIN_ID/
 * EVM_USDC_ADDRESS/SOLANA_*) the compose template interpolates into the
 * town/mill containers. Same source of truth as the apex connector
 * (hs-config-writer) and the `.env` written by env-writer — so children use the
 * public RPCs for the operator's chosen network instead of the unreachable local
 * `anvil` default (the cause of the "disconnected" boot-loop).
 */
export function buildNetworkNodeEnv(
  config: TownhouseConfig
): Record<string, string> {
  const profile = resolveConfigNetworkProfile(config);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(profile.nodeEnv)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/**
 * Build the per-node secret/identity env overlay. Callers start from
 * `process.env` and layer this on top (done inside `startNodeViaCompose`); the
 * returned object is the SECRET OVERLAY ONLY.
 */
export function buildNodeEnv(
  type: NodeType,
  nostrSecretKeyHex: string,
  nostrPubkeyHex: string,
  evmPrivateKeyHex: string,
  mnemonic: string | null,
  apexEvmAddress: string,
  chainEnv: Record<string, string>
): Record<string, string> {
  // Town's TOON_SETTLEMENT_PRIVATE_KEY (and mill's settlement key) requires a
  // 0x-prefixed 32-byte hex string. bytesToHex returns unprefixed hex — without
  // the 0x, town crashes at boot with `TOON_SETTLEMENT_PRIVATE_KEY must be a
  // 0x-prefixed 32-byte hex string` (Story 46.4 Finding O).
  const evmPrivateKeyHex0x = `0x${evmPrivateKeyHex}`;
  // The *_NOSTR_PUBKEY overlay is the x-only pubkey derived from the same secret
  // the container already receives — purely informational so operators / SDK
  // clients can read it via `docker inspect` / `node list --json` (issue #81).
  switch (type) {
    case 'town':
      return {
        TOWN_SECRET_KEY: nostrSecretKeyHex,
        TOWN_NOSTR_PUBKEY: nostrPubkeyHex,
        TOWN_SETTLEMENT_PRIVATE_KEY: evmPrivateKeyHex0x,
        APEX_EVM_ADDRESS: apexEvmAddress,
        ...chainEnv,
      };
    case 'mill':
      return {
        MILL_SECRET_KEY: nostrSecretKeyHex,
        MILL_NOSTR_PUBKEY: nostrPubkeyHex,
        MILL_SETTLEMENT_PRIVATE_KEY: evmPrivateKeyHex0x,
        MILL_MNEMONIC: mnemonic ?? '',
        APEX_EVM_ADDRESS: apexEvmAddress,
        ...chainEnv,
      };
    case 'dvm':
      // DVM does no on-chain settlement — no chain env needed.
      return {
        DVM_SECRET_KEY: nostrSecretKeyHex,
        DVM_NOSTR_PUBKEY: nostrPubkeyHex,
      };
  }
}

/**
 * Resolve the mill's Nostr relay URLs with precedence: explicit `bodyRelays`
 * (the `--relays` flag) > persisted `config.nodes.mill.relays` > legacy
 * `MILL_RELAYS` env var (back-compat for operators who exported it before
 * `townhouse hs up`). Trims and drops blank entries. Returns [] when nothing is
 * supplied anywhere — callers turn that into an actionable 400 (provision) or a
 * skip (rebind). Resolving from the request body and config (not just
 * process.env) is what frees `node add mill` from the "MILL_RELAYS must be
 * exported before hs up or the API never sees it" trap.
 */
export function resolveMillRelays(
  bodyRelays: string[] | undefined,
  config: TownhouseConfig
): string[] {
  const fromBody = (bodyRelays ?? []).map((r) => r.trim()).filter(Boolean);
  if (fromBody.length > 0) return fromBody;
  const fromConfig = (config.nodes.mill.relays ?? [])
    .map((r) => r.trim())
    .filter(Boolean);
  if (fromConfig.length > 0) return fromConfig;
  return (process.env['MILL_RELAYS'] ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
}

/**
 * Resolve the DVM's Arweave Turbo credential with the same precedence chain:
 * `--turbo-token` > `config.nodes.dvm.turboToken` > legacy `TURBO_TOKEN` env.
 * Returns '' when unset anywhere — the DVM boots fine without it (free-tier
 * <100KB uploads still work), so this is intentionally NOT a hard requirement,
 * only an injected value when present.
 */
export function resolveDvmTurboToken(
  bodyToken: string | undefined,
  config: TownhouseConfig
): string {
  return (
    bodyToken?.trim() ||
    config.nodes.dvm.turboToken?.trim() ||
    process.env['TURBO_TOKEN']?.trim() ||
    ''
  );
}

/**
 * Resolve the apex's PUBLIC BTP URL that the town advertises in its kind:10032,
 * so clients learn where to route packets destined for `g.townhouse.town`.
 * Precedence:
 *   1. operator override `transport.externalUrl` (when set and not the literal
 *      `'auto'`), normalised to end in `/btp`;
 *   2. HS mode → `ws://<hostname>:3000/btp` from the resolved `.anyone` hostname
 *      (host.json), or undefined when not yet published. The explicit `:3000`
 *      (the connector's HS virtual port) + plain `ws` scheme match what the HS
 *      actually serves; `wss://<hostname>/btp` (`:443`, TLS) was unreachable
 *      and broke client auto-discovery (issue #259);
 *   3. direct mode → the loopback dial URL (operators expose externally via
 *      `transport.externalUrl` or a reverse proxy).
 */
export function resolvePublicBtpUrl(
  config: TownhouseConfig,
  hostname?: string
): string | undefined {
  const ext = config.transport.externalUrl;
  if (ext && ext !== 'auto') {
    const trimmed = ext.replace(/\/+$/, '');
    return trimmed.endsWith('/btp') ? trimmed : `${trimmed}/btp`;
  }
  // A resolved .anyone hostname (from host.json) is the authoritative signal
  // that the apex is running as a hidden service — `hs up` does NOT rewrite
  // config.transport.mode (it stays 'direct' from init), so keying off the
  // hostname's presence is correct where the config mode is not.
  if (hostname) return `ws://${hostname}:${HS_BTP_PORT}/btp`;
  if (config.transport.mode === 'direct') return 'ws://127.0.0.1:3000/btp';
  return undefined;
}

/**
 * Resolve the public Nostr relay READ URL the town advertises (kind:10032
 * `relayUrl` + kind:10166), so clients know where to subscribe for free reads.
 * Precedence:
 *   1. operator override `transport.relayExternalUrl` (both modes);
 *   2. HS mode → `ws://<relayHostname>:7100/` from the relay hidden service's
 *      resolved `.anyone` hostname. The explicit `:7100` (the relay sidecar's
 *      HS virtual port) + plain `ws` scheme match what the HS actually serves;
 *      `wss://<relayHostname>/` (`:443`, TLS) was unreachable (issue #259);
 *   3. otherwise undefined — the relay isn't publicly exposed (direct mode
 *      without `relayExternalUrl` keeps the relay loopback-only / unadvertised).
 */
export function resolveRelayUrl(
  config: TownhouseConfig,
  relayHostname?: string
): string | undefined {
  const ext = config.transport.relayExternalUrl;
  if (ext) {
    const trimmed = ext.replace(/\/+$/, '');
    return `${trimmed}/`;
  }
  if (relayHostname) return `ws://${relayHostname}:${HS_RELAY_PORT}/`;
  return undefined;
}

/** Inputs for {@link assembleNodeEnv}. */
export interface AssembleNodeEnvParams {
  type: NodeType;
  nostrSecretKeyHex: string;
  nostrPubkey: string;
  evmPrivateKeyHex: string;
  mnemonic: string | null;
  apexEvmAddress: string;
  config: TownhouseConfig;
  /** mill: pre-resolved relays (from `--relays`). Omit to resolve config/env. */
  relays?: string[];
  /** dvm: pre-resolved Turbo token (from `--turbo-token`). Omit to resolve config/env. */
  turboToken?: string;
  /** town: apex public BTP URL to advertise in kind:10032 (see resolvePublicBtpUrl). */
  publicBtpUrl?: string;
  /** town: public relay read URL to advertise in kind:10032 (see resolveRelayUrl). */
  relayUrl?: string;
}

/**
 * Assemble the COMPLETE container env overlay for one node: identity/secret keys
 * + network chain env + the resolved operator inputs (mill `MILL_RELAYS`, dvm
 * `TURBO_TOKEN`). This is the single source both provisioning and rebind use so
 * the two paths never diverge. When `relays`/`turboToken` are omitted they are
 * resolved from config/env via {@link resolveMillRelays}/{@link resolveDvmTurboToken}.
 */
export function assembleNodeEnv(
  params: AssembleNodeEnvParams
): Record<string, string> {
  const { type, config } = params;
  const env = buildNodeEnv(
    type,
    params.nostrSecretKeyHex,
    params.nostrPubkey,
    params.evmPrivateKeyHex,
    params.mnemonic,
    params.apexEvmAddress,
    buildNetworkNodeEnv(config)
  );
  if (type === 'mill') {
    const relays =
      params.relays && params.relays.length > 0
        ? params.relays
        : resolveMillRelays(undefined, config);
    env['MILL_RELAYS'] = relays.join(',');
  }
  if (type === 'dvm') {
    const token =
      params.turboToken?.trim() || resolveDvmTurboToken(undefined, config);
    if (token) env['TURBO_TOKEN'] = token;
  }
  if (type === 'town') {
    // Negotiation values the town advertises in its kind:10032 + enforces:
    // the apex public BTP URL, the publish price (feePerEvent), and the
    // settlement asset. compose interpolates these into the town container,
    // which maps them to TOON_* via docker/src/entrypoint-town.ts.
    const town = config.nodes.town;
    if (params.publicBtpUrl) env['PUBLIC_BTP_URL'] = params.publicBtpUrl;
    // Public relay read URL (entrypoint-town maps PUBLIC_RELAY_URL →
    // TOON_EXTERNAL_RELAY_URL, which the town advertises in kind:10032/10166).
    if (params.relayUrl) env['PUBLIC_RELAY_URL'] = params.relayUrl;
    if (town.feePerEvent !== undefined) {
      env['FEE_PER_EVENT'] = String(town.feePerEvent);
    }
    // Derive the advertised settlement asset (assetCode + scale) from the
    // operator's chain/token selection, validated against the deployment's
    // supported set (USDC/ETH/SOL/MINA per chain). assetScale is ALWAYS derived
    // from the resolved token — never operator-typed. Best-effort here:
    // provision-time preflight already rejected invalid selections, so on any
    // resolution error we leave it unset and the town uses its built-in default.
    try {
      const asset = resolveTownSettlementAsset(config, {
        settlementChainId: town.settlementChainId,
        assetCode: town.assetCode,
      });
      if (asset) {
        env['ASSET_CODE'] = asset.assetCode;
        env['ASSET_SCALE'] = String(asset.assetScale);
      }
    } catch {
      // invalid selection — leave unset; the town falls back to its default
    }
  }
  return env;
}
