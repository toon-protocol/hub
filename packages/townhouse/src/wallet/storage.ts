/**
 * Wallet file I/O for Townhouse (Story 21.4, Task 2.2).
 *
 * Persists encrypted wallet to disk with 0o600 permissions (owner-only).
 * Warns if existing file has world-readable permissions.
 */

import { writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { EncryptedWallet } from './types.js';

/**
 * Save encrypted wallet to disk with restrictive permissions.
 * Creates parent directory if missing.
 */
export async function saveWallet(
  path: string,
  encrypted: EncryptedWallet
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const data = JSON.stringify(encrypted, null, 2);
  await writeFile(path, data, { encoding: 'utf-8', mode: 0o600 });
}

/**
 * Load encrypted wallet from disk.
 * Returns null if file does not exist.
 * Warns (via returned flag) if file permissions are too open.
 */
export async function loadWallet(
  path: string
): Promise<{ wallet: EncryptedWallet; permissionsWarning?: string } | null> {
  let data: string;
  try {
    data = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return null;
    }
    throw err;
  }

  // Check permissions
  let permissionsWarning: string | undefined;
  try {
    const stats = await stat(path);
    const mode = stats.mode & 0o777;
    if (mode & 0o077) {
      permissionsWarning = `Warning: wallet file ${path} has permissions ${mode.toString(8)} (should be 600)`;
    }
  } catch {
    // stat failure is non-fatal — skip permissions check
  }

  const wallet = JSON.parse(data) as EncryptedWallet;
  return { wallet, permissionsWarning };
}
