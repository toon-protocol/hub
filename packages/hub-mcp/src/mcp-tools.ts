/**
 * MCP tool definitions + dispatch. The MCP server is a thin proxy: each
 * `hub_*` tool maps to either the apex Fastify API (live telemetry +
 * money/topology) or the `hub` CLI (lifecycle / config that must work
 * before the apex is up). This module is the testable core (no stdio / SDK
 * transport) so the tool→api/cli mapping and the "booting — retry" handling can
 * be unit-tested directly. Mirrors client-mcp's mcp-tools.ts contract.
 */
import { ApiError, ApexUnreachableError } from './api-client.js';
import type { ApiClient } from './api-client.js';
import type { CliDriver } from './cli-driver.js';
import { CliError, CliNotFoundError } from './cli-driver.js';
import type { ResolvedConfig } from './config.js';
import { readUpStatus, spawnUpDetached } from './apex-lifecycle.js';
import {
  StreamsUnavailableError,
  metricsSnapshotViaWs,
  tailLogsViaSse,
} from './streams.js';
import { computeVersionInfo, readSelfPackage } from './version.js';
import type { WithdrawRequest } from '@toon-protocol/hub';

/** A JSON-Schema-described MCP tool. */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** MCP tool-call result shape (subset of the SDK's CallToolResult). */
export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

/** Dependencies threaded into dispatch — injectable for tests. */
export interface ToolCtx {
  api: ApiClient;
  cli: CliDriver;
  cfg: ResolvedConfig;
}

const EMPTY = {
  type: 'object',
  properties: {},
  additionalProperties: false,
} as const;

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  // ── lifecycle ──
  {
    name: 'hub_init',
    description:
      'Create hub config. Loads TOWNHOUSE_MNEMONIC if set, otherwise ' +
      'generates and returns a fresh operator mnemonic for the agent to custody.',
    inputSchema: {
      type: 'object',
      properties: {
        preset: { type: 'string', description: 'Optional preset (e.g. demo).' },
        network: {
          type: 'string',
          description: 'mainnet | testnet | devnet | custom.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'hub_up',
    description:
      'Boot the apex (direct default, or transport:"hs"). Returns a handle ' +
      'immediately — poll hub_up_status for per-step boot progress.',
    inputSchema: {
      type: 'object',
      properties: {
        transport: { type: 'string', enum: ['direct', 'hs'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'hub_up_status',
    description:
      'Per-step boot progress for an in-flight or completed hub_up ' +
      '(reads the up.log job record).',
    inputSchema: EMPTY,
  },
  {
    name: 'hub_down',
    description: 'Stop the apex stack (hs:true for a hidden-service apex).',
    inputSchema: {
      type: 'object',
      properties: { hs: { type: 'boolean' } },
      additionalProperties: false,
    },
  },
  {
    name: 'hub_status',
    description: 'Apex / connector / node / .anyone health.',
    inputSchema: EMPTY,
  },
  // ── nodes ──
  {
    name: 'hub_list_nodes',
    description: 'List provisioned nodes (id, type, ilpAddress, status).',
    inputSchema: EMPTY,
  },
  {
    name: 'hub_add_node',
    description:
      'Provision a town | mill | dvm child node. mill requires relays ' +
      '(Nostr relay URLs); dvm optionally takes turboToken (Arweave Turbo JWK ' +
      'for larger uploads); town optionally takes settlementChainId + assetCode ' +
      '(the kind:10032 settlement chain/token, validated against supported — see ' +
      'hub_chains). Supplying these here avoids exporting MILL_RELAYS/' +
      'TURBO_TOKEN before the apex was started.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['town', 'mill', 'dvm'] },
        relays: { type: 'array', items: { type: 'string' } },
        turboToken: { type: 'string' },
        settlementChainId: { type: 'string' },
        assetCode: { type: 'string' },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  {
    name: 'hub_remove_node',
    description: 'Deprovision a node by id.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'hub_set_node_fees',
    description:
      'Tune fees: town feePerEvent / mill feeBasisPoints / dvm feePerJob + ' +
      'kindPricing; or toggle enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['town', 'mill', 'dvm'] },
        feePerEvent: { type: 'number' },
        feeBasisPoints: { type: 'number' },
        feePerJob: { type: 'number' },
        kindPricing: { type: 'object' },
        enabled: { type: 'boolean' },
      },
      required: ['type'],
      additionalProperties: false,
    },
  },
  // ── chains / transport ──
  {
    name: 'hub_chains',
    description:
      'List, add, or remove settlement chains (op: list | add | remove). ' +
      'add/remove pass through CLI flags in `args`. `list` returns both the ' +
      'editable `chainProviders` (what add/remove mutate) and a `resolved` view ' +
      'of the chains the connector actually runs — when the apex relies on a ' +
      'network preset, `resolved` includes Solana/Mina even though ' +
      '`chainProviders` is empty/EVM-only.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'add', 'remove'] },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Extra CLI args for add/remove.',
        },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'hub_transport',
    description: 'Get transport status, or flip it (set: direct | hs).',
    inputSchema: {
      type: 'object',
      properties: { set: { type: 'string', enum: ['direct', 'hs'] } },
      additionalProperties: false,
    },
  },
  // ── wallet / earnings / $ ──
  {
    name: 'hub_balances',
    description: 'EVM / Solana / Arweave balances per node.',
    inputSchema: EMPTY,
  },
  {
    name: 'hub_earnings',
    description: 'Apex + per-peer earnings with today/month/year deltas.',
    inputSchema: EMPTY,
  },
  {
    name: 'hub_seed',
    description: 'Reveal the operator mnemonic for backup (the agent owns it).',
    inputSchema: EMPTY,
  },
  {
    name: 'hub_withdraw',
    description:
      'Withdraw earnings to a recipient (EVM in v1). Set dryRun:true for a ' +
      'gas/fee estimate without broadcasting.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeType: { type: 'string', enum: ['town', 'mill', 'dvm'] },
        chainFamily: { type: 'string', enum: ['evm', 'solana', 'mina'] },
        token: { type: 'string' },
        recipient: { type: 'string' },
        amount: {
          type: 'string',
          description:
            'Amount in BASE units (raw integer, e.g. wei / 1e18 for an ' +
            '18-decimal USDC), NOT decimal tokens — "10" transfers 10 base ' +
            'units, not 10 tokens. For 1 token of an 18-decimal asset pass ' +
            '"1000000000000000000".',
        },
        dryRun: { type: 'boolean' },
      },
      required: ['nodeType', 'chainFamily', 'token', 'recipient', 'amount'],
      additionalProperties: false,
    },
  },
  {
    name: 'hub_credits',
    description: 'Buy or check Arweave upload credits (op: buy | balance).',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['buy', 'balance'] },
        token: { type: 'string' },
        amount: { type: 'string' },
        quoteOnly: { type: 'boolean' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  // ── telemetry ──
  {
    name: 'hub_logs',
    description:
      'Tail a bounded slice of node logs (live SSE stream, falling back to ' +
      'recent CLI history; filter by service/level). Result carries `source`.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string' },
        level: { type: 'string' },
        maxLines: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'hub_metrics',
    description:
      'Connector metrics snapshot (live WS /metrics, falling back to the ' +
      'CLI). Result carries `source`.',
    inputSchema: EMPTY,
  },
  {
    name: 'hub_channels',
    description: 'Open payment channels (nonce watermark + transferred).',
    inputSchema: EMPTY,
  },
  {
    name: 'hub_health',
    description: 'Probe apex / api / nodes / .anyone.',
    inputSchema: EMPTY,
  },
  {
    name: 'hub_version',
    description:
      'Report this MCP package version, the pinned hub range, and the ' +
      'detected CLI version — flags version skew (a too-old hub CLI).',
    inputSchema: EMPTY,
  },
];

/**
 * Dispatch an MCP tool call. Always resolves a `ToolResult` (errors are encoded
 * as `isError:true` text, not thrown, so the agent sees a readable message). An
 * unreachable apex under AUTOUP yields a clear "booting — retry" message.
 */
export async function dispatchTool(
  ctx: ToolCtx,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const { api, cli, cfg } = ctx;
  try {
    switch (name) {
      // ── lifecycle → CLI / job record ──
      case 'hub_init':
        return ok(await cli.runJson(['init', ...presetArgs(args)]));
      case 'hub_up': {
        const transport =
          args['transport'] === 'hs' || args['transport'] === 'direct'
            ? (args['transport'] as 'hs' | 'direct')
            : cfg.transport;
        const pid = spawnUpDetached(cfg, transport);
        return ok({
          started: true,
          pid,
          transport,
          poll: 'hub_up_status',
        });
      }
      case 'hub_up_status':
        return ok(readUpStatus(cfg));
      case 'hub_down':
        return ok(await cli.runJson(args['hs'] ? ['hs', 'down'] : ['down']));
      case 'hub_status':
        return ok(await statusPreferApi(ctx));

      // ── nodes → API ──
      case 'hub_list_nodes':
        return ok(await api.listNodes());
      case 'hub_add_node': {
        const addBody: {
          type: 'town' | 'mill' | 'dvm';
          relays?: string[];
          turboToken?: string;
          settlementChainId?: string;
          assetCode?: string;
        } = { type: asNodeType(args['type']) };
        if (Array.isArray(args['relays'])) {
          const relays = (args['relays'] as unknown[])
            .map((r) => String(r).trim())
            .filter(Boolean);
          if (relays.length > 0) addBody.relays = relays;
        }
        if (typeof args['turboToken'] === 'string' && args['turboToken']) {
          addBody.turboToken = args['turboToken'];
        }
        if (
          typeof args['settlementChainId'] === 'string' &&
          args['settlementChainId']
        ) {
          addBody.settlementChainId = args['settlementChainId'];
        }
        if (typeof args['assetCode'] === 'string' && args['assetCode']) {
          addBody.assetCode = args['assetCode'];
        }
        return ok(await api.addNode(addBody));
      }
      case 'hub_remove_node':
        return ok(await api.removeNode(String(args['id'])));
      case 'hub_set_node_fees':
        return ok(
          await api.setNodeConfig(String(args['type']), stripType(args))
        );

      // ── chains / transport ──
      case 'hub_chains':
        return ok(await chains(ctx, args));
      case 'hub_transport':
        return ok(
          args['set']
            ? await api.setTransport({ mode: asTransport(args['set']) })
            : await api.transport()
        );

      // ── wallet / $ ──
      case 'hub_balances':
        return ok(await api.balances());
      case 'hub_earnings':
        return ok(await api.earnings());
      case 'hub_seed':
        return ok(await cli.runJson(['wallet', 'seed', '--confirm']));
      case 'hub_withdraw':
        return ok(await api.withdraw(args as unknown as WithdrawRequest));
      case 'hub_credits':
        return ok(await credits(cli, args));

      // ── telemetry ──
      case 'hub_logs':
        return ok(await tailLogs(ctx, args));
      case 'hub_metrics':
        return ok(await metricsSnapshot(ctx));
      case 'hub_channels':
        return ok(await cli.runJson(['channels']));
      case 'hub_health':
        // health exits 1 when any probe is unhealthy but still reports the full
        // breakdown — surface that to the agent rather than a generic CLI error.
        return ok(await cli.runJsonLenient(['health']));
      case 'hub_version':
        return ok(await versionInfo(ctx));

      default:
        return err(`Unknown tool: ${name}`);
    }
  } catch (e) {
    return toErrorResult(e, cfg);
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

function presetArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof args['preset'] === 'string') out.push('--preset', args['preset']);
  if (typeof args['network'] === 'string')
    out.push('--network', args['network']);
  return out;
}

function stripType(args: Record<string, unknown>): Record<string, unknown> {
  const { type: _omit, ...rest } = args;
  return rest;
}

function asNodeType(v: unknown): 'town' | 'mill' | 'dvm' {
  if (v === 'town' || v === 'mill' || v === 'dvm') return v;
  throw new ApiError(`invalid node type: ${String(v)}`, 400, false);
}

function asTransport(v: unknown): 'direct' | 'hs' {
  if (v === 'direct' || v === 'hs') return v;
  throw new ApiError(`invalid transport: ${String(v)}`, 400, false);
}

/** Prefer the API for status; fall back to the CLI when the apex is down. */
async function statusPreferApi(ctx: ToolCtx): Promise<unknown> {
  try {
    const [nodes, transport] = await Promise.all([
      ctx.api.listNodes(),
      ctx.api.transport(),
    ]);
    return { source: 'api', nodes, transport };
  } catch (e) {
    if (e instanceof ApexUnreachableError) {
      return { source: 'cli', ...(await ctx.cli.runJson<object>(['status'])) };
    }
    throw e;
  }
}

async function chains(
  ctx: ToolCtx,
  args: Record<string, unknown>
): Promise<unknown> {
  const op = args['op'];
  if (op === 'list') return ctx.api.chains();
  const extra = Array.isArray(args['args'])
    ? (args['args'] as unknown[]).map(String)
    : [];
  if (op === 'add') return ctx.cli.runJson(['chains', 'add', ...extra]);
  if (op === 'remove') return ctx.cli.runJson(['chains', 'remove', ...extra]);
  throw new ApiError(`invalid chains op: ${String(op)}`, 400, false);
}

async function credits(
  cli: CliDriver,
  args: Record<string, unknown>
): Promise<unknown> {
  const op = args['op'];
  const flags: string[] = [];
  if (typeof args['token'] === 'string') flags.push('--token', args['token']);
  if (op === 'balance') return cli.runJson(['credits', 'balance', ...flags]);
  if (op === 'buy') {
    if (typeof args['amount'] === 'string')
      flags.push('--amount', args['amount']);
    if (args['quoteOnly']) flags.push('--quote-only');
    flags.push('--yes');
    return cli.runJson(['credits', 'buy', ...flags]);
  }
  throw new ApiError(`invalid credits op: ${String(op)}`, 400, false);
}

/**
 * Connector metrics. Prefer the live WS /metrics snapshot (design §5); fall back
 * to the `hub metrics` CLI JSON when the apex WS path is unavailable
 * (e.g. runtime without a global WebSocket, or the apex not yet up).
 */
async function metricsSnapshot(ctx: ToolCtx): Promise<unknown> {
  try {
    const payload = await metricsSnapshotViaWs({ baseUrl: ctx.cfg.apiUrl });
    return { source: 'ws', ...payload };
  } catch (e) {
    if (!(e instanceof StreamsUnavailableError)) throw e;
    return { source: 'cli', ...(await ctx.cli.runJson<object>(['metrics'])) };
  }
}

/**
 * Bounded log tail. Prefer the live SSE stream (design §5); fall back to the
 * CLI's recent-history view when the stream is unavailable OR yields nothing in
 * the window (a forward-looking live tail is empty on a quiet system, whereas
 * the agent asking for "logs" usually wants the most recent lines).
 */
async function tailLogs(
  ctx: ToolCtx,
  args: Record<string, unknown>
): Promise<unknown> {
  const maxLines =
    typeof args['maxLines'] === 'number' ? args['maxLines'] : 100;
  const service =
    typeof args['service'] === 'string' ? args['service'] : undefined;
  const level = typeof args['level'] === 'string' ? args['level'] : undefined;

  try {
    const events = await tailLogsViaSse({
      baseUrl: ctx.cfg.apiUrl,
      maxLines,
      ...(service ? { service } : {}),
      ...(level ? { level } : {}),
    });
    if (events.length > 0) {
      return { source: 'sse', count: events.length, events };
    }
    // Quiet live tail — fall through to the CLI's recent history.
  } catch (e) {
    if (!(e instanceof StreamsUnavailableError)) throw e;
  }
  return tailLogsViaCli(ctx, maxLines, service, level);
}

async function tailLogsViaCli(
  ctx: ToolCtx,
  maxLines: number,
  service?: string,
  level?: string
): Promise<unknown> {
  const lines = await ctx.cli.runNdjson<Record<string, unknown>>([
    'logs',
    '--lines',
    String(maxLines),
  ]);
  const filtered = lines.filter(
    (l) =>
      (service === undefined || l['service'] === service) &&
      (level === undefined || l['level'] === level)
  );
  return { source: 'cli', count: filtered.length, events: filtered };
}

/**
 * Version-skew report. Probes the `hub version` CLI command (added
 * alongside this tool) and compares it to the pinned peer range. A CLI too old
 * to support `version` exits non-zero / prints no JSON → CliError → reported as
 * "couldn't probe", itself a skew signal.
 */
async function versionInfo(ctx: ToolCtx): Promise<unknown> {
  const self = readSelfPackage();
  return computeVersionInfo(self, async () => {
    try {
      const v = await ctx.cli.runJson<{ version: string }>(['version']);
      return v.version;
    } catch (e) {
      // Let a CliNotFoundError through so computeVersionInfo can emit the
      // actionable "set TOWNHOUSE_BIN" note; any other failure (CLI too old to
      // support `version`, non-JSON output) is just "couldn't probe".
      if (e instanceof CliNotFoundError) throw e;
      return undefined;
    }
  });
}

/**
 * Classify an `ApiError` as genuinely-retryable vs terminal. Retryable means
 * the same call may succeed shortly without operator intervention: a 503
 * (apex busy / still booting), an explicit `retryable:true`, or the
 * lifecycle-in-flight 409 (`node_lifecycle_in_flight`). A non-null-asserted
 * config/validation 4xx (e.g. a 400, or a `*_not_configured` / `*_not_set`
 * code) is terminal — retrying without fixing config just fails again.
 */
function isRetryableApiError(e: ApiError): boolean {
  const code = `${e.message}${e.detail ? ` ${e.detail}` : ''}`.toLowerCase();
  // Config/validation codes are terminal even if a stale `retryable` flag or
  // 503 sneaks through.
  if (/_not_configured\b|_not_set\b/.test(code)) return false;
  if (e.status === 503) return true;
  // The lifecycle-in-flight 409 clears on its own once the prior call lands.
  if (e.status === 409 && code.includes('node_lifecycle_in_flight'))
    return true;
  // A 4xx (other than the in-flight 409 above) is an operator-fixable
  // validation/config error — terminal.
  if (e.status >= 400 && e.status < 500) return false;
  return e.retryable;
}

function toErrorResult(e: unknown, cfg: ResolvedConfig): ToolResult {
  if (e instanceof ApexUnreachableError) {
    return err(
      `Hub apex API not reachable at ${e.baseUrl}. If AUTOUP is on it may ` +
        `be booting (image pulls / HS bootstrap can take minutes) — poll ` +
        `hub_up_status and retry. Boot log: ${cfg.configDir}/up.log.`
    );
  }
  if (e instanceof ApiError) {
    const text = `${e.message}${e.detail ? `: ${e.detail}` : ''}`;
    // Only genuinely-retryable conditions get the "retry shortly" hint:
    // a 503, an explicit `retryable:true`, or the lifecycle-in-flight 409.
    // A 4xx config/validation error (e.g. a 400, or a `*_not_configured` /
    // `*_not_set` code like `usdc_address_not_configured`) is NOT retryable
    // — retrying without fixing config just fails again, so surface the
    // failing code/detail as a clear, terminal error instead.
    if (isRetryableApiError(e)) {
      return err(`Apex busy or still booting — retry shortly. (${text})`);
    }
    return err(text);
  }
  if (e instanceof CliNotFoundError) {
    // Already an actionable "set TOWNHOUSE_BIN" message — surface verbatim.
    return err(e.message);
  }
  if (e instanceof CliError) {
    return err(
      `hub CLI failed (exit ${e.exitCode}): ${e.stderr.trim() || e.message}`
    );
  }
  return err(e instanceof Error ? e.message : String(e));
}

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
