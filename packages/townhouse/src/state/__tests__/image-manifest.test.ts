/**
 * Image manifest schema + reader tests (Story 46.2, Task 2.2).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readImageManifest, ImageManifestSchema } from '../image-manifest.js';

const FIXTURE_PATH = join(
  __dirname,
  '../../__tests__/fixtures/compose-loader/image-manifest.json'
);

describe('ImageManifestSchema', () => {
  it('parses the valid fixture successfully', async () => {
    const manifest = await readImageManifest(FIXTURE_PATH);
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.images.town.name).toBe('ghcr.io/toon-protocol/town');
    expect(manifest.images.mill.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(manifest.images.connector.tag).toBe('3.4.1');
  });

  it('rejects when a required images.<type> field is missing', () => {
    const result = ImageManifestSchema.safeParse({
      schemaVersion: 1,
      townhouseVersion: '0.0.1',
      builtAt: '2026-05-01T00:00:00.000Z',
      images: {
        'townhouse-api': {
          name: 'ghcr.io/toon-protocol/townhouse-api',
          tag: '0.0.1',
          digest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        town: {
          name: 'ghcr.io/toon-protocol/town',
          tag: '0.0.1',
          digest:
            'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
        // mill, dvm, connector intentionally omitted
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bad digest format (sha512 prefix)', () => {
    const result = ImageManifestSchema.safeParse({
      schemaVersion: 1,
      townhouseVersion: '0.0.1',
      builtAt: '2026-05-01T00:00:00.000Z',
      images: {
        'townhouse-api': {
          name: 'x',
          tag: 'v1',
          digest: 'sha512:' + 'a'.repeat(64),
        },
        town: { name: 'x', tag: 'v1', digest: 'sha512:' + 'a'.repeat(64) },
        mill: { name: 'x', tag: 'v1', digest: 'sha512:' + 'a'.repeat(64) },
        dvm: { name: 'x', tag: 'v1', digest: 'sha512:' + 'a'.repeat(64) },
        connector: {
          name: 'x',
          tag: 'v1',
          digest: 'sha512:' + 'a'.repeat(64),
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a bad digest format (plain hex without sha256:)', () => {
    const bad = 'a'.repeat(64); // no sha256: prefix
    const result = ImageManifestSchema.safeParse({
      schemaVersion: 1,
      townhouseVersion: '0.0.1',
      builtAt: '2026-05-01T00:00:00.000Z',
      images: {
        'townhouse-api': { name: 'x', tag: 'v1', digest: bad },
        town: { name: 'x', tag: 'v1', digest: bad },
        mill: { name: 'x', tag: 'v1', digest: bad },
        dvm: { name: 'x', tag: 'v1', digest: bad },
        connector: { name: 'x', tag: 'v1', digest: bad },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown top-level key (strict)', () => {
    const result = ImageManifestSchema.safeParse({
      schemaVersion: 1,
      townhouseVersion: '0.0.1',
      builtAt: '2026-05-01T00:00:00.000Z',
      weirdField: 'should-be-rejected',
      images: {
        'townhouse-api': {
          name: 'x',
          tag: 'v1',
          digest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        town: {
          name: 'x',
          tag: 'v1',
          digest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        mill: {
          name: 'x',
          tag: 'v1',
          digest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        dvm: {
          name: 'x',
          tag: 'v1',
          digest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
        connector: {
          name: 'x',
          tag: 'v1',
          digest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      // zod strict() emits an 'unrecognized_keys' issue at the root path;
      // the key name appears in the message rather than the path array.
      const issue = result.error.issues[0];
      expect(issue?.code).toBe('unrecognized_keys');
      const msg = issue?.message ?? '';
      expect(msg).toContain('weirdField');
    }
  });
});

describe('readImageManifest', () => {
  it('throws ENOENT for a missing file', async () => {
    await expect(
      readImageManifest('/nonexistent/path/image-manifest.json')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
