/**
 * Server configuration, resolved purely from environment variables. The MCP
 * server holds no long-term key state: `TOWNHOUSE_MNEMONIC` is the hub
 * stack's secret (read by `init`/`up`/the wallet), passed through to the child
 * CLI — see docs/hub-mcp-design.md §3.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolvedConfig {
  /** Apex Fastify control API base URL. `TOWNHOUSE_API_URL` (default :9400). */
  apiUrl: string;
  /** Operator wallet seed. `TOWNHOUSE_MNEMONIC` (no password, §3). Optional. */
  mnemonic?: string;
  /** Hub config/wallet dir. `TOWNHOUSE_CONFIG_DIR` (default ~/.hub). */
  configDir: string;
  /** `hub` CLI binary. `TOWNHOUSE_BIN` (default 'hub' from PATH). */
  hubBin: string;
  /** Auto-`up` the apex on demand. `TOWNHOUSE_AUTOUP` (default true; '0' disables). */
  autoUp: boolean;
  /** Default boot transport. `TOWNHOUSE_TRANSPORT_MODE` ('hs' | 'direct'). */
  transport: 'direct' | 'hs';
}

/** Resolve config from an env map (defaults to `process.env`). Pure + testable. */
export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env
): ResolvedConfig {
  const mnemonic = env['TOWNHOUSE_MNEMONIC'];
  return {
    apiUrl: env['TOWNHOUSE_API_URL'] ?? 'http://127.0.0.1:9400',
    ...(mnemonic ? { mnemonic } : {}),
    configDir: env['TOWNHOUSE_CONFIG_DIR'] ?? join(homedir(), '.hub'),
    hubBin: env['TOWNHOUSE_BIN'] ?? 'hub',
    autoUp: env['TOWNHOUSE_AUTOUP'] !== '0',
    transport: env['TOWNHOUSE_TRANSPORT_MODE'] === 'hs' ? 'hs' : 'direct',
  };
}
