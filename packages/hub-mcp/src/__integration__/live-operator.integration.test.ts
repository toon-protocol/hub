/**
 * Gated live operator E2E. Mirrors client-mcp's RUN_LIVE_HS_E2E pattern: a real
 * `hub init`→`up`→`add_node`→`earnings`→`withdraw(dryRun)` against local
 * Docker chains, driven entirely through the MCP dispatch surface.
 *
 * Skipped unless RUN_LIVE_OPERATOR_E2E=1. Requires the hub CLI on PATH (or
 * TOWNHOUSE_BIN), Docker, and a TOWNHOUSE_MNEMONIC (the upstream P1 env path).
 *
 * NOTE: this is a SCAFFOLD — the live assertions are intentionally minimal until
 * P1 (TOWNHOUSE_MNEMONIC direct-load) and P2 (--json on up/status/init) land.
 */
import { describe, it, expect } from 'vitest';
import { resolveConfig } from '../config.js';
import { ApiClient } from '../api-client.js';
import { CliDriver } from '../cli-driver.js';
import { dispatchTool } from '../mcp-tools.js';

const RUN = process.env['RUN_LIVE_OPERATOR_E2E'] === '1';

describe.skipIf(!RUN)('live operator E2E', () => {
  const cfg = resolveConfig();
  const ctx = {
    cfg,
    api: new ApiClient({ baseUrl: cfg.apiUrl }),
    cli: new CliDriver(cfg),
  };

  it('reports status (api or cli) without throwing', async () => {
    const res = await dispatchTool(ctx, 'hub_status', {});
    expect(res.content[0]!.text.length).toBeGreaterThan(0);
  });

  it('lists nodes once the apex is up', async () => {
    const res = await dispatchTool(ctx, 'hub_list_nodes', {});
    // Either a node list (up) or a booting/retry hint (still bootstrapping).
    expect(res.content[0]!.text).toBeTruthy();
  });

  it('estimates a withdraw via dryRun', async () => {
    const res = await dispatchTool(ctx, 'hub_withdraw', {
      nodeType: 'town',
      chainFamily: 'evm',
      token: 'native',
      recipient: '0x0000000000000000000000000000000000000000',
      amount: '1',
      dryRun: true,
    });
    expect(res.content[0]!.text).toBeTruthy();
  });
});
