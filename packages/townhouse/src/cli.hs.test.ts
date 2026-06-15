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
import { mountTui } from './tui/index.js';

// Mock the TUI module so tests never actually render Ink.
// vi.mock is hoisted before imports — the dynamic import inside handleHsUp
// gets this mock when process.stdout.isTTY is true.
vi.mock('./tui/index.js', () => ({
  mountTui: vi.fn(() => ({
    waitUntilExit: () => Promise.resolve(),
  })),
}));

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
  /** If supplied, used as the `rebindChildren` override (boot rebinder spy). */
  rebindSpy?: ReturnType<typeof vi.fn>;
  /**
   * Pull-progress events to emit from each `pullImage(ref)` call. Indexed
   * by image ref. When omitted, `pullImage` resolves silently.
   * (Epic 49 Followup D.)
   */
  pullEventsByImage?: Record<
    string,
    { status: string; id?: string; progress?: string }[]
  >;
  /** If true, the next pullImage call rejects (verifies non-fatal degrade). */
  pullImageThrows?: boolean;
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
  rebindSpy,
  pullEventsByImage,
  pullImageThrows = false,
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

  // Stub pullImage: synthesizes `pullProgress` events from the supplied
  // map and resolves. Drives Followup D narration assertions.
  const pullImage = vi.fn(async (image: string) => {
    if (pullImageThrows) {
      throw new Error(`stub pull failed for ${image}`);
    }
    const events = pullEventsByImage?.[image] ?? [];
    const handlers = listeners.get('pullProgress') ?? [];
    for (const event of events) {
      for (const h of handlers) {
        h({
          image,
          status: event.status,
          id: event.id,
          progress: event.progress,
        });
      }
    }
  });

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
      pullImage: pullImage as (image: string) => Promise<void>,
      // Present so the boot-rebind wiring is exercised; the rebinder itself is
      // stubbed via `rebindChildren` below, so this is never actually invoked.
      startNodeViaCompose: vi.fn(async () => undefined),
      // Relay HS sidecar lifecycle — only invoked when nodes.yaml has a town.
      ensureRelaySidecar: vi.fn(async () => undefined),
      getRelayHsHostname: vi.fn(async () => 'relay-test.anyone'),
    })),
    rebindChildren:
      rebindSpy ??
      vi.fn(async () => ({ started: [], skipped: [], failed: [] })),
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
    // Port-collision preflight stub (Epic 49 Followup B): default to "no
    // collisions" so happy-path tests don't get blocked by ports actually
    // bound on the host running CI.
    checkPortCollisions: vi.fn(async () => []),
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
        expect.stringContaining('Usage: townhouse hs <up|enable|down>')
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

  it('hs up --json emits a terminal {step:"done"} NDJSON marker (P2b)', async () => {
    const hostname = 'apex123.anyone';
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({ hostname });
      await main(
        ['hs', 'up', '-c', configPath, '--json'],
        undefined,
        undefined,
        overrides
      );

      // emitUpStep writes NDJSON via console.log; townhouse_up_status keys on
      // a terminal done/error step.
      const steps = consoleSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.trim().startsWith('{'))
        .map((l) => JSON.parse(l) as { step?: string; transport?: string });
      expect(steps.some((s) => s.step === 'starting')).toBe(true);
      const done = steps.find((s) => s.step === 'done');
      expect(done).toBeDefined();
      expect(done?.transport).toBe('hs');
      expect(steps.some((s) => s.step === 'error')).toBe(false);
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

  it('hs up re-attaches (no port-collision error) when apex is already live on its own ports', async () => {
    const hostname = 'running456.anyone';
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      // Apex is already live...
      const overrides = makeHsOverrides({ hostname, probe: 'running' });
      // ...and the preflight WOULD flag its own canonical ports as in-use.
      overrides.checkPortCollisions = vi.fn(async () => [
        {
          port: 9401,
          containerName: 'townhouse-hs-connector',
          composeProject: 'compose',
          status: 'Up 10 minutes',
        },
      ]);

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      // Idempotent re-attach wins: no collision error, no failure exit.
      expect(process.exitCode).not.toBe(1);
      const stderrOut = stderrSpy.mock.calls
        .map((c) => c[0] as string)
        .join('');
      expect(stderrOut).not.toContain(
        'cannot start — host ports already in use'
      );
      // The preflight is never even consulted — the probe short-circuits first.
      expect(overrides.checkPortCollisions).not.toHaveBeenCalled();
      // And it re-prints the live address (re-attach path).
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

  it('hs up publishes the relay HS + writes host.json.relayHostname when a town exists', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      // Seed a provisioned town so the relay-HS step fires.
      writeFileSync(
        join(configDir, 'nodes.yaml'),
        'entries:\n  - id: town\n    type: town\n    peerId: town\n    ilpAddress: g.townhouse.town\n    derivationIndex: 0\n    enabledAt: 2026-01-01T00:00:00.000Z\n    lastSeenAt: null\n'
      );
      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const orch = (overrides.createOrchestrator as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as {
        ensureRelaySidecar: ReturnType<typeof vi.fn>;
        getRelayHsHostname: ReturnType<typeof vi.fn>;
      };
      expect(orch.ensureRelaySidecar).toHaveBeenCalledTimes(1);
      expect(orch.getRelayHsHostname).toHaveBeenCalledTimes(1);

      const hostJson = JSON.parse(
        readFileSync(join(configDir, 'host.json'), 'utf-8')
      ) as { relayHostname?: string };
      expect(hostJson.relayHostname).toBe('relay-test.anyone');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up skips the relay HS when no town is provisioned', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      const orch = (overrides.createOrchestrator as ReturnType<typeof vi.fn>)
        .mock.results[0]?.value as {
        ensureRelaySidecar: ReturnType<typeof vi.fn>;
      };
      expect(orch.ensureRelaySidecar).not.toHaveBeenCalled();
      const hostJson = JSON.parse(
        readFileSync(join(configDir, 'host.json'), 'utf-8')
      ) as { relayHostname?: string };
      expect(hostJson.relayHostname).toBeUndefined();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up calls the boot rebinder once with nodes.yaml path + config (before reconcile)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const rebindSpy = vi.fn(async () => ({
        started: [],
        skipped: [],
        failed: [],
      }));
      const overrides = makeHsOverrides({ rebindSpy });
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      expect(rebindSpy).toHaveBeenCalledTimes(1);
      expect(rebindSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          nodesYamlPath: join(configDir, 'nodes.yaml'),
          config: expect.anything(),
          wallet: expect.anything(),
          orchestrator: expect.anything(),
        })
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: boot-rebind errors are non-fatal (logged, apex still comes up)', async () => {
    const hostname = 'rebinderr.anyone';
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const rebindSpy = vi.fn(async () => {
        throw new Error('rebind boom');
      });
      const overrides = makeHsOverrides({ hostname, rebindSpy });
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      expect(process.exitCode).not.toBe(1);
      const errOutput = consoleErrorSpy.mock.calls
        .map((c) => c[0] as string)
        .join('\n');
      expect(errOutput).toContain('child rebind error (non-fatal)');
      expect(errOutput).toContain('rebind boom');
      const allOutput =
        consoleSpy.mock.calls.map((c) => c[0] as string).join('') +
        stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
      expect(allOutput).toContain(`Apex live at ${hostname}`);
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

  // ── TUI mount gate (Story 48.1, AC #1 + AC #2) ───────────────────────────

  it('hs up with isTTY=true calls mountTui and awaits waitUntilExit', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    const origIsTTY = process.stdout.isTTY;
    const origCI = process.env['CI'];
    const origNO_TUI = process.env['NO_TUI'];
    const origTERM = process.env['TERM'];
    const origApiUrl = process.env['HS_TOWNHOUSE_API_URL'];
    try {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      delete process.env['CI'];
      delete process.env['NO_TUI'];
      delete process.env['HS_TOWNHOUSE_API_URL'];
      process.env['TERM'] = 'xterm-256color';

      vi.mocked(mountTui).mockClear();

      // P12: prove `await instance.waitUntilExit()` is actually awaited.
      // The instrumented waitUntilExit flips a flag synchronously, then resolves.
      // If the CLI forgets the await, main() returns before waitUntilExit's
      // resolved continuation runs — but we can't distinguish that from the
      // immediate-await case without timing. Instead we assert the flag is
      // set by the time main() returns (which only happens after await).
      let waitUntilExitCalled = false;
      vi.mocked(mountTui).mockImplementation(
        () =>
          ({
            waitUntilExit: () => {
              waitUntilExitCalled = true;
              return Promise.resolve();
            },
          }) as ReturnType<typeof mountTui>
      );

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        makeHsOverrides({})
      );

      expect(vi.mocked(mountTui)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mountTui)).toHaveBeenCalledWith({});
      expect(waitUntilExitCalled).toBe(true);
    } finally {
      if (origApiUrl === undefined) {
        delete process.env['HS_TOWNHOUSE_API_URL'];
      } else {
        process.env['HS_TOWNHOUSE_API_URL'] = origApiUrl;
      }
      Object.defineProperty(process.stdout, 'isTTY', {
        value: origIsTTY,
        writable: true,
        configurable: true,
      });
      if (origCI === undefined) {
        delete process.env['CI'];
      } else {
        process.env['CI'] = origCI;
      }
      if (origNO_TUI === undefined) {
        delete process.env['NO_TUI'];
      } else {
        process.env['NO_TUI'] = origNO_TUI;
      }
      if (origTERM === undefined) {
        delete process.env['TERM'];
      } else {
        process.env['TERM'] = origTERM;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up with isTTY=false does NOT call mountTui and exits 0', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      // process.stdout.isTTY is undefined/falsy by default in test environment
      vi.mocked(mountTui).mockClear();

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        makeHsOverrides({})
      );

      expect(vi.mocked(mountTui)).not.toHaveBeenCalled();
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up with HS_TOWNHOUSE_API_URL env override threads through mountTui (P27)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    const origIsTTY = process.stdout.isTTY;
    const origCI = process.env['CI'];
    const origNO_TUI = process.env['NO_TUI'];
    const origTERM = process.env['TERM'];
    const origApiUrl = process.env['HS_TOWNHOUSE_API_URL'];
    try {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        writable: true,
        configurable: true,
      });
      delete process.env['CI'];
      delete process.env['NO_TUI'];
      process.env['TERM'] = 'xterm-256color';
      process.env['HS_TOWNHOUSE_API_URL'] = 'http://127.0.0.1:39999';

      vi.mocked(mountTui).mockClear();
      vi.mocked(mountTui).mockReturnValue({
        waitUntilExit: () => Promise.resolve(),
      } as ReturnType<typeof mountTui>);

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        makeHsOverrides({})
      );

      expect(vi.mocked(mountTui)).toHaveBeenCalledWith({
        apiUrl: 'http://127.0.0.1:39999',
      });
    } finally {
      if (origApiUrl === undefined) {
        delete process.env['HS_TOWNHOUSE_API_URL'];
      } else {
        process.env['HS_TOWNHOUSE_API_URL'] = origApiUrl;
      }
      Object.defineProperty(process.stdout, 'isTTY', {
        value: origIsTTY,
        writable: true,
        configurable: true,
      });
      if (origCI === undefined) {
        delete process.env['CI'];
      } else {
        process.env['CI'] = origCI;
      }
      if (origNO_TUI === undefined) {
        delete process.env['NO_TUI'];
      } else {
        process.env['NO_TUI'] = origNO_TUI;
      }
      if (origTERM === undefined) {
        delete process.env['TERM'];
      } else {
        process.env['TERM'] = origTERM;
      }
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // ── Port-collision preflight (Epic 49 Followup B) ─────────────────────────

  it('hs up exits 1 BEFORE wallet unlock when preflight reports collisions', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const overrides = makeHsOverrides({});
      // Override the preflight stub to report a collision.
      overrides.checkPortCollisions = vi.fn(async () => [
        {
          port: 9401,
          containerName: 'townhouse-hs-connector',
          composeProject: 'compose',
          status: 'Up 5 hours',
        },
        { port: 3100 },
      ]);

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      expect(process.exitCode).toBe(1);
      // Preflight still blocks the cold boot: no orchestrator, no materialize,
      // and (since it runs before wallet unlock) no wallet decrypt.
      expect(overrides.createOrchestrator).not.toHaveBeenCalled();
      expect(overrides.materializeComposeTemplate).not.toHaveBeenCalled();
      // The idempotency probe now runs BEFORE the preflight: it finds apex not
      // live (cold), so the preflight fires on the foreign collision. The probe
      // having run is exactly what lets an already-live apex re-attach instead
      // of failing the port check on its own ports.
      expect(overrides.createAdminClient).toHaveBeenCalled();

      const stderrOut = stderrSpy.mock.calls
        .map((c) => c[0] as string)
        .join('');
      expect(stderrOut).toContain(
        'townhouse hs up: cannot start — host ports already in use:'
      );
      expect(stderrOut).toContain('127.0.0.1:9401');
      expect(stderrOut).toContain("'townhouse-hs-connector'");
      expect(stderrOut).toContain("(compose project 'compose'");
      expect(stderrOut).toContain('127.0.0.1:3100');
      expect(stderrOut).toContain('docker compose -p compose down');
      expect(stderrOut).toContain(
        'Re-run with --skip-preflight to bypass this check.'
      );
      stderrSpy.mockRestore();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up --skip-preflight bypasses the preflight check entirely', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      const preflightSpy = vi.fn(async () => [
        { port: 9401, containerName: 'x', composeProject: 'y', status: 'Up' },
      ]);
      overrides.checkPortCollisions = preflightSpy;

      await main(
        ['hs', 'up', '-c', configPath, '--skip-preflight'],
        undefined,
        undefined,
        overrides
      );

      // Preflight stub never invoked when --skip-preflight is set.
      expect(preflightSpy).not.toHaveBeenCalled();
      // Boot proceeded.
      expect(overrides.createOrchestrator).toHaveBeenCalled();
      expect(process.exitCode).not.toBe(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: preflight returning [] proceeds to cold-boot normally', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      overrides.checkPortCollisions = vi.fn(async () => []);

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      expect(overrides.checkPortCollisions).toHaveBeenCalledTimes(1);
      expect(overrides.createOrchestrator).toHaveBeenCalled();
      expect(process.exitCode).not.toBe(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: preflight error is non-fatal (logs and continues)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      overrides.checkPortCollisions = vi.fn(async () => {
        throw new Error('kernel: out of file descriptors');
      });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      // Non-fatal: boot continued and exit code is NOT 1.
      expect(overrides.createOrchestrator).toHaveBeenCalled();
      expect(process.exitCode).not.toBe(1);
      const errOutput = consoleErrorSpy.mock.calls
        .map((c) => c[0] as string)
        .join('\n');
      expect(errOutput).toContain('port preflight skipped (non-fatal)');
      expect(errOutput).toContain('out of file descriptors');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  // ── Cold image-pull progress narration (Epic 49 Followup D) ─────────────

  /** Write a valid image-manifest.json into the configDir so handleHsUp's
   * collectApexImageRefs returns the two apex images.
   */
  function writeApexManifest(configDir: string): {
    connectorRef: string;
    apiRef: string;
  } {
    const connectorDigest =
      'sha256:1111111111111111111111111111111111111111111111111111111111111111';
    const apiDigest =
      'sha256:2222222222222222222222222222222222222222222222222222222222222222';
    const manifest = {
      schemaVersion: 1,
      townhouseVersion: '0.0.1-test',
      builtAt: '2026-05-21T00:00:00.000Z',
      images: {
        'townhouse-api': {
          name: 'ghcr.io/toon-protocol/townhouse-api',
          tag: '0.0.1-test',
          digest: apiDigest,
        },
        town: {
          name: 'ghcr.io/toon-protocol/town',
          tag: '0.0.1-test',
          digest:
            'sha256:3333333333333333333333333333333333333333333333333333333333333333',
        },
        mill: {
          name: 'ghcr.io/toon-protocol/mill',
          tag: '0.0.1-test',
          digest:
            'sha256:4444444444444444444444444444444444444444444444444444444444444444',
        },
        dvm: {
          name: 'ghcr.io/toon-protocol/dvm',
          tag: '0.0.1-test',
          digest:
            'sha256:5555555555555555555555555555555555555555555555555555555555555555',
        },
        connector: {
          name: 'ghcr.io/toon-protocol/connector',
          tag: '0.0.1-test',
          digest: connectorDigest,
        },
      },
    };
    writeFileSync(
      join(configDir, 'image-manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );
    return {
      connectorRef: `ghcr.io/toon-protocol/connector@${connectorDigest}`,
      apiRef: `ghcr.io/toon-protocol/townhouse-api@${apiDigest}`,
    };
  }

  it('hs up: pre-pulls apex images and prints "Pulling N of M" preamble', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const { connectorRef, apiRef } = writeApexManifest(configDir);
      const overrides = makeHsOverrides({
        pullEventsByImage: {
          [connectorRef]: [
            { status: 'Pulling fs layer', id: 'layer-1' },
            { status: 'Pull complete', id: 'layer-1' },
          ],
          [apiRef]: [
            { status: 'Pulling fs layer', id: 'layer-2' },
            { status: 'Pull complete', id: 'layer-2' },
          ],
        },
      });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const stdout = consoleSpy.mock.calls
        .map((c) => c[0] as string)
        .join('\n');

      expect(stdout).toContain('Pulling 2 apex images...');
      expect(stdout).toContain(`[1/2] ${connectorRef}`);
      expect(stdout).toContain(`[2/2] ${apiRef}`);
      expect(stdout).toContain(`[pull] ${connectorRef}: Pulling fs layer`);
      expect(stdout).toContain(`[pull] ${connectorRef}: Pull complete`);
      expect(stdout).toContain(`[pull] ${apiRef}: Pulling fs layer`);
      expect(stdout).toContain(`[pull] ${apiRef}: Pull complete`);
      expect(process.exitCode).not.toBe(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: dedupes repeated Downloading events to one line per layer-state transition', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const { connectorRef, apiRef } = writeApexManifest(configDir);
      const overrides = makeHsOverrides({
        pullEventsByImage: {
          [connectorRef]: [
            { status: 'Pulling fs layer', id: 'l1' },
            // Many Downloading events back-to-back — only the FIRST should
            // print (transition Pulling fs layer → Downloading). Subsequent
            // ones land in the throttle window (< 1 s elapsed in same tick).
            { status: 'Downloading', id: 'l1', progress: '1MB' },
            { status: 'Downloading', id: 'l1', progress: '2MB' },
            { status: 'Downloading', id: 'l1', progress: '3MB' },
            { status: 'Downloading', id: 'l1', progress: '4MB' },
            { status: 'Extracting', id: 'l1', progress: '1MB' },
            { status: 'Pull complete', id: 'l1' },
          ],
          [apiRef]: [{ status: 'Already exists', id: 'l2' }],
        },
      });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const pullLines = consoleSpy.mock.calls
        .map((c) => c[0] as string)
        .filter((line) => line.includes('[pull]'));

      // Connector: 4 lines expected — Pulling fs layer, Downloading (1st),
      // Extracting (transition), Pull complete. The 3 redundant Downloading
      // events are throttled out.
      const connectorLines = pullLines.filter((l) => l.includes(connectorRef));
      expect(connectorLines).toEqual([
        `  [pull] ${connectorRef}: Pulling fs layer`,
        `  [pull] ${connectorRef}: Downloading 1MB`,
        `  [pull] ${connectorRef}: Extracting 1MB`,
        `  [pull] ${connectorRef}: Pull complete`,
      ]);

      // API: single "Already exists" line.
      const apiLines = pullLines.filter((l) => l.includes(apiRef));
      expect(apiLines).toEqual([`  [pull] ${apiRef}: Already exists`]);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: missing image-manifest.json narrates on-demand pull (no silent void, no error)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    // Intentionally NOT writing image-manifest.json.
    try {
      const overrides = makeHsOverrides({});

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const stdout = consoleSpy.mock.calls
        .map((c) => c[0] as string)
        .join('\n');
      // No per-image pre-pull lines (no manifest to pin them)...
      expect(stdout).not.toContain('[pull]');
      // ...but the wait is NOT a silent void: the user is told Docker will pull
      // images on demand and that first start can take a few minutes.
      expect(stdout).toContain('Docker will pull');
      // Boot still succeeds.
      expect(process.exitCode).not.toBe(1);
      expect(overrides.createOrchestrator).toHaveBeenCalled();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: pullImage rejection is non-fatal — logs and continues to compose-up', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      writeApexManifest(configDir);
      const overrides = makeHsOverrides({ pullImageThrows: true });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const stdout = consoleSpy.mock.calls
        .map((c) => c[0] as string)
        .join('\n');
      // Calm, non-alarming narration (not an error) — and the boot continues.
      expect(stdout).toContain('Could not pre-pull images');
      expect(stdout).toContain('Docker will pull them during startup');
      // Boot still proceeded to orchestrator.up — see createOrchestrator was
      // called and the orchestrator stub's up was invoked.
      const orchInstance = (
        overrides.createOrchestrator as ReturnType<typeof vi.fn>
      ).mock.results[0]?.value;
      expect(orchInstance.up).toHaveBeenCalled();
      expect(process.exitCode).not.toBe(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: TUI mount failure is NOT reported as a boot failure (apex already live)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    writeApexManifest(configDir);
    const overrides = makeHsOverrides({});

    // Force the Ink/TUI path on (shouldRenderInk needs a TTY, no CI, TERM≠dumb)
    // and make the TUI mount throw — simulating an Ink/React render failure that
    // happens AFTER apex is already live. The boot must still count as success.
    const origStdoutIsTTY = process.stdout.isTTY;
    const origCI = process.env['CI'];
    const origNoColor = process.env['NO_COLOR'];
    const origTerm = process.env['TERM'];
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
    delete process.env['CI'];
    process.env['NO_COLOR'] = '1'; // suppress the ribbon spinner timer
    process.env['TERM'] = 'xterm';
    vi.mocked(mountTui).mockImplementationOnce(() => {
      throw new Error('ink mount boom');
    });

    try {
      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      // We actually exercised the TUI branch.
      expect(vi.mocked(mountTui)).toHaveBeenCalled();
      // Boot is NOT reported as a failure — apex is live.
      expect(process.exitCode).not.toBe(1);
      const stderr = consoleErrorSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(stderr).not.toContain('Apex boot failed');
      // The display failure is surfaced as a calm, non-fatal note instead.
      expect(stderr).toContain('display issue, not a node issue');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: origStdoutIsTTY,
        configurable: true,
      });
      if (origCI === undefined) delete process.env['CI'];
      else process.env['CI'] = origCI;
      if (origNoColor === undefined) delete process.env['NO_COLOR'];
      else process.env['NO_COLOR'] = origNoColor;
      if (origTerm === undefined) delete process.env['TERM'];
      else process.env['TERM'] = origTerm;
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: ATOR bootstrap timeout retries up to 3× and succeeds on 3rd attempt', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const { OrchestratorError } = await import('./docker/orchestrator.js');
      let upCallCount = 0;
      const downFn = vi.fn(async () => undefined);
      const upFn = vi.fn(async () => {
        upCallCount++;
        if (upCallCount < 3) {
          throw new OrchestratorError('docker compose up failed (exit 1)', {
            stderr:
              'dependency failed to start: container townhouse-hs-connector is unhealthy',
          });
        }
        // 3rd attempt succeeds — no throw
      });

      const overrides = makeHsOverrides({ up: upFn, down: downFn });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      // up() called 3 times (2 bootstrap timeouts + 1 success)
      expect(upFn).toHaveBeenCalledTimes(3);
      // down() called between retries — exactly 2 times (after attempt 1 and 2)
      expect(downFn).toHaveBeenCalledTimes(2);
      // retry log messages emitted for each failure
      const errOutput = consoleErrorSpy.mock.calls
        .map((c) => c[0] as string)
        .join('\n');
      expect(errOutput).toContain('ATOR bootstrap timed out (attempt 1/3)');
      expect(errOutput).toContain('ATOR bootstrap timed out (attempt 2/3)');
      expect(process.exitCode).not.toBe(1);
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs up: ATOR bootstrap timeout exhausted (3 failures) propagates error', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const stderrSpy = vi
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      const { OrchestratorError } = await import('./docker/orchestrator.js');
      const downFn = vi.fn(async () => undefined);
      const upFn = vi.fn(async () => {
        throw new OrchestratorError('docker compose up failed (exit 1)', {
          stderr:
            'dependency failed to start: container townhouse-hs-connector is unhealthy',
        });
      });

      const overrides = makeHsOverrides({ up: upFn, down: downFn });

      await main(
        ['hs', 'up', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      // All 3 attempts were made
      expect(upFn).toHaveBeenCalledTimes(3);
      // down() called after attempt 1 and 2 (not after the final throw)
      expect(downFn).toHaveBeenCalledTimes(2);
      expect(process.exitCode).toBe(1);
      stderrSpy.mockRestore();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ── Phase 3: `townhouse up` defaults to a direct-BTP apex; HS stays opt-in ──
describe('CLI up — direct-BTP default (Phase 3)', () => {
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
    process.exitCode = undefined;
    stdinIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      writable: true,
      configurable: true,
    });
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

  it('plain `up` (no flags) boots a direct apex and prints the BTP dial address', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      await main(['up', '-c', configPath], undefined, undefined, overrides);

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('Apex live (direct BTP)');
      expect(output).toContain('ws://127.0.0.1:3000/btp');
      // Direct path materializes the 'direct' compose profile.
      expect(overrides.materializeComposeTemplate).toHaveBeenCalledWith(
        'direct',
        expect.anything()
      );
      // The orchestrator was constructed with the 'direct' profile (widened type).
      expect(overrides.createOrchestrator).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ profile: 'direct' })
      );
      // A direct connector.yaml (no anon) was written.
      const written = readFileSync(join(configDir, 'connector.yaml'), 'utf-8');
      expect(written).not.toContain('anon');
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('plain `up` auto-rebinds children + reconciles peers (direct mode)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const rebindSpy = vi.fn(async () => ({
        started: [],
        skipped: [],
        failed: [],
      }));
      const reconcileSpy = vi.fn(async () => undefined);
      const overrides = makeHsOverrides({ rebindSpy, reconcileSpy });
      await main(['up', '-c', configPath], undefined, undefined, overrides);

      expect(rebindSpy).toHaveBeenCalledTimes(1);
      expect(rebindSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          nodesYamlPath: join(configDir, 'nodes.yaml'),
        })
      );
      // Direct mode now also re-registers child peers (it didn't before).
      expect(overrides.createReconciler).toHaveBeenCalledTimes(1);
      expect(reconcileSpy).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('`up --transport direct` is a synonym for the default direct path', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      await main(
        ['up', '--transport', 'direct', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('Apex live (direct BTP)');
      expect(overrides.materializeComposeTemplate).toHaveBeenCalledWith(
        'direct',
        expect.anything()
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('back-compat guard: refuses direct `up` when an HS apex config exists', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      // Simulate an operator already running an HS apex.
      writeFileSync(
        join(configDir, 'connector.yaml'),
        'anon:\n  enabled: true\ntransport:\n  type: hs\n',
        'utf-8'
      );
      const overrides = makeHsOverrides({});
      await main(['up', '-c', configPath], undefined, undefined, overrides);

      const errOut = consoleErrorSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(errOut).toContain('hidden-service apex detected');
      expect(errOut).toContain('townhouse hs up');
      expect(process.exitCode).toBe(1);
      // Guard fires BEFORE any orchestration — no direct stack was brought up.
      expect(overrides.createOrchestrator).not.toHaveBeenCalled();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('`up --transport hs` routes to the hidden-service path', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({ hostname: 'route.anyone' });
      await main(
        ['up', '--transport', 'hs', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      // HS path prints "Apex live at <hostname>" via process.stdout.write,
      // not the direct BTP address.
      const stdoutOut = stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
      const logOut = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(stdoutOut).toContain('route.anyone');
      expect(logOut).not.toContain('Apex live (direct BTP)');
      expect(overrides.materializeComposeTemplate).toHaveBeenCalledWith(
        'hs',
        expect.anything()
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('`up --transport bogus` errors with the supported values', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      const overrides = makeHsOverrides({});
      await main(
        ['up', '--transport', 'bogus', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      const errOut = consoleErrorSpy.mock.calls
        .map((c) => String(c[0]))
        .join('\n');
      expect(errOut).toContain('Unknown --transport value');
      expect(process.exitCode).toBe(1);
      expect(overrides.createOrchestrator).not.toHaveBeenCalled();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});

// ── Phase 3: `hs enable` switches a running direct deployment to HS ──
describe('CLI hs enable (Phase 3)', () => {
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
    process.exitCode = undefined;
    stdinIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      writable: true,
      configurable: true,
    });
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

  it('downs the direct stack then brings up HS (writes anon config)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      // Pre-seed a direct connector.yaml (no anon) — the starting state.
      writeFileSync(
        join(configDir, 'connector.yaml'),
        'transport:\n  type: direct\n',
        'utf-8'
      );
      const downFn = vi.fn(async () => undefined);
      const overrides = makeHsOverrides({
        hostname: 'enabled.anyone',
        down: downFn,
      });
      await main(
        ['hs', 'enable', '-c', configPath],
        undefined,
        undefined,
        overrides
      );

      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('Switching direct apex');
      // Direct stack was torn down before HS came up.
      expect(downFn).toHaveBeenCalled();
      // The HS profile was materialized (force overwrite of the direct config).
      expect(overrides.materializeComposeTemplate).toHaveBeenCalledWith(
        'hs',
        expect.anything()
      );
      // The HS orchestrator was constructed (transitioned to the HS stack).
      expect(overrides.createOrchestrator).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ profile: 'hs' })
      );
      // connector.yaml is now an HS config (force-overwrote the direct one).
      const written = readFileSync(join(configDir, 'connector.yaml'), 'utf-8');
      expect(written).toContain('anon');
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('is a no-op when an HS apex is already configured', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      writeFileSync(
        join(configDir, 'connector.yaml'),
        'anon:\n  enabled: true\ntransport:\n  type: hs\n',
        'utf-8'
      );
      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'enable', '-c', configPath],
        undefined,
        undefined,
        overrides
      );
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).toContain('already configured');
      // No teardown / no HS bring-up.
      expect(overrides.createOrchestrator).not.toHaveBeenCalled();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  const ndjsonSteps = (
    spy: ReturnType<typeof vi.spyOn>
  ): { step?: string; alreadyHs?: boolean; transport?: string }[] =>
    spy.mock.calls
      .map((c) => String(c[0]))
      .filter((l) => l.trim().startsWith('{'))
      .map((l) => JSON.parse(l));

  it('hs enable --json emits NDJSON boot steps (no human prose)', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      writeFileSync(
        join(configDir, 'connector.yaml'),
        'transport:\n  type: direct\n',
        'utf-8'
      );
      const overrides = makeHsOverrides({
        hostname: 'enabled.anyone',
        down: vi.fn(async () => undefined),
      });
      await main(
        ['hs', 'enable', '-c', configPath, '--json'],
        undefined,
        undefined,
        overrides
      );
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      // Human prose is suppressed under --json.
      expect(output).not.toContain('Switching direct apex');
      // `starting` is emitted before delegating to handleHsUp (which owns the
      // terminal done/error step — exercised by the hs up --json test). The
      // direct stack is still torn down first.
      const steps = ndjsonSteps(consoleSpy);
      expect(steps.some((s) => s.step === 'starting')).toBe(true);
      expect(overrides.materializeComposeTemplate).toHaveBeenCalledWith(
        'hs',
        expect.anything()
      );
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('hs enable --json on an already-HS apex emits a terminal alreadyHs step', async () => {
    const { configDir, configPath } = await makeHsTestDir();
    try {
      writeFileSync(
        join(configDir, 'connector.yaml'),
        'anon:\n  enabled: true\ntransport:\n  type: hs\n',
        'utf-8'
      );
      const overrides = makeHsOverrides({});
      await main(
        ['hs', 'enable', '-c', configPath, '--json'],
        undefined,
        undefined,
        overrides
      );
      const output = consoleSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(output).not.toContain('already configured');
      const done = ndjsonSteps(consoleSpy).find((s) => s.step === 'done');
      expect(done?.alreadyHs).toBe(true);
      expect(overrides.createOrchestrator).not.toHaveBeenCalled();
    } finally {
      rmSync(configDir, { recursive: true, force: true });
    }
  });
});
