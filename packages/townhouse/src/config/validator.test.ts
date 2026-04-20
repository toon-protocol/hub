import { describe, it, expect } from 'vitest';
import { validateConfig, ConfigValidationError } from './validator.js';
import { getDefaultConfig } from './defaults.js';

/** Helper: produce a valid raw config object (matches default shape). */
function validRaw(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(getDefaultConfig())) as Record<
    string,
    unknown
  >;
}

describe('validateConfig', () => {
  it('accepts a valid config and returns typed TownhouseConfig', () => {
    const raw = validRaw();
    const config = validateConfig(raw);

    expect(config.nodes.town.enabled).toBe(false);
    expect(config.nodes.mill.enabled).toBe(false);
    expect(config.nodes.dvm.enabled).toBe(false);
    expect(config.api.port).toBe(9400);
    expect(config.api.host).toBe('127.0.0.1');
    expect(config.logging.level).toBe('info');
    expect(config.transport.mode).toBe('direct');
    expect(config.connector.image).toBe(
      'ghcr.io/toon-protocol/connector:latest'
    );
  });

  it('accepts config with optional node fee fields', () => {
    const raw = validRaw();
    const nodes = raw['nodes'] as Record<string, Record<string, unknown>>;
    const town = nodes['town'] as Record<string, unknown>;
    const mill = nodes['mill'] as Record<string, unknown>;
    const dvm = nodes['dvm'] as Record<string, unknown>;
    town['feePerEvent'] = 1000;
    mill['feeBasisPoints'] = 50;
    dvm['feePerJob'] = 5000;

    const config = validateConfig(raw);
    expect(config.nodes.town.feePerEvent).toBe(1000);
    expect(config.nodes.mill.feeBasisPoints).toBe(50);
    expect(config.nodes.dvm.feePerJob).toBe(5000);
  });

  it('rejects null input', () => {
    expect(() => validateConfig(null)).toThrow(ConfigValidationError);
  });

  it('rejects non-object input', () => {
    expect(() => validateConfig('string')).toThrow(ConfigValidationError);
    expect(() => validateConfig(42)).toThrow(ConfigValidationError);
    expect(() => validateConfig([])).toThrow(ConfigValidationError);
  });

  it('rejects missing nodes section', () => {
    const raw = validRaw();
    delete raw['nodes'];
    expect(() => validateConfig(raw)).toThrow(
      'config.nodes must be a non-null object'
    );
  });

  it('rejects missing wallet section', () => {
    const raw = validRaw();
    delete raw['wallet'];
    expect(() => validateConfig(raw)).toThrow(
      'config.wallet must be a non-null object'
    );
  });

  it('rejects missing connector section', () => {
    const raw = validRaw();
    delete raw['connector'];
    expect(() => validateConfig(raw)).toThrow(
      'config.connector must be a non-null object'
    );
  });

  it('rejects missing api section', () => {
    const raw = validRaw();
    delete raw['api'];
    expect(() => validateConfig(raw)).toThrow(
      'config.api must be a non-null object'
    );
  });

  it('rejects missing logging section', () => {
    const raw = validRaw();
    delete raw['logging'];
    expect(() => validateConfig(raw)).toThrow(
      'config.logging must be a non-null object'
    );
  });

  it('rejects non-boolean enabled field in node config', () => {
    const raw = validRaw();
    const nodes = raw['nodes'] as Record<string, Record<string, unknown>>;
    const town = nodes['town'] as Record<string, unknown>;
    town['enabled'] = 'yes';
    expect(() => validateConfig(raw)).toThrow(
      'config.nodes.town.enabled must be a boolean'
    );
  });

  it('rejects invalid transport mode', () => {
    const raw = validRaw();
    const transport = raw['transport'] as Record<string, unknown>;
    transport['mode'] = 'tor';
    expect(() => validateConfig(raw)).toThrow(
      'config.transport.mode must be one of'
    );
  });

  it('rejects invalid logging level', () => {
    const raw = validRaw();
    const logging = raw['logging'] as Record<string, unknown>;
    logging['level'] = 'verbose';
    expect(() => validateConfig(raw)).toThrow(
      'config.logging.level must be one of'
    );
  });

  it('rejects non-string wallet encrypted_path', () => {
    const raw = validRaw();
    const wallet = raw['wallet'] as Record<string, unknown>;
    wallet['encrypted_path'] = 123;
    expect(() => validateConfig(raw)).toThrow(
      'config.wallet.encrypted_path must be a string'
    );
  });

  it('rejects non-number api port', () => {
    const raw = validRaw();
    const api = raw['api'] as Record<string, unknown>;
    api['port'] = '9400';
    expect(() => validateConfig(raw)).toThrow(
      'config.api.port must be a finite number'
    );
  });

  it('rejects non-number connector adminPort', () => {
    const raw = validRaw();
    const connector = raw['connector'] as Record<string, unknown>;
    connector['adminPort'] = 'not-a-port';
    expect(() => validateConfig(raw)).toThrow(
      'config.connector.adminPort must be a finite number'
    );
  });

  it('rejects non-string connector image', () => {
    const raw = validRaw();
    const connector = raw['connector'] as Record<string, unknown>;
    connector['image'] = 42;
    expect(() => validateConfig(raw)).toThrow(
      'config.connector.image must be a string'
    );
  });

  it('rejects non-string api host', () => {
    const raw = validRaw();
    const api = raw['api'] as Record<string, unknown>;
    api['host'] = 123;
    expect(() => validateConfig(raw)).toThrow(
      'config.api.host must be a string'
    );
  });

  it('rejects api port out of range (negative)', () => {
    const raw = validRaw();
    const api = raw['api'] as Record<string, unknown>;
    api['port'] = -1;
    expect(() => validateConfig(raw)).toThrow(
      'config.api.port must be an integer in range 0..65535'
    );
  });

  it('rejects api port out of range (too high)', () => {
    const raw = validRaw();
    const api = raw['api'] as Record<string, unknown>;
    api['port'] = 70000;
    expect(() => validateConfig(raw)).toThrow(
      'config.api.port must be an integer in range 0..65535'
    );
  });

  it('rejects connector adminPort out of range', () => {
    const raw = validRaw();
    const connector = raw['connector'] as Record<string, unknown>;
    connector['adminPort'] = 99999;
    expect(() => validateConfig(raw)).toThrow(
      'config.connector.adminPort must be an integer in range 0..65535'
    );
  });

  it('rejects non-integer port (float)', () => {
    const raw = validRaw();
    const api = raw['api'] as Record<string, unknown>;
    api['port'] = 9400.5;
    expect(() => validateConfig(raw)).toThrow(
      'config.api.port must be an integer in range 0..65535'
    );
  });

  it('accepts config with socksProxy when transport mode is ator', () => {
    const raw = validRaw();
    const transport = raw['transport'] as Record<string, unknown>;
    transport['mode'] = 'ator';
    transport['socksProxy'] = 'socks5://127.0.0.1:9050';
    const config = validateConfig(raw);
    expect(config.transport.mode).toBe('ator');
    expect(config.transport.socksProxy).toBe('socks5://127.0.0.1:9050');
  });

  it('rejects non-string socksProxy', () => {
    const raw = validRaw();
    const transport = raw['transport'] as Record<string, unknown>;
    transport['socksProxy'] = 1234;
    expect(() => validateConfig(raw)).toThrow(
      'config.transport.socksProxy must be a string'
    );
  });
});
