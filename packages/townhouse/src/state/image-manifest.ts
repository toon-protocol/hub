/**
 * Image manifest reader for Townhouse (Story 46.2).
 *
 * `~/.townhouse/image-manifest.json` is materialized by `compose-loader.ts`
 * during `townhouse hs up`. It maps node types to their digest-pinned image
 * refs, consumed by `POST /api/nodes` step 2 (pull image).
 */

import { promises as fs } from 'node:fs';
import { z } from 'zod';

const ImageEntrySchema = z
  .object({
    name: z.string().min(1),
    tag: z.string().min(1),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

export const ImageManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    townhouseVersion: z.string(),
    builtAt: z.string().datetime({ offset: true }),
    images: z
      .object({
        'townhouse-api': ImageEntrySchema,
        town: ImageEntrySchema,
        mill: ImageEntrySchema,
        dvm: ImageEntrySchema,
        connector: ImageEntrySchema,
      })
      .strict(),
  })
  .strict();

export type ImageManifest = z.infer<typeof ImageManifestSchema>;

/**
 * Sentinel digest used by `.github/workflows/connector-publish-smoke.yml`
 * to populate the four non-connector entries of a synthetic
 * `image-manifest.json` it writes when the operator supplies
 * `connector_digest` for a candidate connector tag.
 *
 * The smoke workflow only validates the CONNECTOR entry; the four other
 * entries exist purely to satisfy `ImageManifestSchema.strict()`. Any future
 * per-image alignment check MUST treat this value as "not a real registry
 * digest" and skip the comparison rather than fail. Recognize via either
 * literal equality or `isSyntheticDigest(d)`.
 */
export const SYNTHETIC_DIGEST_SENTINEL =
  'sha256:dead000000000000000000000000000000000000000000000000000000000000';

/** True iff the digest is the synthetic sentinel produced by the smoke workflow. */
export function isSyntheticDigest(digest: string): boolean {
  return digest === SYNTHETIC_DIGEST_SENTINEL;
}

/**
 * Read and validate `image-manifest.json` at the given path.
 *
 * Throws ENOENT if the file is missing — there is no graceful fallback for a
 * missing manifest; it means `townhouse hs up` was not run first.
 * Throws `ZodError` with a useful path if the file is present but invalid.
 */
export async function readImageManifest(path: string): Promise<ImageManifest> {
  const raw = await fs.readFile(path, 'utf-8');
  const parsed: unknown = JSON.parse(raw);
  return ImageManifestSchema.parse(parsed);
}
