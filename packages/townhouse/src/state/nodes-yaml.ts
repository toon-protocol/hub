/**
 * `nodes.yaml` schema + read/write helpers (Story 46.1).
 *
 * `~/.townhouse/nodes.yaml` is the operator-managed source of truth for
 * enabled child nodes. The reconciler (see `../reconciler.ts`) converges
 * connector peer state to this file on every `townhouse hs up`.
 *
 * Architectural rule (Epic 46.2 dependency): yaml writes happen BEFORE
 * connector registration. The drift window resolves in the safe direction —
 * a yaml entry without a connector peer is re-registered on next boot; a
 * connector peer without a yaml entry is treated as `'external'` and left
 * alone.
 */

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { parse as yamlParse, stringify as yamlStringify } from 'yaml';
import { z } from 'zod';

const NodesYamlEntrySchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['town', 'mill', 'dvm']),
    peerId: z.string().min(1),
    ilpAddress: z.string().min(1),
    derivationIndex: z.number().int().nonnegative(),
    // x-only Nostr pubkey (32-byte / 64-char lowercase hex) derived from the
    // node's secret key at provisioning time. Surfaced by `node list --json`
    // so operators / SDK clients can read e.g. the mill pubkey (for streamSwap
    // seal verification) without re-deriving from the secret (issue #81).
    // Optional for backward compatibility with nodes.yaml files written before
    // the field existed.
    nostrPubkey: z
      .string()
      .regex(/^[0-9a-f]{64}$/, 'must be 64-char lowercase hex')
      .optional(),
    enabledAt: z.string().datetime({ offset: true }),
    lastSeenAt: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();

export const NodesYamlSchema = z
  .object({
    entries: z.array(NodesYamlEntrySchema),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seenPeerIds = new Set<string>();
    const seenDerivationIndexes = new Set<number>();
    for (const [i, e] of data.entries.entries()) {
      if (seenPeerIds.has(e.peerId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', i, 'peerId'],
          message: `duplicate peerId: ${e.peerId}`,
        });
      }
      seenPeerIds.add(e.peerId);
      if (seenDerivationIndexes.has(e.derivationIndex)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', i, 'derivationIndex'],
          message: `duplicate derivationIndex: ${e.derivationIndex}`,
        });
      }
      seenDerivationIndexes.add(e.derivationIndex);
    }
  });

export type NodesYamlEntry = z.infer<typeof NodesYamlEntrySchema>;
export type NodesYaml = z.infer<typeof NodesYamlSchema>;

/**
 * Read and validate `nodes.yaml` at the given path.
 *
 * Returns `{ entries: [] }` if the file does not exist (graceful first-run).
 * Throws a `ZodError` with a useful path if the file is present but invalid.
 */
export async function readNodesYaml(path: string): Promise<NodesYaml> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { entries: [] };
    }
    throw err;
  }
  const parsed: unknown = yamlParse(raw);
  // An empty yaml file (or one containing only `~`) parses to null — coerce
  // to the empty default so the schema validation succeeds.
  if (parsed === null || parsed === undefined) {
    return { entries: [] };
  }
  return NodesYamlSchema.parse(parsed);
}

/**
 * Write `nodes.yaml` atomically with file mode `0o600`.
 *
 * Atomic = write to `<path>.tmp` then `fs.rename`. On POSIX, rename is
 * atomic when source + destination live on the same filesystem (always true
 * for `~/.townhouse/nodes.yaml`). Prevents partial-write corruption if the
 * process is killed mid-write.
 */
export async function writeNodesYaml(
  path: string,
  data: NodesYaml
): Promise<void> {
  // Validate before serializing — never persist a yaml that won't round-trip.
  const validated = NodesYamlSchema.parse(data);
  const yamlContent = yamlStringify(validated);
  const tmpPath = `${path}.tmp`;
  await fs.mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await fs.writeFile(tmpPath, yamlContent, { encoding: 'utf-8', mode: 0o600 });
  await fs.rename(tmpPath, path);
  // fs.writeFile honors mode only on file creation. Re-chmod after rename
  // to handle the case where `<path>` already existed and inherited a
  // different mode from a previous run.
  await fs.chmod(path, 0o600);
}

// Re-export for downstream validators (Epic 47 aggregator) that need to
// validate operator input without reaching into a deep import path.
export { NodesYamlEntrySchema };
