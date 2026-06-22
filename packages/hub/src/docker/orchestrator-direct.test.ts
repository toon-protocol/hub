/**
 * Unit tests for DockerOrchestrator 'direct' profile path (Phase 2 direct-apex).
 *
 * Mirrors orchestrator-hs.test.ts: constructor-injected execFileAsync and
 * adminClientFactory stubs, no real Docker daemon. The 'direct' profile is
 * compose-driven like 'hs' but gates readiness on connector /health
 * (pingAdminLive) instead of the HS hostname.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerOrchestrator, OrchestratorError } from './orchestrator.js';
import type { ConnectorAdminClient } from '../connector/admin-client.js';
import type { HubConfig } from '../config/schema.js';
import { getDefaultConfig } from '../config/defaults.js';
import type Docker from 'dockerode';

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number }
) => Promise<{ stdout: string; stderr: string }>;

function makeConfig(): HubConfig {
  return getDefaultConfig();
}

function makeDocker(): Docker {
  return {} as Docker;
}

function makeExec(): {
  exec: ExecFileAsync;
  calls: { file: string; args: string[] }[];
} {
  const calls: { file: string; args: string[] }[] = [];
  const exec: ExecFileAsync = (file, args) => {
    calls.push({ file: String(file), args: Array.from(args) });
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { exec, calls };
}

/** Admin factory whose pingAdminLive resolves (connector healthy). */
function makePingFactory(
  pingFn: () => Promise<{ status: 'healthy'; nodeId?: string }>
) {
  return () =>
    ({
      pingAdminLive: pingFn,
    }) as unknown as ConnectorAdminClient;
}

function makeTempCompose(): { composePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-direct-test-'));
  const composePath = join(dir, 'compose.yml');
  writeFileSync(composePath, 'services: {}\n');
  return {
    composePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("DockerOrchestrator ('direct' profile)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('constructs with a composePath', () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec } = makeExec();
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'direct',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makePingFactory(() =>
            Promise.resolve({ status: 'healthy' })
          ) as never,
        }
      );
      expect(orch).toBeInstanceOf(DockerOrchestrator);
    } finally {
      cleanup();
    }
  });

  it('throws OrchestratorError when direct profile is passed without composePath', () => {
    expect(
      () =>
        new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
          profile: 'direct',
        })
    ).toThrow(OrchestratorError);
  });

  it('the composePath error message names the direct profile', () => {
    expect(
      () =>
        new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
          profile: 'direct',
        })
    ).toThrow(/direct.*composePath|composePath/);
  });

  it('up([]) dispatches to compose up with no --profile flags', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec, calls } = makeExec();
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'direct',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makePingFactory(() =>
            Promise.resolve({ status: 'healthy' })
          ) as never,
        }
      );
      await orch.up([]);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.file).toBe('docker');
      expect(calls[0]!.args).toEqual([
        'compose',
        '-f',
        composePath,
        'up',
        '-d',
      ]);
    } finally {
      cleanup();
    }
  });

  it('up([town]) gates on connector health (pingAdminLive), not HS hostname', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec, calls } = makeExec();
      let pinged = 0;
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'direct',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makePingFactory(() => {
            pinged++;
            return Promise.resolve({ status: 'healthy' });
          }) as never,
        }
      );
      await orch.up(['town']);
      // compose up included the town profile flag.
      expect(calls[0]!.args).toEqual([
        'compose',
        '-f',
        composePath,
        '--profile',
        'town',
        'up',
        '-d',
      ]);
      // readiness probe was the connector health ping.
      expect(pinged).toBeGreaterThanOrEqual(1);
    } finally {
      cleanup();
    }
  });
});
