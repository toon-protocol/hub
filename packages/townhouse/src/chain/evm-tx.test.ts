import { describe, it, expect, vi } from 'vitest';
import {
  signAndBroadcastEthTransfer,
  signAndBroadcastUsdcTransfer,
  getReceipt,
  estimateNativeTransferGas,
} from './evm-tx.js';

const HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const CHAIN_ID = 31337;

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      sendTransaction: vi.fn().mockResolvedValue(HASH),
      writeContract: vi.fn().mockResolvedValue(HASH),
    })),
    createPublicClient: vi.fn(() => ({
      getChainId: vi.fn().mockResolvedValue(CHAIN_ID),
      getTransactionReceipt: vi
        .fn()
        .mockResolvedValue({ status: 'success', blockNumber: 1n }),
      estimateGas: vi.fn().mockResolvedValue(21000n),
      getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n),
    })),
    parseAbi: actual.parseAbi,
    http: actual.http,
  };
});

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi
    .fn()
    .mockReturnValue({ address: '0x1234' as `0x${string}` }),
}));

describe('evm-tx helpers', () => {
  it('signAndBroadcastEthTransfer returns txHash and chainId', async () => {
    const key = new Uint8Array(32).fill(1);
    const result = await signAndBroadcastEthTransfer(
      'http://localhost:28545',
      key,
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      BigInt('100000000000000000')
    );
    expect(result.txHash).toBe(HASH);
    expect(result.chainId).toBe(CHAIN_ID);
  });

  it('signAndBroadcastUsdcTransfer returns txHash and chainId', async () => {
    const key = new Uint8Array(32).fill(1);
    const result = await signAndBroadcastUsdcTransfer(
      'http://localhost:28545',
      '0x1234567890123456789012345678901234567890',
      key,
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      BigInt('1000000')
    );
    expect(result.txHash).toBe(HASH);
  });

  it('getReceipt returns success status', async () => {
    const receipt = await getReceipt('http://localhost:28545', HASH);
    expect(receipt.status).toBe('success');
    expect(receipt.blockNumber).toBe(1);
  });

  it('estimateNativeTransferGas returns gas and fee', async () => {
    const est = await estimateNativeTransferGas(
      'http://localhost:28545',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      BigInt('1')
    );
    expect(est.gas).toBe('21000');
    expect(est.fee).toBe((21000n * 1_000_000_000n).toString());
  });
});
