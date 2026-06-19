/**
 * Connector version alignment guard.
 *
 * Asserts that DEFAULT_CONNECTOR_IMAGE is a well-formed digest-pinned reference
 * and that DEFAULT_CONNECTOR_TAG is a valid semver string. When
 * .github/workflows/publish-townhouse-images.yml exists, also asserts that its
 * CONNECTOR_VERSION_DEFAULT env matches DEFAULT_CONNECTOR_TAG so a human who
 * bumps one but not the other fails CI before a release ships.
 *
 * See constants.ts for the full bump checklist and the historical incident that
 * motivated this guard (PR #165 drifted constants.ts to 3.10.3 while leaving
 * the workflow env at 3.10.0, silently breaking v0.17.4 and v0.17.5 publishes).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONNECTOR_IMAGE, DEFAULT_CONNECTOR_TAG } from './constants.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PUBLISH_WORKFLOW_PATH = join(
  __dirname,
  '../../../.github/workflows/publish-townhouse-images.yml'
);

describe('connector version alignment', () => {
  it('DEFAULT_CONNECTOR_IMAGE is digest-pinned to ghcr.io/toon-protocol/connector', () => {
    expect(DEFAULT_CONNECTOR_IMAGE).toMatch(
      /^ghcr\.io\/toon-protocol\/connector@sha256:[0-9a-f]{64}$/
    );
  });

  it('DEFAULT_CONNECTOR_TAG is a semver string', () => {
    expect(DEFAULT_CONNECTOR_TAG).toMatch(
      /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.]+)?(?:\+[A-Za-z0-9.]+)?$/
    );
  });

  it.skipIf(!existsSync(PUBLISH_WORKFLOW_PATH))(
    'CONNECTOR_VERSION_DEFAULT in publish-townhouse-images.yml matches DEFAULT_CONNECTOR_TAG',
    () => {
      const workflow = readFileSync(PUBLISH_WORKFLOW_PATH, 'utf-8');
      const match = workflow.match(
        /CONNECTOR_VERSION_DEFAULT:\s*['"]?([^\s'"#]+)['"]?/
      );
      expect(
        match,
        `publish-townhouse-images.yml must define CONNECTOR_VERSION_DEFAULT — no match found`
      ).not.toBeNull();
      expect(match?.[1]).toBe(DEFAULT_CONNECTOR_TAG);
    }
  );
});
