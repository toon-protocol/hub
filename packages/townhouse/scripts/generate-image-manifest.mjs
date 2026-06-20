/**
 * Generate dist/image-manifest.json — the digest-pinned image manifest that
 * `townhouse up --transport direct` (compose-loader) requires. Fetches the
 * current digest of each public GHCR image and writes the manifest the tsup
 * onSuccess hook then reads to substitute into the compose templates.
 *
 * Fixes the publish gap where 0.34.3 shipped without the manifest (the release
 * build only ran tsup, which READS the manifest but never produced it).
 *
 * Best-effort: throws on network failure so callers can fall back (local dev
 * offline) while a release build (with network) ships a real manifest.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const REPOS = {
  'townhouse-api': 'townhouse-api',
  town: 'town',
  mill: 'mill',
  dvm: 'dvm',
  connector: 'connector',
};
const TAG = process.env.TOON_IMAGE_TAG ?? 'latest';
const ACCEPT =
  'application/vnd.oci.image.index.v1+json, ' +
  'application/vnd.docker.distribution.manifest.list.v2+json, ' +
  'application/vnd.oci.image.manifest.v1+json, ' +
  'application/vnd.docker.distribution.manifest.v2+json';

async function digestFor(repo) {
  const tokRes = await fetch(
    `https://ghcr.io/token?scope=repository:toon-protocol/${repo}:pull`
  );
  const { token } = await tokRes.json();
  const res = await fetch(
    `https://ghcr.io/v2/toon-protocol/${repo}/manifests/${TAG}`,
    { method: 'HEAD', headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT } }
  );
  if (!res.ok) throw new Error(`GHCR ${repo}:${TAG} -> HTTP ${res.status}`);
  const digest = res.headers.get('docker-content-digest');
  if (!/^sha256:[0-9a-f]{64}$/.test(digest ?? '')) {
    throw new Error(`bad digest for ${repo}: ${digest}`);
  }
  return digest;
}

export async function generateImageManifest(distDir, townhouseVersion) {
  const images = {};
  for (const [key, repo] of Object.entries(REPOS)) {
    images[key] = {
      name: `ghcr.io/toon-protocol/${repo}`,
      tag: TAG,
      digest: await digestFor(repo),
    };
  }
  const manifest = {
    schemaVersion: 1,
    townhouseVersion,
    builtAt: new Date().toISOString(),
    images,
  };
  mkdirSync(distDir, { recursive: true });
  const out = join(distDir, 'image-manifest.json');
  writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return out;
}

// CLI entrypoint: `node scripts/generate-image-manifest.mjs [distDir] [version]`
if (import.meta.url === `file://${process.argv[1]}`) {
  const distDir = process.argv[2] ?? 'dist';
  const version = process.argv[3] ?? '0.0.0';
  generateImageManifest(distDir, version)
    .then((p) => console.log(`[image-manifest] wrote ${p}`))
    .catch((e) => {
      console.error(`[image-manifest] failed: ${e.message}`);
      process.exit(1);
    });
}
