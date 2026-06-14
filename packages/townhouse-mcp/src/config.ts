/**
 * Server configuration, resolved purely from environment variables. The MCP
 * server holds no long-term key state: `TOWNHOUSE_MNEMONIC` is the townhouse
 * stack's secret (read by `init`/`up`/the wallet), passed through to the child
 * CLI — see docs/townhouse-mcp-design.md §3.
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ResolvedConfig {
  /** Apex Fastify control API base URL. `TOWNHOUSE_API_URL` (default :9400). */
  apiUrl: string;
  /** Operator wallet seed. `TOWNHOUSE_MNEMONIC` (no password, §3). Optional. */
  mnemonic?: string;
  /** Townhouse config/wallet dir. `TOWNHOUSE_CONFIG_DIR` (default ~/.townhouse). */
  configDir: string;
  /** `townhouse` CLI binary. `TOWNHOUSE_BIN` (default 'townhouse' from PATH). */
  townhouseBin: string;
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
    configDir: env['TOWNHOUSE_CONFIG_DIR'] ?? join(homedir(), '.townhouse'),
    townhouseBin: env['TOWNHOUSE_BIN'] ?? 'townhouse',
    autoUp: env['TOWNHOUSE_AUTOUP'] !== '0',
    transport: env['TOWNHOUSE_TRANSPORT_MODE'] === 'hs' ? 'hs' : 'direct',
  };
}
