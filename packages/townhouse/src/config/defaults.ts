import type { TownhouseConfig } from './schema.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONNECTOR_IMAGE } from '../constants.js';

/**
 * Sensible default configuration. All nodes disabled by default —
 * operator must explicitly enable what they want to run.
 */
export function getDefaultConfig(): TownhouseConfig {
  return {
    nodes: {
      town: { enabled: false },
      mill: { enabled: false },
      dvm: { enabled: false },
    },
    wallet: {
      encrypted_path: join(homedir(), '.townhouse', 'wallet.enc'),
    },
    connector: {
      image: DEFAULT_CONNECTOR_IMAGE,
      adminPort: 9401,
    },
    transport: {
      mode: 'direct',
    },
    api: {
      port: 9400,
      host: '127.0.0.1',
    },
    logging: {
      level: 'info',
    },
  };
}
