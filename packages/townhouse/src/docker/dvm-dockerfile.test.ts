/**
 * DVM image configuration guard.
 *
 * Originally checked docker/Dockerfile.dvm (removed during the CI fix).
 * Rewritten against the current structure: verifies that the dvm service is
 * correctly defined in the fixture image-manifest and compose templates, so an
 * accidental rename or removal of the dvm image or service fails CI.
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

describe('dvm image configuration', () => {
  it('fixture image-manifest has a dvm entry named ghcr.io/toon-protocol/dvm', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'image-manifest.json'), 'utf-8')
    ) as Record<string, unknown>;
    const images = manifest['images'] as Record<
      string,
      { name: string; tag: string; digest: string }
    >;
    expect(images['dvm']).toBeDefined();
    expect(images['dvm']!.name).toBe('ghcr.io/toon-protocol/dvm');
  });

  it('fixture image-manifest dvm digest is sha256-pinned', () => {
    const manifest = JSON.parse(
      readFileSync(join(FIXTURE_DIR, 'image-manifest.json'), 'utf-8')
    ) as Record<string, unknown>;
    const images = manifest['images'] as Record<
      string,
      { name: string; tag: string; digest: string }
    >;
    expect(images['dvm']!.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('HS compose template defines a dvm service with a digest-pinned image', () => {
    const compose = readFileSync(
      join(FIXTURE_DIR, 'compose/townhouse-hs.yml'),
      'utf-8'
    );
    expect(compose).toContain('dvm:');
    expect(compose).toMatch(
      /ghcr\.io\/toon-protocol\/dvm@sha256:[0-9a-f]{64}/
    );
  });

  it('direct compose template defines a dvm service with a digest-pinned image', () => {
    const compose = readFileSync(
      join(FIXTURE_DIR, 'compose/townhouse-direct.yml'),
      'utf-8'
    );
    expect(compose).toContain('dvm:');
    expect(compose).toMatch(
      /ghcr\.io\/toon-protocol\/dvm@sha256:[0-9a-f]{64}/
    );
  });
});
