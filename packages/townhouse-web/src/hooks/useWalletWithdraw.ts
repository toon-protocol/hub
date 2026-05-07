import type {
  WithdrawRequest,
  WithdrawResponse,
  TransactionReceiptPayload,
} from '@toon-protocol/townhouse';

export interface WithdrawErrorResponse {
  error: string;
  code?: string;
  message?: string;
  supportedFamilies?: string[];
}

export type WithdrawHookResult = WithdrawResponse | WithdrawErrorResponse;

/** Single-shot withdraw + receipt polling. Never caches secrets. */
export function useWalletWithdraw(
  options: {
    withdrawUrl?: string;
    transactionUrl?: (txHash: string) => string;
  } = {}
): {
  submit: (req: WithdrawRequest) => Promise<WithdrawHookResult>;
  getReceipt: (txHash: string) => Promise<TransactionReceiptPayload>;
} {
  const withdrawUrl = options.withdrawUrl ?? '/api/wallet/withdraw'; // proxied to /wallet/withdraw
  const txUrlFn =
    options.transactionUrl ??
    ((txHash: string) => `/api/wallet/transaction/${txHash}`); // proxied

  async function submit(req: WithdrawRequest): Promise<WithdrawHookResult> {
    const res = await fetch(withdrawUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      throw new Error(`withdraw: unexpected response (${res.status})`);
    }
    if (!res.ok) {
      // Server returned a structured error — surface it as a typed error
      // payload instead of pretending it succeeded.
      if (parsed && typeof parsed === 'object' && 'error' in parsed) {
        return parsed as WithdrawErrorResponse;
      }
      throw new Error(`withdraw: HTTP ${res.status}`);
    }
    if (
      parsed &&
      typeof parsed === 'object' &&
      ('txHash' in parsed || 'estimatedGas' in parsed)
    ) {
      return parsed as WithdrawResponse;
    }
    throw new Error('withdraw: unexpected response shape');
  }

  async function getReceipt(
    txHash: string
  ): Promise<TransactionReceiptPayload> {
    const res = await fetch(txUrlFn(txHash));
    if (!res.ok) {
      throw new Error(`receipt: HTTP ${res.status}`);
    }
    const parsed = (await res.json()) as TransactionReceiptPayload;
    if (!parsed || typeof parsed !== 'object' || !('status' in parsed)) {
      throw new Error('receipt: unexpected response shape');
    }
    return parsed;
  }

  return { submit, getReceipt };
}
