import { describe, it, expect } from 'vitest';
import { CliDriver, CliError, type ExecResult } from './cli-driver.js';
import type { ResolvedConfig } from './config.js';

const cfg: ResolvedConfig = {
  apiUrl: 'http://127.0.0.1:9400',
  configDir: '/tmp/th',
  townhouseBin: 'townhouse',
  autoUp: false,
  transport: 'direct',
};

const exec =
  (result: ExecResult, capture?: (args: string[]) => void) =>
  async (_bin: string, args: string[]): Promise<ExecResult> => {
    capture?.(args);
    return result;
  };

describe('CliDriver.runJson', () => {
  it('parses JSON on exit 0 and appends --json', async () => {
    let seen: string[] = [];
    const d = new CliDriver(
      cfg,
      exec({ stdout: '{"a":1}', stderr: '', code: 0 }, (a) => (seen = a))
    );
    expect(await d.runJson(['health'])).toEqual({ a: 1 });
    expect(seen).toEqual(['health', '--json']);
  });

  it('throws CliError on a non-zero exit', async () => {
    const d = new CliDriver(cfg, exec({ stdout: '', stderr: 'boom', code: 1 }));
    await expect(d.runJson(['init'])).rejects.toBeInstanceOf(CliError);
  });
});

describe('CliDriver.runJsonLenient', () => {
  it('returns the JSON payload even when the command exits non-zero', async () => {
    // `townhouse health` exits 1 on an unhealthy probe but still reports.
    const d = new CliDriver(
      cfg,
      exec({ stdout: '{"overall":"unhealthy"}', stderr: '', code: 1 })
    );
    expect(await d.runJsonLenient(['health'])).toEqual({
      overall: 'unhealthy',
    });
  });

  it('throws CliError when non-zero AND no parseable JSON on stdout', async () => {
    const d = new CliDriver(
      cfg,
      exec({ stdout: 'not json', stderr: 'fatal', code: 1 })
    );
    await expect(d.runJsonLenient(['health'])).rejects.toBeInstanceOf(CliError);
  });
});

describe('CliDriver.runNdjson', () => {
  it('parses one object per line, skipping blank/garbage lines', async () => {
    const d = new CliDriver(
      cfg,
      exec({ stdout: '{"a":1}\n\nnotjson\n{"b":2}\n', stderr: '', code: 0 })
    );
    expect(await d.runNdjson(['logs'])).toEqual([{ a: 1 }, { b: 2 }]);
  });
});
