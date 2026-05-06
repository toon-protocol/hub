/**
 * Runtime validation for Townhouse configuration.
 * Validates shape, narrows types, returns typed config or throws.
 */

import type { TownhouseConfig } from './schema.js';

class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

function assertObject(
  value: unknown,
  path: string
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigValidationError(`${path} must be a non-null object`);
  }
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigValidationError(`${path} must be a boolean`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new ConfigValidationError(`${path} must be a string`);
  }
}

function assertNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigValidationError(`${path} must be a finite number`);
  }
}

function assertPort(value: number, path: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 65535) {
    throw new ConfigValidationError(
      `${path} must be an integer in range 0..65535`
    );
  }
}

const VALID_LOG_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const VALID_TRANSPORT_MODES = new Set(['ator', 'direct']);

function validateNodeConfig(
  raw: unknown,
  path: string
): { enabled: boolean } & Record<string, unknown> {
  assertObject(raw, path);
  assertBoolean(raw['enabled'], `${path}.enabled`);

  if (raw['feePerEvent'] !== undefined) {
    assertNumber(raw['feePerEvent'], `${path}.feePerEvent`);
  }
  if (raw['feeBasisPoints'] !== undefined) {
    assertNumber(raw['feeBasisPoints'], `${path}.feeBasisPoints`);
  }
  if (raw['feePerJob'] !== undefined) {
    assertNumber(raw['feePerJob'], `${path}.feePerJob`);
  }
  if (raw['kindPricing'] !== undefined) {
    assertObject(raw['kindPricing'], `${path}.kindPricing`);
    for (const [k, v] of Object.entries(
      raw['kindPricing'] as Record<string, unknown>
    )) {
      // Keys must be positive-integer strings — prevents prototype-key
      // pollution (`__proto__`, `constructor`) and env-var key injection
      // (newlines / spaces) when the orchestrator emits KIND_PRICING_<k>.
      if (!/^[0-9]+$/.test(k)) {
        throw new ConfigValidationError(
          `${path}.kindPricing has invalid key "${k}" — must be a positive-integer string`
        );
      }
      assertNumber(v, `${path}.kindPricing.${k}`);
      if (!Number.isInteger(v as number) || (v as number) < 0) {
        throw new ConfigValidationError(
          `${path}.kindPricing.${k} must be a non-negative integer`
        );
      }
      if ((v as number) > Number.MAX_SAFE_INTEGER) {
        throw new ConfigValidationError(
          `${path}.kindPricing.${k} exceeds Number.MAX_SAFE_INTEGER`
        );
      }
    }
  }
  if (raw['image'] !== undefined) {
    assertString(raw['image'], `${path}.image`);
  }

  return raw as { enabled: boolean } & Record<string, unknown>;
}

/**
 * Validate raw input and return a typed TownhouseConfig.
 * Throws ConfigValidationError with descriptive messages on invalid input.
 */
export function validateConfig(raw: unknown): TownhouseConfig {
  assertObject(raw, 'config');

  // nodes
  assertObject(raw['nodes'], 'config.nodes');
  const nodes = raw['nodes'] as Record<string, unknown>;
  const town = validateNodeConfig(nodes['town'], 'config.nodes.town');
  const mill = validateNodeConfig(nodes['mill'], 'config.nodes.mill');
  const dvm = validateNodeConfig(nodes['dvm'], 'config.nodes.dvm');

  // wallet
  assertObject(raw['wallet'], 'config.wallet');
  const wallet = raw['wallet'] as Record<string, unknown>;
  assertString(wallet['encrypted_path'], 'config.wallet.encrypted_path');

  // connector
  assertObject(raw['connector'], 'config.connector');
  const connector = raw['connector'] as Record<string, unknown>;
  assertString(connector['image'], 'config.connector.image');
  assertNumber(connector['adminPort'], 'config.connector.adminPort');
  assertPort(connector['adminPort'] as number, 'config.connector.adminPort');

  // transport
  assertObject(raw['transport'], 'config.transport');
  const transport = raw['transport'] as Record<string, unknown>;
  assertString(transport['mode'], 'config.transport.mode');
  if (!VALID_TRANSPORT_MODES.has(transport['mode'] as string)) {
    throw new ConfigValidationError(
      `config.transport.mode must be one of: ${[...VALID_TRANSPORT_MODES].join(', ')}`
    );
  }
  if (transport['socksProxy'] !== undefined) {
    assertString(transport['socksProxy'], 'config.transport.socksProxy');
  }
  if (transport['externalUrl'] !== undefined) {
    assertString(transport['externalUrl'], 'config.transport.externalUrl');
  }
  // hiddenService is optional and only meaningful when mode='ator'. We
  // validate the inner shape unconditionally if present (a hiddenService
  // block under mode='direct' is operator confusion, not silent acceptance).
  if (transport['hiddenService'] !== undefined) {
    assertObject(transport['hiddenService'], 'config.transport.hiddenService');
    const hs = transport['hiddenService'] as Record<string, unknown>;
    assertString(hs['dir'], 'config.transport.hiddenService.dir');
    assertNumber(hs['port'], 'config.transport.hiddenService.port');
    assertPort(hs['port'] as number, 'config.transport.hiddenService.port');
    if (hs['externalUrl'] !== undefined) {
      assertString(hs['externalUrl'], 'config.transport.hiddenService.externalUrl');
    }
    if (hs['startupTimeoutMs'] !== undefined) {
      assertNumber(hs['startupTimeoutMs'], 'config.transport.hiddenService.startupTimeoutMs');
    }
    if (hs['stopTimeoutMs'] !== undefined) {
      assertNumber(hs['stopTimeoutMs'], 'config.transport.hiddenService.stopTimeoutMs');
    }
    if (transport['mode'] !== 'ator') {
      throw new ConfigValidationError(
        'config.transport.hiddenService is only valid when config.transport.mode is "ator"'
      );
    }
  }
  // relayHiddenService is the second optional HS — when set, the orchestrator
  // launches a parallel sidecar that forwards inbound .anyone traffic to the
  // town container's port 7100 so external Nostr clients can read the relay
  // without routing through ILP/BTP. Reuses HiddenServiceConfig shape.
  if (transport['relayHiddenService'] !== undefined) {
    assertObject(
      transport['relayHiddenService'],
      'config.transport.relayHiddenService'
    );
    const hs = transport['relayHiddenService'] as Record<string, unknown>;
    assertString(hs['dir'], 'config.transport.relayHiddenService.dir');
    assertNumber(hs['port'], 'config.transport.relayHiddenService.port');
    assertPort(hs['port'] as number, 'config.transport.relayHiddenService.port');
    if (hs['externalUrl'] !== undefined) {
      assertString(
        hs['externalUrl'],
        'config.transport.relayHiddenService.externalUrl'
      );
    }
    if (hs['startupTimeoutMs'] !== undefined) {
      assertNumber(
        hs['startupTimeoutMs'],
        'config.transport.relayHiddenService.startupTimeoutMs'
      );
    }
    if (hs['stopTimeoutMs'] !== undefined) {
      assertNumber(
        hs['stopTimeoutMs'],
        'config.transport.relayHiddenService.stopTimeoutMs'
      );
    }
  }

  // mode='ator' requires SOMETHING to advertise: either explicit externalUrl
  // OR hiddenService (which makes externalUrl='auto' implicit). Without one
  // of these, the connector's socks5 transport rejects with "missing
  // required field: transport.externalUrl" and the connector fails to boot.
  if (
    transport['mode'] === 'ator' &&
    transport['externalUrl'] === undefined &&
    transport['hiddenService'] === undefined
  ) {
    throw new ConfigValidationError(
      'config.transport.mode="ator" requires either config.transport.externalUrl ' +
        '(operator-managed anon binary) or config.transport.hiddenService ' +
        '(connector-managed anon binary). Without one of these, the underlying ' +
        'connector will reject the manifest at boot.'
    );
  }

  // api
  assertObject(raw['api'], 'config.api');
  const api = raw['api'] as Record<string, unknown>;
  assertNumber(api['port'], 'config.api.port');
  assertPort(api['port'] as number, 'config.api.port');
  assertString(api['host'], 'config.api.host');

  // logging
  assertObject(raw['logging'], 'config.logging');
  const logging = raw['logging'] as Record<string, unknown>;
  assertString(logging['level'], 'config.logging.level');
  if (!VALID_LOG_LEVELS.has(logging['level'] as string)) {
    throw new ConfigValidationError(
      `config.logging.level must be one of: ${[...VALID_LOG_LEVELS].join(', ')}`
    );
  }

  return {
    nodes: {
      town: {
        enabled: town['enabled'] as boolean,
        ...pickOptional(town, ['feePerEvent', 'image']),
      },
      mill: {
        enabled: mill['enabled'] as boolean,
        ...pickOptional(mill, ['feeBasisPoints', 'image']),
      },
      dvm: {
        enabled: dvm['enabled'] as boolean,
        ...pickOptional(dvm, ['feePerJob', 'kindPricing', 'image']),
      },
    },
    wallet: { encrypted_path: wallet['encrypted_path'] as string },
    connector: {
      image: connector['image'] as string,
      adminPort: connector['adminPort'] as number,
    },
    transport: {
      mode: transport['mode'] as 'ator' | 'direct',
      ...(transport['socksProxy'] !== undefined
        ? { socksProxy: transport['socksProxy'] as string }
        : {}),
      ...(transport['externalUrl'] !== undefined
        ? { externalUrl: transport['externalUrl'] as string }
        : {}),
      ...(transport['hiddenService'] !== undefined
        ? {
            hiddenService: transport['hiddenService'] as {
              dir: string;
              port: number;
              externalUrl?: string;
              startupTimeoutMs?: number;
              stopTimeoutMs?: number;
            },
          }
        : {}),
      ...(transport['relayHiddenService'] !== undefined
        ? {
            relayHiddenService: transport['relayHiddenService'] as {
              dir: string;
              port: number;
              externalUrl?: string;
              startupTimeoutMs?: number;
              stopTimeoutMs?: number;
            },
          }
        : {}),
    },
    api: {
      port: api['port'] as number,
      host: api['host'] as string,
    },
    logging: {
      level: logging['level'] as 'debug' | 'info' | 'warn' | 'error',
    },
  };
}

function pickOptional(
  obj: Record<string, unknown>,
  keys: string[]
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

export { ConfigValidationError };
