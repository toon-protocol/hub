/**
 * Shared config-mutation mutex.
 *
 * Serializes concurrent PATCH /api/nodes/:type/config and PATCH /api/transport
 * mutations so they cannot race on the same config.yaml file.
 */

let isMutating = false;

/**
 * Synchronous test-and-set acquire of the mutex. Returns true on success,
 * false if already held.
 *
 * Safety: relies on the JavaScript event-loop running the if-check and the
 * assignment in the same synchronous tick. Do NOT introduce an `await`
 * between the read and the write or this guard becomes racy.
 */
export function acquireConfigMutex(): boolean {
  if (isMutating) return false;
  isMutating = true;
  return true;
}

export function releaseConfigMutex(): void {
  isMutating = false;
}

/** Reset for testing. */
export function resetConfigMutex(): void {
  isMutating = false;
}
