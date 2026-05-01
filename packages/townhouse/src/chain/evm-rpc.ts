/**
 * EVM JSON-RPC helpers for balance queries.
 * Uses native fetch + AbortController (no external deps).
 */

const TIMEOUT_MS = 3_000;
const HEX_ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/** JSON-RPC request helper. The local 3s timeout always fires regardless of
 *  whether the caller passes their own signal. */
async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
  signal?: AbortSignal,
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('rpc_timeout')), TIMEOUT_MS);
  // Forward caller cancellation into our controller so the local timeout-driven
  // abort and the caller-driven abort both reach the underlying fetch.
  const onCallerAbort = signal
    ? () => controller.abort((signal.reason as Error | undefined) ?? new Error('aborted'))
    : null;
  if (signal && onCallerAbort) {
    if (signal.aborted) onCallerAbort();
    else signal.addEventListener('abort', onCallerAbort, { once: true });
  }

  try {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`EVM RPC ${method} failed: HTTP ${res.status}`);
    const data = (await res.json()) as { result?: string; error?: { message: string } };
    if (data.error) throw new Error(`EVM RPC ${method} error: ${data.error.message}`);
    return data.result;
  } finally {
    clearTimeout(timeout);
    if (signal && onCallerAbort) {
      signal.removeEventListener('abort', onCallerAbort);
    }
  }
}

/**
 * Get native ETH balance (wei) for an address.
 * Returns balance as decimal string.
 */
export async function getEvmBalance(rpcUrl: string, address: string): Promise<string> {
  if (!HEX_ADDR_RE.test(address)) {
    throw new Error(`getEvmBalance: invalid address shape (${address})`);
  }
  const hex = (await rpcCall(rpcUrl, 'eth_getBalance', [address, 'latest'])) as string;
  return BigInt(hex).toString();
}

/**
 * Get ERC-20 token balance using balanceOf(address) selector.
 * Returns balance as decimal string.
 */
export async function getErc20Balance(
  rpcUrl: string,
  contractAddress: string,
  holderAddress: string,
): Promise<string> {
  if (!HEX_ADDR_RE.test(contractAddress)) {
    throw new Error(`getErc20Balance: invalid contract address (${contractAddress})`);
  }
  if (!HEX_ADDR_RE.test(holderAddress)) {
    throw new Error(`getErc20Balance: invalid holder address (${holderAddress})`);
  }
  // ABI-encode balanceOf(address): selector 0x70a08231 + padded address
  const paddedAddr = holderAddress.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const data = `0x70a08231${paddedAddr}`;

  const hex = (await rpcCall(rpcUrl, 'eth_call', [
    { to: contractAddress, data },
    'latest',
  ])) as string;

  if (!hex || hex === '0x') return '0';
  return BigInt(hex).toString();
}
