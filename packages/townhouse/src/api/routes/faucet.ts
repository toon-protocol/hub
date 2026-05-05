/**
 * POST /api/faucet — operator-facing dev faucet for Town EVM + SOL devnets.
 *
 * Request:
 *   { chain: 'evm' | 'solana', recipient: string, amount?: number }
 *
 * Response (200):
 *   { tx: string, explorerUrl?: string, recipient: string, chain }
 *
 * Resolves the chain RPC URL the same way the demo preset does — leases.json
 * if present, local devnet fallback otherwise. Replicates the JSON-RPC logic
 * of `scripts/faucet-{evm,sol}.sh` so the dashboard doesn't have to shell out.
 *
 * EVM path (anvil dev RPCs only — meaningless on a real chain):
 *   1. anvil_setBalance — top up native ETH (no key needed; dev RPC)
 *   2. anvil_impersonateAccount + eth_sendTransaction + stop — ERC-20
 *      transfer of Mock USDC from the deployer (account[0]) so we don't
 *      have to hold a private key in the route.
 *
 * Solana path:
 *   1. requestAirdrop — top up native SOL (test-validator dev RPC, no key)
 *   2. SPL TransferChecked — Mock USDC drip from the faucet treasury, signed
 *      by the bootstrap-baked authority keypair (loaded from
 *      infra/solana/keys/faucet-authority.json — public dev key, like
 *      Anvil's account[0]). Recipient ATA is created on-the-fly if missing.
 *      If the mint doesn't exist (older lease pre-bootstrap), we silently
 *      skip the USDC step and return the SOL airdrop sig.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { FastifyInstance } from 'fastify';

import type { ApiDeps } from '../types.js';
import {
  buildExplorerUrl,
  loadLeases,
  type AkashLeasesForExplorer,
} from '../../earnings/explorer-links.js';
import {
  createAssociatedTokenAccount,
  deriveATA,
  getAccountInfo,
  keypairFromJsonArray,
  makeRpc,
  requestAirdrop as splRequestAirdrop,
  transferChecked,
  waitForConfirmation,
  type Keypair as SolanaKeypair,
} from '../../../../../infra/solana/spl-primitives.mjs';

/** Same fallback URLs the demo preset uses (`presets/demo.ts`). */
const LOCAL_EVM_RPC = 'http://localhost:28545';
const LOCAL_SOL_RPC = 'http://localhost:28899';

/** Hardcoded fixtures from the Anvil entrypoint — see `docker/Dockerfile.akash-anvil`. */
const ANVIL_DEPLOYER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const MOCK_USDC_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/** Mock USDC mint pubkey + faucet authority, baked at Solana validator boot.
 *  See infra/solana/bootstrap-usdc.mjs and infra/solana/keys/. */
const SOLANA_USDC_MINT = '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q';
const SOLANA_USDC_DECIMALS = 6;
const SOLANA_FAUCET_AUTHORITY = 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3';

/** Optional knob for tests — pins the leases.json path. */
export const FAUCET_LEASES_PATH_OVERRIDE: { value: string | null } = {
  value: null,
};

/** Optional knob for tests — pins the Solana faucet-authority keypair path. */
export const FAUCET_AUTHORITY_PATH_OVERRIDE: { value: string | null } = {
  value: null,
};

const DEFAULT_LEASES_PATH = (): string =>
  FAUCET_LEASES_PATH_OVERRIDE.value ??
  resolve(process.cwd(), 'deploy', 'akash', 'leases.json');

const DEFAULT_AUTHORITY_PATH = (): string =>
  FAUCET_AUTHORITY_PATH_OVERRIDE.value ??
  resolve(process.cwd(), 'infra', 'solana', 'keys', 'faucet-authority.json');

let cachedAuthority: SolanaKeypair | null = null;
function loadFaucetAuthority(): SolanaKeypair | null {
  if (cachedAuthority) return cachedAuthority;
  try {
    const arr = JSON.parse(readFileSync(DEFAULT_AUTHORITY_PATH(), 'utf8')) as number[];
    cachedAuthority = keypairFromJsonArray(arr);
    if (cachedAuthority.pubkeyBase58 !== SOLANA_FAUCET_AUTHORITY) {
      // Defensive: fail loud rather than silently sign with the wrong key.
      throw new Error(
        `faucet authority pubkey mismatch: file=${cachedAuthority.pubkeyBase58} const=${SOLANA_FAUCET_AUTHORITY}`
      );
    }
    return cachedAuthority;
  } catch (err) {
    // Missing keypair = USDC drip disabled; SOL drip still works.
    return null;
  }
}

interface FaucetRequestBody {
  chain: 'evm' | 'solana';
  recipient: string;
  amount?: number;
}

interface FaucetResponse {
  tx: string;
  explorerUrl?: string;
  recipient: string;
  chain: 'evm' | 'solana';
}

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function evmRpcUrl(leases: AkashLeasesForExplorer | null): string {
  return leases?.anvil?.url ?? LOCAL_EVM_RPC;
}

function solRpcUrl(leases: AkashLeasesForExplorer | null): string {
  return leases?.solana?.url ?? LOCAL_SOL_RPC;
}

/** BigInt-safe decimal-string * 10^18 → hex (no leading 0x) for ERC-20 amount encoding. */
function decimalTimesE18ToHex(decimal: number): string {
  // Treat as integer USDC amount; if the user passes 0.5 we floor it (USDC
  // entrypoint funded whole-number balances, fractional drips aren't useful).
  const whole = BigInt(Math.floor(decimal));
  return (whole * 10n ** 18n).toString(16);
}

function ethToWeiHex(eth: number): string {
  return '0x' + (BigInt(Math.floor(eth)) * 10n ** 18n).toString(16);
}

function pad32(hex: string): string {
  return hex.padStart(64, '0');
}

async function rpc<T = unknown>(
  url: string,
  method: string,
  params: unknown[]
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) {
    throw new Error(`${method} failed: ${json.error.message}`);
  }
  return json.result as T;
}

async function dripEvm(
  recipient: string,
  amount: number,
  rpcUrl: string
): Promise<string> {
  // 1. Top up ETH via anvil_setBalance.
  await rpc(rpcUrl, 'anvil_setBalance', [
    recipient,
    ethToWeiHex(Math.max(amount, 1)),
  ]);

  // 2. Impersonate the deployer so we don't need to hold a private key.
  await rpc(rpcUrl, 'anvil_impersonateAccount', [ANVIL_DEPLOYER_ADDRESS]);
  try {
    // ERC-20 transfer(address,uint256) selector = 0xa9059cbb.
    const data =
      '0xa9059cbb' +
      pad32(recipient.slice(2).toLowerCase()) +
      pad32(decimalTimesE18ToHex(amount));
    const txHash = await rpc<string>(rpcUrl, 'eth_sendTransaction', [
      {
        from: ANVIL_DEPLOYER_ADDRESS,
        to: MOCK_USDC_ADDRESS,
        data,
        gas: '0x100000',
      },
    ]);
    return txHash;
  } finally {
    await rpc(rpcUrl, 'anvil_stopImpersonatingAccount', [
      ANVIL_DEPLOYER_ADDRESS,
    ]).catch(() => {
      // Stop-impersonate failure is non-fatal; the dev chain resets the
      // impersonation list on its own. Don't mask the original tx success.
    });
  }
}

async function dripSol(
  recipient: string,
  amount: number,
  rpcUrl: string
): Promise<string> {
  // SOL drip — `amount` is interpreted as USDC for parity with EVM, with a
  // fixed 1 SOL native top-up. Keeps the dashboard's chain toggle predictable
  // (the input field always means "USDC") and avoids accidentally minting
  // huge SOL balances when an operator types a USDC amount.
  const splRpc = makeRpc(rpcUrl);
  const sigSol = await splRequestAirdrop(splRpc, recipient, 1_000_000_000);
  await waitForConfirmation(splRpc, sigSol).catch(() => {
    // Airdrop confirmation timeout is non-fatal — the SPL transfer below
    // will fail loudly if the recipient still has 0 SOL when its ATA is
    // created. We don't want a slow-finalizing validator to block the drip
    // outright if the airdrop has already been seen.
  });

  // No mint baked in / authority key not available → SOL-only drip.
  const authority = loadFaucetAuthority();
  if (!authority) return sigSol;
  const mintInfo = await getAccountInfo(splRpc, SOLANA_USDC_MINT);
  if (!mintInfo) return sigSol;

  // Ensure recipient has an ATA (idempotent — short-circuits if it exists).
  const recipientAta = await createAssociatedTokenAccount(
    splRpc,
    authority,
    recipient,
    SOLANA_USDC_MINT
  );

  // Treasury ATA is owned by the faucet authority (created at bootstrap).
  const treasuryAta = deriveATA(SOLANA_FAUCET_AUTHORITY, SOLANA_USDC_MINT);

  // amount is in whole USDC; convert to base units (decimals=6).
  const baseUnits = BigInt(Math.floor(Math.max(amount, 0))) * 1_000_000n;

  return await transferChecked(
    splRpc,
    authority,
    treasuryAta,
    SOLANA_USDC_MINT,
    recipientAta,
    authority,
    baseUnits,
    SOLANA_USDC_DECIMALS
  );
}

export function registerFaucetRoutes(
  app: FastifyInstance,
  _deps: ApiDeps
): void {
  app.post<{ Body: FaucetRequestBody; Reply: FaucetResponse | { error: string } }>(
    '/faucet',
    async (req, reply) => {
      const body = req.body ?? ({} as FaucetRequestBody);

      // Validate chain.
      if (body.chain !== 'evm' && body.chain !== 'solana') {
        return reply.code(400).send({
          error: "chain must be 'evm' or 'solana'",
        });
      }

      // Validate recipient against per-chain regex.
      const recipient = (body.recipient ?? '').trim();
      const re = body.chain === 'evm' ? EVM_ADDRESS_RE : SOLANA_PUBKEY_RE;
      if (!re.test(recipient)) {
        return reply.code(400).send({
          error:
            body.chain === 'evm'
              ? 'recipient must be a 0x-prefixed 40-hex EVM address'
              : 'recipient must be a base58-encoded Solana pubkey',
        });
      }

      // Defaults: 100 USDC drip for both chains, plus a fixed native gas
      // top-up (1 ETH for EVM, 1 SOL for Solana). `amount` always means
      // USDC — the dashboard's UI label mirrors this for both chains.
      const amount =
        typeof body.amount === 'number' && body.amount > 0
          ? body.amount
          : 100;

      const leases = loadLeases(DEFAULT_LEASES_PATH());

      try {
        const tx =
          body.chain === 'evm'
            ? await dripEvm(recipient, amount, evmRpcUrl(leases))
            : await dripSol(recipient, amount, solRpcUrl(leases));

        return reply.code(200).send({
          tx,
          explorerUrl: buildExplorerUrl(body.chain, tx, leases),
          recipient,
          chain: body.chain,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        req.log.error({ err: message }, '[faucet] drip failed');
        return reply.code(502).send({ error: message });
      }
    }
  );
}
