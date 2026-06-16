/**
 * Drives the `townhouse` CLI for lifecycle + config + money mutations that the
 * Fastify API doesn't cover (and that must work BEFORE the apex is up). Always
 * consumes `--json` / NDJSON; never scrapes human text. Injects
 * `TOWNHOUSE_MNEMONIC` + config dir into the child env (keys live at the
 * townhouse layer — docs/townhouse-mcp-design.md §3).
 */
import { spawn } from 'node:child_process';
import type { ResolvedConfig } from './config.js';

/** Error thrown when a `townhouse` invocation exits non-zero. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly stderr: string
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/**
 * Thrown when the `townhouse` binary itself can't be spawned (ENOENT) — i.e. the
 * CLI isn't on PATH and `TOWNHOUSE_BIN` wasn't set to point at it. Distinct from
 * {@link CliError} (a CLI that ran but exited non-zero) so the MCP layer can give
 * the operator an actionable "set TOWNHOUSE_BIN" hint instead of a bare
 * `spawn townhouse ENOENT`. CLI-backed tools (`health`, `channels`, `chains
 * add/remove`, `set_node_fees`, `seed`, `withdraw`, `credits`, the lifecycle
 * commands, and the `version` CLI probe) all require a resolvable CLI.
 */
export class CliNotFoundError extends Error {
  constructor(readonly bin: string) {
    super(
      `townhouse CLI not found (tried to spawn "${bin}"). Set TOWNHOUSE_BIN to ` +
        `the CLI entry point (e.g. node_modules/@toon-protocol/hub/dist/cli.js ` +
        `or packages/townhouse/dist/cli.js in a checkout), or install ` +
        `@toon-protocol/hub so the \`townhouse\` command is on PATH. ` +
        `CLI-backed tools (health, channels, chains, set_node_fees, withdraw, ` +
        `seed, credits, lifecycle) need it.`
    );
    this.name = 'CliNotFoundError';
  }
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Low-level spawn function shape — injectable for tests. */
export type SpawnExec = (
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv
) => Promise<ExecResult>;

export class CliDriver {
  private readonly cfg: ResolvedConfig;
  private readonly exec: SpawnExec;

  constructor(cfg: ResolvedConfig, exec: SpawnExec = defaultExec) {
    this.cfg = cfg;
    this.exec = exec;
  }

  /** Child env with the operator secret + config dir injected. */
  childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      ...(this.cfg.mnemonic ? { TOWNHOUSE_MNEMONIC: this.cfg.mnemonic } : {}),
      TOWNHOUSE_CONFIG_DIR: this.cfg.configDir,
    };
  }

  /** Run a short-lived command with `--json`, parse a single JSON value. */
  async runJson<T>(args: string[]): Promise<T> {
    const { stdout, stderr, code } = await this.exec(
      this.cfg.townhouseBin,
      [...args, '--json'],
      this.childEnv()
    );
    if (code !== 0) {
      throw new CliError(
        `townhouse ${args.join(' ')} exited ${code}`,
        code,
        stderr
      );
    }
    return JSON.parse(stdout) as T;
  }

  /**
   * Like {@link runJson}, but a non-zero exit is NOT treated as failure when the
   * command still emitted a valid JSON payload on stdout. Some commands use the
   * exit code as a *status signal* while reporting structurally — e.g.
   * `townhouse health` exits 1 when any probe is unhealthy yet still prints the
   * full health breakdown the agent wants to see. Only throws when there is no
   * parseable JSON to return.
   */
  async runJsonLenient<T>(args: string[]): Promise<T> {
    const { stdout, stderr, code } = await this.exec(
      this.cfg.townhouseBin,
      [...args, '--json'],
      this.childEnv()
    );
    try {
      return JSON.parse(stdout) as T;
    } catch {
      throw new CliError(
        `townhouse ${args.join(' ')} exited ${code}`,
        code,
        stderr
      );
    }
  }

  /** Run a command emitting NDJSON (`logs`), parse one object per line. */
  async runNdjson<T>(args: string[]): Promise<T[]> {
    const { stdout, stderr, code } = await this.exec(
      this.cfg.townhouseBin,
      [...args, '--json'],
      this.childEnv()
    );
    if (code !== 0) {
      throw new CliError(
        `townhouse ${args.join(' ')} exited ${code}`,
        code,
        stderr
      );
    }
    const out: T[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as T);
      } catch {
        /* skip non-JSON noise */
      }
    }
    return out;
  }
}

/** Default spawn-based executor: buffer stdout/stderr, resolve on close. */
function defaultExec(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e: NodeJS.ErrnoException) => {
      // ENOENT means the binary couldn't be found — turn the cryptic
      // `spawn townhouse ENOENT` into an actionable "set TOWNHOUSE_BIN" error.
      if (e.code === 'ENOENT') reject(new CliNotFoundError(bin));
      else reject(e);
    });
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}
