/**
 * Image manifest schema + reader tests (Story 46.2, Task 2.2).
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import {
  readImageManifest,
  ImageManifestSchema,
  SYNTHETIC_DIGEST_SENTINEL,
  isSyntheticDigest,
} from '../image-manifest.js';

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
      hubVersion: '0.0.1',
      builtAt: '2026-05-01T00:00:00.000Z',
      images: {
        'hub-api': {
          name: 'ghcr.io/toon-protocol/hub-api',
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
      hubVersion: '0.0.1',
      builtAt: '2026-05-01T00:00:00.000Z',
      images: {
        'hub-api': {
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
      hubVersion: '0.0.1',
      builtAt: '2026-05-01T00:00:00.000Z',
      images: {
        'hub-api': { name: 'x', tag: 'v1', digest: bad },
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
      hubVersion: '0.0.1',
      builtAt: '2026-05-01T00:00:00.000Z',
      weirdField: 'should-be-rejected',
      images: {
        'hub-api': {
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

// Story 50.0 review #9 — the synthetic-digest sentinel is duplicated as a
// YAML literal in `.github/workflows/connector-publish-smoke.yml` because GHA
// cannot import TypeScript at workflow scope. Without this test a future bump
// of the TS constant would silently desync from YAML, breaking the smoke
// workflow's synthetic-manifest path on a future per-image alignment check
// that consults isSyntheticDigest().
describe('SYNTHETIC_DIGEST_SENTINEL', () => {
  const WORKFLOW_PATH = join(
    __dirname,
    '../../../../../.github/workflows/connector-publish-smoke.yml'
  );
  // Story 50.0 review P8 — the sentinel has a THIRD sync site: a bash literal
  // in scripts/rerun-earnings-gate.sh consumed by the drift guard's
  // SYNTHETIC_DIGEST_SENTINEL bash variable. Without this arm a future rename
  // would silently desync the gate-rerun script.
  const RERUN_SCRIPT_PATH = join(
    __dirname,
    '../../../../../scripts/rerun-earnings-gate.sh'
  );

  it('isSyntheticDigest() recognizes the exported constant', () => {
    expect(isSyntheticDigest(SYNTHETIC_DIGEST_SENTINEL)).toBe(true);
    expect(
      isSyntheticDigest('sha256:' + 'a'.repeat(64)),
      'random digest must not be misclassified as synthetic'
    ).toBe(false);
  });

  it.skipIf(!existsSync(WORKFLOW_PATH))(
    'matches the literal hardcoded in connector-publish-smoke.yml',
    () => {
      const workflowSource = readFileSync(WORKFLOW_PATH, 'utf-8');
      // The workflow defines:
      //   SYNTHETIC_DIGEST: 'sha256:dead000…'
      // The match below intentionally requires the SYNTHETIC_DIGEST key name so
      // we don't accidentally match the sentinel inside a comment.
      const match = workflowSource.match(
        /SYNTHETIC_DIGEST:\s*['"](sha256:[a-f0-9]{64})['"]/
      );
      expect(
        match,
        `connector-publish-smoke.yml must define SYNTHETIC_DIGEST: 'sha256:<64hex>' — got no match at ${WORKFLOW_PATH}`
      ).not.toBeNull();
      expect(match?.[1]).toBe(SYNTHETIC_DIGEST_SENTINEL);
    }
  );

  it.skipIf(!existsSync(RERUN_SCRIPT_PATH))(
    'matches the bash literal in scripts/rerun-earnings-gate.sh',
    () => {
      const rerunSource = readFileSync(RERUN_SCRIPT_PATH, 'utf-8');
      // The script defines:
      //   SYNTHETIC_DIGEST_SENTINEL="sha256:dead000…"
      // Require the variable-name anchor so we don't accidentally match the
      // sentinel inside a comment.
      const match = rerunSource.match(
        /SYNTHETIC_DIGEST_SENTINEL=["'](sha256:[a-f0-9]{64})["']/
      );
      expect(
        match,
        `rerun-earnings-gate.sh must define SYNTHETIC_DIGEST_SENTINEL="sha256:<64hex>" — got no match at ${RERUN_SCRIPT_PATH}`
      ).not.toBeNull();
      expect(match?.[1]).toBe(SYNTHETIC_DIGEST_SENTINEL);
    }
  );
});

describe('readImageManifest', () => {
  it('throws ENOENT for a missing file', async () => {
    await expect(
      readImageManifest('/nonexistent/path/image-manifest.json')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
