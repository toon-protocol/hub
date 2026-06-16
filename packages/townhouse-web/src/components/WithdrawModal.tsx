import { useEffect, useRef, useState, useCallback } from 'react';
import { isAddress } from 'viem';
import { Button } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { useWalletWithdraw } from '@/hooks/useWalletWithdraw';
import type { WalletBalanceEntry, WithdrawRequest, TransactionReceiptPayload } from '@toon-protocol/hub';
import type { NodeType } from '@toon-protocol/hub';

export interface WithdrawModalProps {
  nodeType: NodeType;
  balances: WalletBalanceEntry[];
  open: boolean;
  onClose: () => void;
}

type ChainFamily = 'evm' | 'solana' | 'mina';
type Step = 1 | 2 | 3 | 4 | 5 | 6;

function isFormat(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr);
}

function truncateHash(hash: string): string {
  if (hash.length < 14) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

function relativeTime(estimatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - estimatedAt) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

function explorerUrlFor(chainId: number, txHash: string): string | null {
  // Local Anvil — no public explorer
  if (chainId === 31337) return null;
  if (chainId === 1) return `https://etherscan.io/tx/${txHash}`;
  if (chainId === 11155111) return `https://sepolia.etherscan.io/tx/${txHash}`;
  if (chainId === 8453) return `https://basescan.org/tx/${txHash}`;
  if (chainId === 42161) return `https://arbiscan.io/tx/${txHash}`;
  // Generic chainlist fallback
  return `https://blockscan.com/tx/${txHash}`;
}

export function WithdrawModal({ nodeType, balances, open, onClose }: WithdrawModalProps) {
  const { submit, getReceipt } = useWalletWithdraw();
  const [step, setStep] = useState<Step>(1);
  const [chainFamily, setChainFamily] = useState<ChainFamily>('evm');
  const [token, setToken] = useState<'native' | 'USDC'>('native');
  const [recipient, setRecipient] = useState('');
  const [amount, setAmount] = useState('');
  const [recipientError, setRecipientError] = useState('');
  const [amountError, setAmountError] = useState('');
  const [gasEstimate, setGasEstimate] = useState<{ gas: string; fee: string } | null>(null);
  const [gasEstimatedAt, setGasEstimatedAt] = useState<number | null>(null);
  const [estimateError, setEstimateError] = useState('');
  const [refreshingEstimate, setRefreshingEstimate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [txResult, setTxResult] = useState<{ txHash: `0x${string}`; chainId: number } | null>(null);
  const [receipt, setReceipt] = useState<TransactionReceiptPayload | null>(null);
  const [submitError, setSubmitError] = useState('');
  const [pollExhausted, setPollExhausted] = useState(false);
  const [pollError, setPollError] = useState('');
  const [now, setNow] = useState(Date.now());

  const dialogRef = useRef<HTMLDivElement>(null);
  const firstFocusRef = useRef<HTMLButtonElement>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCancelledRef = useRef(false);

  const cancelPoll = useCallback(() => {
    pollCancelledRef.current = true;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const handleClose = useCallback(() => {
    cancelPoll();
    onClose();
  }, [cancelPoll, onClose]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setStep(1);
      setChainFamily('evm');
      setToken('native');
      setRecipient('');
      setAmount('');
      setRecipientError('');
      setAmountError('');
      setGasEstimate(null);
      setGasEstimatedAt(null);
      setEstimateError('');
      setRefreshingEstimate(false);
      setSubmitting(false);
      setTxResult(null);
      setReceipt(null);
      setSubmitError('');
      setPollExhausted(false);
      setPollError('');
      pollCancelledRef.current = false;
      setTimeout(() => firstFocusRef.current?.focus(), 50);
    } else {
      cancelPoll();
    }
  }, [open, cancelPoll]);

  // Tick clock for the "estimated <time> ago" caption while step 5 is open.
  useEffect(() => {
    if (!open || step !== 5 || gasEstimatedAt === null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [open, step, gasEstimatedAt]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, handleClose]);

  // Cleanup any in-flight poll on unmount
  useEffect(() => () => cancelPoll(), [cancelPoll]);

  if (!open) return null;

  const evmBalance = balances.find(
    (b) => b.nodeType === nodeType && b.family === 'evm' && b.token === (token === 'native' ? 'ETH' : 'USDC')
  );

  const validateAmount = (val: string, currentBalance?: WalletBalanceEntry) => {
    if (!val) return setAmountError('');
    try {
      const n = BigInt(val);
      if (n <= 0n) {
        setAmountError('Amount must be positive');
        return;
      }
      if (currentBalance?.available && currentBalance.balance) {
        if (n > BigInt(currentBalance.balance)) {
          setAmountError('Insufficient balance');
          return;
        }
      }
      setAmountError('');
    } catch {
      setAmountError('Amount must be an integer (raw units)');
    }
  };

  const handleRecipientChange = (val: string) => {
    setRecipient(val);
    if (!val) {
      setRecipientError('');
      return;
    }
    if (!isFormat(val)) {
      setRecipientError('Invalid address — must be 0x-prefixed 40-char hex');
      return;
    }
    if (!isAddress(val)) {
      setRecipientError('Invalid address — EIP-55 checksum mismatch');
      return;
    }
    setRecipientError('');
  };

  const handleAmountChange = (val: string) => {
    setAmount(val);
    validateAmount(val, evmBalance);
  };

  const handleTokenChange = (next: 'native' | 'USDC') => {
    setToken(next);
    // Re-validate amount against the new token's balance — the previous error
    // would otherwise persist (or vanish) misleadingly.
    const nextBalance = balances.find(
      (b) => b.nodeType === nodeType && b.family === 'evm' && b.token === (next === 'native' ? 'ETH' : 'USDC'),
    );
    validateAmount(amount, nextBalance);
  };

  const handleMaxClick = () => {
    if (!evmBalance?.available || !evmBalance.balance) return;
    // For native ETH the server will refuse `balance` exactly because gas is
    // paid in the same denomination — leave headroom by knocking off a small
    // pessimistic buffer (0.001 ETH = 1e15 wei). USDC pays gas in ETH so the
    // full balance is fine.
    const balance = BigInt(evmBalance.balance);
    const buffer = token === 'native' ? 1_000_000_000_000_000n : 0n;
    const maxAmount = balance > buffer ? (balance - buffer).toString() : balance.toString();
    handleAmountChange(maxAmount);
  };

  const canGoToStep3 = chainFamily === 'evm';
  const canGoToStep4 = canGoToStep3 && !recipientError && recipient;
  const canGoToStep5 = canGoToStep4 && !amountError && amount;

  const fetchEstimate = async () => {
    setRefreshingEstimate(true);
    setEstimateError('');
    try {
      const req: WithdrawRequest = { nodeType, chainFamily: 'evm', token, recipient, amount, dryRun: true };
      const res = await submit(req);
      if ('estimatedGas' in res) {
        setGasEstimate({ gas: res.estimatedGas, fee: res.estimatedFee });
        setGasEstimatedAt(Date.now());
      } else {
        setEstimateError('Estimate unavailable.');
        setGasEstimate(null);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Estimate failed';
      setEstimateError(msg);
      setGasEstimate(null);
    } finally {
      setRefreshingEstimate(false);
    }
  };

  const handleReview = async () => {
    if (!canGoToStep5) return;
    setSubmitting(true);
    await fetchEstimate();
    setSubmitting(false);
    setStep(5);
  };

  const handleSubmit = async () => {
    setSubmitting(true);
    setSubmitError('');
    pollCancelledRef.current = false;
    try {
      const req: WithdrawRequest = { nodeType, chainFamily: 'evm', token, recipient, amount };
      const res = await submit(req);
      if (!('txHash' in res)) {
        setSubmitError('Broadcast did not return a tx hash');
        return;
      }
      const success = { txHash: res.txHash, chainId: res.chainId };
      setTxResult(success);
      setStep(6);
      // Poll for receipt up to 30 s
      let attempts = 0;
      const poll = async () => {
        if (pollCancelledRef.current) return;
        if (attempts++ >= 15) {
          setPollExhausted(true);
          return;
        }
        try {
          const r = await getReceipt(success.txHash);
          if (pollCancelledRef.current) return;
          setReceipt(r);
          if (r.status === 'pending') {
            pollTimerRef.current = setTimeout(() => void poll(), 2_000);
          }
        } catch (e) {
          if (pollCancelledRef.current) return;
          setPollError(e instanceof Error ? e.message : 'receipt fetch failed');
        }
      };
      void poll();
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : 'Broadcast failed');
    } finally {
      setSubmitting(false);
    }
  };

  const retryPoll = () => {
    if (!txResult?.txHash) return;
    setPollExhausted(false);
    setPollError('');
    pollCancelledRef.current = false;
    let attempts = 0;
    const poll = async () => {
      if (pollCancelledRef.current) return;
      if (attempts++ >= 15) {
        setPollExhausted(true);
        return;
      }
      try {
        const r = await getReceipt(txResult.txHash);
        if (pollCancelledRef.current) return;
        setReceipt(r);
        if (r.status === 'pending') {
          pollTimerRef.current = setTimeout(() => void poll(), 2_000);
        }
      } catch (e) {
        if (pollCancelledRef.current) return;
        setPollError(e instanceof Error ? e.message : 'receipt fetch failed');
      }
    };
    void poll();
  };

  const explorer = txResult ? explorerUrlFor(txResult.chainId, txResult.txHash) : null;

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Withdraw funds"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="bg-canvas shadow-border rounded-lg p-6 w-full max-w-md flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-geist-sans font-semibold text-ink tracking-tight-16">Withdraw</h2>
          <button
            ref={firstFocusRef}
            type="button"
            className="font-geist-sans text-xs text-ink/50 hover:text-ink"
            onClick={handleClose}
            aria-label="Close withdraw modal"
          >
            ✕
          </button>
        </div>

        {/* Live region — announces step transitions to screen readers. */}
        <p role="status" aria-live="polite" className="sr-only">
          Step {step} of 6
        </p>

        {/* Step 1: Chain family */}
        {step === 1 && (
          <div className="flex flex-col gap-3">
            <p className="font-geist-sans text-sm text-ink">Select chain</p>
            {(['evm', 'solana', 'mina'] as ChainFamily[]).map((f) => {
              const captionId = `withdraw-chain-${f}-caption`;
              const disabled = f !== 'evm';
              return (
                <label key={f} className={`flex items-center gap-2 ${disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}>
                  <input
                    type="radio"
                    name="chainFamily"
                    value={f}
                    checked={chainFamily === f}
                    disabled={disabled}
                    onChange={() => setChainFamily(f)}
                    aria-describedby={disabled ? captionId : undefined}
                  />
                  <span className="font-geist-sans text-sm text-ink">
                    {f === 'evm' ? 'EVM' : f === 'solana' ? 'Solana' : 'Mina'}
                  </span>
                  {disabled && (
                    <span id={captionId} className="font-geist-sans text-xs text-ink/40">
                      ({f === 'solana' ? 'Solana' : 'Mina'} withdrawal coming soon — copy the address and use an external wallet for now)
                    </span>
                  )}
                </label>
              );
            })}
            <Button onClick={() => setStep(2)} disabled={!canGoToStep3}>Next →</Button>
          </div>
        )}

        {/* Step 2: Token selector */}
        {step === 2 && (
          <div className="flex flex-col gap-3">
            <p className="font-geist-sans text-sm text-ink">Select token</p>
            {(['native', 'USDC'] as const).map((t) => (
              <label key={t} className="flex items-center gap-2 cursor-pointer">
                <input type="radio" name="token" value={t} checked={token === t} onChange={() => handleTokenChange(t)} />
                <span className="font-geist-sans text-sm text-ink">{t === 'native' ? 'ETH' : 'USDC'}</span>
              </label>
            ))}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStep(1)}>← Back</Button>
              <Button onClick={() => setStep(3)}>Next →</Button>
            </div>
          </div>
        )}

        {/* Step 3: Recipient */}
        {step === 3 && (
          <div className="flex flex-col gap-3">
            <label className="font-geist-sans text-sm text-ink" htmlFor="withdraw-recipient">Recipient address</label>
            <Input
              id="withdraw-recipient"
              value={recipient}
              onChange={(e) => handleRecipientChange((e.target as HTMLInputElement).value)}
              placeholder="0x..."
              aria-describedby={recipientError ? 'withdraw-recipient-error' : undefined}
            />
            {recipientError && (
              <p id="withdraw-recipient-error" className="font-geist-sans text-xs text-red-500">{recipientError}</p>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStep(2)}>← Back</Button>
              <Button onClick={() => setStep(4)} disabled={!canGoToStep4}>Next →</Button>
            </div>
          </div>
        )}

        {/* Step 4: Amount */}
        {step === 4 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <label className="font-geist-sans text-sm text-ink" htmlFor="withdraw-amount">Amount (raw units)</label>
              {evmBalance?.available && (
                <button type="button" className="font-geist-sans text-xs text-ink/50 hover:text-ink" onClick={handleMaxClick}>Max</button>
              )}
            </div>
            <Input
              id="withdraw-amount"
              value={amount}
              onChange={(e) => handleAmountChange((e.target as HTMLInputElement).value)}
              placeholder="e.g. 100000000000000000"
              aria-describedby={amountError ? 'withdraw-amount-error' : undefined}
            />
            {amountError && (
              <p id="withdraw-amount-error" className="font-geist-sans text-xs text-red-500">{amountError}</p>
            )}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStep(3)}>← Back</Button>
              <Button onClick={() => void handleReview()} disabled={!canGoToStep5 || submitting}>
                {submitting ? 'Estimating…' : 'Review →'}
              </Button>
            </div>
          </div>
        )}

        {/* Step 5: Review */}
        {step === 5 && (
          <div className="flex flex-col gap-3">
            <p className="font-geist-sans text-sm font-medium text-ink">Review transaction</p>
            <dl className="flex flex-col gap-1">
              <div className="flex justify-between">
                <dt className="font-geist-sans text-xs text-ink/50">Recipient</dt>
                <dd className="font-geist-mono text-xs text-ink">{truncateHash(recipient)}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="font-geist-sans text-xs text-ink/50">Amount</dt>
                <dd className="font-geist-mono text-xs text-ink">{amount}</dd>
              </div>
              {gasEstimate && (
                <div className="flex justify-between items-baseline">
                  <dt className="font-geist-sans text-xs text-ink/50">Est. gas fee</dt>
                  <dd className="font-geist-mono text-xs text-ink">{gasEstimate.fee} wei</dd>
                </div>
              )}
              {gasEstimate && gasEstimatedAt !== null && (
                <div className="flex justify-between items-baseline">
                  <dt className="font-geist-sans text-xs text-ink/40">
                    estimated {relativeTime(gasEstimatedAt, now)}
                  </dt>
                  <dd>
                    <button
                      type="button"
                      className="font-geist-sans text-xs text-ink/60 hover:text-ink underline-offset-2 hover:underline disabled:opacity-50"
                      onClick={() => void fetchEstimate()}
                      disabled={refreshingEstimate}
                    >
                      {refreshingEstimate ? 'Refreshing…' : 'Refresh estimate'}
                    </button>
                  </dd>
                </div>
              )}
            </dl>
            {estimateError && <p className="font-geist-sans text-xs text-red-500">{estimateError}</p>}
            {submitError && <p className="font-geist-sans text-xs text-red-500">{submitError}</p>}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setStep(4)}>← Back</Button>
              <Button onClick={() => void handleSubmit()} disabled={submitting}>
                {submitting ? 'Broadcasting…' : 'Send'}
              </Button>
            </div>
          </div>
        )}

        {/* Step 6: Result */}
        {step === 6 && txResult && (
          <div className="flex flex-col gap-3">
            {receipt?.status === 'reverted' ? (
              <p className="font-geist-sans text-sm text-red-500">Transaction reverted.</p>
            ) : receipt?.status === 'success' ? (
              <p className="font-geist-sans text-sm text-green-600">Transaction confirmed ✓</p>
            ) : pollExhausted ? (
              <div className="flex flex-col gap-2">
                <p className="font-geist-sans text-sm text-ink/70">
                  Receipt not seen after 30 seconds. The transaction may still confirm.
                </p>
                <button
                  type="button"
                  className="font-geist-sans text-xs text-ink/60 hover:text-ink underline-offset-2 hover:underline self-start"
                  onClick={retryPoll}
                >
                  Retry
                </button>
              </div>
            ) : pollError ? (
              <div className="flex flex-col gap-2">
                <p className="font-geist-sans text-sm text-red-500">Receipt fetch failed: {pollError}</p>
                <button
                  type="button"
                  className="font-geist-sans text-xs text-ink/60 hover:text-ink underline-offset-2 hover:underline self-start"
                  onClick={retryPoll}
                >
                  Retry
                </button>
              </div>
            ) : (
              <p className="font-geist-sans text-sm text-ink/60">Waiting for confirmation…</p>
            )}
            <div className="flex items-center gap-2">
              <code className="font-geist-mono text-xs text-ink">{truncateHash(txResult.txHash)}</code>
              <button
                type="button"
                className="font-geist-sans text-xs text-ink/50 hover:text-ink"
                onClick={() => void navigator.clipboard.writeText(txResult.txHash)}
                aria-label="Copy transaction hash"
              >
                Copy
              </button>
              {explorer && (
                <a
                  href={explorer}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-geist-sans text-xs text-ink/60 hover:text-ink underline-offset-2 hover:underline"
                >
                  View on explorer →
                </a>
              )}
            </div>
            {!explorer && (
              <p className="font-geist-sans text-xs text-ink/40">Local Anvil chain — no public explorer</p>
            )}
            <Button onClick={handleClose}>Close</Button>
          </div>
        )}
      </div>
    </div>
  );
}
