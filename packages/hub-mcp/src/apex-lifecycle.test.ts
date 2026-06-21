import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUpStatus, autoUpIfEnabled, upLogPath } from './apex-lifecycle.js';
import type { ResolvedConfig } from './config.js';
import type { ApiClient } from './api-client.js';

let dir: string;

function cfg(over: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    apiUrl: 'http://127.0.0.1:9400',
    configDir: dir,
    hubBin: 'hub',
    autoUp: true,
    transport: 'direct',
    ...over,
  };
}

function fakeApi(reachable: boolean): ApiClient {
  return { ping: vi.fn(async () => reachable) } as unknown as ApiClient;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'thmcp-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('readUpStatus', () => {
  it('returns an empty, not-done status when no log exists', () => {
    expect(readUpStatus(cfg())).toEqual({
      events: [],
      done: false,
      failed: false,
    });
  });

  it('parses NDJSON and skips a trailing partial line', () => {
    writeFileSync(
      upLogPath(cfg()),
      '{"step":"pulling"}\n{"step":"starting"}\n{"step":"partia'
    );
    const s = readUpStatus(cfg());
    expect(s.events).toHaveLength(2);
    expect(s.done).toBe(false);
  });

  it('marks done on a terminal `done` step', () => {
    writeFileSync(upLogPath(cfg()), '{"step":"starting"}\n{"step":"done"}');
    expect(readUpStatus(cfg())).toMatchObject({ done: true, failed: false });
  });

  it('marks done+failed on a terminal `error` step', () => {
    writeFileSync(upLogPath(cfg()), '{"step":"pulling"}\n{"step":"error"}');
    expect(readUpStatus(cfg())).toMatchObject({ done: true, failed: true });
  });
});

describe('autoUpIfEnabled (early-return guards — never spawns)', () => {
  it('does nothing when autoUp is disabled', async () => {
    await autoUpIfEnabled(fakeApi(false), cfg({ autoUp: false }));
    expect(existsSync(upLogPath(cfg()))).toBe(false);
  });

  it('does nothing when the apex is already reachable', async () => {
    const api = fakeApi(true);
    await autoUpIfEnabled(api, cfg());
    expect(api.ping).toHaveBeenCalled();
    expect(existsSync(upLogPath(cfg()))).toBe(false);
  });

  it('does not re-spawn while an up is already in flight', async () => {
    // An unfinished up.log => an up is running; guard must early-return.
    writeFileSync(upLogPath(cfg()), '{"step":"pulling"}\n');
    await autoUpIfEnabled(fakeApi(false), cfg());
    // Log left untouched (no second boot appended a terminal step).
    expect(readUpStatus(cfg()).done).toBe(false);
    expect(readFileSync(upLogPath(cfg()), 'utf8')).toBe('{"step":"pulling"}\n');
  });
});
