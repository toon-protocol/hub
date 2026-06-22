/**
 * Mill image configuration guard.
 *
 * Originally checked docker/Dockerfile.mill (removed during the mill→swap
 * rename). Rewritten against the current structure: verifies that the mill
 * service is correctly defined in the fixture image-manifest and compose
 * templates, so an accidental rename of the mill image or service fails CI.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_DIR = join(
  __dirname,
  '../__tests__/fixtures/compose-loader'
);

describe('mill image configuration', () => {
  it('fixture image-manifest has a mill entry named ghcr.io/toon-protocol/mill', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'image-manifest.json'), 'utf-8')
    ) as Record<string, unknown>;
    const images = manifest['images'] as Record<
      string,
      { name: string; tag: string; digest: string }
    >;
    expect(images['mill']).toBeDefined();
    expect(images['mill']!.name).toBe('ghcr.io/toon-protocol/mill');
  });

  it('fixture image-manifest mill digest is sha256-pinned', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'image-manifest.json'), 'utf-8')
    ) as Record<string, unknown>;
    const images = manifest['images'] as Record<
      string,
      { name: string; tag: string; digest: string }
    >;
    expect(images['mill']!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('HS compose template defines a mill service with a digest-pinned image', () => {
    const compose = readFileSync(
      join(FIXTURE_DIR, 'compose/townhouse-hs.yml'),
      'utf-8'
    );
    expect(compose).toContain('mill:');
    expect(compose).toMatch(
      /ghcr\.io\/toon-protocol\/mill@sha256:[0-9a-f]{64}/
    );
  });

  it('direct compose template defines a mill service with a digest-pinned image', () => {
    const compose = readFileSync(
      join(FIXTURE_DIR, 'compose/townhouse-direct.yml'),
      'utf-8'
    );
    expect(compose).toContain('mill:');
    expect(compose).toMatch(
      /ghcr\.io\/toon-protocol\/mill@sha256:[0-9a-f]{64}/
    );
  });
});
