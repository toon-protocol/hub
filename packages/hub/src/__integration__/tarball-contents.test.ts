/**
 * Integration test: verifies that `pnpm pack` produces a tarball containing
 * the three required artifacts:
 *   - package/dist/compose/hub-hs.yml
 *   - package/dist/compose/hub-dev.yml
 *   - package/dist/image-manifest.json
 *
 * Also asserts the HS YAML in the tarball contains no unsubstituted placeholders
 * and that every image: line uses digest form (@sha256:).
 *
 * Skip conditions:
 *   - SKIP_PACK_TEST=1 : developer explicitly skips (no dist/ rebuild needed)
 *   - dist/image-manifest.json absent at test start : local dev path where
 *     manifest hasn't been placed yet. The tarball-content check for image-manifest.json
 *     is skipped but the compose file assertions still run.
 *
 * In CI: dist/image-manifest.json is placed by the download-artifact step +
 * render step BEFORE this test runs, so all assertions run.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PKG_DIR = join(__dirname, '..', '..');
const DIST_COMPOSE_HS = join(PKG_DIR, 'dist', 'compose', 'hub-hs.yml');
const DIST_COMPOSE_DEV = join(PKG_DIR, 'dist', 'compose', 'hub-dev.yml');
const MANIFEST_PATH = join(PKG_DIR, 'dist', 'image-manifest.json');

const skipPackTest = process.env['SKIP_PACK_TEST'] === '1';
const manifestPresent = existsSync(MANIFEST_PATH);

describe.skipIf(skipPackTest)('tarball-contents', () => {
  let packOutDir: string;
  let extractDir: string;
  let tgzPath: string;

  beforeAll(() => {
    // Precondition: dist/compose/ must already be built. `pnpm pack` packs
    // whatever is in dist/, so a stale or missing build would silently produce
    // a green-but-wrong result. Fail loudly with an actionable message.
    if (!existsSync(DIST_COMPOSE_HS) || !existsSync(DIST_COMPOSE_DEV)) {
      throw new Error(
        `tarball-contents test requires built dist/compose/. Missing:\n` +
          `  ${DIST_COMPOSE_HS} ${existsSync(DIST_COMPOSE_HS) ? '✓' : '✗'}\n` +
          `  ${DIST_COMPOSE_DEV} ${existsSync(DIST_COMPOSE_DEV) ? '✓' : '✗'}\n` +
          `Run 'pnpm --filter @toon-protocol/hub build' first ` +
          `(or set SKIP_PACK_TEST=1 to skip this test).`
      );
    }

    packOutDir = mkdtempSync(join(tmpdir(), 'hub-pack-'));
    extractDir = mkdtempSync(join(tmpdir(), 'hub-extract-'));

    // Run pnpm pack from the package directory. We do NOT parse pnpm's stdout
    // for the tgz path — output format varies across pnpm versions. The tmpdir
    // is created fresh by mkdtempSync, so readdirSync is the authoritative source.
    execFileSync('pnpm', ['pack', '--pack-destination', packOutDir], {
      cwd: PKG_DIR,
      encoding: 'utf-8',
      timeout: 60_000,
    });

    const files = readdirSync(packOutDir).filter((f) => f.endsWith('.tgz'));
    expect(files.length, 'expected exactly one .tgz in pack output dir').toBe(
      1
    );
    tgzPath = join(packOutDir, files[0]!);

    // Extract the tarball
    execFileSync('tar', ['-xzf', tgzPath, '-C', extractDir], {
      timeout: 30_000,
    });
  }, 90_000);

  afterAll(() => {
    if (packOutDir) rmSync(packOutDir, { recursive: true, force: true });
    if (extractDir) rmSync(extractDir, { recursive: true, force: true });
  });

  it('tarball contains package/dist/compose/hub-hs.yml', () => {
    const hsPath = join(
      extractDir,
      'package',
      'dist',
      'compose',
      'hub-hs.yml'
    );
    expect(existsSync(hsPath), `expected ${hsPath} to exist in tarball`).toBe(
      true
    );
  });

  it('tarball contains package/dist/compose/hub-dev.yml', () => {
    const devPath = join(
      extractDir,
      'package',
      'dist',
      'compose',
      'hub-dev.yml'
    );
    expect(existsSync(devPath), `expected ${devPath} to exist in tarball`).toBe(
      true
    );
  });

  it.skipIf(!manifestPresent)(
    'tarball contains package/dist/image-manifest.json (skipped when manifest absent locally)',
    () => {
      const manifestInTarball = join(
        extractDir,
        'package',
        'dist',
        'image-manifest.json'
      );
      expect(
        existsSync(manifestInTarball),
        `expected ${manifestInTarball} to exist in tarball`
      ).toBe(true);
    }
  );

  it('tarball HS YAML has no unsubstituted placeholders', () => {
    const hsPath = join(
      extractDir,
      'package',
      'dist',
      'compose',
      'hub-hs.yml'
    );
    if (!existsSync(hsPath)) return; // covered by previous test
    const content = readFileSync(hsPath, 'utf-8');
    expect(
      content,
      'HS YAML in tarball must not contain unsubstituted placeholders'
    ).not.toMatch(/\$\{TOON_[A-Z_]+_DIGEST\}/);
  });

  it.skipIf(!manifestPresent)(
    'tarball HS YAML has @sha256: digest form for every image: line (skipped when manifest absent)',
    () => {
      const hsPath = join(
        extractDir,
        'package',
        'dist',
        'compose',
        'hub-hs.yml'
      );
      if (!existsSync(hsPath)) return;
      const content = readFileSync(hsPath, 'utf-8');
      const imageLines = content
        .split('\n')
        .filter((l) => /^\s+image:\s/.test(l));
      expect(imageLines.length).toBeGreaterThan(0);
      for (const line of imageLines) {
        expect(
          line,
          `image line must use @sha256: form: ${line.trim()}`
        ).toMatch(/@sha256:[a-f0-9]{64}/);
      }
    }
  );

  it('tarball ships a published, npm-facing README.md', () => {
    const readmePath = join(extractDir, 'package', 'README.md');
    expect(existsSync(readmePath), 'README.md must ship in the tarball').toBe(
      true
    );
    const readme = readFileSync(readmePath, 'utf-8');
    // It is the operator quickstart...
    expect(readme).toContain('npx @toon-protocol/hub init');
    expect(readme).toContain('npx @toon-protocol/hub hs up');
    // ...not the contributor doc. A published-package user has no monorepo, no
    // sibling repos, and no dev-stack script — those instructions would only
    // confuse them, so they must not leak back into the published README.
    expect(
      readme,
      'published README must not contain monorepo-only `pnpm --filter` commands'
    ).not.toMatch(/pnpm --filter/);
    expect(
      readme,
      'published README must not reference sibling repo paths (../)'
    ).not.toContain('../');
    expect(
      readme,
      'published README must not reference the contributor dev-stack script'
    ).not.toContain('hub-dev-infra.sh');
  });

  it('tarball does NOT ship the contributor CONTRIBUTING.md', () => {
    const contribPath = join(extractDir, 'package', 'CONTRIBUTING.md');
    expect(
      existsSync(contribPath),
      'CONTRIBUTING.md is contributor-only and must stay out of the npm tarball'
    ).toBe(false);
  });
});
