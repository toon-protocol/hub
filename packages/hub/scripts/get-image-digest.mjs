/**
 * Shared digest extraction + validation for the hub image manifest.
 *
 * Both `scripts/render-compose-template.mjs` and
 * `packages/hub/tsup.config.ts` import this so a single source of truth
 * defines (a) what makes a manifest entry valid, and (b) what error messages
 * the operator sees when it isn't. Round-1 review deferred this consolidation
 * (#8 in deferred-work.md); Round-2 review observed that the patch round
 * actually worsened the drift by introducing parallel digest-validation logic.
 */

export const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

/**
 * Returns the digest string for a given image key (e.g. 'connector', 'town')
 * after validating that the manifest contains the entry and the digest is a
 * well-formed sha256 ref. Throws a descriptive Error on any failure.
 */
export function getImageDigest(manifest, key) {
  const entry = manifest?.images?.[key];
  if (!entry) {
    throw new Error(
      `image-manifest digest lookup failed: manifest missing image entry images.${key}`
    );
  }
  const digest = entry.digest;
  if (typeof digest !== 'string' || !DIGEST_RE.test(digest)) {
    throw new Error(
      `image-manifest digest for '${key}' is not a valid sha256 ref: '${digest}'`
    );
  }
  return digest;
}
