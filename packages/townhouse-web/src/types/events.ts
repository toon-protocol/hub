/**
 * Consumer-side event type definitions for the townhouse-web dashboard.
 *
 * These types mirror the wire shapes emitted by Mill (`@toon-protocol/mill`)
 * and the SDK (`@toon-protocol/sdk`). We re-declare them here (rather than
 * importing) to:
 *  - keep the dashboard buildable without a Node-only SDK module graph in
 *    the Vite browser bundle;
 *  - allow the dashboard to add UI-only fields (e.g. derived display
 *    strings) without polluting the SDK types.
 *
 * Story D3 — AC-D3-3 — adds the {@link SettlementEvent} type that D4's
 * earnings aggregator will read to render block-explorer deeplinks.
 *
 * @module
 * @since D3
 */

/**
 * Chain family discriminator for {@link SettlementEvent}.
 *
 * Mirrors `SettlementChain` in `@toon-protocol/mill` and
 * `SettlementEventChain` in `@toon-protocol/sdk`. Mina is intentionally
 * excluded until a dedicated story lands Mina settlement.
 */
export type SettlementChain = 'evm' | 'solana';

/**
 * On-chain settlement event consumed by the townhouse-web earnings
 * aggregator (story D4).
 *
 * Field semantics:
 * - `txHash`: on-chain transaction identifier.
 *   - For `chain === 'evm'`: lowercase 0x-prefixed 32-byte hex string
 *     (matches viem's default).
 *   - For `chain === 'solana'`: base58-encoded transaction signature
 *     (Solana tooling conventionally calls this a `signature`; we reuse
 *     `txHash` for cross-chain consistency with the EVM path).
 * - `chain`: chain family discriminator. Drives the block-explorer URL
 *   the dashboard renders.
 * - `channelId`: payment-channel identifier on the target chain.
 * - `cumulativeAmount`: cumulative target-asset amount settled (decimal
 *   string in target micro-units).
 * - `nonce`: balance-proof nonce settled (decimal string).
 * - `recipient`: chain-specific payout address (sender).
 * - `settledAt`: ms-epoch the Mill recorded the settlement.
 *
 * Fields are optional to remain additively compatible with consumers
 * that pre-date Story D3 (matches the SDK's `SettlementEvent` shape).
 * D4 callers MUST narrow `txHash` + `chain` before rendering deeplinks.
 *
 * @stable — D4 earnings aggregator depends on `txHash` + `chain`.
 * @since D3
 */
export interface SettlementEvent {
  /** On-chain transaction identifier. EVM: 0x hex. Solana: base58 signature. */
  txHash?: string;
  /** Chain family discriminator. */
  chain?: SettlementChain;
  /** Payment-channel identifier on the target chain. */
  channelId?: string;
  /** Cumulative settled amount (target micro-units, decimal string). */
  cumulativeAmount?: string;
  /** Balance-proof nonce (decimal string). */
  nonce?: string;
  /** Chain-specific payout address (sender). */
  recipient?: string;
  /** ms-epoch the Mill recorded the settlement. */
  settledAt?: number;
}

/**
 * Type guard: narrows an arbitrary event-like input to a
 * {@link SettlementEvent} that has both `txHash` and `chain` set.
 *
 * D4's earnings aggregator uses this to filter the relay-event stream
 * down to the rows it can render block-explorer deeplinks for.
 *
 * @since D3
 */
export function hasSettlementTxFields(
  event: SettlementEvent | null | undefined
): event is SettlementEvent & {
  txHash: string;
  chain: SettlementChain;
} {
  if (event == null) return false;
  if (typeof event.txHash !== 'string' || event.txHash.length === 0)
    return false;
  if (event.chain !== 'evm' && event.chain !== 'solana') return false;
  return true;
}
