/**
 * Turbo SDK signer factory — bridges WalletManager-derived keys to the
 * `@ardrive/turbo-sdk` signer abstraction (epic-49, Phase 2).
 *
 * The Turbo SDK accepts an `ArweaveSigner`, `EthereumSigner`, or
 * `HexSolanaSigner` (all re-exported from `@dha-team/arbundles`) to
 * authenticate the funding side of `topUpWithTokens` and `getBalance`.
 *
 * For the credits-buy flow the SIGNER is the funding identity (EVM or SOL),
 * not the credit recipient. The credit recipient is specified separately via
 * `turboCreditDestinationAddress` in the top-up call — see
 * `packages/townhouse/src/credits/buy.ts`.
 *
 * Why the @ardrive/turbo-sdk re-export and not @dha-team/arbundles directly?
 *   The Turbo SDK's `signer.d.ts` explicitly re-exports `ArweaveSigner`,
 *   `EthereumSigner`, `HexSolanaSigner` (see lib/types/node/signer.d.ts) as a
 *   "utility export to avoid clients having to install arbundles." Importing
 *   from `@ardrive/turbo-sdk/node` keeps the version pin in one place and
 *   guarantees identical class identity to whatever Turbo's internal factory
 *   constructs.
 */

import {
  ArweaveSigner,
  EthereumSigner,
  HexSolanaSigner,
} from '@ardrive/turbo-sdk/node';
import bs58 from 'bs58';

import type { NodeType } from '../docker/types.js';
import type { WalletManager } from './manager.js';

/**
 * Assemble the 64-byte Solana secret key (32-byte private seed + 32-byte
 * public key) and return it base58-encoded — the format `HexSolanaSigner`
 * actually consumes. (The class is misleadingly named: its `sign()` method
 * hex-encodes the message, but its CONSTRUCTOR expects a base58-encoded
 * secret key per `@dha-team/arbundles/.../SolanaSigner.js` which calls
 * `bs58.decode(_key)` on the input.)
 */
function solanaSecretKeyBase58(
  privateKeyHex: string,
  publicKeyBase58: string
): string {
  const priv = Buffer.from(privateKeyHex, 'hex');
  if (priv.length !== 32) {
    throw new Error(
      `Solana private key seed must be 32 bytes, got ${priv.length}`
    );
  }
  const pub = bs58.decode(publicKeyBase58);
  if (pub.length !== 32) {
    throw new Error(`Solana public key must be 32 bytes, got ${pub.length}`);
  }
  const secret = new Uint8Array(64);
  secret.set(priv, 0);
  secret.set(pub, 32);
  return bs58.encode(secret);
}

/**
 * Friendly token identifiers exposed to CLI users. Mapped to Turbo's canonical
 * `TokenType` string in `TURBO_TOKEN_MAP`. We keep the friendly names because
 * `pol`/`usdc-pol`/`usdc-eth` are more memorable than `matic`/`polygon-usdc`.
 */
export type TurboTokenId =
  | 'eth'
  | 'pol'
  | 'base-eth'
  | 'base-usdc'
  | 'usdc-eth'
  | 'usdc-pol'
  | 'sol'
  | 'ar';

/**
 * Canonical Turbo `TokenType` string per friendly id. Source of truth for the
 * `token` parameter passed to `TurboFactory.authenticated` and downstream
 * `getWincForToken` / `topUpWithTokens` calls.
 *
 * Mapping derived from `@ardrive/turbo-sdk` `tokenTypes` (see
 * `lib/types/types.d.ts:36`):
 *   "arweave" | "ario" | "base-ario" | "solana" | "ethereum" | "kyve"
 *   | "matic" | "pol" | "base-eth" | "usdc" | "base-usdc" | "polygon-usdc"
 */
const TURBO_TOKEN_MAP = {
  eth: 'ethereum',
  pol: 'pol',
  'base-eth': 'base-eth',
  'base-usdc': 'base-usdc',
  'usdc-eth': 'usdc',
  'usdc-pol': 'polygon-usdc',
  sol: 'solana',
  ar: 'arweave',
} as const;

export type TurboCanonicalToken = (typeof TURBO_TOKEN_MAP)[TurboTokenId];

/** EVM family — uses secp256k1 + an `EthereumSigner` regardless of chain. */
const EVM_TOKENS: ReadonlySet<TurboTokenId> = new Set([
  'eth',
  'pol',
  'base-eth',
  'base-usdc',
  'usdc-eth',
  'usdc-pol',
]);

/** Return type for `buildTurboSigner` — opaque to callers besides Turbo. */
export interface TurboSignerBundle {
  /** ArweaveSigner | EthereumSigner | HexSolanaSigner instance. */
  signer: ArweaveSigner | EthereumSigner | HexSolanaSigner;
  /** Canonical Turbo token string (passed verbatim to TurboFactory). */
  token: TurboCanonicalToken;
  /**
   * Native address corresponding to the signer (checksummed EVM hex,
   * base58 SOL, or base64url AR). Useful for confirmation prompts and
   * balance queries — for `credits buy` this is the FUNDING address.
   */
  address: string;
}

/**
 * Map a friendly `TurboTokenId` to the canonical Turbo string. Exported for
 * tests + the CLI argv parser. Throws on unknown ids.
 */
export function canonicalTurboToken(token: TurboTokenId): TurboCanonicalToken {
  const canonical = TURBO_TOKEN_MAP[token];
  if (!canonical) {
    throw new Error(
      `Unknown TurboTokenId '${String(token)}'. Supported: ${Object.keys(TURBO_TOKEN_MAP).join(', ')}`
    );
  }
  return canonical;
}

/**
 * Construct a Turbo SDK signer bundle from a node's WalletManager-derived key.
 *
 * EVM family → `EthereumSigner(privateKeyHex)`.
 * `sol`       → `HexSolanaSigner(privateKeyHex)`.
 * `ar`        → `await wallet.ensureArweaveKey(...)` then `ArweaveSigner(jwk)`.
 *
 * The caller is responsible for the lifecycle of `wallet` — this function
 * does NOT lock the wallet on completion.
 */
export async function buildTurboSigner(
  wallet: WalletManager,
  nodeType: NodeType,
  token: TurboTokenId
): Promise<TurboSignerBundle> {
  const canonical = canonicalTurboToken(token);

  if (EVM_TOKENS.has(token)) {
    const privateKeyHex = wallet.getEvmPrivateKeyHex(nodeType);
    const signer = new EthereumSigner(privateKeyHex);
    const keys = wallet.getNodeKeys(nodeType);
    return { signer, token: canonical, address: keys.evmAddress };
  }

  if (token === 'sol') {
    const privateKeyHex = wallet.getSolanaPrivateKeyHex(nodeType);
    const keys = wallet.getNodeKeys(nodeType);
    if (!keys.solanaAddress) {
      // Defensive — getSolanaPrivateKeyHex would have thrown first, but the
      // type system can't see that.
      throw new Error(`Solana address not available for node '${nodeType}'`);
    }
    const secretBase58 = solanaSecretKeyBase58(
      privateKeyHex,
      keys.solanaAddress
    );
    const signer = new HexSolanaSigner(secretBase58);
    return { signer, token: canonical, address: keys.solanaAddress };
  }

  if (token === 'ar') {
    // RSA-4096 derivation is 5-30s on first call — Phase 1 contract.
    await wallet.ensureArweaveKey(nodeType);
    const jwk = wallet.getArweaveJwk(nodeType);
    const signer = new ArweaveSigner(jwk);
    const keys = wallet.getNodeKeys(nodeType);
    if (!keys.arweaveAddress) {
      throw new Error(
        `Arweave address not populated for node '${nodeType}' after ensureArweaveKey`
      );
    }
    return { signer, token: canonical, address: keys.arweaveAddress };
  }

  // Exhaustiveness — TS sees `token` as `never` here when all variants covered.
  throw new Error(`Unsupported TurboTokenId: ${String(token)}`);
}
