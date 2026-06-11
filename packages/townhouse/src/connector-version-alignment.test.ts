/**
 * Source-level connector-version alignment guard (network-free).
 *
 * Catches the human drift that broke the v0.17.4 / v0.17.5 publishes: PR #165
 * bumped `packages/townhouse/src/constants.ts` to connector 3.10.3 but left
 * `.github/workflows/publish-townhouse-images.yml`'s
 * `env.CONNECTOR_VERSION_DEFAULT` at 3.10.0. The two drifted, the workflow's
 * preflight `docker buildx imagetools inspect` hard-failed, and TWO consecutive
 * releases silently published NO images.
 *
 * This test runs in normal CI (no network, no Docker). It asserts:
 *   (a) the workflow's `CONNECTOR_VERSION_DEFAULT` env equals
 *       `DEFAULT_CONNECTOR_TAG` in constants.ts, and
 *   (b) `DEFAULT_CONNECTOR_IMAGE` is a well-formed digest-pinned ghcr ref.
 *
 * The live tag↔digest resolution stays in the workflow's preflight job; this
 * guard only catches the SOURCE-level lockstep drift, at PR time, before a
 * release.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { DEFAULT_CONNECTOR_IMAGE, DEFAULT_CONNECTOR_TAG } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Walk up from packages/townhouse/src to the repo root, then into .github.
// (src) → townhouse → packages → repo-root
const workflowPath = join(
  __dirname,
  '..',
  '..',
  '..',
  '.github',
  'workflows',
  'publish-townhouse-images.yml'
);

describe('connector version alignment (source-level guard)', () => {
  it('workflow CONNECTOR_VERSION_DEFAULT equals constants.ts DEFAULT_CONNECTOR_TAG', () => {
    const workflowSrc = readFileSync(workflowPath, 'utf-8');
    const workflow = parse(workflowSrc) as {
      env?: Record<string, unknown>;
    };

    const workflowTag = workflow.env?.['CONNECTOR_VERSION_DEFAULT'];

    expect(
      workflowTag,
      'publish-townhouse-images.yml must define env.CONNECTOR_VERSION_DEFAULT'
    ).toBeDefined();

    // String() so a YAML-numeric value (e.g. an accidental unquoted 3.10) is
    // compared as a string and still produces a clear mismatch message rather
    // than a type confusion.
    expect(
      String(workflowTag),
      `workflow CONNECTOR_VERSION_DEFAULT=${String(workflowTag)} but ` +
        `constants.ts DEFAULT_CONNECTOR_TAG=${DEFAULT_CONNECTOR_TAG} — ` +
        `bump both together (and the @sha256 digest in DEFAULT_CONNECTOR_IMAGE).`
    ).toBe(DEFAULT_CONNECTOR_TAG);
  });

  it('DEFAULT_CONNECTOR_IMAGE is a well-formed ghcr connector digest ref', () => {
    expect(
      DEFAULT_CONNECTOR_IMAGE,
      `DEFAULT_CONNECTOR_IMAGE=${DEFAULT_CONNECTOR_IMAGE} must be ` +
        `'ghcr.io/toon-protocol/connector@sha256:<64 lowercase hex>'`
    ).toMatch(/^ghcr\.io\/toon-protocol\/connector@sha256:[a-f0-9]{64}$/);
  });
});
