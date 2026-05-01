/**
 * Tests for createWizardApiServer (AC-8: wizard mode, route isolation, transition).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createWizardApiServer } from './wizard-server.js';
import type { WizardInitialDeps } from './wizard-server.js';
import Docker from 'dockerode';

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `wizard-srv-test-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('createWizardApiServer (AC-8)', () => {
  let dir: string;
  let deps: WizardInitialDeps;

  beforeEach(() => {
    dir = makeTempDir();
    deps = {
      configDir: dir,
      configPath: join(dir, 'config.yaml'),
      walletPath: join(dir, 'wallet.enc'),
      port: 0,
      docker: new Docker(),
      logger: false,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('starts in wizard mode — GET /wizard/state returns mode: wizard', async () => {
    const server = await createWizardApiServer(deps);
    try {
      const res = await server.app.inject({
        method: 'GET',
        url: '/wizard/state',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().mode).toBe('wizard');
    } finally {
      await server.close();
    }
  });

  it('normal-mode routes return 404 before transition', async () => {
    const server = await createWizardApiServer(deps);
    try {
      const res = await server.app.inject({ method: 'GET', url: '/nodes' });
      expect(res.statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('wizard routes respond to GET /wizard/state and POST /wizard/mnemonic-preview', async () => {
    const server = await createWizardApiServer(deps);
    try {
      const stateRes = await server.app.inject({
        method: 'GET',
        url: '/wizard/state',
      });
      expect(stateRes.statusCode).toBe(200);

      const previewRes = await server.app.inject({
        method: 'POST',
        url: '/wizard/mnemonic-preview',
      });
      expect(previewRes.statusCode).toBe(200);
      expect(previewRes.json().mnemonic).toBeDefined();
    } finally {
      await server.close();
    }
  });

  it('POST /wizard/init returns 409 when wallet already exists after close', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(deps.walletPath, '{}');

    const server = await createWizardApiServer(deps);
    try {
      const res = await server.app.inject({
        method: 'POST',
        url: '/wizard/init',
        payload: {
          password: 'test-pw',
          password_confirm: 'test-pw',
          mnemonic_mode: 'generate',
          mnemonic:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
          backup_ack: true,
          nodes: {
            town: { enabled: true },
            mill: { enabled: false },
            dvm: { enabled: false },
          },
          transport: { mode: 'direct' },
        },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('wallet_already_exists');
    } finally {
      await server.close();
    }
  });
});
