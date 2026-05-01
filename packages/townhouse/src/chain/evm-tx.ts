/**
 * EVM transaction construction and broadcast helpers.
 * Uses viem for EIP-1559 tx construction, signing, and receipt polling.
 * SECURITY: private keys are never logged.
 */

import {
  createWalletClient,
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  parseAbi,
  type Hash,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { TransactionReceiptPayload } from '../api/types.js';

function toViemPrivkey(raw: Uint8Array): `0x${string}` {
  const hex = Buffer.from(raw).toString('hex');
  return `0x${hex}` as `0x${string}`;
}

/** Build a viem chain object pinned to the runtime-fetched chainId so EIP-155
 *  replay protection is enforced. Refusing `chain: null` is the whole point. */
function buildChain(rpcUrl: string, chainId: number) {
  return defineChain({
    id: chainId,
    name: `evm-${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
]);

export async function signAndBroadcastEthTransfer(
  rpcUrl: string,
  privateKey: Uint8Array,
  recipient: `0x${string}`,
  amount: bigint
): Promise<{ txHash: Hash; chainId: number }> {
  const account = privateKeyToAccount(toViemPrivkey(privateKey));
  const transport = http(rpcUrl);

  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();
  const chain = buildChain(rpcUrl, chainId);

  const walletClient = createWalletClient({ account, transport, chain });

  const txHash = await walletClient.sendTransaction({
    to: recipient,
    value: amount,
    chain,
  });

  return { txHash, chainId };
}

export async function signAndBroadcastUsdcTransfer(
  rpcUrl: string,
  usdcAddress: `0x${string}`,
  privateKey: Uint8Array,
  recipient: `0x${string}`,
  amount: bigint
): Promise<{ txHash: Hash; chainId: number }> {
  const account = privateKeyToAccount(toViemPrivkey(privateKey));
  const transport = http(rpcUrl);

  const publicClient = createPublicClient({ transport });
  const chainId = await publicClient.getChainId();
  const chain = buildChain(rpcUrl, chainId);

  const walletClient = createWalletClient({ account, transport, chain });

  const txHash = await walletClient.writeContract({
    address: usdcAddress,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [recipient, amount],
    chain,
  });

  return { txHash, chainId };
}

export async function getReceipt(
  rpcUrl: string,
  txHash: Hash
): Promise<TransactionReceiptPayload> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
    if (!receipt) return { status: 'pending', txHash };
    return {
      status: receipt.status === 'success' ? 'success' : 'reverted',
      blockNumber: Number(receipt.blockNumber),
      txHash,
    };
  } catch (e) {
    // Receipt not found yet
    if (e instanceof Error && e.message.includes('not found')) {
      return { status: 'pending', txHash };
    }
    throw e;
  }
}

export async function estimateNativeTransferGas(
  rpcUrl: string,
  fromAddress: `0x${string}`,
  recipient: `0x${string}`,
  amount: bigint
): Promise<{ gas: string; fee: string }> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const [gas, gasPrice] = await Promise.all([
    publicClient.estimateGas({ account: fromAddress, to: recipient, value: amount }),
    publicClient.getGasPrice(),
  ]);
  const fee = gas * gasPrice;
  return { gas: gas.toString(), fee: fee.toString() };
}

/** Estimate gas for an ERC-20 `transfer(to, amount)` call.
 *  Native transfer is ~21k; ERC-20 transfer is ~50-65k — using the native
 *  estimator for USDC under-reports the fee by ~3×. */
export async function estimateUsdcTransferGas(
  rpcUrl: string,
  fromAddress: `0x${string}`,
  usdcAddress: `0x${string}`,
  recipient: `0x${string}`,
  amount: bigint
): Promise<{ gas: string; fee: string }> {
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const data = encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [recipient, amount],
  });
  const [gas, gasPrice] = await Promise.all([
    publicClient.estimateGas({ account: fromAddress, to: usdcAddress, data }),
    publicClient.getGasPrice(),
  ]);
  const fee = gas * gasPrice;
  return { gas: gas.toString(), fee: fee.toString() };
}
