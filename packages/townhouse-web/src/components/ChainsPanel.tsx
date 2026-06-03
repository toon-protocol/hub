import { useEffect, useState } from 'react';
import type { ChainProviderEntry, NetworkMode } from '@toon-protocol/townhouse';
import { Button } from './primitives/Button';
import { ChainAddForm } from './ChainAddForm';
import { NetworkSelector } from './NetworkSelector';
import { useChains } from '@/hooks/useChains';
import { useChainsPatch } from '@/hooks/useChainsPatch';
import { useNetwork } from '@/hooks/useNetwork';
import { useNetworkPatch } from '@/hooks/useNetworkPatch';

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
  const { network, kind: networkKind, refetch: refetchNetwork } = useNetwork();
  const {
    patch: patchNetwork,
    pending: networkPending,
    error: networkError,
  } = useNetworkPatch();
  const [draft, setDraft] = useState<ChainProviderEntry[]>([]);
  const [success, setSuccess] = useState<string | null>(null);
  const [networkSuccess, setNetworkSuccess] = useState<string | null>(null);
  const [evmUrl, setEvmUrl] = useState('');
  const [solUrl, setSolUrl] = useState('');

  // Until the network mode resolves, default to mainnet (the API default).
  const mode: NetworkMode = network?.network ?? 'mainnet';

  useEffect(() => {
    if (kind === 'ready') setDraft(chains);
  }, [kind, chains]);

  // Seed the custom RPC URL inputs from GET /api/network once it resolves.
  useEffect(() => {
    if (network?.endpoints) {
      setEvmUrl(network.endpoints.evmUrl ?? '');
      setSolUrl(network.endpoints.solUrl ?? '');
    }
  }, [network?.endpoints]);

  function handleNetworkChange(next: NetworkMode): void {
    if (next === mode) return;
    setNetworkSuccess(null);
    void patchNetwork(
      next,
      () => {
        refetchNetwork();
        setNetworkSuccess(
          next === 'custom'
            ? 'Switched to custom — configure your chains below.'
            : `Network set to ${next} — the connector is restarting.`
        );
      },
      next === 'custom' ? { evmUrl, solUrl } : undefined
    ).catch(() => {
      /* error surfaces via networkError */
    });
  }

  function handleEndpointsChange(nextEvmUrl: string, nextSolUrl: string): void {
    setEvmUrl(nextEvmUrl);
    setSolUrl(nextSolUrl);
    // Persist the new URLs against the custom mode (no-op outside custom mode).
    if (mode !== 'custom') return;
    setNetworkSuccess(null);
    void patchNetwork(
      'custom',
      () => {
        refetchNetwork();
        setNetworkSuccess('RPC URLs saved — the connector is restarting.');
      },
      { evmUrl: nextEvmUrl, solUrl: nextSolUrl }
    ).catch(() => {
      /* error surfaces via networkError */
    });
  }

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

      <div className="mb-6">
        {networkKind === 'error' ? (
          <p className="font-geist-sans text-sm text-red-600">
            Couldn&apos;t load network configuration.
          </p>
        ) : (
          <NetworkSelector
            value={mode}
            onChange={handleNetworkChange}
            status={network?.status}
            nodeEnv={network?.nodeEnv}
            evmUrl={evmUrl}
            solUrl={solUrl}
            onEndpointsChange={handleEndpointsChange}
            disabled={networkPending || networkKind === 'loading'}
          />
        )}
        <div className="flex items-center gap-3 mt-2 min-h-[1.25rem]">
          {networkPending && (
            <span className="font-geist-sans text-sm text-ink/60">
              Applying…
            </span>
          )}
          {networkSuccess && (
            <span
              role="status"
              className="font-geist-sans text-sm text-green-700"
            >
              {networkSuccess}
            </span>
          )}
          {networkError && (
            <span role="alert" className="font-geist-sans text-sm text-red-600">
              {networkError}
            </span>
          )}
        </div>
      </div>

      {mode !== 'custom' && (
        <p className="font-geist-sans text-sm text-ink/50">
          Per-chain editing is available in <strong>custom</strong> network
          mode. The endpoints above are resolved from the selected tier.
        </p>
      )}

      {mode === 'custom' && kind === 'loading' && (
        <p className="font-geist-sans text-sm text-ink/50">Loading…</p>
      )}
      {mode === 'custom' && kind === 'error' && (
        <p className="font-geist-sans text-sm text-red-600">
          Couldn&apos;t load settlement chains.
        </p>
      )}

      {mode === 'custom' && kind !== 'loading' && (
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
                className="flex items-center justify-between gap-3 rounded-md shadow-border px-3 py-2"
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
