import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { resolveConfig } from './config.js';

describe('resolveConfig', () => {
  it('applies defaults for an empty env', () => {
    const cfg = resolveConfig({});
    expect(cfg.apiUrl).toBe('http://127.0.0.1:9400');
    expect(cfg.configDir).toBe(join(homedir(), '.hub'));
    expect(cfg.hubBin).toBe('hub');
    expect(cfg.autoUp).toBe(true);
    expect(cfg.transport).toBe('direct');
    expect(cfg.mnemonic).toBeUndefined();
  });

  it('reads each override from the env', () => {
    const cfg = resolveConfig({
      TOWNHOUSE_API_URL: 'http://127.0.0.1:9999',
      TOWNHOUSE_MNEMONIC: 'word1 word2 word3',
      TOWNHOUSE_CONFIG_DIR: '/tmp/th',
      TOWNHOUSE_BIN: '/usr/local/bin/hub',
      TOWNHOUSE_AUTOUP: '0',
      TOWNHOUSE_TRANSPORT_MODE: 'hs',
    });
    expect(cfg.apiUrl).toBe('http://127.0.0.1:9999');
    expect(cfg.mnemonic).toBe('word1 word2 word3');
    expect(cfg.configDir).toBe('/tmp/th');
    expect(cfg.hubBin).toBe('/usr/local/bin/hub');
    expect(cfg.autoUp).toBe(false);
    expect(cfg.transport).toBe('hs');
  });

  it('treats any AUTOUP value other than "0" as enabled', () => {
    expect(resolveConfig({ TOWNHOUSE_AUTOUP: '1' }).autoUp).toBe(true);
    expect(resolveConfig({ TOWNHOUSE_AUTOUP: 'true' }).autoUp).toBe(true);
    expect(resolveConfig({ TOWNHOUSE_AUTOUP: '0' }).autoUp).toBe(false);
  });

  it('omits the mnemonic key entirely when unset', () => {
    expect('mnemonic' in resolveConfig({})).toBe(false);
  });
});
