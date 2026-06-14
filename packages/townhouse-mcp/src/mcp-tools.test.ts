import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock apex-lifecycle so lifecycle tools don't touch fs / spawn real processes.
vi.mock('./apex-lifecycle.js', () => ({
  spawnUpDetached: vi.fn(() => 4242),
  readUpStatus: vi.fn(() => ({ events: ['e'], done: true, failed: false })),
}));

// Mock the streaming adapters so telemetry tools don't open real sockets.
// Keep the real `StreamsUnavailableError` so dispatch's `instanceof` fallback
// branches still work.
vi.mock('./streams.js', async (importActual) => {
  const actual = await importActual<typeof StreamsModule>();
  return {
    ...actual,
    tailLogsViaSse: vi.fn(),
    metricsSnapshotViaWs: vi.fn(),
  };
});

import { dispatchTool, TOOL_DEFINITIONS, type ToolCtx } from './mcp-tools.js';
import { ApiError, ApexUnreachableError } from './api-client.js';
import { CliError } from './cli-driver.js';
import { spawnUpDetached, readUpStatus } from './apex-lifecycle.js';
import {
  StreamsUnavailableError,
  tailLogsViaSse,
  metricsSnapshotViaWs,
} from './streams.js';
import type * as StreamsModule from './streams.js';
import type { Mock } from 'vitest';
import type { ApiClient } from './api-client.js';
import type { CliDriver } from './cli-driver.js';
import type { ResolvedConfig } from './config.js';

function ctx(over: {
  api?: Partial<ApiClient>;
  cli?: Partial<CliDriver>;
  cfg?: Partial<ResolvedConfig>;
}): ToolCtx {
  return {
    api: (over.api ?? {}) as unknown as ApiClient,
    cli: (over.cli ?? {}) as unknown as CliDriver,
    cfg: {
      apiUrl: 'http://127.0.0.1:9400',
      configDir: '/tmp/th',
      townhouseBin: 'townhouse',
      autoUp: true,
      transport: 'direct',
      ...over.cfg,
    },
  };
}

const parse = (r: { content: { text: string }[] }): unknown =>
  JSON.parse(r.content[0]!.text);

beforeEach(() => {
  vi.clearAllMocks();
  // Default: streams unavailable → telemetry tools fall back to the CLI.
  (tailLogsViaSse as unknown as Mock).mockRejectedValue(
    new StreamsUnavailableError('http://x/api/logs/stream')
  );
  (metricsSnapshotViaWs as unknown as Mock).mockRejectedValue(
    new StreamsUnavailableError('ws://x/metrics')
  );
});

describe('TOOL_DEFINITIONS', () => {
  it('exposes the documented operator surface', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name).sort()).toEqual(
      [
        'townhouse_add_node',
        'townhouse_balances',
        'townhouse_chains',
        'townhouse_channels',
        'townhouse_credits',
        'townhouse_down',
        'townhouse_earnings',
        'townhouse_health',
        'townhouse_init',
        'townhouse_list_nodes',
        'townhouse_logs',
        'townhouse_metrics',
        'townhouse_remove_node',
        'townhouse_seed',
        'townhouse_set_node_fees',
        'townhouse_status',
        'townhouse_transport',
        'townhouse_up',
        'townhouse_up_status',
        'townhouse_version',
        'townhouse_withdraw',
      ].sort()
    );
  });

  it('every tool has an object input schema + description', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.inputSchema['type']).toBe('object');
      expect(typeof t.description).toBe('string');
    }
  });
});

describe('dispatchTool — API-backed tools', () => {
  it('townhouse_balances returns the API payload as JSON', async () => {
    const api = { balances: vi.fn().mockResolvedValue({ entries: [], ts: 1 }) };
    const res = await dispatchTool(ctx({ api }), 'townhouse_balances', {});
    expect(res.isError).toBeFalsy();
    expect(parse(res)).toEqual({ entries: [], ts: 1 });
  });

  it('townhouse_add_node forwards the node type', async () => {
    const api = {
      addNode: vi.fn().mockResolvedValue({ step: 'register-peer' }),
    };
    await dispatchTool(ctx({ api }), 'townhouse_add_node', { type: 'mill' });
    expect(api.addNode).toHaveBeenCalledWith({ type: 'mill' });
  });

  it('townhouse_set_node_fees strips `type` from the patch body', async () => {
    const api = { setNodeConfig: vi.fn().mockResolvedValue({ ok: true }) };
    await dispatchTool(ctx({ api }), 'townhouse_set_node_fees', {
      type: 'town',
      feePerEvent: 5,
    });
    expect(api.setNodeConfig).toHaveBeenCalledWith('town', { feePerEvent: 5 });
  });

  it('townhouse_withdraw passes the request through', async () => {
    const api = { withdraw: vi.fn().mockResolvedValue({ txHash: '0xabc' }) };
    const args = {
      nodeType: 'town',
      chainFamily: 'evm',
      token: 'native',
      recipient: '0x0',
      amount: '1',
    };
    await dispatchTool(ctx({ api }), 'townhouse_withdraw', args);
    expect(api.withdraw).toHaveBeenCalledWith(args);
  });
});

describe('dispatchTool — CLI-backed tools', () => {
  it('townhouse_chains op=list reads the API', async () => {
    const api = { chains: vi.fn().mockResolvedValue([{ chainType: 'evm' }]) };
    await dispatchTool(ctx({ api }), 'townhouse_chains', { op: 'list' });
    expect(api.chains).toHaveBeenCalled();
  });

  it('townhouse_chains op=add shells the CLI with passthrough args', async () => {
    const cli = { runJson: vi.fn().mockResolvedValue({ ok: true }) };
    await dispatchTool(ctx({ cli }), 'townhouse_chains', {
      op: 'add',
      args: ['--chain-type', 'evm'],
    });
    expect(cli.runJson).toHaveBeenCalledWith([
      'chains',
      'add',
      '--chain-type',
      'evm',
    ]);
  });

  it('townhouse_credits op=balance shells the CLI with --token', async () => {
    const cli = { runJson: vi.fn().mockResolvedValue({ credits: '0' }) };
    await dispatchTool(ctx({ cli }), 'townhouse_credits', {
      op: 'balance',
      token: 'eth',
    });
    expect(cli.runJson).toHaveBeenCalledWith([
      'credits',
      'balance',
      '--token',
      'eth',
    ]);
  });

  it('townhouse_logs falls back to NDJSON history when SSE is unavailable', async () => {
    const cli = {
      runNdjson: vi.fn().mockResolvedValue([
        { service: 'town', level: 'info', message: 'a' },
        { service: 'mill', level: 'info', message: 'b' },
      ]),
    };
    const res = await dispatchTool(ctx({ cli }), 'townhouse_logs', {
      service: 'town',
    });
    expect(cli.runNdjson).toHaveBeenCalledWith(['logs', '--lines', '100']);
    expect(parse(res)).toMatchObject({ source: 'cli', count: 1 });
  });
});

describe('dispatchTool — telemetry stream/CLI source', () => {
  it('townhouse_logs prefers the live SSE stream when it yields events', async () => {
    const events = [{ ts: 't', service: 'town', level: 'info', msg: 'live' }];
    (tailLogsViaSse as unknown as Mock).mockResolvedValue(events);
    const cli = { runNdjson: vi.fn() };
    const res = await dispatchTool(ctx({ cli }), 'townhouse_logs', {});
    expect(parse(res)).toMatchObject({ source: 'sse', count: 1, events });
    expect(cli.runNdjson).not.toHaveBeenCalled();
  });

  it('townhouse_logs falls back to the CLI when the SSE tail is empty', async () => {
    (tailLogsViaSse as unknown as Mock).mockResolvedValue([]);
    const cli = { runNdjson: vi.fn().mockResolvedValue([]) };
    const res = await dispatchTool(ctx({ cli }), 'townhouse_logs', {});
    expect(cli.runNdjson).toHaveBeenCalled();
    expect(parse(res)).toMatchObject({ source: 'cli' });
  });

  it('townhouse_metrics prefers the WS snapshot', async () => {
    const payload = {
      packetsForwarded: 3,
      packetsRejected: 0,
      bytesSent: 1,
      attribution: 'aggregate',
      available: true,
    };
    (metricsSnapshotViaWs as unknown as Mock).mockResolvedValue(payload);
    const cli = { runJson: vi.fn() };
    const res = await dispatchTool(ctx({ cli }), 'townhouse_metrics', {});
    expect(parse(res)).toMatchObject({ source: 'ws', packetsForwarded: 3 });
    expect(cli.runJson).not.toHaveBeenCalled();
  });

  it('townhouse_metrics falls back to the CLI when WS is unavailable', async () => {
    const cli = {
      runJson: vi.fn().mockResolvedValue({ packetsForwarded: 9 }),
    };
    const res = await dispatchTool(ctx({ cli }), 'townhouse_metrics', {});
    expect(cli.runJson).toHaveBeenCalledWith(['metrics']);
    expect(parse(res)).toMatchObject({ source: 'cli', packetsForwarded: 9 });
  });
});

describe('dispatchTool — townhouse_version', () => {
  it('probes `townhouse version` and reports against the pinned range', async () => {
    const cli = { runJson: vi.fn().mockResolvedValue({ version: '9.9.9' }) };
    const res = await dispatchTool(ctx({ cli }), 'townhouse_version', {});
    expect(cli.runJson).toHaveBeenCalledWith(['version']);
    const info = parse(res) as Record<string, unknown>;
    expect(info).toMatchObject({ detectedCliVersion: '9.9.9' });
    // The MCP package pins a floor >= 0.26.0; a 9.9.9 CLI clears it.
    expect(info['satisfies']).toBe(true);
  });

  it('reports a too-old CLI as version skew', async () => {
    const cli = { runJson: vi.fn().mockResolvedValue({ version: '0.10.0' }) };
    const res = await dispatchTool(ctx({ cli }), 'townhouse_version', {});
    expect(parse(res)).toMatchObject({
      detectedCliVersion: '0.10.0',
      satisfies: false,
    });
  });

  it('reports satisfies:null when the CLI lacks `version`', async () => {
    const cli = {
      runJson: vi.fn().mockRejectedValue(new CliError('unknown', 1, 'nope')),
    };
    const res = await dispatchTool(ctx({ cli }), 'townhouse_version', {});
    expect(parse(res)).toMatchObject({
      detectedCliVersion: null,
      satisfies: null,
    });
  });
});

describe('dispatchTool — lifecycle (mocked apex-lifecycle)', () => {
  it('townhouse_up spawns detached and returns a poll handle', async () => {
    const res = await dispatchTool(ctx({}), 'townhouse_up', {});
    expect(spawnUpDetached).toHaveBeenCalledWith(
      expect.objectContaining({ townhouseBin: 'townhouse' }),
      'direct'
    );
    expect(parse(res)).toMatchObject({
      started: true,
      pid: 4242,
      poll: 'townhouse_up_status',
    });
  });

  it('townhouse_up honours an explicit hs transport', async () => {
    await dispatchTool(ctx({}), 'townhouse_up', { transport: 'hs' });
    expect(spawnUpDetached).toHaveBeenCalledWith(expect.anything(), 'hs');
  });

  it('townhouse_up_status reads the job record', async () => {
    const res = await dispatchTool(ctx({}), 'townhouse_up_status', {});
    expect(readUpStatus).toHaveBeenCalled();
    expect(parse(res)).toMatchObject({ done: true });
  });
});

describe('dispatchTool — error encoding', () => {
  it('encodes an unreachable apex as a booting/retry hint', async () => {
    const api = {
      balances: vi
        .fn()
        .mockRejectedValue(new ApexUnreachableError('http://127.0.0.1:9400')),
    };
    const res = await dispatchTool(ctx({ api }), 'townhouse_balances', {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/booting/i);
    expect(res.content[0]!.text).toContain('townhouse_up_status');
  });

  it('encodes a retryable ApiError as "retry shortly"', async () => {
    const api = {
      earnings: vi.fn().mockRejectedValue(new ApiError('busy', 503, true)),
    };
    const res = await dispatchTool(ctx({ api }), 'townhouse_earnings', {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/retry shortly/i);
  });

  it('encodes a non-retryable ApiError with its detail', async () => {
    const api = {
      withdraw: vi
        .fn()
        .mockRejectedValue(
          new ApiError('insufficient_balance', 400, false, 'need more')
        ),
    };
    const res = await dispatchTool(ctx({ api }), 'townhouse_withdraw', {
      nodeType: 'town',
      chainFamily: 'evm',
      token: 'native',
      recipient: '0x0',
      amount: '1',
    });
    expect(res.content[0]!.text).toBe('insufficient_balance: need more');
  });

  it('encodes a CLI failure with its stderr', async () => {
    const cli = {
      runJson: vi
        .fn()
        .mockRejectedValue(new CliError('boom', 1, 'wallet locked')),
    };
    const res = await dispatchTool(ctx({ cli }), 'townhouse_seed', {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/wallet locked/);
  });

  it('reports an unknown tool', async () => {
    const res = await dispatchTool(ctx({}), 'townhouse_bogus', {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/Unknown tool/);
  });
});
