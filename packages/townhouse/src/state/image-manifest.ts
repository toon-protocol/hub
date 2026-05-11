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
