import { useEffect, useState } from 'react';
import type { ChainProviderEntry } from '@toon-protocol/townhouse';
import { Button } from './primitives/Button';
import { ChainAddForm } from './ChainAddForm';
import { useChains } from '@/hooks/useChains';
import { useChainsPatch } from '@/hooks/useChainsPatch';

// Re-exported for back-compat with existing tests.
export { buildEntryFromForm } from './ChainAddForm';

function describe(c: ChainProviderEntry): string {
  if (c.chainType === 'evm') return `RPC ${c.rpcUrl}`;
  if (c.chainType === 'solana')
    return `RPC ${c.rpcUrl} · program ${c.programId}`;
  return `GraphQL ${c.graphqlUrl} · zkApp ${c.zkAppAddress}`;
}

/** Upsert by chainId. */
function upsert(
  list: ChainProviderEntry[],
  entry: ChainProviderEntry
): ChainProviderEntry[] {
  return [...list.filter((c) => c.chainId !== entry.chainId), entry];
}

/**
 * Editable settlement-chain panel (Settings view). Lists configured chains,
 * supports add (adaptive per chain type) + remove, and PATCHes the whole list
 * to /api/chains (which validates + restarts the connector). Keys are
 * write-only — the API returns them redacted as '***'.
 */
export function ChainsPanel(): JSX.Element {
  const { chains, kind, refetch } = useChains();
  const { patch, pending, error: patchError } = useChainsPatch();
  const [draft, setDraft] = useState<ChainProviderEntry[]>([]);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (kind === 'ready') setDraft(chains);
  }, [kind, chains]);

  function handleRemove(chainId: string): void {
    setSuccess(null);
    setDraft((d) => d.filter((c) => c.chainId !== chainId));
  }

  function handleSave(): void {
    setSuccess(null);
    void patch(draft, () => {
      refetch();
      setSuccess('Settlement chains saved — the connector is restarting.');
    }).catch(() => {
      /* error surfaces via patchError */
    });
  }

  return (
    <section aria-labelledby="chains-heading">
      <h2
        id="chains-heading"
        className="font-geist-sans text-lg font-semibold text-ink tracking-tight-20 mb-1"
      >
        Settlement chains
      </h2>
      <p className="font-geist-sans text-sm text-ink/60 mb-4">
        Chains the connector settles ILP payment claims on (EVM, Solana, Mina).
        Signing keys are write-only — shown as <code>***</code>. Saving restarts
        the connector.
      </p>

      {kind === 'loading' && (
        <p className="font-geist-sans text-sm text-ink/50">Loading…</p>
      )}
      {kind === 'error' && (
        <p className="font-geist-sans text-sm text-red-600">
          Couldn&apos;t load settlement chains.
        </p>
      )}

      {kind !== 'loading' && (
        <>
          <ul className="flex flex-col gap-2 mb-4">
            {draft.length === 0 && (
              <li className="font-geist-sans text-sm text-ink/50">
                No chains configured — the connector uses a built-in dev
                placeholder.
              </li>
            )}
            {draft.map((c) => (
              <li
                key={c.chainId}
                className="flex items-center justify-between gap-3 rounded-md border border-ink/10 px-3 py-2"
              >
                <div className="flex flex-col">
                  <span className="font-geist-sans text-sm font-medium text-ink">
                    {c.chainType.toUpperCase()} · {c.chainId}
                  </span>
                  <span className="font-geist-sans text-xs text-ink/60">
                    {describe(c)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemove(c.chainId)}
                  aria-label={`Remove ${c.chainId}`}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>

          <div className="mb-4">
            <ChainAddForm
              onAdd={(entry) => {
                setSuccess(null);
                setDraft((d) => upsert(d, entry));
              }}
            />
          </div>

          <div className="flex items-center gap-3">
            <Button variant="primary" onClick={handleSave} disabled={pending}>
              {pending ? 'Applying…' : 'Apply chains & restart connector'}
            </Button>
            {success && (
              <span className="font-geist-sans text-sm text-green-700">
                {success}
              </span>
            )}
            {patchError && (
              <span className="font-geist-sans text-sm text-red-600">
                {patchError}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
