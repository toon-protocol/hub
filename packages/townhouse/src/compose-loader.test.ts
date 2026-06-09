import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  statSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  loadComposeTemplate,
  materializeComposeTemplate,
  ComposeLoaderError,
} from './compose-loader.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Fixture dir: src/__tests__/fixtures/compose-loader/
// Contains: image-manifest.json + compose/townhouse-{hs,direct,dev}.yml (pre-rendered).
const FIXTURE_DIR = join(__dirname, '__tests__', 'fixtures', 'compose-loader');

describe('loadComposeTemplate', () => {
  it('returns dev template verbatim', () => {
    const yaml = loadComposeTemplate('dev', { distDir: FIXTURE_DIR });
    expect(yaml).toContain('townhouse-dev-net');
    expect(yaml).toContain('ghcr.io/toon-protocol/connector:3.4.1');
  });

  it('returns hs template with five @sha256: substitutions when fixture contains substituted file', () => {
    const yaml = loadComposeTemplate('hs', { distDir: FIXTURE_DIR });
    // Five image lines with @sha256: form
    const sha256Matches = yaml.match(/@sha256:[a-f0-9]{64}/g);
    expect(sha256Matches).toBeTruthy();
    expect(sha256Matches!.length).toBe(5);
    // No unsubstituted placeholders
    expect(yaml).not.toMatch(/\$\{TOON_[A-Z_]+_DIGEST\}/);
  });

  it('throws ComposeLoaderError when template file is missing', () => {
    const missingDir = join(tmpdir(), 'nonexistent-fixture-dir-' + Date.now());
    expect(() =>
      loadComposeTemplate('hs', { distDir: missingDir })
    ).toThrowError(ComposeLoaderError);
  });

  it('thrown ComposeLoaderError contains the missing path', () => {
    const missingDir = '/nonexistent/dist/dir-' + Date.now();
    let thrown: Error | undefined;
    try {
      loadComposeTemplate('hs', { distDir: missingDir });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown).toBeInstanceOf(ComposeLoaderError);
    expect(thrown!.message).toContain(missingDir);
  });
});

describe('materializeComposeTemplate', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'compose-loader-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('writes compose/townhouse-hs.yml AND image-manifest.json to tmpHome', () => {
    const { composePath, manifestPath } = materializeComposeTemplate('hs', {
      distDir: FIXTURE_DIR,
      townhouseHome: tmpHome,
    });
    expect(composePath).toBe(join(tmpHome, 'compose', 'townhouse-hs.yml'));
    expect(manifestPath).toBe(join(tmpHome, 'image-manifest.json'));
    // Files exist
    expect(() => statSync(composePath)).not.toThrow();
    expect(() => statSync(manifestPath)).not.toThrow();
  });

  it('compose file is written with mode 0o600', () => {
    const { composePath } = materializeComposeTemplate('hs', {
      distDir: FIXTURE_DIR,
      townhouseHome: tmpHome,
    });
    const mode = statSync(composePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('manifest file is written with mode 0o600', () => {
    const { manifestPath } = materializeComposeTemplate('hs', {
      distDir: FIXTURE_DIR,
      townhouseHome: tmpHome,
    });
    const mode = statSync(manifestPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('compose dir is created with mode 0o700', () => {
    materializeComposeTemplate('hs', {
      distDir: FIXTURE_DIR,
      townhouseHome: tmpHome,
    });
    const composeDir = join(tmpHome, 'compose');
    const mode = statSync(composeDir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('is idempotent — second call overwrites first, mode stays 0o600, content matches, no errors', () => {
    const opts = { distDir: FIXTURE_DIR, townhouseHome: tmpHome };
    const first = materializeComposeTemplate('hs', opts);
    const firstContent = readFileSync(first.composePath, 'utf-8');
    const firstManifest = readFileSync(first.manifestPath, 'utf-8');
    const second = materializeComposeTemplate('hs', opts);
    expect(first.composePath).toBe(second.composePath);
    expect(first.manifestPath).toBe(second.manifestPath);
    const mode = statSync(second.composePath).mode & 0o777;
    expect(mode).toBe(0o600);
    // R2-MINOR fix: assert content equality, not just path equality.
    // A regression that wrote different bytes (truncated, wrong template,
    // mid-write garbage) would have passed the previous version of this test.
    expect(readFileSync(second.composePath, 'utf-8')).toBe(firstContent);
    expect(readFileSync(second.manifestPath, 'utf-8')).toBe(firstManifest);
  });

  it('throws ComposeLoaderError for hs profile when manifest is absent', () => {
    // Use a fixture dir that has the HS compose but no image-manifest.json.
    const noManifestDir = mkdtempSync(join(tmpdir(), 'no-manifest-hs-'));
    try {
      mkdirSync(join(noManifestDir, 'compose'), { recursive: true });
      copyFileSync(
        join(FIXTURE_DIR, 'compose', 'townhouse-hs.yml'),
        join(noManifestDir, 'compose', 'townhouse-hs.yml')
      );
      expect(() =>
        materializeComposeTemplate('hs', {
          distDir: noManifestDir,
          townhouseHome: tmpHome,
        })
      ).toThrowError(ComposeLoaderError);
    } finally {
      rmSync(noManifestDir, { recursive: true, force: true });
    }
  });

  it('does NOT throw for dev profile when manifest is absent', () => {
    // Use a fixture dir that has the dev compose but no image-manifest.json.
    const noManifestDir = mkdtempSync(join(tmpdir(), 'no-manifest-dev-'));
    try {
      mkdirSync(join(noManifestDir, 'compose'), { recursive: true });
      copyFileSync(
        join(FIXTURE_DIR, 'compose', 'townhouse-dev.yml'),
        join(noManifestDir, 'compose', 'townhouse-dev.yml')
      );
      // dev profile should not throw even with no manifest
      expect(() =>
        materializeComposeTemplate('dev', {
          distDir: noManifestDir,
          townhouseHome: tmpHome,
        })
      ).not.toThrow();
    } finally {
      rmSync(noManifestDir, { recursive: true, force: true });
    }
  });

  it('mode is 0o600 regardless of process umask (chmodSync enforces explicitly)', () => {
    // process.umask() cannot be set in vitest worker threads. The typical default
    // umask is 0o022 (inherited from the parent process), which is already in effect
    // here — so this test verifies that chmodSync enforces 0o600 under that umask.
    const { composePath } = materializeComposeTemplate('hs', {
      distDir: FIXTURE_DIR,
      townhouseHome: tmpHome,
    });
    const mode = statSync(composePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe("'direct' compose profile (Phase 2 direct-apex)", () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'compose-loader-direct-test-'));
  });

  afterEach(() => {
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('loadComposeTemplate accepts the direct profile and returns its YAML', () => {
    const yaml = loadComposeTemplate('direct', { distDir: FIXTURE_DIR });
    expect(yaml).toContain('townhouse-direct-net');
    expect(yaml).toContain('townhouse-direct-connector');
    // KEY difference vs HS: the connector BTP port :3000 is host-exposed.
    expect(yaml).toContain('3000:3000');
    // No HS / anon namespacing leaks into the direct template.
    expect(yaml).not.toContain('townhouse-hs-anon');
  });

  it('direct template carries five @sha256: substitutions like HS', () => {
    const yaml = loadComposeTemplate('direct', { distDir: FIXTURE_DIR });
    const sha256Matches = yaml.match(/@sha256:[a-f0-9]{64}/g);
    expect(sha256Matches).toBeTruthy();
    expect(sha256Matches!.length).toBe(5);
    expect(yaml).not.toMatch(/\$\{TOON_[A-Z_]+_DIGEST\}/);
  });

  it('materializeComposeTemplate writes compose/townhouse-direct.yml', () => {
    const { composePath, manifestPath } = materializeComposeTemplate('direct', {
      distDir: FIXTURE_DIR,
      townhouseHome: tmpHome,
    });
    expect(composePath).toBe(join(tmpHome, 'compose', 'townhouse-direct.yml'));
    expect(() => statSync(composePath)).not.toThrow();
    expect(() => statSync(manifestPath)).not.toThrow();
    const mode = statSync(composePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('requires a manifest just like HS (throws when absent)', () => {
    const noManifestDir = mkdtempSync(join(tmpdir(), 'no-manifest-direct-'));
    try {
      mkdirSync(join(noManifestDir, 'compose'), { recursive: true });
      copyFileSync(
        join(FIXTURE_DIR, 'compose', 'townhouse-direct.yml'),
        join(noManifestDir, 'compose', 'townhouse-direct.yml')
      );
      expect(() =>
        materializeComposeTemplate('direct', {
          distDir: noManifestDir,
          townhouseHome: tmpHome,
        })
      ).toThrowError(ComposeLoaderError);
    } finally {
      rmSync(noManifestDir, { recursive: true, force: true });
    }
  });

  it('rejects an unknown profile', () => {
    expect(() =>
      // @ts-expect-error — intentionally invalid profile
      loadComposeTemplate('bogus', { distDir: FIXTURE_DIR })
    ).toThrowError(ComposeLoaderError);
  });
});
