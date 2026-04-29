#!/usr/bin/env node
/**
 * dev:docker orchestrator (AC-7).
 * 1. Asserts .env.townhouse-dev exists (clear error if absent).
 * 2. Spawns Fastify API (port 9400) + Vite dev server (port 5173) via concurrently.
 * Both processes shut down cleanly on Ctrl+C (--kill-others).
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(__dirname, '..');
const repoRoot = resolve(pkgRoot, '..', '..');
const envFile = join(repoRoot, '.env.townhouse-dev');

if (!existsSync(envFile)) {
  console.error(
    '\n[townhouse-web] Error: .env.townhouse-dev not found at:\n' +
    `  ${envFile}\n\n` +
    'Run `./scripts/townhouse-dev-infra.sh up` first.\n'
  );
  process.exit(1);
}

const concurrently = resolve(pkgRoot, 'node_modules', '.bin', 'concurrently');

if (!existsSync(concurrently)) {
  console.error(
    '\n[townhouse-web] Error: concurrently binary not found at:\n' +
    `  ${concurrently}\n\n` +
    'Run `pnpm install` first.\n'
  );
  process.exit(1);
}

const apiServerScript = join(pkgRoot, 'scripts', 'api-server.mjs');

// Use shell:false with explicit args so paths with spaces or shell metacharacters
// don't fragment. concurrently itself parses each command arg through its own shell.
const proc = spawn(
  concurrently,
  [
    '--kill-others',
    '--names', 'api,vite',
    '--prefix-colors', 'blue,cyan',
    `dotenv -e "${envFile}" -- node "${apiServerScript}"`,
    'vite --port 5173',
  ],
  {
    stdio: 'inherit',
    cwd: pkgRoot,
  }
);

proc.on('error', (err) => {
  console.error('[townhouse-web] failed to spawn concurrently:', err);
  process.exit(1);
});

const forwardSignal = (sig) => () => {
  if (!proc.killed) proc.kill(sig);
};
process.on('SIGINT', forwardSignal('SIGINT'));
process.on('SIGTERM', forwardSignal('SIGTERM'));

proc.on('exit', (code, signal) => {
  if (signal) process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1));
  process.exit(code ?? 0);
});
