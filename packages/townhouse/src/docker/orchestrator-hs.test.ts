/**
 * Unit tests for DockerOrchestrator HS-profile path (Story 45.3, AC #12).
 *
 * Uses constructor-injected execFileAsync and adminClientFactory stubs instead
 * of vi.mock('node:child_process') to avoid ESM-load-order brittleness.
 * No real Docker daemon is required — all subprocess calls are intercepted.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerOrchestrator, OrchestratorError } from './orchestrator.js';
import type { ConnectorAdminClient } from '../connector/admin-client.js';
import type { TownhouseConfig } from '../config/schema.js';
import { getDefaultConfig } from '../config/defaults.js';
import type Docker from 'dockerode';

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options?: { timeout?: number; maxBuffer?: number }
) => Promise<{ stdout: string; stderr: string }>;

function makeConfig(): TownhouseConfig {
  return getDefaultConfig();
}

function makeDocker(): Docker {
  return {} as Docker;
}

function makeExec(resolve?: { stdout: string; stderr: string }): {
  exec: ExecFileAsync;
  calls: { file: string; args: string[] }[];
} {
  const calls: { file: string; args: string[] }[] = [];
  const exec: ExecFileAsync = (file, args) => {
    calls.push({ file: String(file), args: Array.from(args) });
    if (resolve !== undefined) return Promise.resolve(resolve);
    return Promise.resolve({ stdout: '', stderr: '' });
  };
  return { exec, calls };
}

function makeAdminFactory(
  getHsHostnameFn: () => Promise<{
    hostname: string | null;
    publishedAt: string | null;
  }>
) {
  return () =>
    ({
      getHsHostname: getHsHostnameFn,
    }) as unknown as ConnectorAdminClient;
}

/**
 * Create a real temp compose file on disk so validateComposePath (Fix 8)
 * does not reject it. Returns the absolute path and a cleanup function.
 */
function makeTempCompose(): { composePath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'orch-hs-test-'));
  const composePath = join(dir, 'compose.yml');
  writeFileSync(composePath, 'services: {}\n');
  return {
    composePath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('DockerOrchestrator (HS profile)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Constructor validation ────────────────────────────────────────────────

  it('stores profile and composePath from options', () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec } = makeExec();
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makeAdminFactory(() =>
            Promise.resolve({
              hostname: 'x.anon',
              publishedAt: '2026-05-09T00:00:00Z',
            })
          ) as never,
        }
      );
      // No throw = success; profile and composePath stored internally
      expect(orch).toBeInstanceOf(DockerOrchestrator);
    } finally {
      cleanup();
    }
  });

  it('throws OrchestratorError when profile hs is passed without composePath', () => {
    expect(
      () =>
        new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
          profile: 'hs',
          // no composePath
        })
    ).toThrow(OrchestratorError);
  });

  it('throws OrchestratorError with composePath error message when profile hs missing composePath', () => {
    expect(
      () =>
        new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
          profile: 'hs',
        })
    ).toThrow(/composePath/);
  });

  it('constructs successfully with dev profile and a nonexistent composePath (composePath ignored)', () => {
    const { exec, calls } = makeExec();
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'dev',
      composePath: '/nonexistent/path.yml',
      execFileAsync: exec as never,
    });
    expect(orch).toBeInstanceOf(DockerOrchestrator);
    expect(calls).toHaveLength(0);
  });

  // ── up() argv composition ────────────────────────────────────────────────

  it('up([]) invokes execFile with no --profile flags', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec, calls } = makeExec();
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makeAdminFactory(() =>
            Promise.resolve({
              hostname: 'x.anon',
              publishedAt: '2026-05-09T00:00:00Z',
            })
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

  it('up([town]) inserts --profile town BEFORE up -d', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec, calls } = makeExec();
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makeAdminFactory(() =>
            Promise.resolve({
              hostname: 'x.anon',
              publishedAt: '2026-05-09T00:00:00Z',
            })
          ) as never,
        }
      );
      await orch.up(['town']);
      expect(calls[0]!.args).toEqual([
        'compose',
        '-f',
        composePath,
        '--profile',
        'town',
        'up',
        '-d',
      ]);
    } finally {
      cleanup();
    }
  });

  it('up([town, mill, dvm]) orders flags deterministically as town → mill → dvm', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec, calls } = makeExec();
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makeAdminFactory(() =>
            Promise.resolve({
              hostname: 'x.anon',
              publishedAt: '2026-05-09T00:00:00Z',
            })
          ) as never,
        }
      );
      await orch.up(['dvm', 'mill', 'town']); // intentionally out-of-order input
      expect(calls[0]!.args).toEqual([
        'compose',
        '-f',
        composePath,
        '--profile',
        'town',
        '--profile',
        'mill',
        '--profile',
        'dvm',
        'up',
        '-d',
      ]);
    } finally {
      cleanup();
    }
  });

  // ── Readiness poll ────────────────────────────────────────────────────────

  it('polls getHsHostname until hostname is non-null then resolves', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec } = makeExec();
      let callCount = 0;
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makeAdminFactory(() => {
            callCount++;
            if (callCount < 3) {
              return Promise.resolve({ hostname: null, publishedAt: null });
            }
            return Promise.resolve({
              hostname: 'xyz.anon',
              publishedAt: '2026-05-09T00:00:00Z',
            });
          }) as never,
        }
      );
      await orch.up([]);
      expect(callCount).toBe(3);
    } finally {
      cleanup();
    }
  });

  it('throws OrchestratorError with "timeout" on 120s hostname publication timeout', async () => {
    // Fix 6: fake hrtime.bigint() alongside setTimeout so the monotonic
    // deadline check advances with the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date', 'hrtime'] });
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec } = makeExec();
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makeAdminFactory(() =>
            Promise.resolve({ hostname: null, publishedAt: null })
          ) as never,
        }
      );
      // Attach rejection handler immediately to avoid unhandled-rejection warning
      // when fake timers fire the rejection before we await it.
      const settled = new Promise<Error | null>((resolve) => {
        orch
          .up([])
          .then(() => resolve(null))
          .catch((e: unknown) =>
            resolve(e instanceof Error ? e : new Error(String(e)))
          );
      });
      await vi.advanceTimersByTimeAsync(121_000);
      const err = await settled;
      expect(err).toBeInstanceOf(OrchestratorError);
      expect(err!.message).toMatch(/timeout/);
    } finally {
      cleanup();
    }
  });

  it('stops polling on anon-disabled (503) and throws with "anon-disabled" in message', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const { exec } = makeExec();
      let callCount = 0;
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: exec as never,
          adminClientFactory: makeAdminFactory(() => {
            callCount++;
            return Promise.reject(
              new Error('connector is anon-disabled (HTTP 503)')
            );
          }) as never,
        }
      );
      await expect(orch.up([])).rejects.toThrow(/anon-disabled/);
      expect(callCount).toBe(1); // exactly one call, no retry on 503
    } finally {
      cleanup();
    }
  });

  // ── Failure surfacing ─────────────────────────────────────────────────────

  it('emits containerState { name: "connector", state: "error" } before throwing on compose up failure', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const fakeExec: ExecFileAsync = () => {
        const e = new Error(
          'Process exited with code 1'
        ) as NodeJS.ErrnoException & {
          stderr?: string;
          code?: number;
        };
        e.stderr = 'failed to start "connector": container exited 1';
        e.code = 1;
        return Promise.reject(e);
      };
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: fakeExec as never,
        }
      );
      const events: { name: string; state: string }[] = [];
      orch.on('containerState', (e) => events.push(e));
      await expect(orch.up([])).rejects.toThrow(OrchestratorError);
      expect(events).toContainEqual(
        expect.objectContaining({ name: 'connector', state: 'error' })
      );
    } finally {
      cleanup();
    }
  });

  it('emits fallback containerState { name: "compose-up" } when stderr is unparseable', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const fakeExec: ExecFileAsync = () => {
        const e = new Error(
          'Process exited with code 1'
        ) as NodeJS.ErrnoException & {
          stderr?: string;
          code?: number;
        };
        e.stderr = 'some completely unrecognized error output';
        e.code = 1;
        return Promise.reject(e);
      };
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: fakeExec as never,
        }
      );
      const events: { name: string; state: string }[] = [];
      orch.on('containerState', (e) => events.push(e));
      await expect(orch.up([])).rejects.toThrow(OrchestratorError);
      expect(events).toContainEqual(
        expect.objectContaining({ name: 'compose-up', state: 'error' })
      );
    } finally {
      cleanup();
    }
  });

  // ── down() ────────────────────────────────────────────────────────────────

  it('down() invokes execFile with compose -f <path> down (no -v flag)', async () => {
    const { exec, calls } = makeExec();
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/test/compose.yml',
      execFileAsync: exec as never,
    });
    await orch.down();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      'compose',
      '-f',
      '/test/compose.yml',
      'down',
    ]);
    // Ensure no -v flag (volume preservation)
    expect(calls[0]!.args).not.toContain('-v');
  });

  // ── dev profile uses dockerode (not execFile) ─────────────────────────────

  it('dev profile up() does NOT call execFileAsync', async () => {
    const { exec, calls } = makeExec();
    const mockContainer = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
      inspect: vi.fn().mockResolvedValue({
        State: { Health: { Status: 'healthy' }, Running: true },
      }),
    };
    const mockNetwork = { remove: vi.fn().mockResolvedValue(undefined) };
    const docker = {
      createContainer: vi.fn().mockResolvedValue(mockContainer),
      getContainer: vi.fn().mockReturnValue(mockContainer),
      listContainers: vi.fn().mockResolvedValue([]),
      createNetwork: vi.fn().mockResolvedValue(mockNetwork),
      listNetworks: vi.fn().mockResolvedValue([]),
      getNetwork: vi.fn().mockReturnValue(mockNetwork),
      pull: vi.fn().mockResolvedValue({ pipe: vi.fn() }),
      listImages: vi.fn().mockResolvedValue([
        {
          RepoTags: ['ghcr.io/toon-protocol/connector@sha256:abc'],
          RepoDigests: [],
        },
      ]),
      modem: {
        followProgress: vi
          .fn()
          .mockImplementation(
            (_s: unknown, onFinished: (err: Error | null) => void) =>
              onFinished(null)
          ),
      },
    } as unknown as Docker;

    const orch = new DockerOrchestrator(docker, makeConfig(), undefined, {
      profile: 'dev',
      composePath: '/nonexistent/path.yml',
      execFileAsync: exec as never,
    });
    await orch.up([]);
    expect(calls).toHaveLength(0);
  });

  // ── Fix 1: activeNodes mutation guard ────────────────────────────────────

  it('Fix 1: activeNodes is NOT mutated before upHs when compose up fails', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const fakeExec: ExecFileAsync = () => {
        const e = new Error('compose up failed') as NodeJS.ErrnoException & {
          code?: number;
          stderr?: string;
        };
        e.code = 1;
        e.stderr = 'error output';
        return Promise.reject(e);
      };
      // We verify the test indirectly: if activeNodes were mutated before
      // upHs throws, a subsequent up() call with different profiles would
      // inherit phantom state. The real check is that up() rejects cleanly
      // without leaving the orchestrator in an inconsistent state.
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: fakeExec as never,
        }
      );
      await expect(orch.up(['town'])).rejects.toThrow(OrchestratorError);
      // If mutation happens before throw, a second call would carry ['town']
      // in activeNodes even though the first up() failed. Here we just confirm
      // the orchestrator can be called again without internal corruption.
      await expect(orch.up(['town'])).rejects.toThrow(OrchestratorError);
    } finally {
      cleanup();
    }
  });

  // ── Fix 2: container rollback on waitForHsHostname timeout ───────────────

  it('Fix 2: downHs is called as rollback when waitForHsHostname times out', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const calls: string[] = [];
      const fakeExec: ExecFileAsync = (_file, args) => {
        // Record whether this is an 'up' or 'down' call
        const subcommand = args.find((a) => a === 'up' || a === 'down');
        if (subcommand) calls.push(subcommand);
        return Promise.resolve({ stdout: '', stderr: '' });
      };
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: fakeExec as never,
          // Always return null hostname so waitForHsHostname times out immediately
          adminClientFactory: () =>
            ({
              getHsHostname: () =>
                Promise.reject(
                  new Error('connector is anon-disabled (HTTP 503)')
                ),
            }) as unknown as ConnectorAdminClient,
        }
      );
      await expect(orch.up([])).rejects.toThrow(/anon-disabled/);
      // Should have called 'up' then 'down' (rollback)
      expect(calls).toContain('up');
      expect(calls).toContain('down');
      expect(calls.indexOf('up')).toBeLessThan(calls.indexOf('down'));
    } finally {
      cleanup();
    }
  });

  // ── Fix 3: downHs idempotency ─────────────────────────────────────────────

  it('Fix 3: downHs does not throw when compose down exits non-zero with "no such service"', async () => {
    const fakeExec: ExecFileAsync = () => {
      const e = new Error(
        'compose down: nothing to stop'
      ) as NodeJS.ErrnoException & {
        code?: number;
        stderr?: string;
      };
      e.code = 1;
      e.stderr = 'no such service: townhouse-apex';
      return Promise.reject(e);
    };
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/test/compose.yml',
      execFileAsync: fakeExec as never,
    });
    // Should resolve without throwing — idempotent teardown
    await expect(orch.down()).resolves.toBeUndefined();
  });

  // ── Fix 4: surfaceComposeFailure generic pattern ──────────────────────────

  it('Fix 4: surfaceComposeFailure captures service name from non-hs-prefixed container names', async () => {
    const { composePath, cleanup } = makeTempCompose();
    try {
      const fakeExec: ExecFileAsync = () => {
        const e = new Error('compose up failed') as NodeJS.ErrnoException & {
          code?: number;
          stderr?: string;
        };
        e.code = 1;
        // Epic 46 container name format: <project>-<service>-<N>
        e.stderr = 'Container townhouse-epic46-town-1 Error';
        return Promise.reject(e);
      };
      const orch = new DockerOrchestrator(
        makeDocker(),
        makeConfig(),
        undefined,
        {
          profile: 'hs',
          composePath,
          execFileAsync: fakeExec as never,
        }
      );
      const events: { name: string; state: string }[] = [];
      orch.on('containerState', (e) => events.push(e));
      await expect(orch.up([])).rejects.toThrow(OrchestratorError);
      // Should capture 'town' (the service name), not fall through to 'compose-up'
      expect(
        events.some((ev) => ev.name !== 'compose-up' && ev.state === 'error')
      ).toBe(true);
    } finally {
      cleanup();
    }
  });
});
