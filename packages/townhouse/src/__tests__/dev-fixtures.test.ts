/**
 * Dev Fixture Validation — Story 21.8.0, Task 3.6
 *
 * Guards against the docker/dev-fixtures/*.config.json files going stale
 * relative to the Mill config schema. Parses both files and validates
 * the structural shape the Mill entrypoint expects.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WORKSPACE_ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const FIXTURES_DIR = join(WORKSPACE_ROOT, 'docker', 'dev-fixtures');

function loadFixture(name: string): Record<string, unknown> {
  const path = join(FIXTURES_DIR, name);
  const content = readFileSync(path, 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

function validateMillConfigShape(
  cfg: Record<string, unknown>,
  label: string
): void {
  // swapPairs: non-empty array
  expect(
    Array.isArray(cfg['swapPairs']),
    `${label}: swapPairs must be array`
  ).toBe(true);
  const pairs = cfg['swapPairs'] as unknown[];
  expect(pairs.length, `${label}: swapPairs must be non-empty`).toBeGreaterThan(
    0
  );

  for (const pair of pairs) {
    const p = pair as Record<string, unknown>;
    const from = p['from'] as Record<string, unknown> | undefined;
    const to = p['to'] as Record<string, unknown> | undefined;

    expect(typeof from?.['assetCode'], `${label}: pair.from.assetCode`).toBe(
      'string'
    );
    expect(typeof from?.['assetScale'], `${label}: pair.from.assetScale`).toBe(
      'number'
    );
    expect(typeof from?.['chain'], `${label}: pair.from.chain`).toBe('string');
    expect(typeof to?.['assetCode'], `${label}: pair.to.assetCode`).toBe(
      'string'
    );
    expect(typeof to?.['assetScale'], `${label}: pair.to.assetScale`).toBe(
      'number'
    );
    expect(typeof to?.['chain'], `${label}: pair.to.chain`).toBe('string');
    expect(typeof (p['rate'] as string), `${label}: pair.rate`).toBe('string');
  }

  // chains: non-empty array of known chain kinds
  expect(Array.isArray(cfg['chains']), `${label}: chains must be array`).toBe(
    true
  );
  const chains = cfg['chains'] as unknown[];
  expect(chains.length, `${label}: chains must be non-empty`).toBeGreaterThan(
    0
  );
  for (const c of chains) {
    expect(
      ['evm', 'solana', 'mina'],
      `${label}: invalid chain kind "${c as string}"`
    ).toContain(c);
  }

  // channels: object of arrays
  const channels = cfg['channels'] as Record<string, unknown> | undefined;
  expect(typeof channels, `${label}: channels must be object`).toBe('object');
  expect(channels !== null, `${label}: channels must not be null`).toBe(true);
  for (const [chainKey, entries] of Object.entries(channels ?? {})) {
    expect(
      Array.isArray(entries),
      `${label}: channels.${chainKey} must be array`
    ).toBe(true);
    for (const entry of entries as unknown[]) {
      const e = entry as Record<string, unknown>;
      expect(
        typeof e['channelId'],
        `${label}: channels.${chainKey}[*].channelId`
      ).toBe('string');
      // cumulativeAmount and nonce are number in JSON (toBigInt handles conversion)
      expect(
        ['number', 'string'].includes(typeof e['cumulativeAmount']),
        `${label}: cumulativeAmount type`
      ).toBe(true);
      expect(
        ['number', 'string'].includes(typeof e['nonce']),
        `${label}: nonce type`
      ).toBe(true);
      // Non-zero for dev fixtures (confirms channel is seeded)
      expect(
        Number(e['cumulativeAmount']),
        `${label}: cumulativeAmount must be > 0`
      ).toBeGreaterThan(0);
      expect(Number(e['nonce']), `${label}: nonce must be > 0`).toBeGreaterThan(
        0
      );
    }
  }

  // inventory: object of numbers/strings
  const inventory = cfg['inventory'] as Record<string, unknown> | undefined;
  expect(typeof inventory, `${label}: inventory must be object`).toBe('object');
  for (const [chainKey, amt] of Object.entries(inventory ?? {})) {
    expect(
      ['number', 'string'].includes(typeof amt),
      `${label}: inventory.${chainKey} type`
    ).toBe(true);
    expect(
      Number(amt),
      `${label}: inventory.${chainKey} must be > 0`
    ).toBeGreaterThan(0);
  }

  // relayUrls: non-empty array of strings starting with ws://
  const relayUrls = cfg['relayUrls'] as unknown[] | undefined;
  expect(Array.isArray(relayUrls), `${label}: relayUrls must be array`).toBe(
    true
  );
  expect(
    (relayUrls ?? []).length,
    `${label}: relayUrls must be non-empty`
  ).toBeGreaterThan(0);
  for (const url of relayUrls ?? []) {
    expect(typeof url, `${label}: relayUrl must be string`).toBe('string');
    expect(
      (url as string).startsWith('ws://'),
      `${label}: relayUrl must start with ws://`
    ).toBe(true);
  }
}

describe('dev-fixtures Mill config shape validation', () => {
  it('mill-01.config.json parses as valid JSON and matches Mill config shape', () => {
    const cfg = loadFixture('mill-01.config.json');
    validateMillConfigShape(cfg, 'mill-01');
  });

  it('mill-02.config.json parses as valid JSON and matches Mill config shape', () => {
    const cfg = loadFixture('mill-02.config.json');
    validateMillConfigShape(cfg, 'mill-02');
  });

  it('mill-01 swap pair is EVM↔Solana', () => {
    const cfg = loadFixture('mill-01.config.json');
    const pairs = cfg['swapPairs'] as Record<string, Record<string, string>>[];
    const pair = pairs[0];
    expect(pair['from']['chain']).toContain('evm');
    expect(pair['to']['chain']).toContain('solana');
  });

  it('mill-02 swap pair is EVM↔Mina', () => {
    const cfg = loadFixture('mill-02.config.json');
    const pairs = cfg['swapPairs'] as Record<string, Record<string, string>>[];
    const pair = pairs[0];
    expect(pair['from']['chain']).toContain('evm');
    expect(pair['to']['chain']).toContain('mina');
  });

  it('mill-01 relayUrls point at dev townhouse Town containers', () => {
    const cfg = loadFixture('mill-01.config.json');
    const relayUrls = cfg['relayUrls'] as string[];
    expect(relayUrls).toContain('ws://townhouse-dev-town-01:7100');
    expect(relayUrls).toContain('ws://townhouse-dev-town-02:7100');
  });

  it('mill-02 relayUrls point at dev townhouse Town containers', () => {
    const cfg = loadFixture('mill-02.config.json');
    const relayUrls = cfg['relayUrls'] as string[];
    expect(relayUrls).toContain('ws://townhouse-dev-town-01:7100');
    expect(relayUrls).toContain('ws://townhouse-dev-town-02:7100');
  });
});
