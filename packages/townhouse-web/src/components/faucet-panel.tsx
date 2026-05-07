/**
 * FaucetPanel — operator dev faucet for Town EVM + SOL devnets.
 *
 * Compact card with chain toggle (EVM / SOL), recipient input, optional
 * amount, and Drip button. Result row shows tx hash and a clickable
 * block-explorer link when one is resolvable from `leases.json`.
 *
 * Posts to `POST /api/faucet`. The route validates the recipient against
 * per-chain regex; this component mirrors the same regex so users get
 * inline feedback before round-tripping.
 *
 * Mounted in the operator dashboard's right column below StatusPills (D9
 * left budget for it). Hidden by default in any non-demo preset.
 */

import * as React from 'react';

import { Button } from './primitives/Button';
import { Input } from './primitives/Input';

type Chain = 'evm' | 'solana';

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_PUBKEY_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const DEFAULT_AMOUNTS: Record<Chain, number> = {
  evm: 100, // USDC; route also tops up 1 ETH
  solana: 100, // USDC; route also tops up 1 SOL
};

const AMOUNT_LABELS: Record<Chain, string> = {
  evm: 'USDC (+1 ETH)',
  solana: 'USDC (+1 SOL)',
};

const PLACEHOLDERS: Record<Chain, string> = {
  evm: '0xRecipient…',
  solana: 'Base58 pubkey',
};

interface FaucetSuccess {
  tx: string;
  explorerUrl?: string;
  recipient: string;
  chain: Chain;
}

interface FaucetError {
  error: string;
}

type FaucetState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | { kind: 'success'; result: FaucetSuccess }
  | { kind: 'error'; message: string };

const FAUCET_ENDPOINT = '/api/faucet';

export function FaucetPanel(): React.JSX.Element {
  const [chain, setChain] = React.useState<Chain>('evm');
  const [recipient, setRecipient] = React.useState('');
  const [amount, setAmount] = React.useState<string>('');
  const [state, setState] = React.useState<FaucetState>({ kind: 'idle' });

  const recipientRe = chain === 'evm' ? EVM_ADDRESS_RE : SOLANA_PUBKEY_RE;
  const recipientValid =
    recipient.length === 0 || recipientRe.test(recipient.trim());
  const canDrip =
    recipient.trim().length > 0 && recipientValid && state.kind !== 'pending';

  async function handleDrip() {
    setState({ kind: 'pending' });
    const numericAmount = amount.trim() === '' ? undefined : Number(amount);
    try {
      const res = await fetch(FAUCET_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chain,
          recipient: recipient.trim(),
          amount: Number.isFinite(numericAmount) ? numericAmount : undefined,
        }),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as FaucetError;
        throw new Error(errBody.error ?? `HTTP ${res.status}`);
      }
      const result = (await res.json()) as FaucetSuccess;
      setState({ kind: 'success', result });
    } catch (err) {
      setState({
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleSwitchChain(next: Chain) {
    if (next === chain) return;
    setChain(next);
    // Recipient + amount don't roundtrip across chain types.
    setRecipient('');
    setAmount('');
    setState({ kind: 'idle' });
  }

  return (
    <section
      aria-label="Faucet"
      data-testid="faucet-panel"
      className="rounded-xl shadow-border bg-card p-3"
    >
      <header className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-ink">Faucet</h3>
        <div
          role="tablist"
          aria-label="Faucet chain"
          className="inline-flex shadow-border rounded-md overflow-hidden"
        >
          <button
            type="button"
            role="tab"
            aria-selected={chain === 'evm'}
            onClick={() => handleSwitchChain('evm')}
            className={`px-2 py-1 text-xs font-medium ${
              chain === 'evm' ? 'bg-ink text-canvas' : 'bg-canvas text-ink hover:bg-ink/5'
            }`}
            data-testid="faucet-tab-evm"
          >
            EVM
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={chain === 'solana'}
            onClick={() => handleSwitchChain('solana')}
            className={`px-2 py-1 text-xs font-medium ${
              chain === 'solana' ? 'bg-ink text-canvas' : 'bg-canvas text-ink hover:bg-ink/5'
            }`}
            data-testid="faucet-tab-solana"
          >
            SOL
          </button>
        </div>
      </header>

      <div className="grid grid-cols-[1fr_88px_auto] gap-2 items-stretch">
        <Input
          aria-label="Recipient"
          placeholder={PLACEHOLDERS[chain]}
          value={recipient}
          onChange={(e) => setRecipient(e.target.value)}
          aria-invalid={!recipientValid}
          data-testid="faucet-recipient"
        />
        <Input
          aria-label="Amount"
          placeholder={String(DEFAULT_AMOUNTS[chain])}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          inputMode="decimal"
          data-testid="faucet-amount"
        />
        <Button
          variant="primary"
          size="md"
          onClick={handleDrip}
          disabled={!canDrip}
          loading={state.kind === 'pending'}
          data-testid="faucet-drip"
        >
          Drip
        </Button>
      </div>

      <p className="mt-1 text-[11px] text-ink/60">
        Default: {DEFAULT_AMOUNTS[chain]} {AMOUNT_LABELS[chain]}
      </p>

      {state.kind === 'error' && (
        <p
          role="alert"
          className="mt-2 text-xs text-rose-600"
          data-testid="faucet-error"
        >
          {state.message}
        </p>
      )}

      {state.kind === 'success' && (
        <div
          className="mt-2 flex items-center gap-2 text-xs text-ink"
          data-testid="faucet-success"
        >
          <span className="font-geist-mono truncate" title={state.result.tx}>
            ✓ {state.result.tx.slice(0, 18)}…
          </span>
          {state.result.explorerUrl && (
            <a
              href={state.result.explorerUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-ink underline hover:no-underline"
              data-testid="faucet-explorer-link"
            >
              View ↗
            </a>
          )}
        </div>
      )}
    </section>
  );
}
