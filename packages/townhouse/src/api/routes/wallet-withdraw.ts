/**
 * POST /api/wallet/withdraw — EVM-only signed withdrawal (v1)
 * GET  /api/wallet/transaction/:txHash — receipt polling
 *
 * SECURITY: Private keys and signed-tx hex are never logged.
 * Localhost-only boundary enforced by the API server bind address.
 */

import type { FastifyInstance } from 'fastify';
import { isAddress } from 'viem';
import type {
  ApiDeps,
  WithdrawRequest,
  WithdrawSuccessResponse,
  WithdrawDryRunResponse,
  TransactionReceiptPayload,
} from '../types.js';
import {
  signAndBroadcastEthTransfer,
  signAndBroadcastUsdcTransfer,
  getReceipt,
  estimateNativeTransferGas,
  estimateUsdcTransferGas,
} from '../../chain/evm-tx.js';
import { getEvmBalance, getErc20Balance } from '../../chain/evm-rpc.js';
import type { NodeType } from '../../docker/types.js';

const NODE_TYPES = new Set<string>(['town', 'mill', 'dvm']);

/** Map a thrown viem/fetch error to an "RPC unreachable" verdict.
 *  Replaces brittle `e.message.includes('fetch')` substring matching, which
 *  over-catches viem strings like "could not fetch nonce" (a real broadcast
 *  failure, not a transport problem). */
function isRpcUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  // Node fetch / undici surface transport failures as TypeError with a `cause`
  // whose `code` is set to one of these. Anything else is a real broadcast
  // failure that should propagate as 500 broadcast_failed.
  const cause = (e as { cause?: { code?: string } }).cause;
  if (cause?.code) {
    return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT'].includes(cause.code);
  }
  // Bare TypeError "fetch failed" (no cause attached, e.g. mocked failures in
  // tests) — match exact viem fetch-failure strings, not the looser substring.
  return /^fetch failed$/i.test(e.message) || /HTTP request failed/i.test(e.message);
}

export function registerWalletWithdrawRoutes(app: FastifyInstance, deps: ApiDeps): void {
  // POST /wallet/withdraw
  app.post('/wallet/withdraw', async (request, reply) => {
    const body = request.body as Partial<WithdrawRequest>;

    // Validate nodeType
    if (!body.nodeType || !NODE_TYPES.has(body.nodeType)) {
      return reply.status(400).send({ error: 'invalid_node_type', message: 'nodeType must be town, mill, or dvm' });
    }

    // v1: EVM-only; Solana/Mina → 501
    if (body.chainFamily === 'solana' || body.chainFamily === 'mina') {
      return reply.status(501).send({
        error: 'chain_not_supported_for_withdrawal',
        message: `${body.chainFamily} withdrawal coming soon — copy the address and use an external wallet for now`,
        supportedFamilies: ['evm'],
      });
    }
    if (body.chainFamily !== 'evm') {
      return reply.status(400).send({ error: 'invalid_chain_family', message: 'chainFamily must be evm, solana, or mina' });
    }

    // Validate token
    if (body.token !== 'native' && body.token !== 'USDC') {
      return reply.status(400).send({ error: 'invalid_token', message: 'token must be native or USDC' });
    }

    // Validate recipient — regex + viem isAddress for EIP-55
    const recipient = body.recipient ?? '';
    if (!/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
      return reply.status(400).send({ error: 'invalid_recipient', code: 'invalid_recipient_format' });
    }
    if (!isAddress(recipient)) {
      return reply.status(400).send({ error: 'invalid_recipient', code: 'invalid_recipient_checksum' });
    }

    // Validate amount
    let amountBig: bigint;
    try {
      amountBig = BigInt(body.amount ?? '');
      if (amountBig <= 0n) throw new Error('non-positive');
    } catch {
      return reply.status(400).send({ error: 'invalid_amount', message: 'amount must be a positive integer string (raw units)' });
    }

    const anvil = process.env['TOWNHOUSE_DEV_ANVIL_RPC'] ?? 'http://127.0.0.1:28545';
    const usdcAddress = (process.env['TOON_USDC_ADDRESS'] || undefined) as `0x${string}` | undefined;

    // Get keys
    let nodeKeys: ReturnType<typeof deps.wallet.getNodeKeys>;
    try {
      nodeKeys = deps.wallet.getNodeKeys(body.nodeType as NodeType);
    } catch {
      return reply.status(503).send({ error: 'wallet_not_initialized' });
    }

    const evmAddress = nodeKeys.evmAddress as `0x${string}`;

    // USDC config is a server-side requirement, not user input — 503 not 400.
    if (body.token === 'USDC' && !usdcAddress) {
      return reply.status(503).send({ error: 'usdc_address_not_configured', message: 'TOON_USDC_ADDRESS not set on server' });
    }

    // Balance check + gas-aware native cap.
    let onChainBalance: bigint;
    let estimateForGuard: { gas: string; fee: string } | null = null;
    try {
      if (body.token === 'native') {
        onChainBalance = BigInt(await getEvmBalance(anvil, evmAddress));
      } else {
        // USDC — gas is paid in native ETH, not the USDC balance.
        onChainBalance = BigInt(await getErc20Balance(anvil, usdcAddress!, evmAddress));
      }
      if (amountBig > onChainBalance) {
        return reply.status(400).send({ error: 'insufficient_balance', code: 'insufficient_balance' });
      }
      // Native-only gas headroom check: a "Max" withdraw passes the raw
      // balance check then fails at broadcast with "insufficient funds for
      // gas * price + value". Reject early with a distinct code so the UI
      // can surface "leave headroom for fees".
      if (body.token === 'native') {
        try {
          estimateForGuard = await estimateNativeTransferGas(anvil, evmAddress, recipient as `0x${string}`, amountBig);
          const fee = BigInt(estimateForGuard.fee);
          if (amountBig + fee > onChainBalance) {
            return reply.status(400).send({
              error: 'insufficient_balance',
              code: 'insufficient_balance_for_gas',
              message: 'amount + estimated gas exceeds balance — leave headroom for fees',
            });
          }
        } catch {
          // Estimate unavailable — broadcast will surface the real reason.
        }
      }
    } catch (e) {
      if (isRpcUnreachable(e)) {
        return reply.status(503).send({ error: 'rpc_unreachable' });
      }
      throw e;
    }

    // dryRun: return gas estimate without broadcasting. Estimator must match
    // the broadcast path or the displayed fee under-reports for ERC-20.
    if (body.dryRun === true) {
      try {
        const est =
          body.token === 'native'
            ? estimateForGuard ?? await estimateNativeTransferGas(anvil, evmAddress, recipient as `0x${string}`, amountBig)
            : await estimateUsdcTransferGas(anvil, evmAddress, usdcAddress!, recipient as `0x${string}`, amountBig);
        const response: WithdrawDryRunResponse = { estimatedGas: est.gas, estimatedFee: est.fee };
        return reply.status(200).send(response);
      } catch (e) {
        if (isRpcUnreachable(e)) {
          return reply.status(503).send({ error: 'rpc_unreachable' });
        }
        throw e;
      }
    }

    // Broadcast
    try {
      let txHash: `0x${string}`;
      let chainId: number;

      if (body.token === 'native') {
        const result = await signAndBroadcastEthTransfer(
          anvil,
          nodeKeys.evmPrivateKey,
          recipient as `0x${string}`,
          amountBig
        );
        txHash = result.txHash;
        chainId = result.chainId;
      } else {
        const result = await signAndBroadcastUsdcTransfer(
          anvil,
          usdcAddress!,
          nodeKeys.evmPrivateKey,
          recipient as `0x${string}`,
          amountBig
        );
        txHash = result.txHash;
        chainId = result.chainId;
      }

      const response: WithdrawSuccessResponse = { txHash, chainId };
      return reply.status(200).send(response);
    } catch (e) {
      if (isRpcUnreachable(e)) {
        return reply.status(503).send({ error: 'rpc_unreachable' });
      }
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(500).send({ error: 'broadcast_failed', message: msg });
    }
  });

  // GET /wallet/transaction/:txHash
  app.get<{ Params: { txHash: string } }>(
    '/wallet/transaction/:txHash',
    async (request, reply) => {
      const { txHash } = request.params;

      if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
        return reply.status(400).send({ error: 'invalid_tx_hash', message: 'txHash must be a 0x-prefixed 32-byte hex string' });
      }

      const anvil = process.env['TOWNHOUSE_DEV_ANVIL_RPC'] ?? 'http://127.0.0.1:28545';
      try {
        const receipt: TransactionReceiptPayload = await getReceipt(anvil, txHash as `0x${string}`);
        return reply.status(200).send(receipt);
      } catch (e) {
        if (isRpcUnreachable(e)) {
          return reply.status(503).send({ error: 'rpc_unreachable' });
        }
        throw e;
      }
    }
  );
}
