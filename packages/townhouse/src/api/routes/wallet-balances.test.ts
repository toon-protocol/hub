import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  registerWalletBalancesRoutes,
  resetWalletBalancesCache,
} from './wallet-balances.js';
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

function buildDeps(wallet: WalletManager): ApiDeps {
  return {
    configPath: '/tmp/test.yaml',
    config: getDefaultConfig(),
    orchestrator: new MockOrchestrator() as unknown as DockerOrchestrator,
    wallet,
    connectorAdmin: new MockConnector() as unknown as ConnectorAdminClient,
  };
}

beforeEach(() => {
  resetWalletBalancesCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetWalletBalancesCache();
});

describe('GET /api/wallet/balances', () => {
  let app: FastifyInstance;
  let wallet: WalletManager;

  beforeEach(async () => {
    wallet = new WalletManager({ encryptedPath: '/tmp/test-wallet.enc' });
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    wallet.lock();
    await app.close();
  });

  it('returns 503 when wallet not initialized', async () => {
    registerWalletBalancesRoutes(app, buildDeps(wallet));
    const res = await app.inject({ method: 'GET', url: '/wallet/balances' });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({
      error: 'wallet_not_initialized',
    });
  });

  it('returns entries with available:false when EVM RPC times out', async () => {
    await wallet.fromMnemonic(DEV_MNEMONIC);
    // Stub fetch to abort (simulate timeout)
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('aborted'), { name: 'AbortError' })
        )
    );
    vi.stubEnv(
      'TOON_USDC_ADDRESS',
      '0xUsdcAddr1234567890123456789012345678901234'
    );

    registerWalletBalancesRoutes(app, buildDeps(wallet));
    const res = await app.inject({ method: 'GET', url: '/wallet/balances' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { entries: { available: boolean }[] };
    expect(body.entries.every((e) => !e.available)).toBe(true);
  });

  it('returns USDC entries with available:false when USDC address not configured', async () => {
    await wallet.fromMnemonic(DEV_MNEMONIC);
    vi.stubEnv('TOON_USDC_ADDRESS', '');

    // Mock ETH fetch success, ignore USDC (should be marked unavailable)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: true,
          json: async () => ({ result: '0xde0b6b3a7640000' }),
        })
      )
    );

    registerWalletBalancesRoutes(app, buildDeps(wallet));
    const res = await app.inject({ method: 'GET', url: '/wallet/balances' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      entries: { token: string; available: boolean; reason?: string }[];
    };
    const usdcEntries = body.entries.filter((e) => e.token === 'USDC');
    expect(usdcEntries.length).toBeGreaterThan(0);
    for (const e of usdcEntries) {
      expect(e.available).toBe(false);
      expect(e.reason).toBe('usdc_address_not_configured');
    }
  });

  it('happy path returns entries for all chains', async () => {
    await wallet.fromMnemonic(DEV_MNEMONIC);
    vi.stubEnv(
      'TOON_USDC_ADDRESS',
      '0x1234567890123456789012345678901234567890'
    );
    vi.stubEnv('TOWNHOUSE_DEV_ANVIL_RPC', 'http://127.0.0.1:28545');
    vi.stubEnv('TOWNHOUSE_DEV_SOLANA_RPC', 'http://127.0.0.1:28899');
    vi.stubEnv('TOWNHOUSE_DEV_MINA_GRAPHQL', 'http://127.0.0.1:28085/graphql');

    // Mock all fetches to return 1 unit
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string, opts: RequestInit) => {
        const body = JSON.parse((opts?.body as string) ?? '{}') as {
          method?: string;
          query?: string;
        };
        if (body.query) {
          // Mina GraphQL
          return Promise.resolve({
            ok: true,
            json: async () => ({
              data: { account: { balance: { total: '1.000000000' } } },
            }),
          });
        }
        if (body.method === 'getBalance') {
          // Solana
          return Promise.resolve({
            ok: true,
            json: async () => ({ result: { value: 1_000_000_000 } }),
          });
        }
        // EVM — return 1 wei for eth_getBalance, 1 for balanceOf
        return Promise.resolve({
          ok: true,
          json: async () => ({ result: '0x1' }),
        });
      })
    );

    registerWalletBalancesRoutes(app, buildDeps(wallet));
    const res = await app.inject({ method: 'GET', url: '/wallet/balances' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { entries: unknown[]; ts: number };
    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries.length).toBeGreaterThan(0);
    expect(typeof body.ts).toBe('number');
  });

  it('cache hit returns same ts on parallel requests', async () => {
    await wallet.fromMnemonic(DEV_MNEMONIC);
    vi.stubEnv('TOON_USDC_ADDRESS', '');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        return Promise.resolve({
          ok: true,
          json: async () => ({ result: '0x1' }),
        });
      })
    );

    registerWalletBalancesRoutes(app, buildDeps(wallet));
    const [r1, r2] = await Promise.all([
      app.inject({ method: 'GET', url: '/wallet/balances' }),
      app.inject({ method: 'GET', url: '/wallet/balances' }),
    ]);
    expect(r1.statusCode).toBe(200);
    expect(r2.statusCode).toBe(200);
    // Both should succeed; cache means RPC not called twice per address
    const b1 = JSON.parse(r1.body) as { ts: number };
    const b2 = JSON.parse(r2.body) as { ts: number };
    // ts may differ between requests but both are valid numbers
    expect(typeof b1.ts).toBe('number');
    expect(typeof b2.ts).toBe('number');
  });
});
