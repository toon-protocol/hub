import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = join(__dirname, '..', 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as Record<
  string,
  unknown
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

  it('does not have workspace:* in dependencies', () => {
    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    if (deps) {
      for (const [, version] of Object.entries(deps)) {
        expect(version).not.toContain('workspace:');
      }
    }
  });

  it('does not depend on @toon-protocol/core or @toon-protocol/sdk', () => {
    const deps = pkg['dependencies'] as Record<string, string> | undefined;
    if (deps) {
      expect(deps['@toon-protocol/core']).toBeUndefined();
      expect(deps['@toon-protocol/sdk']).toBeUndefined();
    }
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
});
