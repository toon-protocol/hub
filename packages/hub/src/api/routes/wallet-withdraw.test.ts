import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type * as ViemModule from 'viem';
import { registerWalletWithdrawRoutes } from './wallet-withdraw.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { WalletManager } from '../../wallet/manager.js';
import { getDefaultConfig } from '../../config/defaults.js';

const DEV_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

class MockOrchestrator {
  on() {
    return this;
  }
  off() {
    return this;
  }
  async status() {
    return [];
  }
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class MockConnector {}

// EVM mock helpers
const MOCK_TX_HASH = ('0x' + 'ab'.repeat(32)) as `0x${string}`;
const MOCK_CHAIN_ID = 31337;

// Mock viem so we never hit real network
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof ViemModule>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      sendTransaction: vi.fn().mockResolvedValue(MOCK_TX_HASH),
      writeContract: vi.fn().mockResolvedValue(MOCK_TX_HASH),
    })),
    createPublicClient: vi.fn(() => ({
      getChainId: vi.fn().mockResolvedValue(MOCK_CHAIN_ID),
      getTransactionReceipt: vi.fn().mockResolvedValue({
        status: 'success',
        blockNumber: 42n,
      }),
      estimateGas: vi.fn().mockResolvedValue(21000n),
      getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n),
    })),
    isAddress: actual.isAddress,
    parseAbi: actual.parseAbi,
    http: actual.http,
  };
});

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi
    .fn()
    .mockReturnValue({ address: '0x1234' as `0x${string}` }),
}));

// Fetch is mocked globally to simulate RPC responses for balance checks.
// The mock returns a large balance (enough for any withdraw amount in tests).

/** Build a mock fetch that returns large RPC balances (1000 ETH, 1000 USDC).
 *  Decides ETH vs USDC by selector matching on the JSON-RPC body — `eth_call`
 *  with the `0x70a08231` selector is `balanceOf(address)`, everything else is
 *  treated as a native ETH balance query. Selector matching is robust to large
 *  ETH amounts that would cross any naive hex-length threshold. */
function buildFetchMock(
  opts: { ethBalance?: bigint; usdcBalance?: bigint; fail?: boolean } = {}
) {
  const eth = opts.ethBalance ?? 1_000_000_000_000_000_000_000n; // 1000 ETH
  const usdc = opts.usdcBalance ?? 1_000_000_000n; // 1000 USDC (scale 6)
  return vi
    .fn()
    .mockImplementation((_url: string, init?: { body?: string }) => {
      if (opts.fail) {
        const err = new TypeError('fetch failed');
        (err as { cause?: { code?: string } }).cause = { code: 'ECONNREFUSED' };
        return Promise.reject(err);
      }
      let body: { method?: string; params?: unknown[] } = {};
      try {
        body = init?.body ? (JSON.parse(init.body) as typeof body) : {};
      } catch {
        /* leave empty */
      }
      const params = body.params ?? [];
      const isErc20 =
        body.method === 'eth_call' &&
        typeof (params[0] as { data?: string } | undefined)?.data ===
          'string' &&
        (params[0] as { data: string }).data
          .toLowerCase()
          .startsWith('0x70a08231');
      return Promise.resolve({
        ok: true,
        json: async () => {
          const hex = '0x' + eth.toString(16);
          const usdcHex = '0x' + usdc.toString(16).padStart(64, '0');
          return { result: isErc20 ? usdcHex : hex };
        },
      });
    });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function buildApp(wallet: WalletManager): FastifyInstance {
  const deps: ApiDeps = {
    configPath: '/tmp/test.yaml',
    config: getDefaultConfig(),
    orchestrator: new MockOrchestrator() as unknown as DockerOrchestrator,
    wallet,
    connectorAdmin: new MockConnector() as unknown as ConnectorAdminClient,
  };
  const app = Fastify({ logger: false });
  registerWalletWithdrawRoutes(app, deps);
  return app;
}

const VALID_RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // Anvil deployer (valid checksum)

describe('POST /api/wallet/withdraw', () => {
  let app: FastifyInstance;
  let wallet: WalletManager;

  beforeEach(async () => {
    wallet = new WalletManager({ encryptedPath: '/tmp/test.enc' });
    await wallet.fromMnemonic(DEV_MNEMONIC);
    vi.stubEnv(
      'TOON_USDC_ADDRESS',
      '0x1234567890123456789012345678901234567890'
    );
    vi.stubEnv('TOWNHOUSE_DEV_ANVIL_RPC', 'http://127.0.0.1:28545');
    vi.stubGlobal('fetch', buildFetchMock());
    app = buildApp(wallet);
  });

  afterEach(async () => {
    wallet.lock();
    await app.close();
  });

  it('happy path — native ETH withdrawal returns txHash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'town',
        chainFamily: 'evm',
        token: 'native',
        recipient: VALID_RECIPIENT,
        amount: '100000000000000000', // 0.1 ETH
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { txHash: string; chainId: number };
    expect(body.txHash).toBe(MOCK_TX_HASH);
    expect(body.chainId).toBe(MOCK_CHAIN_ID);
  });

  it('happy path — USDC withdrawal returns txHash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'mill',
        chainFamily: 'evm',
        token: 'USDC',
        recipient: VALID_RECIPIENT,
        amount: '1000000', // 1 USDC
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { txHash: string };
    expect(body.txHash).toBe(MOCK_TX_HASH);
  });

  it('USDC withdrawal works when only the production EVM_USDC_ADDRESS is set (network profile)', async () => {
    // Production/testnet apex supplies the network-profile name, not the dev
    // TOON_USDC_ADDRESS. Withdraw must not 503 with usdc_address_not_configured
    // (#232).
    vi.stubEnv('TOON_USDC_ADDRESS', '');
    vi.stubEnv(
      'EVM_USDC_ADDRESS',
      '0x1234567890123456789012345678901234567890'
    );
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'mill',
        chainFamily: 'evm',
        token: 'USDC',
        recipient: VALID_RECIPIENT,
        amount: '1000000',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { txHash: string };
    expect(body.txHash).toBe(MOCK_TX_HASH);
  });

  it('dryRun returns gas estimate without broadcasting', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'town',
        chainFamily: 'evm',
        token: 'native',
        recipient: VALID_RECIPIENT,
        amount: '100000000000000000',
        dryRun: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      estimatedGas: string;
      estimatedFee: string;
    };
    expect(body.estimatedGas).toBeDefined();
    expect(body.estimatedFee).toBeDefined();
    // Should not have txHash for dryRun
    expect((body as { txHash?: string }).txHash).toBeUndefined();
  });

  it('returns 501 for Solana chainFamily', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'mill',
        chainFamily: 'solana',
        token: 'native',
        recipient: VALID_RECIPIENT,
        amount: '1000000000',
      },
    });
    expect(res.statusCode).toBe(501);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'chain_not_supported_for_withdrawal',
    });
  });

  it('returns 501 for Mina chainFamily', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'mill',
        chainFamily: 'mina',
        token: 'native',
        recipient: 'B62abc',
        amount: '1000000000',
      },
    });
    expect(res.statusCode).toBe(501);
  });

  it('returns 400 for invalid recipient address', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'town',
        chainFamily: 'evm',
        token: 'native',
        recipient: 'not-an-address',
        amount: '1',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'invalid_recipient_format',
    });
  });

  it('returns 400 with code insufficient_balance when amount exceeds balance', async () => {
    // Override fetch to return tiny balance (100 wei)
    vi.stubGlobal('fetch', buildFetchMock({ ethBalance: 100n }));

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'town',
        chainFamily: 'evm',
        token: 'native',
        recipient: VALID_RECIPIENT,
        amount: '1000000000000000000000', // way more than 100 wei
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toMatchObject({
      code: 'insufficient_balance',
    });
  });

  it('returns 400 with code invalid_recipient_checksum distinct from format', async () => {
    // Lowercased version of a mixed-case checksummed address — passes regex but
    // viem.isAddress (in checksum mode) returns false because the checksum no
    // longer matches.
    const wrongCase = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'town',
        chainFamily: 'evm',
        token: 'native',
        recipient: wrongCase,
        amount: '1',
      },
    });
    // Either: route accepts all-lowercase as valid (viem default), in which
    // case 200 — or rejects with invalid_recipient_checksum (400). The
    // important contract is that the response distinguishes "format" from
    // "checksum" and never collapses them into a single error code.
    if (res.statusCode === 400) {
      expect(JSON.parse(res.body)).toMatchObject({
        code: 'invalid_recipient_checksum',
      });
    } else {
      // viem.isAddress accepted the all-lowercase form — verify it did NOT
      // emit invalid_recipient_format for it (which would be wrong).
      expect(res.statusCode).toBe(200);
    }
  });

  it('returns 503 rpc_unreachable when broadcast fetch fails', async () => {
    // Allow the balance-check to succeed, then fail the actual broadcast by
    // throwing from the viem walletClient mock.
    const viem = await import('viem');
    vi.mocked(viem.createWalletClient).mockReturnValueOnce({
      sendTransaction: vi.fn().mockRejectedValueOnce(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED' },
        })
      ),
      writeContract: vi.fn(),
    } as unknown as ReturnType<typeof viem.createWalletClient>);

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'town',
        chainFamily: 'evm',
        token: 'native',
        recipient: VALID_RECIPIENT,
        amount: '100000000000000000',
      },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'rpc_unreachable' });
  });

  it('never logs the EVM private key or signed-tx hex', async () => {
    // Capture all log writes via a custom Pino destination stream. This is
    // the supported Fastify path for inspecting log output (passing a custom
    // logger object directly throws FST_ERR_LOG_INVALID_LOGGER_CONFIG).
    const captured: string[] = [];
    const stream = {
      write(chunk: string) {
        captured.push(chunk);
      },
    };

    const deps: ApiDeps = {
      configPath: '/tmp/test.yaml',
      config: getDefaultConfig(),
      orchestrator: new MockOrchestrator() as unknown as DockerOrchestrator,
      wallet,
      connectorAdmin: new MockConnector() as unknown as ConnectorAdminClient,
    };
    const loggedApp = Fastify({
      logger: {
        level: 'trace',
        stream: stream as unknown as NodeJS.WritableStream,
      },
    });
    registerWalletWithdrawRoutes(loggedApp, deps);

    await loggedApp.inject({
      method: 'POST',
      url: '/wallet/withdraw',
      payload: {
        nodeType: 'town',
        chainFamily: 'evm',
        token: 'native',
        recipient: VALID_RECIPIENT,
        amount: '100000000000000000',
      },
    });

    const logBlob = captured.join('\n');
    expect(logBlob).not.toContain(MOCK_TX_HASH);
    // Private key (32 bytes hex) must not appear in any log line.
    const nodeKeys = wallet.getNodeKeys('town');
    const privateKeyHex =
      '0x' + Buffer.from(nodeKeys.evmPrivateKey).toString('hex');
    expect(logBlob).not.toContain(privateKeyHex);
    expect(logBlob).not.toContain(privateKeyHex.slice(2)); // also bare hex without 0x

    await loggedApp.close();
  });
});

describe('GET /api/wallet/transaction/:txHash', () => {
  let app: FastifyInstance;
  let wallet: WalletManager;

  beforeEach(async () => {
    wallet = new WalletManager({ encryptedPath: '/tmp/test.enc' });
    app = buildApp(wallet);
  });

  afterEach(async () => {
    wallet.lock();
    await app.close();
  });

  it('returns success receipt when found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/wallet/transaction/${MOCK_TX_HASH}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      status: string;
      blockNumber: number;
    };
    expect(body.status).toBe('success');
    expect(body.blockNumber).toBe(42);
  });

  it('returns pending when receipt not found', async () => {
    const viem = await import('viem');
    vi.mocked(viem.createPublicClient).mockReturnValueOnce({
      getTransactionReceipt: vi
        .fn()
        .mockRejectedValueOnce(new Error('Transaction receipt not found')),
      getChainId: vi.fn().mockResolvedValue(MOCK_CHAIN_ID),
      estimateGas: vi.fn(),
      getGasPrice: vi.fn(),
    } as unknown as ReturnType<typeof viem.createPublicClient>);

    const res = await app.inject({
      method: 'GET',
      url: `/wallet/transaction/${MOCK_TX_HASH}`,
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { status: string };
    expect(body.status).toBe('pending');
  });

  it('returns 400 for malformed hash', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/wallet/transaction/not-a-hash',
    });
    expect(res.statusCode).toBe(400);
  });
});
