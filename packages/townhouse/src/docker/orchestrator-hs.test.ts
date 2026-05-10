/**
 * Unit tests for DockerOrchestrator HS-profile path (Story 45.3, AC #12).
 *
 * Uses constructor-injected execFileAsync and adminClientFactory stubs instead
 * of vi.mock('node:child_process') to avoid ESM-load-order brittleness.
 * No real Docker daemon is required — all subprocess calls are intercepted.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
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

describe('DockerOrchestrator (HS profile)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Constructor validation ────────────────────────────────────────────────

  it('stores profile and composePath from options', () => {
    const { exec } = makeExec();
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/test/compose.yml',
      execFileAsync: exec as never,
      adminClientFactory: makeAdminFactory(() =>
        Promise.resolve({
          hostname: 'x.anyone',
          publishedAt: '2026-05-09T00:00:00Z',
        })
      ) as never,
    });
    // No throw = success; profile and composePath stored internally
    expect(orch).toBeInstanceOf(DockerOrchestrator);
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
    const { exec, calls } = makeExec();
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/test/compose.yml',
      execFileAsync: exec as never,
      adminClientFactory: makeAdminFactory(() =>
        Promise.resolve({
          hostname: 'x.anyone',
          publishedAt: '2026-05-09T00:00:00Z',
        })
      ) as never,
    });
    await orch.up([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.file).toBe('docker');
    expect(calls[0]!.args).toEqual([
      'compose',
      '-f',
      '/test/compose.yml',
      'up',
      '-d',
    ]);
  });

  it('up([town]) inserts --profile town BEFORE up -d', async () => {
    const { exec, calls } = makeExec();
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/test/compose.yml',
      execFileAsync: exec as never,
      adminClientFactory: makeAdminFactory(() =>
        Promise.resolve({
          hostname: 'x.anyone',
          publishedAt: '2026-05-09T00:00:00Z',
        })
      ) as never,
    });
    await orch.up(['town']);
    expect(calls[0]!.args).toEqual([
      'compose',
      '-f',
      '/test/compose.yml',
      '--profile',
      'town',
      'up',
      '-d',
    ]);
  });

  it('up([town, mill, dvm]) orders flags deterministically as town → mill → dvm', async () => {
    const { exec, calls } = makeExec();
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/test/compose.yml',
      execFileAsync: exec as never,
      adminClientFactory: makeAdminFactory(() =>
        Promise.resolve({
          hostname: 'x.anyone',
          publishedAt: '2026-05-09T00:00:00Z',
        })
      ) as never,
    });
    await orch.up(['dvm', 'mill', 'town']); // intentionally out-of-order input
    expect(calls[0]!.args).toEqual([
      'compose',
      '-f',
      '/test/compose.yml',
      '--profile',
      'town',
      '--profile',
      'mill',
      '--profile',
      'dvm',
      'up',
      '-d',
    ]);
  });

  // ── Readiness poll ────────────────────────────────────────────────────────

  it('polls getHsHostname until hostname is non-null then resolves', async () => {
    const { exec } = makeExec();
    let callCount = 0;
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/test/compose.yml',
      execFileAsync: exec as never,
      adminClientFactory: makeAdminFactory(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.resolve({ hostname: null, publishedAt: null });
        }
        return Promise.resolve({
          hostname: 'xyz.anyone',
          publishedAt: '2026-05-09T00:00:00Z',
        });
      }) as never,
    });
    await orch.up([]);
    expect(callCount).toBe(3);
  });

  it('throws OrchestratorError with "timeout" on 120s hostname publication timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { exec } = makeExec();
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/test/c.yml',
      execFileAsync: exec as never,
      adminClientFactory: makeAdminFactory(() =>
        Promise.resolve({ hostname: null, publishedAt: null })
      ) as never,
    });
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
  });

  it('stops polling on anon-disabled (503) and throws with "anon-disabled" in message', async () => {
    const { exec } = makeExec();
    let callCount = 0;
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/x.yml',
      execFileAsync: exec as never,
      adminClientFactory: makeAdminFactory(() => {
        callCount++;
        return Promise.reject(
          new Error('connector is anon-disabled (HTTP 503)')
        );
      }) as never,
    });
    await expect(orch.up([])).rejects.toThrow(/anon-disabled/);
    expect(callCount).toBe(1); // exactly one call, no retry on 503
  });

  // ── Failure surfacing ─────────────────────────────────────────────────────

  it('emits containerState { name: "connector", state: "error" } before throwing on compose up failure', async () => {
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
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/x.yml',
      execFileAsync: fakeExec as never,
    });
    const events: { name: string; state: string }[] = [];
    orch.on('containerState', (e) => events.push(e));
    await expect(orch.up([])).rejects.toThrow(OrchestratorError);
    expect(events).toContainEqual(
      expect.objectContaining({ name: 'connector', state: 'error' })
    );
  });

  it('emits fallback containerState { name: "compose-up" } when stderr is unparseable', async () => {
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
    const orch = new DockerOrchestrator(makeDocker(), makeConfig(), undefined, {
      profile: 'hs',
      composePath: '/x.yml',
      execFileAsync: fakeExec as never,
    });
    const events: { name: string; state: string }[] = [];
    orch.on('containerState', (e) => events.push(e));
    await expect(orch.up([])).rejects.toThrow(OrchestratorError);
    expect(events).toContainEqual(
      expect.objectContaining({ name: 'compose-up', state: 'error' })
    );
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
});
