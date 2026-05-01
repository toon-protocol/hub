/**
 * Mina GraphQL helpers for balance queries.
 * Uses native fetch + AbortController (no external deps).
 */

const TIMEOUT_MS = 3_000;

/**
 * Get MINA balance (nanomina) for a base58check address.
 * Returns balance as decimal string in nanomina (scale 9).
 */
export async function getMinaBalance(graphqlUrl: string, address: string): Promise<string> {
  const query = `query GetBalance($pk: PublicKey!) {
    account(publicKey: $pk) {
      balance {
        total
      }
    }
  }`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(graphqlUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables: { pk: address } }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Mina GraphQL failed: HTTP ${res.status}`);
    const data = await res.json() as {
      data?: { account?: { balance?: { total?: string } } };
      errors?: { message: string }[];
    };
    if (data.errors?.length) throw new Error(`Mina GraphQL error: ${data.errors[0]?.message}`);
    const total = data.data?.account?.balance?.total;
    if (!total) return '0';
    // total is returned as a decimal MINA string (e.g. "1000.000000000").
    // Reject malformed inputs (scientific notation, empty wholes, non-digits)
    // explicitly — a BigInt throw inside this function would surface as a
    // generic 503 instead of a clean `available:false / reason:bad_format`.
    if (!/^\d+(\.\d+)?$/.test(total)) {
      throw new Error(`Mina balance: unsupported numeric format (${total})`);
    }
    const [whole = '0', frac = ''] = total.split('.');
    const fracPadded = frac.padEnd(9, '0').slice(0, 9) || '0';
    const nanomina = BigInt(whole) * 1_000_000_000n + BigInt(fracPadded);
    return nanomina.toString();
  } finally {
    clearTimeout(timeout);
  }
}
