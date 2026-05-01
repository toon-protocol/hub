import type { RevealResponse } from '@toon-protocol/townhouse';

/** Single-shot POST /api/wallet/reveal — never caches the mnemonic. */
export function useWalletReveal(options: { url?: string } = {}): {
  reveal: (password: string) => Promise<RevealResponse>;
} {
  const url = options.url ?? '/api/wallet/reveal'; // proxied to /wallet/reveal

  async function reveal(password: string): Promise<RevealResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      // Non-JSON body (HTML 502, plain text, empty 204…) — surface a structured
      // error rather than letting the JSON parse error bubble as "Network error".
      if (res.status === 401) return { error: 'invalid_password' };
      if (res.status === 503) return { error: 'wallet_not_initialized' };
      return { error: 'wallet_corrupted', message: `unexpected response (${res.status})` };
    }
    if (parsed && typeof parsed === 'object' && ('mnemonic' in parsed || 'error' in parsed)) {
      return parsed as RevealResponse;
    }
    return { error: 'wallet_corrupted', message: 'unexpected response shape' };
  }

  return { reveal };
}
