import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerWalletRevealRoutes } from './wallet-reveal.js';
import type { ApiDeps } from '../types.js';
import type { DockerOrchestrator } from '../../docker/orchestrator.js';
import type { ConnectorAdminClient } from '../../connector/admin-client.js';
import { WalletManager } from '../../wallet/manager.js';
import { encryptWallet } from '../../wallet/crypto.js';
import { saveWallet } from '../../wallet/storage.js';
import { getDefaultConfig } from '../../config/defaults.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFile, unlink } from 'node:fs/promises';

const DEV_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const DEV_PASSWORD = 'testpassword123';

class MockOrchestrator {
  on() { return this; }
  off() { return this; }
  async status() { return []; }
}

class MockConnector {}

afterEach(() => {
  vi.restoreAllMocks();
});

async function buildApp(walletPath: string): Promise<FastifyInstance> {
  const wallet = new WalletManager({ encryptedPath: walletPath });
  const config = { ...getDefaultConfig(), wallet: { encrypted_path: walletPath } };
  const deps: ApiDeps = {
    configPath: '/tmp/test.yaml',
    config,
    orchestrator: new MockOrchestrator() as unknown as DockerOrchestrator,
    wallet,
    connectorAdmin: new MockConnector() as unknown as ConnectorAdminClient,
  };
  const app = Fastify({ logger: false });
  registerWalletRevealRoutes(app, deps);
  return app;
}

describe('POST /api/wallet/reveal', () => {
  const walletPath = join(tmpdir(), `test-wallet-${Date.now()}.enc`);
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp(walletPath);
  });

  afterEach(async () => {
    await app.close();
    await unlink(walletPath).catch(() => {});
  });

  it('happy path — returns mnemonic with correct password', async () => {
    const encrypted = encryptWallet(DEV_MNEMONIC, DEV_PASSWORD);
    await saveWallet(walletPath, encrypted);

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/reveal',
      payload: { password: DEV_PASSWORD },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as { mnemonic: string };
    expect(body.mnemonic).toBe(DEV_MNEMONIC);
  });

  it('returns 401 on wrong password', async () => {
    const encrypted = encryptWallet(DEV_MNEMONIC, DEV_PASSWORD);
    await saveWallet(walletPath, encrypted);

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/reveal',
      payload: { password: 'wrongpassword' },
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'invalid_password' });
  });

  it('returns 503 when wallet file is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/reveal',
      payload: { password: DEV_PASSWORD },
    });
    expect(res.statusCode).toBe(503);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'wallet_not_initialized' });
  });

  it('returns 500 on corrupted wallet JSON', async () => {
    await writeFile(walletPath, 'not valid json', 'utf-8');

    const res = await app.inject({
      method: 'POST',
      url: '/wallet/reveal',
      payload: { password: DEV_PASSWORD },
    });
    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'wallet_corrupted' });
  });

  it('returns 400 on empty password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/reveal',
      payload: { password: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 on oversized password (> 256 chars)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/wallet/reveal',
      payload: { password: 'a'.repeat(257) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('log-leak: password and mnemonic never appear in logs', async () => {
    const encrypted = encryptWallet(DEV_MNEMONIC, DEV_PASSWORD);
    await saveWallet(walletPath, encrypted);

    const logMessages: string[] = [];
    const logApp = Fastify({
      logger: {
        level: 'debug',
        stream: {
          write(msg: string) { logMessages.push(msg); },
        },
      },
    });
    const config = { ...getDefaultConfig(), wallet: { encrypted_path: walletPath } };
    const wallet = new WalletManager({ encryptedPath: walletPath });
    registerWalletRevealRoutes(logApp, {
      configPath: '/tmp/test.yaml',
      config,
      orchestrator: new MockOrchestrator() as unknown as DockerOrchestrator,
      wallet,
      connectorAdmin: new MockConnector() as unknown as ConnectorAdminClient,
    });

    await logApp.inject({
      method: 'POST',
      url: '/wallet/reveal',
      payload: { password: DEV_PASSWORD },
    });
    await logApp.close();

    const allLogs = logMessages.join('');
    expect(allLogs).not.toContain(DEV_PASSWORD);
    expect(allLogs).not.toContain(DEV_MNEMONIC);
  });
});
