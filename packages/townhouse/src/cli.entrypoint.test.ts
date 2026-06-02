/**
 * Regression test for the entrypoint self-invoke guard.
 *
 * npm/npx install the `townhouse` bin as a SYMLINK
 * (node_modules/.bin/townhouse -> ../@toon-protocol/townhouse/dist/cli.js).
 * When launched, process.argv[1] is the symlink path while import.meta.url is
 * the realpath of dist/cli.js. If the guard compares them without resolving
 * symlinks, `invokedDirectly` is false under npx / an installed bin, main()
 * never runs, and EVERY command silently no-ops with exit 0 — i.e. the
 * published package does nothing for the primary `npx @toon-protocol/townhouse`
 * use case. This reproduces the symlink launch and asserts main() executes.
 *
 * Requires a built dist/cli.js (skipped otherwise). Runs no Docker.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CLI_JS = join(__dirname, '..', 'dist', 'cli.js');

const built = existsSync(CLI_JS);

describe.skipIf(!built)('cli entrypoint (symlink invocation)', () => {
  let tmp: string;
  let link: string;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'townhouse-bin-'));
    link = join(tmp, 'townhouse');
    // Mimic node_modules/.bin/townhouse -> dist/cli.js
    symlinkSync(CLI_JS, link);
  });

  afterAll(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('runs main() when launched through a bin symlink (--help prints usage)', () => {
    const out = execFileSync('node', [link, '--help'], {
      encoding: 'utf-8',
      timeout: 30_000,
    });
    // If the guard regressed, main() never runs and stdout is empty.
    expect(out).toContain('TOON node orchestrator');
  });
});
