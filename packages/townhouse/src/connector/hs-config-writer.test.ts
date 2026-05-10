import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { writeHsConnectorConfig } from './hs-config-writer.js';
import { getDefaultConfig } from '../config/defaults.js';

describe('writeHsConnectorConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hs-config-writer-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes connector.yaml on a fresh dir', () => {
    const config = getDefaultConfig();
    const result = writeHsConnectorConfig(tmpDir, config);

    expect(result.created).toBe(true);
    expect(existsSync(result.yamlPath)).toBe(true);
    expect(result.yamlPath).toBe(join(tmpDir, 'connector.yaml'));
  });

  it('written file has mode 0o600', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);
    const mode = statSync(yamlPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('written file contains anon.enabled: true (HS marker)', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const anon = parsed['anon'] as Record<string, unknown> | undefined;
    expect(anon?.['enabled']).toBe(true);
  });

  it('parsed YAML has anon.enabled: true field', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect((parsed['anon'] as Record<string, unknown>)?.['enabled']).toBe(true);
  });

  it('transport block has managed hidden service settings', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const transport = parsed['transport'] as Record<string, unknown>;
    expect(transport['type']).toBe('socks5');
    expect(transport['managed']).toBe(true);
    const opts = transport['managedOptions'] as Record<string, unknown>;
    expect(opts['hiddenServiceDir']).toBe('/var/lib/anon/hs');
    expect(opts['hiddenServicePort']).toBe(3000);
  });

  it('preserves existing file when it contains the HS marker (idempotency)', () => {
    const config = getDefaultConfig();
    // First write
    const first = writeHsConnectorConfig(tmpDir, config);
    expect(first.created).toBe(true);
    const firstContent = readFileSync(first.yamlPath, 'utf-8');

    // Second write without force — must reuse
    const second = writeHsConnectorConfig(tmpDir, config);
    expect(second.created).toBe(false);
    const secondContent = readFileSync(second.yamlPath, 'utf-8');
    expect(secondContent).toBe(firstContent); // byte-for-byte identical
  });

  it('overwrites when force: true even if HS marker present', () => {
    const config = getDefaultConfig();
    writeHsConnectorConfig(tmpDir, config); // first write

    const result = writeHsConnectorConfig(tmpDir, config, { force: true });
    expect(result.created).toBe(true);
  });

  it('overwrites when existing file lacks the HS marker (legacy non-HS config)', () => {
    const existingPath = join(tmpDir, 'connector.yaml');
    // Write a file that does NOT have anon.enabled: true
    writeFileSync(
      existingPath,
      'nodeId: g.townhouse\nanon:\n  enabled: false\n',
      {
        mode: 0o600,
      }
    );

    const config = getDefaultConfig();
    const result = writeHsConnectorConfig(tmpDir, config);
    expect(result.created).toBe(true);
    const parsed = parse(readFileSync(existingPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const anon = parsed['anon'] as Record<string, unknown> | undefined;
    expect(anon?.['enabled']).toBe(true);
  });

  it('chmodSync is called after writeFileSync (defensive re-chmod ordering)', () => {
    // Verify that the file ends up at 0o600 even if the umask would mask it.
    // We can't directly test the ordering, but we can verify the end state.
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);

    // Simulate a prior run that left the file at wrong permissions.
    chmodSync(yamlPath, 0o644);
    // Re-write
    writeHsConnectorConfig(tmpDir, config, { force: true });
    const mode = statSync(yamlPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
