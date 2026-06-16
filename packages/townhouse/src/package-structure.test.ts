import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { DEFAULT_CONNECTOR_IMAGE } from './constants.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<
  string,
  unknown
>;

/** Load and parse docker-compose-townhouse.yml from project root */
const composePath = join(
  __dirname,
  '..',
  '..',
  '..',
  'docker-compose-townhouse.yml'
);
const composeYaml = parse(readFileSync(composePath, 'utf-8')) as Record<
  string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  any
>;

describe('package.json structure', () => {
  it('has type: "module"', () => {
    expect(pkg['type']).toBe('module');
  });

  it('has correct exports map', () => {
    const exports = pkg['exports'] as Record<string, unknown>;
    expect(exports).toBeDefined();
    const dot = exports['.'] as Record<string, unknown>;
    expect(dot['types']).toBe('./dist/index.d.ts');
    expect(dot['import']).toBe('./dist/index.js');
  });

  it('has bin entry for townhouse', () => {
    const bin = pkg['bin'] as Record<string, unknown>;
    expect(bin).toBeDefined();
    expect(bin['townhouse']).toBe('./dist/cli.js');
  });

  it('has engines >= 20', () => {
    const engines = pkg['engines'] as Record<string, unknown>;
    expect(engines).toBeDefined();
    expect(engines['node']).toBe('>=20');
  });

  it('has files: ["dist"]', () => {
    const files = pkg['files'] as string[];
    expect(files).toEqual(['dist']);
  });

  it('does not have workspace:* (wildcard) in dependencies', () => {
    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    if (deps) {
      for (const [, version] of Object.entries(deps)) {
        // workspace:^ and workspace:~  are fine (pinned semver range);
        // workspace:* is disallowed (matches any version — too loose).
        expect(version).not.toBe('workspace:*');
      }
    }
  });

  it('has NO @toon-protocol/* runtime dependencies (they ship as Docker images / are inlined)', () => {
    // town/mill/dvm are Docker-image node types, not npm packages; sdk/core are
    // inlined where needed. A runtime dep on any of them would (a) bloat the
    // install and (b) 404 at `npx @toon-protocol/hub` if that package was
    // never published to npm — exactly the v0.1.0 mill regression this guards.
    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    const toonRuntimeDeps = Object.keys(deps ?? {}).filter((name) =>
      name.startsWith('@toon-protocol/')
    );
    expect(toonRuntimeDeps).toEqual([]);
  });

  it('has required dependencies: yaml, dockerode', () => {
    const deps = pkg['dependencies'] as Record<string, string>;
    expect(deps['yaml']).toBeDefined();
    expect(deps['dockerode']).toBeDefined();
  });

  it('has publishConfig.access = "public"', () => {
    const publishConfig = pkg['publishConfig'] as Record<string, unknown>;
    expect(publishConfig).toBeDefined();
    expect(publishConfig['access']).toBe('public');
  });

  it('built dist/*.js contains no bare @toon-protocol/* runtime import (deriveMillKeys must be inlined)', () => {
    // Runs only when dist/ exists (post-build). tsup `noExternal` must inline
    // `@toon-protocol/mill/wallet`; if it leaks back to an external import, the
    // published tarball would 404 against an unpublished package at install.
    const distDir = join(__dirname, '..', 'dist');
    let jsFiles: string[];
    try {
      jsFiles = readdirSync(distDir).filter((f) => f.endsWith('.js'));
    } catch {
      return; // dist not built in this run — covered by the CI build job
    }
    for (const f of jsFiles) {
      const src = readFileSync(join(distDir, f), 'utf-8');
      expect(
        /from\s+["']@toon-protocol\//.test(src),
        `${f} has an unbundled @toon-protocol/* import`
      ).toBe(false);
    }
  });
});

// ── AC #2: docker-compose-townhouse.yml structure validation ──

describe('docker-compose-townhouse.yml (AC #2)', () => {
  it('defines townhouse-net bridge network', () => {
    expect(composeYaml['networks']).toBeDefined();
    expect(composeYaml['networks']['townhouse-net']).toBeDefined();
    expect(composeYaml['networks']['townhouse-net']['driver']).toBe('bridge');
  });

  it('defines connector service without profile restriction (always runs)', () => {
    const connector = composeYaml['services']['connector'];
    expect(connector).toBeDefined();
    // Connector must NOT have profiles — it always starts
    expect(connector['profiles']).toBeUndefined();
  });

  it('connector service uses ghcr.io/toon-protocol/connector image (AC #3)', () => {
    const connector = composeYaml['services']['connector'];
    expect(connector['image']).toBe(DEFAULT_CONNECTOR_IMAGE);
  });

  it('connector has container_name townhouse-connector', () => {
    const connector = composeYaml['services']['connector'];
    expect(connector['container_name']).toBe('townhouse-connector');
  });

  it('connector has healthcheck defined', () => {
    const connector = composeYaml['services']['connector'];
    expect(connector['healthcheck']).toBeDefined();
    expect(connector['healthcheck']['test']).toBeDefined();
  });

  it('connector is attached to townhouse-net network', () => {
    const connector = composeYaml['services']['connector'];
    expect(connector['networks']).toContain('townhouse-net');
  });

  for (const nodeType of ['town', 'mill', 'dvm'] as const) {
    describe(`${nodeType} service`, () => {
      it(`has profile: [${nodeType}]`, () => {
        const service = composeYaml['services'][nodeType];
        expect(service).toBeDefined();
        expect(service['profiles']).toContain(nodeType);
      });

      it(`has container_name townhouse-${nodeType}`, () => {
        const service = composeYaml['services'][nodeType];
        expect(service['container_name']).toBe(`townhouse-${nodeType}`);
      });

      it('depends on connector with service_healthy condition', () => {
        const service = composeYaml['services'][nodeType];
        expect(service['depends_on']).toBeDefined();
        expect(service['depends_on']['connector']).toBeDefined();
        expect(service['depends_on']['connector']['condition']).toBe(
          'service_healthy'
        );
      });

      it('is attached to townhouse-net network', () => {
        const service = composeYaml['services'][nodeType];
        expect(service['networks']).toContain('townhouse-net');
      });

      it('has CONNECTOR_URL environment variable', () => {
        const service = composeYaml['services'][nodeType];
        expect(service['environment']).toBeDefined();
        expect(service['environment']['CONNECTOR_URL']).toContain(
          'townhouse-connector'
        );
      });
    });
  }

  it('has exactly 4 services: connector, town, mill, dvm', () => {
    const serviceNames = Object.keys(
      composeYaml['services'] as Record<string, unknown>
    );
    expect(serviceNames.sort()).toEqual(['connector', 'dvm', 'mill', 'town']);
  });
});
