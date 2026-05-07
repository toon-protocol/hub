/**
 * Solana JSON-RPC helpers for balance queries.
 * Uses native fetch + AbortController (no external deps).
 */

const TIMEOUT_MS = 3_000;

/**
 * Get native SOL balance (lamports) for a base58 address.
 * Returns balance as decimal string.
 */
export async function getSolanaBalance(
  rpcUrl: string,
  address: string
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'getBalance',
        params: [address],
      }),
      signal: controller.signal,
    });
    if (!res.ok)
      throw new Error(`Solana RPC getBalance failed: HTTP ${res.status}`);
    const data = (await res.json()) as {
      result?: { value?: number };
      error?: { message: string };
    };
    if (data.error) throw new Error(`Solana RPC error: ${data.error.message}`);
    const lamports = data.result?.value ?? 0;
    return BigInt(lamports).toString();
  } finally {
    clearTimeout(timeout);
  }
}
