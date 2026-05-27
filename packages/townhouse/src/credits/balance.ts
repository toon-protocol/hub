/**
 * Query a Turbo credit balance for the address that would fund (and, by
 * default, hold) credits in the `townhouse credits buy` flow
 * (epic-49, Phase 2).
 *
 * Uses an authenticated Turbo client — the SDK's `getBalance()` (no args)
 * returns the balance for the signer's native address. Passing an explicit
 * address is also supported, but for the standard CLI flow the signer's
 * address IS the address we want to query.
 *
 * Pure business logic. The CLI handler formats the winc into a human
 * readable `~N MB` string via `formatWincAsBytes`.
 */

import { TurboFactory } from '@ardrive/turbo-sdk/node';

import type { NodeType } from '../docker/types.js';
import type { WalletManager } from '../wallet/manager.js';
import { buildTurboSigner, type TurboTokenId } from '../wallet/turbo-signer.js';

export interface GetCreditBalanceOptions {
  wallet: WalletManager;
  nodeType: NodeType;
  token: TurboTokenId;
  /** Optional explicit address to query — defaults to signer's address. */
  address?: string;
}

export interface CreditBalanceResult {
  /** Spendable winc balance (per Turbo's `winc` field). */
  winc: bigint;
  /**
   * Winc + currently-revocable approvals (per Turbo's `controlledWinc`).
   * Higher than `winc` when the operator has shared credits with another
   * address that haven't been spent.
   */
  controlledWinc: bigint;
  /**
   * Winc the user can currently spend including received approvals from
   * other addresses (per Turbo's `effectiveBalance`).
   */
  effectiveBalance: bigint;
  /** The address whose balance was queried (funding-identity native form). */
  address: string;
}

/**
 * Fetch the Turbo credit balance held by the funding identity for `nodeType`.
 *
 * Throws on Turbo SDK network errors — the CLI handler should catch and
 * surface a clean operator-facing message.
 */
export async function getCreditBalance(
  opts: GetCreditBalanceOptions
): Promise<CreditBalanceResult> {
  const { wallet, nodeType, token, address: explicitAddress } = opts;

  const {
    signer,
    token: canonicalToken,
    address: signerAddress,
  } = await buildTurboSigner(wallet, nodeType, token);

  const turbo = TurboFactory.authenticated({
    signer,
    token: canonicalToken,
  });

  // Pass the explicit address when supplied so callers can query a different
  // recipient (Phase 4: query the DVM's Arweave address from a SOL signer).
  // Omit otherwise to use the signer's native address.
  const balance = explicitAddress
    ? await turbo.getBalance(explicitAddress)
    : await turbo.getBalance();

  return {
    winc: BigInt(balance.winc),
    controlledWinc: BigInt(balance.controlledWinc),
    effectiveBalance: BigInt(balance.effectiveBalance),
    address: explicitAddress ?? signerAddress,
  };
}
