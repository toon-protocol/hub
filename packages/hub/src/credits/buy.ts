/**
 * Buy Turbo upload credits using a hub-derived EVM or SOL key
 * (epic-49, Phase 2).
 *
 * Pure business logic — no stdout writes, no readline prompts. The CLI
 * handler is responsible for argv parsing, confirmation UI, status streaming,
 * and exit codes. This module owns the Turbo SDK interactions only.
 *
 * Credit↔signer linkage (verified at implementation time, 2026-05-21):
 *   `TurboFundWithTokensParams` accepts an optional `turboCreditDestinationAddress`
 *   (see `@ardrive/turbo-sdk/lib/types/types.d.ts:637-642`). When supplied, the
 *   on-chain payment is sent FROM the SOL/EVM signer's address TO the Turbo
 *   service, but the resulting winc balance is credited to the specified
 *   destination address. That destination address can be an Arweave address,
 *   which an `ArweaveSigner` can subsequently use to spend the credits during
 *   upload (`topUpWithTokens` → AR address; `ArweaveSigner` → spend).
 *
 *   For this Phase 2 work the default is to omit `turboCreditDestinationAddress`
 *   so credits land on the funding identity itself (matches what the CLI prints
 *   for source/destination address). Phase 4's DVM container handoff will pass
 *   the DVM's Arweave address explicitly so credits land where the
 *   ArweaveSigner can spend them.
 */

import { TurboFactory } from '@ardrive/turbo-sdk/node';

import type { NodeType } from '../docker/types.js';
import type { WalletManager } from '../wallet/manager.js';
import { buildTurboSigner, type TurboTokenId } from '../wallet/turbo-signer.js';
import { parseTokenAmount } from './units.js';

export interface BuyCreditsOptions {
  /** Unlocked WalletManager. Caller owns lifecycle (locking). */
  wallet: WalletManager;
  /** Which node's keys fund the purchase. DVM in the standard flow. */
  nodeType: NodeType;
  /** Friendly token id (e.g. 'sol', 'eth', 'usdc-eth'). */
  token: TurboTokenId;
  /**
   * Human decimal amount in token units (e.g. "0.05" for 0.05 SOL,
   * "10" for 10 USDC). Converted to base units (lamports/wei/microUSDC)
   * via `parseTokenAmount` before being handed to the Turbo SDK.
   */
  amount: string;
  /**
   * Optional fee multiplier passed through to `topUpWithTokens` —
   * Turbo's on-chain gas/priority knob. >1 raises the on-chain fee.
   */
  feeMultiplier?: number;
  /**
   * If true, only fetch the quote (no on-chain transaction). Returns a
   * `BuyQuoteResult` with the winc that WOULD be credited for `amount`.
   */
  quoteOnly?: boolean;
  /**
   * Optional explicit credit recipient. When omitted, credits land on the
   * funding identity itself. Phase 4 uses this to credit the DVM's Arweave
   * address from a SOL/EVM funding signer.
   */
  destinationAddress?: string;
}

/** Quote-only result — no on-chain tx submitted. */
export interface BuyQuoteResult {
  kind: 'quote';
  /** Funding-side address (EVM hex / SOL base58 / AR base64url). */
  fromAddress: string;
  /** Credit-recipient address (defaults to fromAddress). */
  creditAddress: string;
  /** Base-unit amount that WOULD be charged on-chain. */
  baseAmount: bigint;
  /** Winc that WOULD be credited for `baseAmount`. */
  winc: bigint;
  /** Raw Turbo response — preserves equivalentWincTokenAmount, fees, etc. */
  raw: {
    winc: string;
    actualTokenAmount: string;
    equivalentWincTokenAmount: string;
  };
}

/** Submit-path result — Turbo's `topUpWithTokens` return shape, BigInt-typed. */
export interface BuySubmitResult {
  kind: 'submit';
  fromAddress: string;
  creditAddress: string;
  baseAmount: bigint;
  /** Winc actually credited (per Turbo's post-submit response). */
  winc: bigint;
  /** On-chain tx id (e.g. SOL signature, EVM tx hash). */
  id: string;
  /** Turbo's tracked status — typically 'pending' immediately after submit. */
  status: 'pending' | 'confirmed' | 'failed';
  /** Token (canonical string Turbo uses, e.g. 'solana', 'ethereum'). */
  token: string;
  /** Optional block height (present when status='confirmed'). */
  block?: number;
}

export type BuyResult = BuyQuoteResult | BuySubmitResult;

/**
 * Build a Turbo authenticated client, fetch a quote for `amount` of `token`,
 * and either return the quote (if `quoteOnly`) or submit `topUpWithTokens`.
 *
 * Pure business logic: no console output, no prompts. The CLI handler should
 * stream status messages between awaits.
 */
export async function buyCredits(opts: BuyCreditsOptions): Promise<BuyResult> {
  const {
    wallet,
    nodeType,
    token,
    amount,
    feeMultiplier,
    quoteOnly,
    destinationAddress,
  } = opts;

  // Parse human → base units first so we fail fast on bad input before
  // building a signer.
  const baseAmount = parseTokenAmount(token, amount);

  // EVM/SOL signer = the funding identity. For `ar` the signer is also
  // the credit recipient (you can buy AR credits with AR — though uncommon).
  const {
    signer,
    token: canonicalToken,
    address: fromAddress,
  } = await buildTurboSigner(wallet, nodeType, token);

  // Default credit destination = funding identity. Phase 4 will override
  // with the DVM's Arweave address.
  const creditAddress = destinationAddress ?? fromAddress;

  const turbo = TurboFactory.authenticated({
    signer,
    token: canonicalToken,
  });

  // Quote step — always run, even on the submit path, so callers always
  // have a winc estimate available. The Turbo SDK quotes in token base units
  // (string-form BigNumber to preserve precision).
  const quote = await turbo.getWincForToken({
    tokenAmount: baseAmount.toString(),
  });
  const quotedWinc = BigInt(quote.winc);

  if (quoteOnly) {
    return {
      kind: 'quote',
      fromAddress,
      creditAddress,
      baseAmount,
      winc: quotedWinc,
      raw: {
        winc: quote.winc,
        actualTokenAmount: quote.actualTokenAmount,
        equivalentWincTokenAmount: quote.equivalentWincTokenAmount,
      },
    };
  }

  // Submit step. `turboCreditDestinationAddress` is omitted when caller did
  // not supply `destinationAddress` (credits land on the funding identity).
  const topUpParams: {
    tokenAmount: string;
    feeMultiplier?: number;
    turboCreditDestinationAddress?: string;
  } = {
    tokenAmount: baseAmount.toString(),
  };
  if (feeMultiplier !== undefined) topUpParams.feeMultiplier = feeMultiplier;
  if (destinationAddress !== undefined) {
    topUpParams.turboCreditDestinationAddress = destinationAddress;
  }

  const submitted = await turbo.topUpWithTokens(topUpParams);

  return {
    kind: 'submit',
    fromAddress,
    creditAddress,
    baseAmount,
    winc: BigInt(submitted.winc),
    id: submitted.id,
    status: submitted.status,
    token: submitted.token,
    ...(submitted.block !== undefined ? { block: submitted.block } : {}),
  };
}
