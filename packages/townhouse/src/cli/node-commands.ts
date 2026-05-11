/**
 * CLI node lifecycle handlers: `townhouse node add` / `remove` / `list`.
 *
 * D4 DECISION (Story 46.3):
 * In HS mode, `nodes.yaml` is the single source of truth for provisioned nodes.
 * `townhouse node add <type>` ignores `config.nodes[type].enabled` entirely —
 * the static flag is the source of truth for the `dev` profile (`townhouse up
 * --town`) only. Epic 46 lazy provisioning and the static dev-profile config
 * are orthogonal: lifecycle-managed nodes answer to nodes.yaml, not the flag.
 */

import * as readline from 'node:readline';
import { renderFailure, useAscii } from './failure-copy.js';

// Default Townhouse host API URL for HS mode.
const DEFAULT_HS_API_URL = 'http://127.0.0.1:28090';

// Maps server-side step identifiers to the user-visible stage labels.
const STEP_TO_STAGE: Record<string, string> = {
  'derive-key': 'Deriving wallet',
  'pull-image': 'Pulling image',
  'write-yaml': 'Deriving wallet', // same disk-class bucket from operator POV
  'start-container': 'Registering with apex',
  healthcheck: 'Registering with apex',
  'register-peer': 'Live',
};

const STAGE_LABELS = [
  'Pulling image',
  'Deriving wallet',
  'Registering with apex',
  'Live',
];

/** Sub-help text printed by `townhouse node <verb> --help`. */
export const NODE_ADD_HELP = `townhouse node add — Provision a child node

Usage:
  townhouse node add [<type>] [--json] [-c <path>]

Arguments:
  <type>   Node type to provision: town, mill, dvm (default: town)

Flags:
  --json   Machine-readable JSON output
  -c       Path to config file

Examples:
  townhouse node add           # provision a Town relay (default)
  townhouse node add town      # same as above
  townhouse node add mill   # earn from chain swaps (5x earnings unlock)
  townhouse node add dvm       # add a DVM compute node`;

export const NODE_REMOVE_HELP = `townhouse node remove — Deprovision a child node

Usage:
  townhouse node remove <id> [--yes] [--json] [-c <path>]

Arguments:
  <id>     Node ID to remove (use 'townhouse node list' to find IDs)

Flags:
  --yes    Skip confirmation prompt (required in non-interactive mode)
  --json   Machine-readable JSON output; implies non-interactive (no prompt)
  -c       Path to config file`;

export const NODE_LIST_HELP = `townhouse node list — List provisioned nodes

Usage:
  townhouse node list [--json] [-c <path>]

Flags:
  --json   Machine-readable JSON output (emits API response verbatim)
  -c       Path to config file`;

export const NODE_HELP = `townhouse node — Manage child nodes

Usage:
  townhouse node add [<type>] [--json] [-c <path>]    Provision a child node (default: town)
  townhouse node remove <id> [--yes] [--json] [-c <path>]   Deprovision a child node
  townhouse node list [--json] [-c <path>]            List provisioned nodes

Run 'townhouse node <verb> --help' for details on each verb.

Tip:
  townhouse node add mill   # earn from chain swaps (5x earnings unlock)`;

// ── Shared helpers ─────────────────────────────────────────────────────────────

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function resolveApiUrl(apiUrl?: string): string {
  return apiUrl ?? DEFAULT_HS_API_URL;
}

function formatRelativeTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return '—';
  const diffMs = Date.now() - ts;
  if (diffMs < 0) return 'just now';
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

async function confirmInteractive(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = await new Promise<string>((resolve) =>
      rl.question(question, resolve)
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function emitJsonError(obj: Record<string, unknown>, exitCode = 1): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exitCode = exitCode;
}

// ── handleNodeAdd ──────────────────────────────────────────────────────────────

export interface NodeAddOptions {
  json: boolean;
  apiUrl?: string;
  fetch?: FetchFn;
  confirm?: (question: string) => Promise<boolean>;
}

export async function handleNodeAdd(
  type: string,
  options: NodeAddOptions
): Promise<void> {
  const ascii = useAscii();
  const check = ascii ? '[OK]' : '✓';
  const xMark = ascii ? '[X]' : '✕';
  const dot = ascii ? '.' : '·';

  if (type !== 'town' && type !== 'mill' && type !== 'dvm') {
    const msg = `Unknown type: '${type}'. Supported: town, mill, dvm`;
    if (options.json) {
      emitJsonError({ ok: false, error: 'invalid_type', message: msg });
    } else {
      process.stderr.write(`${xMark} ${msg}\n`);
      process.exitCode = 1;
    }
    return;
  }

  const url = resolveApiUrl(options.apiUrl);
  const fetchImpl = options.fetch ?? fetch;

  if (!options.json) {
    // Print all stages dim while waiting for the blocking POST to return.
    process.stdout.write(
      `  ${STAGE_LABELS.map((s) => `${dot} ${s}`).join(' · ')}\n`
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);

  let response: Response;
  try {
    response = await fetchImpl(`${url}/api/nodes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAborted = err instanceof Error && err.name === 'AbortError';
    const errMsg = isAborted
      ? 'Request timed out after 120 seconds.'
      : "townhouse hs up isn't running. Run 'townhouse hs up' first.";
    if (options.json) {
      emitJsonError({
        ok: false,
        error: isAborted ? 'timeout' : 'econnrefused',
        message: errMsg,
      });
    } else {
      process.stderr.write(`${xMark} ${errMsg}\n`);
      process.exitCode = 1;
    }
    return;
  }
  clearTimeout(timer);

  if (response.status === 201) {
    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      type?: string;
      peerId?: string;
      ilpAddress?: string;
      hsRoute?: string;
      healthCheckUrl?: string;
    };
    if (options.json) {
      process.stdout.write(JSON.stringify({ ok: true, ...body }) + '\n');
    } else {
      // Re-print all stages green.
      process.stdout.write(
        `  ${STAGE_LABELS.map((s) => `${check} ${s}`).join(' · ')}\n`
      );
      const addedId = body.id ?? type;
      const addedPeer = body.peerId ? ` (${body.peerId})` : '';
      const addedAddr = body.ilpAddress ? ` at ${body.ilpAddress}` : '';
      process.stdout.write(`  Added ${addedId}${addedPeer}${addedAddr}\n`);
    }
    return;
  }

  // Error path — surface the step field from the response body.
  const body = (await response.json().catch(() => ({}))) as {
    step?: string;
    err?: string;
    rollbackError?: string;
    error?: string;
    type?: string;
    existingId?: string;
  };

  if (options.json) {
    emitJsonError({ ok: false, ...body });
    return;
  }

  // 409 node_type_in_use
  if (response.status === 409 && body.error === 'node_type_in_use') {
    process.stderr.write(
      `${xMark} Node of type '${body.type}' already exists with id '${body.existingId}'. Remove it first or use a different type.\n`
    );
    process.exitCode = 1;
    return;
  }

  // 409 node_lifecycle_in_flight
  if (response.status === 409 && body.error === 'node_lifecycle_in_flight') {
    process.stderr.write(
      `${xMark} Another node operation is in flight. Try again in a moment.\n`
    );
    process.exitCode = 1;
    return;
  }

  const step = body.step ?? 'unknown';
  const errText = body.err ?? '';

  // pull-image → use renderFailure with synthetic error matching classifier.
  if (step === 'pull-image') {
    const syntheticErr = new Error(`failed to pull: ${errText}`);
    renderFailure(syntheticErr);
  } else if (
    step === 'start-container' &&
    (errText.includes('port is already allocated') ||
      errText.includes('Cannot connect to the Docker daemon'))
  ) {
    renderFailure(new Error(errText));
  } else {
    // Generic 3-line failure for all other steps.
    const stageName = STEP_TO_STAGE[step] ?? step;
    const arrow = ascii ? '->' : '→';
    process.stderr.write(
      `${xMark} Step ${step} failed (stage: ${stageName}): ${errText}\n`
    );
    process.stderr.write(
      `  ${arrow} Run 'townhouse hs down && townhouse hs up' to reset state, then retry.\n`
    );
  }

  if (body.rollbackError) {
    process.stderr.write(`  Rollback error: ${body.rollbackError}\n`);
  }

  process.exitCode = 1;
}

// ── handleNodeRemove ───────────────────────────────────────────────────────────

export interface NodeRemoveOptions {
  yes: boolean;
  json: boolean;
  apiUrl?: string;
  fetch?: FetchFn;
  confirm?: (question: string) => Promise<boolean>;
}

const NODE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export async function handleNodeRemove(
  id: string,
  options: NodeRemoveOptions
): Promise<void> {
  const ascii = useAscii();
  const check = ascii ? '[OK]' : '✓';
  const xMark = ascii ? '[X]' : '✕';

  if (!id) {
    const msg = 'Usage: townhouse node remove <id> [--yes] [--json]';
    if (options.json) {
      emitJsonError({ ok: false, error: 'missing_id', message: msg });
    } else {
      process.stderr.write(`${msg}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // Sanitize id against the route pattern before sending (fail fast, no round-trip).
  if (!NODE_ID_PATTERN.test(id)) {
    const msg = `Invalid node id '${id}'. IDs must match ^[a-z][a-z0-9-]*$ (lowercase, no leading hyphens or underscores).`;
    if (options.json) {
      emitJsonError({ ok: false, error: 'invalid_id', message: msg });
    } else {
      process.stderr.write(`${xMark} ${msg}\n`);
      process.exitCode = 1;
    }
    return;
  }

  // Confirmation gate.
  const skipPrompt = options.yes || options.json;
  if (!skipPrompt) {
    if (!process.stdin.isTTY) {
      const msg =
        '--yes required when stdin is not a TTY (use --yes for non-interactive removal).';
      process.stderr.write(`${xMark} ${msg}\n`);
      process.exitCode = 1;
      return;
    }
    const confirmFn = options.confirm ?? confirmInteractive;
    const confirmed = await confirmFn(
      `Remove node '${id}'? This deprovisions the container and deregisters the peer. [y/N] `
    );
    if (!confirmed) {
      process.stdout.write('Cancelled.\n');
      return;
    }
  }

  const url = resolveApiUrl(options.apiUrl);
  const fetchImpl = options.fetch ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let response: Response;
  try {
    response = await fetchImpl(`${url}/api/nodes/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAborted = err instanceof Error && err.name === 'AbortError';
    const errMsg = isAborted
      ? 'Request timed out.'
      : "townhouse hs up isn't running. Run 'townhouse hs up' first.";
    if (options.json) {
      emitJsonError({
        ok: false,
        error: isAborted ? 'timeout' : 'econnrefused',
        message: errMsg,
      });
    } else {
      process.stderr.write(`${xMark} ${errMsg}\n`);
      process.exitCode = 1;
    }
    return;
  }
  clearTimeout(timer);

  if (response.status === 200) {
    const body = (await response.json().catch(() => ({}))) as {
      id?: string;
      type?: string;
    };
    const removedId = body.id ?? id;
    if (options.json) {
      process.stdout.write(
        JSON.stringify({ ok: true, id: removedId, type: body.type }) + '\n'
      );
    } else {
      process.stdout.write(`${check} Removed ${removedId}\n`);
    }
    return;
  }

  const body = (await response.json().catch(() => ({}))) as {
    error?: string;
    step?: string;
    err?: string;
    id?: string;
  };

  if (options.json) {
    emitJsonError({ ok: false, ...body });
    return;
  }

  if (response.status === 404) {
    process.stderr.write(`${xMark} No node with id '${id}'\n`);
  } else if (
    response.status === 409 &&
    body.error === 'node_lifecycle_in_flight'
  ) {
    process.stderr.write(
      `${xMark} Another node operation is in flight. Try again in a moment.\n`
    );
  } else {
    const step = body.step ?? 'unknown';
    process.stderr.write(`${xMark} Step ${step} failed: ${body.err ?? ''}\n`);
  }
  process.exitCode = 1;
}

// ── handleNodeList ─────────────────────────────────────────────────────────────

export interface NodeListOptions {
  json: boolean;
  apiUrl?: string;
  fetch?: FetchFn;
}

interface NodeEntry {
  id: string;
  type: string;
  peerId: string;
  ilpAddress: string;
  status: 'connected' | 'disconnected' | 'unknown';
  enabledAt: string;
  lastSeenAt: string | null;
}

export async function handleNodeList(options: NodeListOptions): Promise<void> {
  const ascii = useAscii();
  const xMark = ascii ? '[X]' : '✕';
  const emDash = ascii ? '-' : '—';

  const url = resolveApiUrl(options.apiUrl);
  const fetchImpl = options.fetch ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetchImpl(`${url}/api/nodes`, {
      method: 'GET',
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAborted = err instanceof Error && err.name === 'AbortError';
    const errMsg = isAborted
      ? 'Request timed out.'
      : "townhouse hs up isn't running. Run 'townhouse hs up' first.";
    if (options.json) {
      emitJsonError({
        ok: false,
        error: isAborted ? 'timeout' : 'econnrefused',
        message: errMsg,
      });
    } else {
      process.stderr.write(`${xMark} ${errMsg}\n`);
      process.exitCode = 1;
    }
    return;
  }
  clearTimeout(timer);

  if (response.status !== 200) {
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (options.json) {
      emitJsonError({ ok: false, ...body });
    } else {
      process.stderr.write(
        `${xMark} Failed to fetch nodes (HTTP ${response.status})\n`
      );
      process.exitCode = 1;
    }
    return;
  }

  const body = (await response.json().catch(() => ({ nodes: [] }))) as {
    nodes?: NodeEntry[];
  };
  const nodes = body.nodes ?? [];

  if (options.json) {
    // Emit the API response body verbatim (no `ok` envelope) — consistent with kubectl -o json.
    process.stdout.write(JSON.stringify({ nodes }) + '\n');
    return;
  }

  if (nodes.length === 0) {
    process.stdout.write(
      "No nodes provisioned. Run 'townhouse node add town' to add one.\n"
    );
    return;
  }

  // Print 4-column table. Header labels follow AC #5 literal (`peer · type ·
  // status · last claim`). Column widths grow to fit the longest value so long
  // IDs / peer handles are never silently sliced.
  const rows = nodes.map((node) => ({
    peer: node.id,
    type: node.type,
    status: node.status,
    lastClaim:
      node.lastSeenAt !== null ? formatRelativeTime(node.lastSeenAt) : emDash,
  }));

  const HEADERS = {
    peer: 'peer',
    type: 'type',
    status: 'status',
    lastClaim: 'last claim',
  };
  const widths = {
    peer: Math.max(HEADERS.peer.length, ...rows.map((r) => r.peer.length)),
    type: Math.max(HEADERS.type.length, ...rows.map((r) => r.type.length)),
    status: Math.max(
      HEADERS.status.length,
      ...rows.map((r) => r.status.length)
    ),
    lastClaim: Math.max(
      HEADERS.lastClaim.length,
      ...rows.map((r) => r.lastClaim.length)
    ),
  };

  function pad(s: string, width: number): string {
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
  }

  const divider = ascii ? '-' : '─';
  process.stdout.write(
    `${pad(HEADERS.peer, widths.peer)}  ${pad(HEADERS.type, widths.type)}  ${pad(HEADERS.status, widths.status)}  ${HEADERS.lastClaim}\n`
  );
  process.stdout.write(
    `${divider.repeat(widths.peer)}  ${divider.repeat(widths.type)}  ${divider.repeat(widths.status)}  ${divider.repeat(widths.lastClaim)}\n`
  );

  for (const row of rows) {
    process.stdout.write(
      `${pad(row.peer, widths.peer)}  ${pad(row.type, widths.type)}  ${pad(row.status, widths.status)}  ${row.lastClaim}\n`
    );
  }
}
