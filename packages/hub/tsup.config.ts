import { defineConfig } from 'tsup';
import {
  cp,
  mkdir,
  readFile,
  writeFile,
  access,
  chmod,
} from 'node:fs/promises';
import { join } from 'node:path';

// Shared digest extractor + validator. Single source of truth for what makes
// a manifest entry valid — used by this hook AND by scripts/render-compose-template.mjs
// (the CI-side renderer that runs after download-artifact). Round-2 review
// flagged that the previous duplicate substitution arrays had drifted error
// contracts; consolidating here closes that gap. The helper lives INSIDE
// packages/hub/ so it's within the Docker build context for
// Dockerfile.hub-api (a sibling-of-package path is not).
// @ts-expect-error — JS module, no type declarations.
import { getImageDigest } from './scripts/get-image-digest.mjs';
// @ts-expect-error — JS module, no type declarations.
import { generateImageManifest } from './scripts/generate-image-manifest.mjs';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  // Inline `@toon-protocol/mill/wallet` (the pure key-derivation `deriveMillKeys`)
  // and its crypto deps into dist. mill ships as a Docker image, NOT an npm
  // runtime dep — bundling here is what lets hub's published package.json
  // carry ZERO @toon-protocol/* runtime dependencies (see package-structure
  // guard test). The crypto libs are bundled too (not left external) so the
  // inlined code resolves @noble's v2-style subpaths at BUILD time and can't
  // hit a runtime version-skew against hub's own @noble/@scure versions.
  noExternal: [
    '@toon-protocol/mill',
    // Apex Solana/Mina settlement-key encoding (base58Encode +
    // hexToMinaBase58PrivateKey) is imported from core; inline it so the
    // published package keeps ZERO @toon-protocol/* runtime deps (same rule as
    // mill above — see package-structure guard test).
    '@toon-protocol/core',
    '@scure/bip39',
    '@scure/bip32',
    '@noble/curves',
    '@noble/hashes',
    'ed25519-hd-key',
  ],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  outExtension: () => ({ js: '.js' }),
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
  onSuccess: async () => {
    // Produce the digest-pinned image manifest that direct mode requires. Best-effort:
    // a release build (with GHCR network) ships a real manifest; local dev offline falls
    // through to the unsubstituted-template warning below. This closes the publish gap
    // where the manifest never reached dist/ (the build only ever READ it).
    try {
      const { version } = JSON.parse(await readFile('package.json', 'utf-8'));
      await generateImageManifest('dist', version);
    } catch (err) {
      console.warn(
        `[tsup] image-manifest generation skipped (${(err as Error).message}) — ` +
          'fine for offline local dev, invalid for npm publish.'
      );
    }

    const composeDistDir = 'dist/compose';
    await mkdir(composeDistDir, { recursive: true });

    // Copy dev template verbatim (no digest substitution — uses local toon:* tags).
    await cp(
      'compose/hub-dev.yml',
      join(composeDistDir, 'hub-dev.yml')
    );

    // Render HS template — substitute digest placeholders from image-manifest.json
    // if present. When the manifest file is absent (typical local dev), emit a
    // warning and ship the unsubstituted template. CI calls
    // scripts/render-compose-template.mjs AFTER download-artifact places the
    // manifest, so the authoritative substitution happens there.
    //
    // IMPORTANT: only ENOENT (manifest absent) is tolerated. JSON parse errors,
    // schema mismatches, and malformed digests all fail the build — silent
    // emission of an unsubstituted template under those conditions would mask
    // real bugs and rely on CI's tarball-content gate as the only safety net.
    const manifestPath = 'dist/image-manifest.json';
    const hsTemplateRaw = await readFile('compose/hub-hs.yml', 'utf-8');
    const directTemplateRaw = await readFile(
      'compose/hub-direct.yml',
      'utf-8'
    );
    let hsRendered = hsTemplateRaw;
    let directRendered = directTemplateRaw;

    let manifestPresent = false;
    try {
      await access(manifestPath);
      manifestPresent = true;
    } catch {
      console.warn(
        '[tsup] dist/image-manifest.json not found — shipping unsubstituted ' +
          'hub-{hs,direct}.yml. This is fine for local dev but invalid for npm publish.'
      );
    }

    if (manifestPresent) {
      const manifestRaw = await readFile(manifestPath, 'utf-8');
      const manifest = JSON.parse(manifestRaw); // throws SyntaxError on malformed JSON

      const subs: [string, string][] = [
        [
          '${TOON_TOWNHOUSE_API_DIGEST}',
          `@${getImageDigest(manifest, 'hub-api')}`,
        ],
        ['${TOON_TOWN_DIGEST}', `@${getImageDigest(manifest, 'town')}`],
        ['${TOON_MILL_DIGEST}', `@${getImageDigest(manifest, 'mill')}`],
        ['${TOON_DVM_DIGEST}', `@${getImageDigest(manifest, 'dvm')}`],
        [
          '${TOON_CONNECTOR_DIGEST}',
          `@${getImageDigest(manifest, 'connector')}`,
        ],
      ];

      for (const [placeholder, replacement] of subs) {
        hsRendered = hsRendered.replaceAll(placeholder, replacement);
        directRendered = directRendered.replaceAll(placeholder, replacement);
      }
    }

    // NFR8 — operator-secret file mode (R2-MINOR fix) on both rendered outputs.
    const hsOutPath = join(composeDistDir, 'hub-hs.yml');
    await writeFile(hsOutPath, hsRendered, 'utf-8');
    await chmod(hsOutPath, 0o600);

    const directOutPath = join(composeDistDir, 'hub-direct.yml');
    await writeFile(directOutPath, directRendered, 'utf-8');
    await chmod(directOutPath, 0o600);
  },
});
