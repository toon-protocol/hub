import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  statSync,
  lstatSync,
  existsSync,
} from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

export type ComposeProfile = 'dev' | 'hs' | 'direct';
const VALID_PROFILES: readonly ComposeProfile[] = [
  'dev',
  'hs',
  'direct',
] as const;

export interface ComposeLoaderOptions {
  /** Override default `~/.townhouse/` write target. Used by tests. */
  townhouseHome?: string;
  /** Override the package-relative dist directory the loader reads from.
   *  Defaults to the `dist/` adjacent to compose-loader.js at runtime.
   *  Tests use this to point at fixture directories. */
  distDir?: string;
}

export class ComposeLoaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ComposeLoaderError';
  }
}

function defaultDistDir(): string {
  // Resolves to `dist/` adjacent to the bundled output at runtime.
  // When bundled by tsup, import.meta.url is the path of dist/index.js,
  // so dirname = <package>/dist. resolve(<package>/dist, '..', 'dist') = <package>/dist.
  // When running via tsx/ts-node from src/, dirname = <package>/src,
  // so resolve(<package>/src, '..', 'dist') = <package>/dist. Both work.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '..', 'dist');
}

function assertValidProfile(
  profile: string
): asserts profile is ComposeProfile {
  if (!(VALID_PROFILES as readonly string[]).includes(profile)) {
    throw new ComposeLoaderError(
      `invalid compose profile: '${profile}'. Must be one of: ${VALID_PROFILES.join(', ')}.`
    );
  }
}

// Reject townhouseHome paths that target system directories. Internal callers
// (CLI, API, Story 45.4) pass `~/.townhouse` or test tmpdirs; an attacker
// reaching this code path with `townhouseHome: '/etc'` would otherwise write
// `/etc/compose/townhouse-hs.yml` and `chmod /etc 0o700`. The list is a
// belt-and-suspenders defense — it doesn't replace caller validation, but it
// turns a silent privilege escalation into a loud error.
const SYSTEM_PATH_PREFIXES = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/root',
] as const;

function assertValidTownhouseHome(home: string): void {
  if (!home) {
    throw new ComposeLoaderError(
      'townhouseHome resolved to an empty path. Set $HOME or pass options.townhouseHome explicitly.'
    );
  }
  if (!isAbsolute(home)) {
    throw new ComposeLoaderError(
      `townhouseHome must be an absolute path; got '${home}'.`
    );
  }
  if (home === '/' || home === '\\') {
    throw new ComposeLoaderError(
      `townhouseHome must not be the filesystem root; got '${home}'. ` +
        `This usually means $HOME is unset and homedir() returned '/'.`
    );
  }
  for (const prefix of SYSTEM_PATH_PREFIXES) {
    if (home === prefix || home.startsWith(prefix + '/')) {
      throw new ComposeLoaderError(
        `townhouseHome must not target a system directory; got '${home}'. ` +
          `Allowed paths: under $HOME, under tmpdir(), or any user-writable location.`
      );
    }
  }
}

// Refuse to write through a symlink at composePath/manifestPath. The dir-level
// guard above only protects the directory itself; this protects the file path.
function assertNotSymlink(filePath: string): void {
  try {
    const lst = lstatSync(filePath);
    if (lst.isSymbolicLink()) {
      throw new ComposeLoaderError(
        `${filePath} is a symlink; refusing to write through it. ` +
          `If this is intentional, remove the symlink and re-run.`
      );
    }
  } catch (err) {
    // ENOENT is expected (file doesn't exist yet — fresh write); rethrow others.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }
}

/**
 * Returns the rendered compose YAML for the requested profile.
 * For 'hs', digest substitutions are already applied (resolved at build time).
 * For 'dev', the YAML is returned verbatim (uses local `toon:*` image tags).
 * Throws `ComposeLoaderError` if the requested profile's YAML is unreadable.
 */
export function loadComposeTemplate(
  profile: ComposeProfile,
  options: ComposeLoaderOptions = {}
): string {
  assertValidProfile(profile);
  const distDir = options.distDir ?? defaultDistDir();
  const composePath = join(distDir, 'compose', `townhouse-${profile}.yml`);
  if (!existsSync(composePath)) {
    throw new ComposeLoaderError(
      `compose template not found: ${composePath}. ` +
        `Did you run 'pnpm --filter @toon-protocol/townhouse build' first?`
    );
  }
  return readFileSync(composePath, 'utf-8');
}

/**
 * Writes the resolved compose YAML to `<townhouseHome>/compose/<profile>.yml`
 * and copies `dist/image-manifest.json` to `<townhouseHome>/image-manifest.json`.
 * BOTH output files are written with mode 0o600 (NFR8 — operator-secret file mode).
 * Returns the absolute paths of the two files written.
 */
export function materializeComposeTemplate(
  profile: ComposeProfile,
  options: ComposeLoaderOptions = {}
): { composePath: string; manifestPath: string } {
  assertValidProfile(profile);
  const home = options.townhouseHome || join(homedir(), '.townhouse');
  assertValidTownhouseHome(home);

  const distDir = options.distDir ?? defaultDistDir();
  const manifestSrc = join(distDir, 'image-manifest.json');

  // Validate inputs BEFORE any writes so a failure leaves disk untouched.
  // HS and direct profiles cannot succeed without a manifest — both ship
  // digest-pinned GHCR images — so fail loudly up-front rather than after
  // writing a stale/torn compose file. (dev uses local toon:* tags and needs
  // no manifest.)
  if ((profile === 'hs' || profile === 'direct') && !existsSync(manifestSrc)) {
    throw new ComposeLoaderError(
      `image-manifest.json not found at ${manifestSrc}. ` +
        `${profile === 'hs' ? 'HS' : 'Direct'} mode requires a digest-pinned image manifest. ` +
        `Reinstall @toon-protocol/townhouse from npm to restore the manifest.`
    );
  }
  // loadComposeTemplate also throws ENOENT if the source is missing — surface
  // it now (read-only) so we don't mkdir or chmod for a doomed call.
  const yaml = loadComposeTemplate(profile, options);

  const composeDir = join(home, 'compose');
  // Pass mode: 0o700 so newly-created intermediates start tight (closes the
  // mkdir → chmod TOCTOU window that allowed brief world-readable state).
  mkdirSync(composeDir, { recursive: true, mode: 0o700 });

  // Refuse to chmod symlink targets — operator may have placed `~/.townhouse`
  // as a symlink to an encrypted volume, and we should not silently flip the
  // mode of a path we did not create. lstatSync inspects the link itself.
  for (const dir of [home, composeDir]) {
    const lst = lstatSync(dir);
    if (lst.isSymbolicLink()) {
      // Resolve the link target and confirm it's a directory; do not chmod.
      const target = statSync(dir);
      if (!target.isDirectory()) {
        throw new ComposeLoaderError(
          `${dir} is a symlink to a non-directory; refusing to materialize.`
        );
      }
      continue;
    }
    // Only narrow the mode if it is currently broader than 0o700. Operators
    // who deliberately set 0o700 OR tighter (e.g. 0o500) keep their setting.
    // Bug fix R2: previous `!== 0o700` widened 0o500 to 0o700 — now we only
    // chmod if the existing mode grants any permission outside the owner.
    const currentMode = lst.mode & 0o777;
    if ((currentMode & 0o077) !== 0) {
      chmodSync(dir, 0o700);
    }
  }

  const composePath = join(composeDir, `townhouse-${profile}.yml`);
  // R2 file-symlink guard — refuse to write through a planted symlink.
  assertNotSymlink(composePath);
  writeFileSync(composePath, yaml, { mode: 0o600, encoding: 'utf-8' });
  // Defensive re-chmod: writeFileSync's mode option is honored only on file
  // creation — if composePath already existed at e.g. 0o644 (stale state from
  // a prior interrupted run), the mode is unchanged by writeFileSync.
  // chmodSync corrects both that case AND the WSL2 umask-masking edge case.
  chmodSync(composePath, 0o600);

  const manifestPath = join(home, 'image-manifest.json');
  if (existsSync(manifestSrc)) {
    assertNotSymlink(manifestPath);
    const manifest = readFileSync(manifestSrc, 'utf-8');
    writeFileSync(manifestPath, manifest, { mode: 0o600, encoding: 'utf-8' });
    chmodSync(manifestPath, 0o600);
  }
  // (Manifest absence for 'dev' profile is silently tolerated — dev mode
  // doesn't need digest pinning. HS profile already failed at the entry guard.)

  return { composePath, manifestPath };
}
