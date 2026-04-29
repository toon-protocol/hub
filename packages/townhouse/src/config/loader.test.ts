import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { loadConfig } from './loader.js';

/** Create a unique temp dir for each test to avoid collisions. */
function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `townhouse-test-${randomBytes(8).toString('hex')}`
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Minimal valid YAML config. */
const VALID_YAML = `
nodes:
  town:
    enabled: false
  mill:
    enabled: true
  dvm:
    enabled: false
wallet:
  encrypted_path: /tmp/wallet.enc
connector:
  image: ghcr.io/toon-protocol/connector:3.3.3
  adminPort: 9401
transport:
  mode: direct
api:
  port: 9400
  host: 127.0.0.1
logging:
  level: info
`;

describe('loadConfig', () => {
  const envBackup = new Map<string, string | undefined>();

  afterEach(() => {
    // Restore env vars
    for (const [key, val] of envBackup) {
      if (val === undefined) {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
    envBackup.clear();
  });

  function setEnv(key: string, value: string): void {
    envBackup.set(key, process.env[key]);
    process.env[key] = value;
  }

  it('loads a valid YAML config from file', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, VALID_YAML, 'utf-8');

    const config = loadConfig(configPath);
    expect(config.nodes.mill.enabled).toBe(true);
    expect(config.api.port).toBe(9400);
    expect(config.logging.level).toBe('info');

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws descriptive error for file not found', () => {
    expect(() => loadConfig('/nonexistent/path/config.yaml')).toThrow(
      'Config file not found'
    );
  });

  it('throws descriptive error for malformed YAML', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, '{{{{invalid yaml!!!!', 'utf-8');

    expect(() => loadConfig(configPath)).toThrow();

    rmSync(dir, { recursive: true, force: true });
  });

  it('TOWNHOUSE_API_PORT env var overrides YAML value', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, VALID_YAML, 'utf-8');

    setEnv('TOWNHOUSE_API_PORT', '8080');
    const config = loadConfig(configPath);
    expect(config.api.port).toBe(8080);

    rmSync(dir, { recursive: true, force: true });
  });

  it('TOWNHOUSE_TRANSPORT_MODE env var overrides YAML value', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, VALID_YAML, 'utf-8');

    setEnv('TOWNHOUSE_TRANSPORT_MODE', 'ator');
    const config = loadConfig(configPath);
    expect(config.transport.mode).toBe('ator');

    rmSync(dir, { recursive: true, force: true });
  });

  it('TOWNHOUSE_LOG_LEVEL env var overrides YAML value', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, VALID_YAML, 'utf-8');

    setEnv('TOWNHOUSE_LOG_LEVEL', 'debug');
    const config = loadConfig(configPath);
    expect(config.logging.level).toBe('debug');

    rmSync(dir, { recursive: true, force: true });
  });

  it('handles empty YAML file gracefully (uses defaults)', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, '', 'utf-8');

    const config = loadConfig(configPath);
    expect(config.nodes.town.enabled).toBe(false);
    expect(config.api.port).toBe(9400);
    expect(config.logging.level).toBe('info');

    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects YAML that parses to an array', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, '- item1\n- item2\n', 'utf-8');

    expect(() => loadConfig(configPath)).toThrow('must be a YAML mapping');

    rmSync(dir, { recursive: true, force: true });
  });

  it('loads partial YAML and merges with defaults', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    const partialYaml = `
nodes:
  town:
    enabled: true
  mill:
    enabled: false
  dvm:
    enabled: false
`;
    writeFileSync(configPath, partialYaml, 'utf-8');

    const config = loadConfig(configPath);
    expect(config.nodes.town.enabled).toBe(true);
    expect(config.api.port).toBe(9400);
    expect(config.logging.level).toBe('info');

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws for invalid TOWNHOUSE_API_PORT (out of range)', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, VALID_YAML, 'utf-8');

    setEnv('TOWNHOUSE_API_PORT', '99999');
    expect(() => loadConfig(configPath)).toThrow(
      'TOWNHOUSE_API_PORT must be 0..65535'
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws for invalid TOWNHOUSE_API_PORT (non-numeric)', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, VALID_YAML, 'utf-8');

    setEnv('TOWNHOUSE_API_PORT', 'abc');
    expect(() => loadConfig(configPath)).toThrow(
      'TOWNHOUSE_API_PORT must be 0..65535'
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws for invalid TOWNHOUSE_TRANSPORT_MODE', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, VALID_YAML, 'utf-8');

    setEnv('TOWNHOUSE_TRANSPORT_MODE', 'tor');
    expect(() => loadConfig(configPath)).toThrow(
      'TOWNHOUSE_TRANSPORT_MODE must be "ator" or "direct"'
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it('throws for invalid TOWNHOUSE_LOG_LEVEL', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    writeFileSync(configPath, VALID_YAML, 'utf-8');

    setEnv('TOWNHOUSE_LOG_LEVEL', 'verbose');
    expect(() => loadConfig(configPath)).toThrow(
      'TOWNHOUSE_LOG_LEVEL must be one of: debug, info, warn, error'
    );

    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects __proto__ keys in YAML (prototype pollution prevention)', () => {
    const dir = makeTempDir();
    const configPath = join(dir, 'config.yaml');
    // Craft a YAML payload that attempts prototype pollution
    const maliciousYaml = `
nodes:
  town:
    enabled: false
  mill:
    enabled: false
  dvm:
    enabled: false
wallet:
  encrypted_path: /tmp/wallet.enc
connector:
  image: ghcr.io/toon-protocol/connector:3.3.3
  adminPort: 9401
transport:
  mode: direct
api:
  port: 9400
  host: 127.0.0.1
logging:
  level: info
"__proto__":
  polluted: true
`;
    writeFileSync(configPath, maliciousYaml, 'utf-8');

    const config = loadConfig(configPath);
    // __proto__ key should be ignored, Object.prototype should not be polluted
    expect(config.api.port).toBe(9400);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    rmSync(dir, { recursive: true, force: true });
  });
});
