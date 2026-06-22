/**
 * Version-skew handling (design §9 open question). Neither the apex API nor the
 * `hub` CLI is versioned over the wire, so this MCP package resolves skew
 * two ways:
 *
 *   1. A declarative pin — `peerDependencies["@toon-protocol/hub"]` in
 *      package.json — that npm/pnpm warn on at install time.
 *   2. A runtime probe — the `hub_version` tool shells `hub version`
 *      and compares the detected CLI version against that pinned range, so an
 *      operator (or the agent) can spot a too-old CLI before a tool misbehaves.
 *
 * The comparison is a deliberate *lower-bound* check (is the CLI at least the
 * pinned floor?): the common failure is an old CLI lacking a flag/command the
 * MCP server relies on, and a precise semver-range solver would be overkill
 * (and a dependency) for that. Pure + injectable so it unit-tests without fs.
 */
import { createRequire } from 'node:module';

/** This package's own version + the hub range it expects. */
export interface SelfPackage {
  version: string;
  /** The `peerDependencies["@toon-protocol/hub"]` range, e.g. `>=0.26.0`. */
  peerRange: string;
}

export interface VersionInfo {
  /** This MCP package's version. */
  mcpVersion: string;
  /** The hub range this MCP package was built against. */
  expectedHubRange: string;
  /** The detected `hub` CLI version, or null if it couldn't be probed. */
  detectedCliVersion: string | null;
  /**
   * Whether the detected CLI meets the pinned lower bound. null when the CLI
   * couldn't be probed (not installed, or too old to support `hub
   * version`) — itself a strong hint of skew.
   */
  satisfies: boolean | null;
  /** Human-readable summary the agent can relay. */
  note: string;
}

/** Read this package's own version + peer range from its package.json. */
export function readSelfPackage(
  requireFn: NodeRequire = createRequire(import.meta.url)
): SelfPackage {
  try {
    const pkg = requireFn('../package.json') as {
      version?: string;
      peerDependencies?: Record<string, string>;
    };
    return {
      version: pkg.version ?? '0.0.0',
      peerRange: pkg.peerDependencies?.['@toon-protocol/hub'] ?? '*',
    };
  } catch {
    return { version: '0.0.0', peerRange: '*' };
  }
}

/** Strip a leading range operator (`>=`, `^`, `~`, `=`) to the bare version. */
export function lowerBound(range: string): string {
  return range.trim().replace(/^[>=^~<]+\s*/, '');
}

/** Numeric semver compare of `a` vs `b`: -1 | 0 | 1 (pre-release tags ignored). */
export function compareSemver(a: string, b: string): number {
  const parse = (v: string): number[] =>
    (v.split('-')[0] ?? v).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** True if `version` meets the lower bound of `range` (`*` always satisfies). */
export function satisfiesLowerBound(version: string, range: string): boolean {
  const bound = lowerBound(range);
  if (!bound || bound === '*') return true;
  return compareSemver(version, bound) >= 0;
}

/** Build the version report, probing the CLI via the injected `detect`. */
export async function computeVersionInfo(
  self: SelfPackage,
  detect: () => Promise<string | undefined>
): Promise<VersionInfo> {
  let cli: string | undefined;
  try {
    cli = await detect();
  } catch (e) {
    // A CliNotFoundError (the `hub` binary couldn't be spawned) is the
    // single most common operator misconfiguration and has a precise fix, so
    // surface its actionable "set TOWNHOUSE_BIN" message verbatim rather than
    // the generic "couldn't probe" note below. Matched by name to avoid a
    // cli-driver import cycle.
    if (e instanceof Error && e.name === 'CliNotFoundError') {
      return {
        mcpVersion: self.version,
        expectedHubRange: self.peerRange,
        detectedCliVersion: null,
        satisfies: null,
        note: e.message,
      };
    }
    cli = undefined;
  }
  if (cli === undefined) {
    return {
      mcpVersion: self.version,
      expectedHubRange: self.peerRange,
      detectedCliVersion: null,
      satisfies: null,
      note:
        'Could not probe the hub CLI version (not installed, or older ' +
        'than the version that added `hub version`). Ensure the CLI ' +
        `satisfies ${self.peerRange}.`,
    };
  }
  const satisfies = satisfiesLowerBound(cli, self.peerRange);
  return {
    mcpVersion: self.version,
    expectedHubRange: self.peerRange,
    detectedCliVersion: cli,
    satisfies,
    note: satisfies
      ? `hub CLI ${cli} satisfies ${self.peerRange}.`
      : `hub CLI ${cli} is older than the pinned floor ${self.peerRange} ` +
        '— tools may misbehave; upgrade @toon-protocol/hub.',
  };
}
