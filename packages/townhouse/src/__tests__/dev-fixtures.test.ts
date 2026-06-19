/**
 * Dev fixture validity guard.
 *
 * Originally checked dev fixture paths that were broken by the CI-fix commit.
 * Rewritten against the current fixture layout at
 * src/__tests__/fixtures/compose-loader/: verifies that all expected fixture
 * files exist, are structurally valid, and that key cross-file invariants hold
 * (e.g. connector tag in image-manifest matches the tag in the dev compose).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_DIR = join(__dirname, 'fixtures/compose-loader');

describe('dev fixture files exist', () => {
  it('image-manifest.json is present', () => {
    expect(existsSync(join(FIXTURE_DIR, 'image-manifest.json'))).toBe(true);
  });

  it('townhouse-dev.yml is present', () => {
    expect(
      existsSync(join(FIXTURE_DIR, 'compose/townhouse-dev.yml'))
    ).toBe(true);
  });

  it('townhouse-hs.yml is present', () => {
    expect(
      existsSync(join(FIXTURE_DIR, 'compose/townhouse-hs.yml'))
    ).toBe(true);
  });

  it('townhouse-direct.yml is present', () => {
    expect(
      existsSync(join(FIXTURE_DIR, 'compose/townhouse-direct.yml'))
    ).toBe(true);
  });
});

describe('image-manifest.json structure', () => {
  it('has schemaVersion 1 and exactly five image entries', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'image-manifest.json'), 'utf-8')
    ) as Record<string, unknown>;
    expect(manifest['schemaVersion']).toBe(1);
    const images = manifest['images'] as Record<string, unknown>;
    expect(Object.keys(images).sort()).toEqual([
      'connector',
      'dvm',
      'mill',
      'town',
      'townhouse-api',
    ]);
  });

  it('connector entry names ghcr.io/toon-protocol/connector', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'image-manifest.json'), 'utf-8')
    ) as Record<string, unknown>;
    const images = manifest['images'] as Record<
      string,
      { name: string; tag: string; digest: string }
    >;
    expect(images['connector']!.name).toBe('ghcr.io/toon-protocol/connector');
  });

  it('all five entries have valid sha256 digests', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'image-manifest.json'), 'utf-8')
    ) as Record<string, unknown>;
    const images = manifest['images'] as Record<
      string,
      { digest: string }
    >;
    for (const [key, entry] of Object.entries(images)) {
      expect(
        entry.digest,
        `images.${key}.digest must be sha256:<64hex>`
      ).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });
});

describe('cross-fixture invariants', () => {
  it('connector tag in image-manifest matches the connector image tag in dev compose', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'image-manifest.json'), 'utf-8')
    ) as Record<string, unknown>;
    const images = manifest['images'] as Record<
      string,
      { name: string; tag: string; digest: string }
    >;
    const connectorTag = images['connector']!.tag;
    const devCompose = readFileSync(
      join(FIXTURE_DIR, 'compose/townhouse-dev.yml'),
      'utf-8'
    );
    expect(devCompose).toContain(`connector:${connectorTag}`);
  });

  it('HS compose uses digest-pinned images for all five services', () => {
    const compose = readFileSync(
      join(FIXTURE_DIR, 'compose/townhouse-hs.yml'),
      'utf-8'
    );
    const digestMatches = compose.match(/@sha256:[0-9a-f]{64}/g) ?? [];
    expect(digestMatches.length).toBeGreaterThanOrEqual(5);
  });

  it('dev compose uses a plain tag for the connector (not digest-pinned)', () => {
    const compose = readFileSync(
      join(FIXTURE_DIR, 'compose/townhouse-dev.yml'),
      'utf-8'
    );
    expect(compose).toMatch(/ghcr\.io\/toon-protocol\/connector:\d+\.\d+\.\d+/);
    expect(compose).not.toMatch(/ghcr\.io\/toon-protocol\/connector@sha256:/);
  });
});
