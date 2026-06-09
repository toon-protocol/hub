/**
 * Tests for wizard API routes (AC-3, AC-4, AC-5, AC-6, AC-7).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {
  registerWizardRoutes,
  buildConfigFromRequest,
  type WizardTransitionState,
} from './wizard.js';
import type { WizardInitRequest } from '../types.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `wizard-test-${randomBytes(8).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const VALID_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function makeValidPayload(
  overrides: Partial<WizardInitRequest> = {}
): WizardInitRequest {
  return {
    password: 'test-password-123',
    password_confirm: 'test-password-123',
    mnemonic_mode: 'generate',
    mnemonic: VALID_MNEMONIC,
    backup_ack: true,
    nodes: {
      town: { enabled: true, feePerEvent: 100 },
      mill: { enabled: false },
      dvm: { enabled: false },
    },
    transport: { mode: 'direct' },
    ...overrides,
  };
}

async function buildApp(
  state: WizardTransitionState,
  configPath: string,
  walletPath: string
) {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  registerWizardRoutes(app, { configPath, walletPath }, state);
  return app;
}

describe('GET /wizard/state (AC-3)', () => {
  let dir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    dir = makeTempDir();
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns wizard mode with all false when disk is empty', async () => {
    const configPath = join(dir, 'config.yaml');
    const walletPath = join(dir, 'wallet.enc');
    const state: WizardTransitionState = { mode: 'wizard' };
    const app = await buildApp(state, configPath, walletPath);

    const res = await app.inject({ method: 'GET', url: '/wizard/state' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.config_exists).toBe(false);
    expect(body.wallet_exists).toBe(false);
    expect(body.containers_running).toBe(false);
    expect(body.mode).toBe('wizard');
    expect(typeof body.ts).toBe('number');
  });

  it('returns config_exists/wallet_exists true when files exist', async () => {
    const configPath = join(dir, 'config.yaml');
    const walletPath = join(dir, 'wallet.enc');
    writeFileSync(configPath, 'test: true');
    writeFileSync(walletPath, '{}');
    const state: WizardTransitionState = { mode: 'wizard' };
    const app = await buildApp(state, configPath, walletPath);

    const res = await app.inject({ method: 'GET', url: '/wizard/state' });
    const body = res.json();
    expect(body.config_exists).toBe(true);
    expect(body.wallet_exists).toBe(true);
    expect(body.containers_running).toBe(false);
    expect(body.mode).toBe('wizard');
  });

  it('returns containers_running=true and mode=normal in normal mode', async () => {
    const configPath = join(dir, 'config.yaml');
    const walletPath = join(dir, 'wallet.enc');
    const state: WizardTransitionState = { mode: 'normal' };
    const app = await buildApp(state, configPath, walletPath);

    const res = await app.inject({ method: 'GET', url: '/wizard/state' });
    const body = res.json();
    expect(body.containers_running).toBe(true);
    expect(body.mode).toBe('normal');
  });
});

describe('POST /wizard/mnemonic-preview (AC-6)', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a valid 12-word BIP-39 phrase', async () => {
    const state: WizardTransitionState = { mode: 'wizard' };
    const app = await buildApp(
      state,
      join(dir, 'config.yaml'),
      join(dir, 'wallet.enc')
    );

    const res = await app.inject({
      method: 'POST',
      url: '/wizard/mnemonic-preview',
    });
    expect(res.statusCode).toBe(200);
    const { mnemonic } = res.json() as { mnemonic: string };
    expect(typeof mnemonic).toBe('string');
    expect(mnemonic.split(' ')).toHaveLength(12);
  });

  it('returns distinct phrases on repeated calls', async () => {
    const state: WizardTransitionState = { mode: 'wizard' };
    const app = await buildApp(
      state,
      join(dir, 'config.yaml'),
      join(dir, 'wallet.enc')
    );

    const r1 = await app.inject({
      method: 'POST',
      url: '/wizard/mnemonic-preview',
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/wizard/mnemonic-preview',
    });
    expect(r1.json().mnemonic).not.toBe(r2.json().mnemonic);
  });

  it('returns 503 after transition to normal mode', async () => {
    const state: WizardTransitionState = { mode: 'normal' };
    const app = await buildApp(
      state,
      join(dir, 'config.yaml'),
      join(dir, 'wallet.enc')
    );

    const res = await app.inject({
      method: 'POST',
      url: '/wizard/mnemonic-preview',
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('wizard_already_completed');
  });

  it('NEVER logs the mnemonic (log-leak check)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const state: WizardTransitionState = { mode: 'wizard' };
      const app = Fastify({ logger: false });
      await app.register(websocket);
      registerWizardRoutes(
        app,
        {
          configPath: join(dir, 'config.yaml'),
          walletPath: join(dir, 'wallet.enc'),
        },
        state
      );

      const res = await app.inject({
        method: 'POST',
        url: '/wizard/mnemonic-preview',
      });
      const mnemonic = res.json().mnemonic as string;

      // Verify no log call contains ANY word of the mnemonic. The earlier
      // version of this assertion only checked the first word, which (when the
      // test fixture uses the all-`abandon` BIP-39 phrase) hides leaks of any
      // word past index 0 — including the distinctive `about` checksum word.
      const allLogs = [
        ...logSpy.mock.calls.flat(),
        ...errSpy.mock.calls.flat(),
      ].map(String);
      const words = mnemonic.split(' ');
      for (const log of allLogs) {
        for (const word of words) {
          expect(log).not.toContain(word);
        }
      }
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('POST /wizard/init (AC-4, AC-5)', () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function postInit(payload: unknown, state?: WizardTransitionState) {
    const st = state ?? {
      mode: 'wizard' as const,
      progressBuffer: [],
      progressSockets: new Set(),
    };
    const app = await buildApp(
      st,
      join(dir, 'config.yaml'),
      join(dir, 'wallet.enc')
    );
    return app.inject({
      method: 'POST',
      url: '/wizard/init',
      payload,
    });
  }

  it('returns 400 password_invalid when password is empty', async () => {
    const res = await postInit(
      makeValidPayload({ password: '', password_confirm: '' })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('password_invalid');
  });

  it('returns 400 password_invalid when password > 256 chars', async () => {
    const long = 'a'.repeat(257);
    const res = await postInit(
      makeValidPayload({ password: long, password_confirm: long })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('password_invalid');
  });

  it('returns 400 password_mismatch when passwords differ', async () => {
    const res = await postInit(
      makeValidPayload({ password_confirm: 'different-pw' })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('password_mismatch');
  });

  it('returns 400 mnemonic_mode_invalid for bad mnemonic_mode', async () => {
    const res = await postInit(
      makeValidPayload({ mnemonic_mode: 'bad' as never })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('mnemonic_mode_invalid');
  });

  it('returns 400 mnemonic_invalid when mnemonic is missing', async () => {
    const res = await postInit({ ...makeValidPayload(), mnemonic: undefined });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('mnemonic_invalid');
  });

  it('returns 400 mnemonic_invalid when mnemonic is not valid BIP-39', async () => {
    const res = await postInit(
      makeValidPayload({ mnemonic: 'not a valid mnemonic at all really no' })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('mnemonic_invalid');
  });

  it('returns 400 backup_not_acknowledged when backup_ack is false (AC-5)', async () => {
    const res = await postInit(makeValidPayload({ backup_ack: false }));
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('backup_not_acknowledged');
    expect(res.json().message).toContain('seed phrase');
  });

  it('returns 400 backup_not_acknowledged even in import mode (AC-5)', async () => {
    const res = await postInit(
      makeValidPayload({
        mnemonic_mode: 'import',
        mnemonic: VALID_MNEMONIC,
        backup_ack: false,
      })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('backup_not_acknowledged');
  });

  it('returns 400 no_nodes_selected when all nodes disabled', async () => {
    const res = await postInit(
      makeValidPayload({
        nodes: {
          town: { enabled: false },
          mill: { enabled: false },
          dvm: { enabled: false },
        },
      })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('no_nodes_selected');
  });

  it('returns 400 fee_out_of_range for town fee > 1000', async () => {
    const res = await postInit(
      makeValidPayload({
        nodes: {
          town: { enabled: true, feePerEvent: 1001 },
          mill: { enabled: false },
          dvm: { enabled: false },
        },
      })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('fee_out_of_range');
  });

  it('returns 400 fee_out_of_range for mill feeBasisPoints > 100', async () => {
    const res = await postInit(
      makeValidPayload({
        nodes: {
          town: { enabled: false },
          mill: { enabled: true, feeBasisPoints: 101 },
          dvm: { enabled: false },
        },
      })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('fee_out_of_range');
  });

  it('returns 400 fee_out_of_range for dvm feePerJob > 100000', async () => {
    const res = await postInit(
      makeValidPayload({
        nodes: {
          town: { enabled: false },
          mill: { enabled: false },
          dvm: { enabled: true, feePerJob: 100001 },
        },
      })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('fee_out_of_range');
  });

  it('returns 400 transport_invalid for bad transport mode', async () => {
    const res = await postInit(
      makeValidPayload({ transport: { mode: 'bad' as never } })
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('transport_invalid');
  });

  it('returns 409 wallet_already_exists when wallet.enc exists', async () => {
    writeFileSync(join(dir, 'wallet.enc'), '{}');
    const res = await postInit(makeValidPayload());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('wallet_already_exists');
  });

  it('returns 409 config_already_exists when config.yaml exists', async () => {
    writeFileSync(join(dir, 'config.yaml'), 'test: true');
    const res = await postInit(makeValidPayload());
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('config_already_exists');
  });

  it('returns 409 wizard_already_completed after transition to normal mode', async () => {
    const state: WizardTransitionState = { mode: 'normal' };
    const app = await buildApp(
      state,
      join(dir, 'config.yaml'),
      join(dir, 'wallet.enc')
    );
    const res = await app.inject({
      method: 'POST',
      url: '/wizard/init',
      payload: makeValidPayload(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('wizard_already_completed');
  });

  it('happy path (generate mode): returns 202 and writes wallet + config', async () => {
    const state: WizardTransitionState = {
      mode: 'wizard',
      progressBuffer: [],
      progressSockets: new Set(),
    };
    const configPath = join(dir, 'config.yaml');
    const walletPath = join(dir, 'wallet.enc');
    const app = await buildApp(state, configPath, walletPath);

    const res = await app.inject({
      method: 'POST',
      url: '/wizard/init',
      payload: makeValidPayload(),
    });

    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('launching');

    // Give async operations a moment to complete
    await new Promise((r) => setTimeout(r, 100));

    // Wallet and config should be written
    const { existsSync } = await import('node:fs');
    expect(existsSync(walletPath)).toBe(true);
    expect(existsSync(configPath)).toBe(true);
  });

  it('NEVER logs the password or mnemonic (log-leak check)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const state: WizardTransitionState = {
        mode: 'wizard',
        progressBuffer: [],
        progressSockets: new Set(),
      };
      const app = await buildApp(
        state,
        join(dir, 'config.yaml'),
        join(dir, 'wallet.enc')
      );
      const payload = makeValidPayload();

      await app.inject({ method: 'POST', url: '/wizard/init', payload });

      const allLogs = [
        ...logSpy.mock.calls.flat(),
        ...errSpy.mock.calls.flat(),
      ].map(String);

      // The fixture mnemonic is `abandon abandon … about` — assert every
      // distinct word is absent (not just the first), so a leak of the
      // checksum word `about` cannot pass.
      const mnemonicWords = Array.from(new Set(payload.mnemonic.split(' ')));
      for (const log of allLogs) {
        // Check password doesn't appear
        expect(log).not.toContain(payload.password);
        // Check every distinct mnemonic word doesn't appear
        for (const word of mnemonicWords) {
          expect(log).not.toContain(word);
        }
      }
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('buildConfigFromRequest', () => {
  it('applies node enabled flags', () => {
    const req = makeValidPayload({
      nodes: {
        town: { enabled: true, feePerEvent: 500 },
        mill: { enabled: true, feeBasisPoints: 30 },
        dvm: { enabled: false },
      },
    });
    const config = buildConfigFromRequest(req, '/tmp/test/config.yaml');
    expect(config.nodes.town.enabled).toBe(true);
    expect(config.nodes.town.feePerEvent).toBe(500);
    expect(config.nodes.mill.enabled).toBe(true);
    expect(config.nodes.mill.feeBasisPoints).toBe(30);
    expect(config.nodes.dvm.enabled).toBe(false);
  });

  it('applies transport mode', () => {
    const config = buildConfigFromRequest(
      makeValidPayload({ transport: { mode: 'hs' } }),
      '/tmp/test/config.yaml'
    );
    expect(config.transport.mode).toBe('hs');
  });

  it('applies chainProviders when provided', () => {
    const config = buildConfigFromRequest(
      makeValidPayload({
        chainProviders: [
          {
            chainType: 'solana',
            chainId: 'solana:devnet',
            rpcUrl: 'https://s',
            programId: 'P',
            keyId: 'k',
          },
        ],
      }),
      '/tmp/test/config.yaml'
    );
    expect(config.chainProviders).toHaveLength(1);
    expect(config.chainProviders?.[0]?.chainType).toBe('solana');
  });

  it('leaves chainProviders unset when omitted (connector uses the default)', () => {
    const config = buildConfigFromRequest(
      makeValidPayload(),
      '/tmp/test/config.yaml'
    );
    expect(config.chainProviders).toBeUndefined();
  });

  it('sets wallet path relative to config dir (POSIX)', () => {
    const config = buildConfigFromRequest(
      makeValidPayload(),
      '/home/user/.townhouse/config.yaml'
    );
    expect(config.wallet.encrypted_path).toBe(
      '/home/user/.townhouse/wallet.enc'
    );
  });

  it('handles paths whose filename is not literally "config.yaml"', () => {
    const config = buildConfigFromRequest(
      makeValidPayload(),
      '/tmp/foo/townhouse.yaml'
    );
    // Must place wallet.enc in the same directory regardless of config filename
    expect(config.wallet.encrypted_path).toBe('/tmp/foo/wallet.enc');
  });
});

describe('WS /wizard/progress (AC-7)', () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  async function buildAndListen(state: WizardTransitionState) {
    const app = Fastify({ logger: false });
    await app.register(websocket);
    registerWizardRoutes(
      app,
      {
        configPath: join(dir, 'config.yaml'),
        walletPath: join(dir, 'wallet.enc'),
      },
      state
    );
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    if (!address || typeof address === 'string')
      throw new Error('Failed to bind WS test server');
    return { app, port: address.port };
  }

  it('replays buffered messages on connect and forwards live broadcasts', async () => {
    const { default: WS } = await import('ws');
    const state: WizardTransitionState = {
      mode: 'wizard',
      progressBuffer: [
        { type: 'pull_progress', image: 'connector', status: 'Pulling', ts: 1 },
        { type: 'container_starting', name: 'town', ts: 2 },
      ],
      progressSockets: new Set(),
    };
    const { app, port } = await buildAndListen(state);

    try {
      const client = new WS(`ws://127.0.0.1:${port}/wizard/progress`);
      const received: string[] = [];
      // Attach the message listener BEFORE the open handshake completes —
      // the server replays the buffer immediately on upgrade, so a late
      // listener would miss the replay.
      client.on('message', (data) => {
        received.push(String(data));
      });
      await new Promise<void>((resolve, reject) => {
        client.on('open', () => resolve());
        client.on('error', reject);
      });

      // Wait briefly for the buffer replay to drain
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(2);
      expect(JSON.parse(received[0]!)).toMatchObject({
        type: 'pull_progress',
        image: 'connector',
      });
      expect(JSON.parse(received[1]!)).toMatchObject({
        type: 'container_starting',
        name: 'town',
      });

      // Live broadcast — push to the server's socket set and verify the client gets it
      const liveMsg = {
        type: 'container_healthy' as const,
        name: 'town',
        ts: 3,
      };
      for (const sock of state.progressSockets!) {
        sock.send(JSON.stringify(liveMsg));
      }
      await new Promise((r) => setTimeout(r, 50));
      expect(received).toHaveLength(3);
      expect(JSON.parse(received[2]!)).toMatchObject({
        type: 'container_healthy',
        name: 'town',
      });

      client.close();
      await new Promise((r) => setTimeout(r, 50));
      // Socket should have been removed from the active set
      expect(state.progressSockets!.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('rejects WS upgrades from disallowed Origin (CSWSH defense)', async () => {
    const { default: WS } = await import('ws');
    const state: WizardTransitionState = {
      mode: 'wizard',
      progressBuffer: [],
      progressSockets: new Set(),
    };
    const { app, port } = await buildAndListen(state);

    try {
      const client = new WS(`ws://127.0.0.1:${port}/wizard/progress`, {
        headers: { Origin: 'http://evil.example.com' },
      });
      const closeCode = await new Promise<number>((resolve) => {
        client.on('close', (code) => resolve(code));
        client.on('error', () => resolve(-1));
      });
      // Either the server closes with 1008 (policy violation) or the upgrade fails outright
      expect([1006, 1008, -1]).toContain(closeCode);
      // Critically: no socket was added to the active set
      expect(state.progressSockets!.size).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('closes immediately in normal mode (wizard already complete)', async () => {
    const { default: WS } = await import('ws');
    const state: WizardTransitionState = { mode: 'normal' };
    const { app, port } = await buildAndListen(state);

    try {
      const client = new WS(`ws://127.0.0.1:${port}/wizard/progress`);
      const closeCode = await new Promise<number>((resolve) => {
        client.on('close', (code) => resolve(code));
        client.on('error', () => resolve(-1));
      });
      expect([1001, -1]).toContain(closeCode);
    } finally {
      await app.close();
    }
  });
});
