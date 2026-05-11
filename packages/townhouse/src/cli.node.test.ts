/**
 * CLI node subcommand unit tests (Story 46.3).
 *
 * All tests use the `nodeCommandOverrides.fetch` DI hook — no real HTTP calls,
 * no real Docker, no real wallet decryption. Mirror pattern of cli.hs.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { main, CliHelpRequested } from './cli.js';
import type { CliNodeCommandOverrides } from './cli.js';
import { renderFailure } from './cli/failure-copy.js';

vi.mock('./cli/failure-copy.js', () => ({
  renderFailure: vi.fn(() => ({ exitCode: 1 })),
  useAscii: vi.fn(() => false),
}));

const ADD_URL = 'http://test.local';

function makeNodeOverrides(
  status: number,
  body: unknown,
  extra?: Partial<CliNodeCommandOverrides>
): CliNodeCommandOverrides {
  return {
    apiUrl: ADD_URL,
    fetch: vi.fn().mockResolvedValue({
      status,
      ok: status >= 200 && status < 300,
      json: () => Promise.resolve(body),
    }),
    ...extra,
  };
}

function makeConnRefused(
  extra?: Partial<CliNodeCommandOverrides>
): CliNodeCommandOverrides {
  return {
    apiUrl: ADD_URL,
    fetch: vi
      .fn()
      .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:28090')),
    ...extra,
  };
}

describe('CLI node subcommand', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTYDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    process.exitCode = undefined;
    // Capture the full descriptor so we can restore an accessor (tty.ReadStream
    // installs a getter) instead of clobbering it with a value property.
    originalIsTTYDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isTTY'
    );
    Object.defineProperty(process.stdin, 'isTTY', {
      value: false,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    process.exitCode = undefined;
    if (originalIsTTYDescriptor) {
      Object.defineProperty(process.stdin, 'isTTY', originalIsTTYDescriptor);
    } else {
      // Property did not exist originally — remove the shim entirely.
      delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
    vi.clearAllMocks();
  });

  function stdoutText(): string {
    return stdoutSpy.mock.calls.map((c) => String(c[0])).join('');
  }
  function stderrText(): string {
    return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
  }
  function consoleText(): string {
    return consoleSpy.mock.calls.map((c) => String(c[0])).join('');
  }

  // ── node add ──────────────────────────────────────────────────────────────

  it('node add with no type → POSTs {type: "town"} (AC #3)', async () => {
    const overrides = makeNodeOverrides(201, {
      id: 'town',
      type: 'town',
      peerId: 'town',
      ilpAddress: 'g.townhouse.town',
      hsRoute: 'g.townhouse.town',
      healthCheckUrl: 'http://townhouse-hs-town:3100/health',
    });
    await main(['node', 'add'], undefined, undefined, undefined, overrides);
    expect(process.exitCode).toBeUndefined();
    const fetched = (overrides.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetched[1].body as string);
    expect(body.type).toBe('town');
  });

  it('node add mill → POSTs {type: "mill"} and prints four-stage progress', async () => {
    const overrides = makeNodeOverrides(201, {
      id: 'mill',
      type: 'mill',
      peerId: 'mill',
      ilpAddress: 'g.townhouse.mill',
      hsRoute: 'g.townhouse.mill',
      healthCheckUrl: 'http://townhouse-hs-mill:3200/health',
    });
    await main(
      ['node', 'add', 'mill'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBeUndefined();
    const fetched = (overrides.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(fetched[1].body as string);
    expect(body.type).toBe('mill');
    const out = stdoutText();
    // Should contain the four stage labels
    expect(out).toContain('Pulling image');
    expect(out).toContain('Deriving wallet');
    expect(out).toContain('Registering with apex');
    expect(out).toContain('Live');
  });

  it('node add on 201 — stdout includes all four stages and the new node id', async () => {
    const overrides = makeNodeOverrides(201, {
      id: 'town',
      type: 'town',
      peerId: 'town',
      ilpAddress: 'g.townhouse.town',
      hsRoute: 'g.townhouse.town',
      healthCheckUrl: 'http://townhouse-hs-town:3100/health',
    });
    await main(
      ['node', 'add', 'town'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBeUndefined();
    const out = stdoutText();
    expect(out).toContain('Pulling image');
    expect(out).toContain('Deriving wallet');
    expect(out).toContain('Registering with apex');
    expect(out).toContain('Live');
    expect(out).toContain('town'); // id
  });

  it('node add on 502 step:pull-image → exit 1, renderFailure called', async () => {
    const overrides = makeNodeOverrides(502, {
      step: 'pull-image',
      err: 'failed to pull and unpack image: ...',
    });
    await main(
      ['node', 'add', 'town'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    expect(renderFailure).toHaveBeenCalledOnce();
    const err = (renderFailure as ReturnType<typeof vi.fn>).mock
      .calls[0][0] as Error;
    expect(err.message).toContain('failed to pull');
  });

  it('node add on 409 node_type_in_use → exit 1, message includes existingId', async () => {
    const overrides = makeNodeOverrides(409, {
      error: 'node_type_in_use',
      type: 'town',
      existingId: 'town',
    });
    await main(
      ['node', 'add', 'town'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    const err = stderrText();
    expect(err).toContain('town'); // existingId value
  });

  it('node add --json on 201 → stdout is single-line valid JSON with ok:true, no human prose', async () => {
    const apiBody = {
      id: 'town',
      type: 'town',
      peerId: 'town',
      ilpAddress: 'g.townhouse.town',
      hsRoute: 'g.townhouse.town',
      healthCheckUrl: 'http://townhouse-hs-town:3100/health',
    };
    const overrides = makeNodeOverrides(201, apiBody);
    await main(
      ['node', 'add', '--json'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBeUndefined();
    const lines = stdoutText().trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe('town');
    // No human prose to stderr
    expect(stderrText()).toBe('');
  });

  it('node add against unreachable API → exit 1, stderr includes "townhouse hs up"', async () => {
    const overrides = makeConnRefused();
    await main(
      ['node', 'add', 'town'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('townhouse hs up');
  });

  it('node add --help → stdout contains upsell string (AC #7)', async () => {
    await expect(
      main(
        ['node', 'add', '--help'],
        undefined,
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow(CliHelpRequested);
    const out = consoleText();
    expect(out).toContain(
      'townhouse node add mill   # earn from chain swaps (5x earnings unlock)'
    );
  });

  // ── node remove ───────────────────────────────────────────────────────────

  it('node remove <id> with TTY and no --yes → prompts; cancels on "n"', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    const confirmFn = vi.fn().mockResolvedValue(false);
    const overrides: CliNodeCommandOverrides = {
      apiUrl: ADD_URL,
      fetch: vi.fn(),
      confirm: confirmFn,
    };
    await main(
      ['node', 'remove', 'town'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBeUndefined(); // cancellation is not an error
    expect(confirmFn).toHaveBeenCalledOnce();
    expect(overrides.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(stdoutText()).toContain('Cancelled.');
  });

  it('node remove <id> with TTY and --yes → does NOT prompt; DELETEs immediately', async () => {
    Object.defineProperty(process.stdin, 'isTTY', {
      value: true,
      writable: true,
      configurable: true,
    });
    const confirmFn = vi.fn();
    const overrides = {
      ...makeNodeOverrides(200, { id: 'town', type: 'town' }),
      confirm: confirmFn,
    };
    await main(
      ['node', 'remove', 'town', '--yes'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBeUndefined();
    expect(confirmFn).not.toHaveBeenCalled();
    expect(overrides.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalledOnce();
  });

  it('node remove <id> with non-TTY and no --yes → exit 1 with --yes required message', async () => {
    // stdin.isTTY is false (default in beforeEach)
    const overrides: CliNodeCommandOverrides = {
      apiUrl: ADD_URL,
      fetch: vi.fn(),
    };
    await main(
      ['node', 'remove', 'town'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('--yes required');
    expect(overrides.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('node remove with no id → exit 1 with usage', async () => {
    const overrides: CliNodeCommandOverrides = {
      apiUrl: ADD_URL,
      fetch: vi.fn(),
    };
    await main(['node', 'remove'], undefined, undefined, undefined, overrides);
    expect(process.exitCode).toBe(1);
    const errOut = stderrText() + consoleText();
    expect(errOut).toContain('Usage');
  });

  it('node remove <id> on 404 → exit 1 with "No node with id" message', async () => {
    const overrides = makeNodeOverrides(404, {
      error: 'unknown_node',
      id: 'town',
    });
    await main(
      ['node', 'remove', 'town', '--yes'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain("No node with id 'town'");
  });

  it('node remove invalid_ID (uppercase) → exit 1, regex rejection (no HTTP call)', async () => {
    const overrides: CliNodeCommandOverrides = {
      apiUrl: ADD_URL,
      fetch: vi.fn(),
    };
    await main(
      ['node', 'remove', 'Town-01', '--yes'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    expect(overrides.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    const err = stderrText();
    expect(err).toContain('Town-01');
  });

  it('node remove <id> --json on 200 → stdout is {"ok":true, id, type}', async () => {
    const overrides = makeNodeOverrides(200, { id: 'town', type: 'town' });
    await main(
      ['node', 'remove', 'town', '--yes', '--json'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBeUndefined();
    const lines = stdoutText().trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe('town');
    expect(parsed.type).toBe('town');
    // No stderr output in json mode
    expect(stderrText()).toBe('');
  });

  // ── node list ─────────────────────────────────────────────────────────────

  it('node list empty → prints empty-state hint', async () => {
    const overrides = makeNodeOverrides(200, { nodes: [] });
    await main(['node', 'list'], undefined, undefined, undefined, overrides);
    expect(process.exitCode).toBeUndefined();
    const out = stdoutText();
    expect(out).toContain('No nodes provisioned');
    expect(out).toContain('townhouse node add town');
  });

  it('node list with 2 nodes → 4-column table with correct status values', async () => {
    const overrides = makeNodeOverrides(200, {
      nodes: [
        {
          id: 'town',
          type: 'town',
          peerId: 'town',
          ilpAddress: 'g.townhouse.town',
          status: 'connected',
          enabledAt: '2026-05-11T00:00:00.000Z',
          lastSeenAt: null,
        },
        {
          id: 'mill',
          type: 'mill',
          peerId: 'mill',
          ilpAddress: 'g.townhouse.mill',
          status: 'disconnected',
          enabledAt: '2026-05-11T00:00:00.000Z',
          lastSeenAt: null,
        },
      ],
    });
    await main(['node', 'list'], undefined, undefined, undefined, overrides);
    expect(process.exitCode).toBeUndefined();
    const out = stdoutText();
    expect(out).toContain('peer');
    expect(out).toContain('type');
    expect(out).toContain('status');
    expect(out).toContain('last claim');
    expect(out).toContain('connected');
    expect(out).toContain('disconnected');
  });

  it('node list --json → emits the body verbatim (no ok envelope)', async () => {
    const apiBody = {
      nodes: [
        {
          id: 'town',
          type: 'town',
          peerId: 'town',
          ilpAddress: 'g.townhouse.town',
          status: 'connected',
          enabledAt: '2026-05-11T00:00:00.000Z',
          lastSeenAt: null,
        },
      ],
    };
    const overrides = makeNodeOverrides(200, apiBody);
    await main(
      ['node', 'list', '--json'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBeUndefined();
    const lines = stdoutText().trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    // No ok envelope for list --json
    expect('ok' in parsed).toBe(false);
    expect(parsed.nodes).toHaveLength(1);
    expect(parsed.nodes[0].id).toBe('town');
  });

  it('node list with connector down → status:"unknown" rendered in table; exit 0', async () => {
    const overrides = makeNodeOverrides(200, {
      nodes: [
        {
          id: 'town',
          type: 'town',
          peerId: 'town',
          ilpAddress: 'g.townhouse.town',
          status: 'unknown',
          enabledAt: '2026-05-11T00:00:00.000Z',
          lastSeenAt: null,
        },
      ],
    });
    await main(['node', 'list'], undefined, undefined, undefined, overrides);
    expect(process.exitCode).toBeUndefined();
    const out = stdoutText();
    expect(out).toContain('unknown');
  });

  // ── node with no subcommand ───────────────────────────────────────────────

  it('node (no subcommand) → prints node sub-help and exits 0 via CliHelpRequested', async () => {
    await expect(
      main(['node'], undefined, undefined, undefined, undefined)
    ).rejects.toThrow(CliHelpRequested);
    const out = consoleText();
    expect(out).toContain('node add');
    expect(out).toContain('node remove');
    expect(out).toContain('node list');
  });

  it('node unknown-verb → exit 1, prints usage', async () => {
    await main(
      ['node', 'frobnicate'],
      undefined,
      undefined,
      undefined,
      undefined
    );
    expect(process.exitCode).toBe(1);
    const out = consoleText() + stderrText();
    expect(out).toContain('node');
  });

  // ── coverage adds (Story 46.3 code review patches) ─────────────────────────

  it('node add foo → exit 1 with "Unknown type" stderr, no HTTP call', async () => {
    const overrides: CliNodeCommandOverrides = {
      apiUrl: ADD_URL,
      fetch: vi.fn(),
    };
    await main(
      ['node', 'add', 'foo'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    expect(overrides.fetch as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    expect(stderrText()).toContain("Unknown type: 'foo'");
  });

  it('node add on 409 node_lifecycle_in_flight → exit 1 with "in flight" message', async () => {
    const overrides = makeNodeOverrides(409, {
      error: 'node_lifecycle_in_flight',
    });
    await main(
      ['node', 'add', 'town'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('in flight');
  });

  it('node remove on 409 node_lifecycle_in_flight → exit 1 with "in flight" message', async () => {
    const overrides = makeNodeOverrides(409, {
      error: 'node_lifecycle_in_flight',
    });
    await main(
      ['node', 'remove', 'town', '--yes'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('in flight');
  });

  it('node list on 500 → exit 1, "Failed to fetch nodes" stderr', async () => {
    const overrides = makeNodeOverrides(500, { error: 'yaml_read_failure' });
    await main(['node', 'list'], undefined, undefined, undefined, overrides);
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('Failed to fetch nodes');
  });

  it('node add timeout (AbortError) → exit 1, "timed out" stderr', async () => {
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const overrides: CliNodeCommandOverrides = {
      apiUrl: ADD_URL,
      fetch: vi.fn().mockRejectedValue(abortErr),
    };
    await main(
      ['node', 'add', 'town'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    expect(stderrText()).toContain('timed out');
  });

  it('node add timeout --json → emits ok:false, error:"timeout" JSON', async () => {
    const abortErr = Object.assign(new Error('aborted'), {
      name: 'AbortError',
    });
    const overrides: CliNodeCommandOverrides = {
      apiUrl: ADD_URL,
      fetch: vi.fn().mockRejectedValue(abortErr),
    };
    await main(
      ['node', 'add', 'town', '--json'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBe(1);
    const parsed = JSON.parse(stdoutText().trim());
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe('timeout');
  });

  it('node list with populated lastSeenAt → renders relative time, not em-dash', async () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const overrides = makeNodeOverrides(200, {
      nodes: [
        {
          id: 'town',
          type: 'town',
          peerId: 'town',
          ilpAddress: 'g.townhouse.town',
          status: 'connected',
          enabledAt: '2026-05-11T00:00:00.000Z',
          lastSeenAt: fiveMinAgo,
        },
      ],
    });
    await main(['node', 'list'], undefined, undefined, undefined, overrides);
    expect(process.exitCode).toBeUndefined();
    expect(stdoutText()).toMatch(/\d+m ago/);
  });

  it('node list with invalid lastSeenAt → renders em-dash (not "NaNd ago")', async () => {
    const overrides = makeNodeOverrides(200, {
      nodes: [
        {
          id: 'town',
          type: 'town',
          peerId: 'town',
          ilpAddress: 'g.townhouse.town',
          status: 'connected',
          enabledAt: '2026-05-11T00:00:00.000Z',
          lastSeenAt: 'not-a-date',
        },
      ],
    });
    await main(['node', 'list'], undefined, undefined, undefined, overrides);
    expect(process.exitCode).toBeUndefined();
    const out = stdoutText();
    expect(out).not.toContain('NaN');
  });

  it('node remove --help → NODE_REMOVE_HELP shown (not generic NODE_HELP)', async () => {
    await expect(
      main(
        ['node', 'remove', '--help'],
        undefined,
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow(CliHelpRequested);
    const out = consoleText();
    expect(out).toContain('Deprovision a child node');
    expect(out).toContain('--yes');
  });

  it('node list --help → NODE_LIST_HELP shown (not generic NODE_HELP)', async () => {
    await expect(
      main(
        ['node', 'list', '--help'],
        undefined,
        undefined,
        undefined,
        undefined
      )
    ).rejects.toThrow(CliHelpRequested);
    const out = consoleText();
    expect(out).toContain('List provisioned nodes');
  });

  it('node add 201 with empty body → exits clean, no crash', async () => {
    // Server returns 201 but body parsing throws (proxy truncation, etc.)
    const overrides: CliNodeCommandOverrides = {
      apiUrl: ADD_URL,
      fetch: vi.fn().mockResolvedValue({
        status: 201,
        ok: true,
        json: () =>
          Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      }),
    };
    await main(
      ['node', 'add', 'town'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBeUndefined();
  });

  it('node remove 200 with empty body → uses CLI-side id for "Removed" message', async () => {
    const overrides: CliNodeCommandOverrides = {
      apiUrl: ADD_URL,
      fetch: vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        json: () =>
          Promise.reject(new SyntaxError('Unexpected end of JSON input')),
      }),
    };
    await main(
      ['node', 'remove', 'town', '--yes'],
      undefined,
      undefined,
      undefined,
      overrides
    );
    expect(process.exitCode).toBeUndefined();
    expect(stdoutText()).toContain('Removed town');
  });
});
