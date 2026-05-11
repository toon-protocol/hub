/**
 * CLI HS subcommand unit tests (Story 45.4, AC #16).
 *
 * Uses dependency-injection overrides (4th param to main()) to avoid real
 * Docker, filesystem, and HTTP calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { main } from './cli.js';
import { WalletManager, encryptWallet, saveWallet } from './wallet/index.js';
import type { CliHsOverrides } from './cli.js';

const WALLET_PASSWORD = 'hs-test-password';

/** Create a temporary config dir with a config.yaml and encrypted wallet. */
async function makeHsTestDir(): Promise<{
  configDir: string;
  configPath: string;
  walletPath: string;
}> {
  const configDir = join(
    tmpdir(),
    `townhouse-hs-test-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(configDir, { recursive: true });

  const walletPath = join(configDir, 'wallet.enc');
  const wm = new WalletManager({ encryptedPath: walletPath });
  const { mnemonic } = await wm.generate();
  await saveWallet(walletPath, encryptWallet(mnemonic, WALLET_PASSWORD));

  const configPath = join(configDir, 'config.yaml');
  writeFileSync(
    configPath,
    `
nodes:
  town:
    enabled: false
    feePerEvent: 1000
  mill:
    enabled: false
    feeBasisPoints: 50
  dvm:
    enabled: false
    feePerJob: 5000
wallet:
  encrypted_path: ${walletPath}
connector:
  image: ghcr.io/toon-protocol/connector:3.5.0
  adminPort: 9401
transport:
  mode: direct
api:
  port: 0
  host: 127.0.0.1
logging:
  level: info
`,
    'utf-8'
  );

  return { configDir, configPath, walletPath };
}

interface HsOverrideOptions {
  /** Hostname returned by the POST-UP admin client call (default: 'abc123test.anyone'). */
  hostname?: string;
  /**
   * Probe behavior:
   *   'cold'         (default): probe throws connection error → cold-boot path
   *   'running'      : probe returns { hostname } → idempotency path
   *   'anon-disabled': probe throws anon-disabled error
   */
  probe?: 'cold' | 'running' | 'anon-disabled';
  /** Custom up() implementation — overrides the orchestrator stub. */
  up?: (profiles: string[]) => Promise<void>;
  /** Custom down() implementation — overrides the orchestrator stub. */
  down?: () => Promise<void>;
  /** If true, the stub orchestrator emits a containerState 'creating' event during up(). */
  emitContainerStateOnUp?: boolean;
  /** If supplied, capture the BootReconciler stub's reconcile spy here. */
  reconcileSpy?: ReturnType<typeof vi.fn>;
  /** If true, the reconciler stub throws — verifies non-fatal handling. */
  reconcileThrows?: boolean;
}

/** Build a minimal CliHsOverrides stub for unit testing. */
function makeHsOverrides({
  hostname = 'abc123test.anyone',
  probe = 'cold',
  up,
  down,
  emitContainerStateOnUp = false,
  reconcileSpy,
  reconcileThrows = false,
}: HsOverrideOptions = {}): CliHsOverrides {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  let adminClientCallCount = 0;

  const orchUp =
    up ??
    vi.fn(async (_profiles: string[]) => {
      if (emitContainerStateOnUp) {
        const handlers = listeners.get('containerState') ?? [];
        for (const h of handlers) {
          h({ name: 'connector', state: 'creating' });
        }
      }
    });
  const orchDown = down ?? vi.fn(async () => undefined);

  return {
    materializeComposeTemplate: vi.fn(() => ({
      composePath: '/tmp/fake/townhouse-hs.yml',
      manifestPath: '/tmp/fake/image-manifest.json',
    })),
    createOrchestrator: vi.fn((_docker, _config, _wm, _opts) => ({
      up: orchUp as (profiles: string[]) => Promise<void>,
      down: orchDown as () => Promise<void>,
      on: (event: string, handler: (...args: unknown[]) => void) => {
        const existing = listeners.get(event) ?? [];
        existing.push(handler);
        listeners.set(event, existing);
      },
    })),
    createAdminClient: vi.fn(() => {
      adminClientCallCount++;
      const isProbeCall = adminClientCallCount === 1;

      return {
        getHsHostname: vi.fn(async () => {
          if (isProbeCall) {
            // Probe call behavior.
            if (probe === 'running') {
              return { hostname, publishedAt: new Date().toISOString() };
            }
            if (probe === 'anon-disabled') {
              throw new Error('connector is anon-disabled (HTTP 503)');
            }
            // 'cold': simulate ECONNREFUSED so the code proceeds to cold-boot.
            throw new Error(
              'Connector admin API connection refused: connect ECONNREFUSED 127.0.0.1:9401'
            );
          }
          // Post-up call: return the published hostname.
          return { hostname, publishedAt: new Date().toISOString() };
        }),
      };
    }),
    runComposeDown: vi.fn(
      async (_composePath: string, _withVolumes: boolean) => undefined
    ),
    createReconciler: vi.fn((_nodesYamlPath: string, _logPath: string) => ({
      reconcile:
        reconcileSpy ??
        vi.fn(async () => {
          if (reconcileThrows) {
            throw new Error('reconciler boom');
          }
        }),
    })),
  };
}

describe('CLI hs subcommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stdinIsTTY: boolean | undefined;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    // Capture and reset process.exitCode
    process.exitCode = undefined;
    stdinIsTTY = process.stdin.isTTY;
    // Default: non-TTY stdin so tests don't try to prompt
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      writable: true,
      configurable: true,
    });
    // Set TOWNHOUSE_WALLET_PASSWORD so hs up doesn't prompt
    process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_PASSWORD;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    stdoutSpy.mockRestore();
    process.exitCode = undefined;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: stdinIsTTY,
      writable: true,
      configurable: true,
    });
    delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
  });

  // ── Unknown hs action ─────────────────────────────────────────────────────

  it('unknown hs action prints usage and exits 1', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      await main(
        ['hs', 'restart', '-c', configPath],
        undefined,
        undefined,
        makeHsOverrides({})
      );
      expect(process.exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Usage: townhouse hs <up|down>')
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // ── hs up: fresh state ────────────────────────────────────────────────────

  it('hs up on fresh state calls materializeComposeTemplate("hs") exactly once', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      expect(overrides.materializeComposeTemplate).toHaveBeenCalledTimes(1);
      expect(overrides.materializeComposeTemplate).toHaveBeenCalledWith(
        'hs',
        expect.objectContaining({ townhouseHome: configDir })
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up on fresh state constructs orchestrator with { profile: "hs", composePath } and calls up([])', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      expect(overrides.createOrchestrator).toHaveBeenCalledWith(
        expect.anything(), // docker
        expect.anything(), // config
        expect.anything(), // walletManager
        expect.objectContaining({
          profile: 'hs',
          composePath: '/tmp/fake/townhouse-hs.yml',
        })
      );

      // up([]) called with empty profile array
      const orchInstance = (
        overrides.createOrchestrator as ReturnType<typeof vi.fn>
      ).mock.results[0]?.value as { up: ReturnType<typeof vi.fn> };
      expect(orchInstance.up).toHaveBeenCalledWith([]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up writes ~/.townhouse/connector.yaml with anon.enabled: true', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const yamlPath = join(configDir, 'connector.yaml');
      expect(existsSync(yamlPath)).toBe(true);
      const { parse: yamlParse } = await import('yaml');
      const parsed = yamlParse(readFileSync(yamlPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      const anon = parsed['anon'] as Record<string, unknown> | undefined;
      expect(anon?.['enabled']).toBe(true);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up writes ~/.townhouse/host.json with the published hostname', async () => {
    const hostname = 'testhost123.anyone';
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({ hostname });
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const hostJsonPath = join(configDir, 'host.json');
      expect(existsSync(hostJsonPath)).toBe(true);
      const json = JSON.parse(readFileSync(hostJsonPath, 'utf-8')) as {
        hostname: string;
        publishedAt: string;
        connectorAdminUrl: string;
        townhouseApiUrl: string;
        writtenAt: string;
      };
      expect(json.hostname).toBe(hostname);
      expect(json.connectorAdminUrl).toBe('http://127.0.0.1:9401');
      expect(json.townhouseApiUrl).toBe('http://127.0.0.1:28090');
      expect(json.publishedAt).toBeTruthy();
      expect(json.writtenAt).toBeTruthy();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up final stdout line is "Apex live at <hostname>"', async () => {
    const hostname = 'apex123.anyone';
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({ hostname });
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const allOutput = stdoutSpy.mock.calls
        .map((c) => c[0] as string)
        .join('');
      expect(allOutput).toContain(`Apex live at ${hostname}`);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up with --password flag does NOT prompt interactively', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    // Remove env var so only --password is available
    delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
    try {
      const overrides = makeHsOverrides({});
      // If it tries to prompt, process.stdin.isTTY is false → would exit 1
      await main(
        ['hs', 'up', '-c', configPath, '--password', WALLET_PASSWORD],
        undefined,
        undefined,
        overrides
      );
      // Should succeed (not exit 1 due to missing password)
      expect(process.exitCode).not.toBe(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_PASSWORD;
    }
  });

  it('hs up with no password and non-TTY stdin exits 1 with password-required message', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    delete process.env['TOWNHOUSE_WALLET_PASSWORD'];
    try {
      // stdin.isTTY is already false from beforeEach
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        makeHsOverrides({})
      );
      expect(process.exitCode).toBe(1);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Wallet password required')
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
      process.env['TOWNHOUSE_WALLET_PASSWORD'] = WALLET_PASSWORD;
    }
  });

  // ── hs up: idempotent re-run ───────────────────────────────────────────────

  it('hs up against running apex (getHsHostname returns non-null) skips materialize + orchestrator', async () => {
    const hostname = 'running123.anyone';
    const { configDir, configPath } = await makeHsTestDir();
    try {
      // probe: 'running' → first admin client call returns the running hostname.
      const overrides = makeHsOverrides({ hostname, probe: 'running' });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      // materializeComposeTemplate should NOT be called (idempotent path)
      expect(overrides.materializeComposeTemplate).not.toHaveBeenCalled();
      // orchestrator should NOT be constructed
      expect(overrides.createOrchestrator).not.toHaveBeenCalled();

      const allOutput =
        consoleSpy.mock.calls.map((c) => c[0] as string).join('') +
        stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
      expect(allOutput).toContain(`Apex live at ${hostname}`);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // ── hs up: containerState → ribbon bootstrap ──────────────────────────────

  it('hs up wires containerState listener (ribbon bootstrap transitions on "creating")', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({
        hostname: 'test.anyone',
        emitContainerStateOnUp: true,
      });
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      // If no error is thrown, the ribbon transition fired without crashing.
      expect(process.exitCode).not.toBe(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // ── hs up: reconciler wiring (Story 46.1) ─────────────────────────────────

  it('hs up calls BootReconciler.reconcile() exactly once on cold-boot', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const reconcileSpy = vi.fn(async () => undefined);
      const overrides = makeHsOverrides({ reconcileSpy });
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      expect(overrides.createReconciler).toHaveBeenCalledTimes(1);
      expect(overrides.createReconciler).toHaveBeenCalledWith(
        join(configDir, 'nodes.yaml'),
        join(configDir, 'reconciler.log')
      );
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: reconciler errors are non-fatal (logged to stderr, hostname still printed)', async () => {
    const hostname = 'reconcerr.anyone';
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({ hostname, reconcileThrows: true });
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      // Non-fatal: exit code is not 1, hostname still printed.
      expect(process.exitCode).not.toBe(1);
      const errOutput = consoleErrorSpy.mock.calls
        .map((c) => c[0] as string)
        .join('\n');
      expect(errOutput).toContain('reconciler error (non-fatal)');
      expect(errOutput).toContain('reconciler boom');
      const allOutput =
        consoleSpy.mock.calls.map((c) => c[0] as string).join('') +
        stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
      expect(allOutput).toContain(`Apex live at ${hostname}`);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: reconciler is NOT called on idempotent path (apex already running)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({ probe: 'running' });
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      // Idempotent re-print path skips orchestrator AND reconciler.
      expect(overrides.createReconciler).not.toHaveBeenCalled();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // ── hs down: default (preserve volumes) ───────────────────────────────────

  it('hs down invokes orchestrator.down() (no -v)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const downFn = vi.fn(async () => undefined);
      const overrides = makeHsOverrides({
        hostname: 'test.anyone',
        down: downFn,
      });
      await main(
        ['hs', 'down', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      expect(downFn).toHaveBeenCalledTimes(1);
      // runComposeDown (the -v path) must NOT have been called
      expect(overrides.runComposeDown).not.toHaveBeenCalled();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs down prints volume-preserved message', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'down', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Volumes preserved')
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // ── hs down --rotate-keys ─────────────────────────────────────────────────

  it('hs down --rotate-keys with non-TTY stdin proceeds without prompt', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      // Create a host.json that rotate-keys should delete
      writeFileSync(
        join(configDir, 'host.json'),
        JSON.stringify({ hostname: 'old.anyone' })
      );

      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'down', '--rotate-keys', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      // runComposeDown should be called with withVolumes: true
      expect(overrides.runComposeDown).toHaveBeenCalledWith(
        '/tmp/fake/townhouse-hs.yml',
        true
      );
      // host.json should be deleted
      expect(existsSync(join(configDir, 'host.json'))).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs down --rotate-keys deletes host.json', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    const hostJsonPath = join(configDir, 'host.json');
    writeFileSync(hostJsonPath, JSON.stringify({ hostname: 'old.anyone' }));
    try {
      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'down', '--rotate-keys', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      expect(existsSync(hostJsonPath)).toBe(false);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // ── Failure copy ──────────────────────────────────────────────────────────

  it('anon-timeout OrchestratorError renders failure copy on stderr', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const overrides = makeHsOverrides({
        up: vi.fn(async () => {
          const { OrchestratorError } =
            await import('./docker/orchestrator.js');
          throw new OrchestratorError(
            'HS hostname publication timeout after 120000ms'
          );
        }),
      });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const stderrOut = stderrSpy.mock.calls
        .map((c) => c[0] as string)
        .join('');
      expect(stderrOut).toContain("Hidden service didn't publish in time.");
      expect(process.exitCode).toBe(1);
      stderrSpy.mockRestore();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('image-pull-failure stderr renders failure copy', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const overrides = makeHsOverrides({
        up: vi.fn(async () => {
          const { OrchestratorError } =
            await import('./docker/orchestrator.js');
          throw new OrchestratorError('docker compose up failed', {
            stderr:
              'failed to pull ghcr.io/toon-protocol/connector: image not found',
          });
        }),
      });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const stderrOut = stderrSpy.mock.calls
        .map((c) => c[0] as string)
        .join('');
      expect(stderrOut).toContain('Image pull failed.');
      expect(process.exitCode).toBe(1);
      stderrSpy.mockRestore();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('port-collision stderr renders failure copy', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const overrides = makeHsOverrides({
        up: vi.fn(async () => {
          const { OrchestratorError } =
            await import('./docker/orchestrator.js');
          throw new OrchestratorError('docker compose up failed', {
            stderr: 'Bind for 127.0.0.1:9401 failed: port is already allocated',
          });
        }),
      });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const stderrOut = stderrSpy.mock.calls
        .map((c) => c[0] as string)
        .join('');
      expect(stderrOut).toContain('Port already in use.');
      expect(process.exitCode).toBe(1);
      stderrSpy.mockRestore();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('missing-docker-sock renders failure copy', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const overrides = makeHsOverrides({
        up: vi.fn(async () => {
          const { OrchestratorError } =
            await import('./docker/orchestrator.js');
          throw new OrchestratorError(
            'docker CLI not found on PATH (ENOENT): docker: command not found'
          );
        }),
      });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const stderrOut = stderrSpy.mock.calls
        .map((c) => c[0] as string)
        .join('');
      expect(stderrOut).toContain('Docker daemon unreachable.');
      expect(process.exitCode).toBe(1);
      stderrSpy.mockRestore();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('generic unknown error renders generic failure copy', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const overrides = makeHsOverrides({
        up: vi.fn(async () => {
          throw new Error('something completely unexpected');
        }),
      });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const stderrOut = stderrSpy.mock.calls
        .map((c) => c[0] as string)
        .join('');
      expect(stderrOut).toContain('Apex boot failed.');
      expect(stderrOut).toContain('something completely unexpected');
      expect(process.exitCode).toBe(1);
      stderrSpy.mockRestore();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
