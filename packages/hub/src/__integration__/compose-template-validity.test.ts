/**
 * Integration test: validates the rendered HS compose template via `docker compose config`.
 *
 * Requirements checked:
 *   - All five services present (connector, hub-api, town, mill, dvm)
 *   - Every services.<name>.image uses digest form (@sha256:<64hex>)
 *   - No `build:` directives in the services section
 *   - Every host-side port binding uses 127.0.0.1: prefix (NFR9)
 *
 * Gated on DOCKER_AVAILABLE env var (default '1' when docker binary is present).
 * Skipped entirely when DOCKER_AVAILABLE is set to anything other than '1'.
 *
 * The test reads from packages/hub/dist/compose/hub-hs.yml —
 * run `pnpm --filter @toon-protocol/hub build` and then place
 * dist/image-manifest.json (from CI artifact or scripts/build-image-manifest.mjs)
 * before running this test to get a fully-substituted template.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve the dist/compose/hub-hs.yml from this integration test location.
// This file lives at packages/hub/src/__integration__/*.test.ts,
// so packages/hub is two levels up.
const PKG_DIR = join(__dirname, '..', '..');
const RENDERED_HS_PATH = join(PKG_DIR, 'dist', 'compose', 'hub-hs.yml');

function isDockerAvailable(): boolean {
  if (process.env['DOCKER_AVAILABLE'] === '0') return false;
  if (process.env['DOCKER_AVAILABLE'] === '1') return true;
  // Auto-detect: check if docker binary exists and responds
  try {
    execSync('docker info --format "{{.ID}}"', {
      stdio: 'ignore',
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = isDockerAvailable();
const renderedHsExists = existsSync(RENDERED_HS_PATH);

describe.skipIf(!renderedHsExists)(
  'compose-template-validity (dist/compose/hub-hs.yml)',
  () => {
    let renderedYaml: string;

    beforeAll(() => {
      renderedYaml = readFileSync(RENDERED_HS_PATH, 'utf-8');
    });

    it('rendered HS template has no unsubstituted digest placeholders', () => {
      expect(renderedYaml).not.toMatch(/\$\{TOON_[A-Z_]+_DIGEST\}/);
    });

    it('every services.<name>.image uses digest form (@sha256:<64hex>)', () => {
      // Extract all image: lines and verify each uses @sha256: form
      const imageLines = renderedYaml
        .split('\n')
        .filter((line) => /^\s+image:\s/.test(line));
      expect(imageLines.length).toBeGreaterThan(0);
      for (const line of imageLines) {
        expect(
          line,
          `image line should use @sha256: form: ${line.trim()}`
        ).toMatch(/@sha256:[a-f0-9]{64}/);
      }
    });

    it('no build: directives appear in the rendered template', () => {
      // Match `build:` as a YAML key (indented or at root), not in comments
      const nonCommentLines = renderedYaml
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'));
      const buildLines = nonCommentLines.filter((line) =>
        /^\s+build:/.test(line)
      );
      expect(buildLines).toHaveLength(0);
    });

    it('every host-side port binding uses 127.0.0.1: prefix (NFR9)', () => {
      // Explicit reject: no `0.0.0.0:` anywhere in the file (Task 2.7 / 8.2).
      // Catches stray non-port bindings (e.g. expose entries, long-form `host_ip`)
      // that the line-by-line port-mapping regex below would miss.
      expect(
        renderedYaml,
        'rendered HS template must not bind 0.0.0.0'
      ).not.toMatch(/\b0\.0\.0\.0:/);

      // Then the structured per-line check on short-form `- 'host:container'` mappings.
      const allPortMappings = renderedYaml
        .split('\n')
        .filter((line) =>
          /^\s+-\s+['"]?\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:|^\s+-\s+['"]?\d+:\d+/.test(
            line
          )
        );

      for (const line of allPortMappings) {
        const clean = line.trim().replace(/^-\s*/, '').replace(/['"]/g, '');
        // If it contains a colon (host:container mapping), check host side
        if (clean.includes(':')) {
          // Accept 127.0.0.1:<port>:<port> form
          expect(
            clean,
            `Port binding must use 127.0.0.1: prefix (NFR9): ${clean}`
          ).toMatch(/^127\.0\.0\.1:/);
        }
      }
    });

    it.skipIf(!dockerAvailable)(
      'docker compose config validates the rendered HS template',
      () => {
        let stdout: string;
        try {
          // Use --profile flags so profiled services (town, mill, dvm) appear in config output.
          // Docker Compose v5+ requires explicit --profile to include profile-restricted services.
          stdout = execFileSync(
            'docker',
            [
              'compose',
              '-f',
              RENDERED_HS_PATH,
              '--profile',
              'town',
              '--profile',
              'mill',
              '--profile',
              'dvm',
              'config',
            ],
            {
              encoding: 'utf-8',
              timeout: 30_000,
              env: {
                ...process.env,
                TOWNHOUSE_WALLET_PASSWORD: 'compose-config-validation-only',
              },
            }
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`docker compose config failed: ${msg}`);
        }

        // All five services should appear in the validated config
        const expectedServices = [
          'connector',
          'hub-api',
          'town',
          'mill',
          'dvm',
        ];
        for (const svc of expectedServices) {
          expect(
            stdout,
            `service '${svc}' should be in docker compose config output`
          ).toContain(svc);
        }
      },
      30_000
    );

    it.skipIf(!dockerAvailable)(
      'docker compose config output has no build: directives for any service',
      () => {
        const stdout = execFileSync(
          'docker',
          [
            'compose',
            '-f',
            RENDERED_HS_PATH,
            '--profile',
            'town',
            '--profile',
            'mill',
            '--profile',
            'dvm',
            'config',
          ],
          {
            encoding: 'utf-8',
            timeout: 30_000,
            env: {
              ...process.env,
              TOWNHOUSE_WALLET_PASSWORD: 'compose-config-validation-only',
            },
          }
        );
        // In the resolved config output, no service should have a build key
        expect(stdout).not.toMatch(/^\s+build:/m);
      },
      30_000
    );

    // R2-MINOR fix: negative-path test that locks in the `${VAR:?}` semantic.
    // If a future patch silently changes ':?' to ':-', this test fails because
    // the unset password no longer triggers a compose-config error.
    it.skipIf(!dockerAvailable)(
      'docker compose config FAILS when TOWNHOUSE_WALLET_PASSWORD is unset (locks in ${VAR:?} semantic)',
      () => {
        const env = { ...process.env };
        delete env['TOWNHOUSE_WALLET_PASSWORD'];
        let exitCode = 0;
        try {
          execFileSync(
            'docker',
            ['compose', '-f', RENDERED_HS_PATH, 'config'],
            { encoding: 'utf-8', timeout: 30_000, env }
          );
        } catch (err) {
          exitCode = (err as { status?: number }).status ?? 1;
        }
        expect(
          exitCode,
          'compose config must fail when password is unset'
        ).not.toBe(0);
      },
      30_000
    );
  }
);

describe.skipIf(renderedHsExists)(
  'compose-template-validity (SKIPPED — dist/compose/hub-hs.yml not present)',
  () => {
    // ctx.skip() emits a real "skipped" status in vitest reporters. An empty
    // body would have been reported as "passed" (green) instead, hiding the
    // missing-precondition signal in CI output.
    it.skip('skipped: run pnpm build + place image-manifest.json first', () => {
      // This block exists to surface a visible "skipped" entry in CI output
      // when the rendered HS template hasn't been produced yet.
    });
  }
);
