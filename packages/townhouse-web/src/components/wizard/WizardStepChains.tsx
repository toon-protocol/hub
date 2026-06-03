import { useEffect, useState } from 'react';
import type { ChainProviderEntry, NetworkMode } from '@toon-protocol/townhouse';
import { Button } from '@/components/primitives/Button';
import { ChainAddForm } from '@/components/ChainAddForm';
import { NetworkSelector } from '@/components/NetworkSelector';
import { useNetwork } from '@/hooks/useNetwork';
import { useNetworkPatch } from '@/hooks/useNetworkPatch';

export interface WizardStepChainsProps {
  chains: ChainProviderEntry[];
  onChange: (chains: ChainProviderEntry[]) => void;
  onContinue: () => void;
  onBack: () => void;
}

function upsert(
  list: ChainProviderEntry[],
  entry: ChainProviderEntry
): ChainProviderEntry[] {
  return [...list.filter((c) => c.chainId !== entry.chainId), entry];
}

/**
 * Optional setup-wizard step: pick the network tier the node runs on
 * (mainnet / testnet / devnet / custom). The tier drives chain + RPC for the
 * connector and every node and is persisted via PATCH /api/network (the wizard
 * init request has no network field — this step persists eagerly on change,
 * mirroring how the privacy step fires its side-effect). `custom` reveals the
 * per-chain editor, whose entries flow into the wizard draft and init request.
 */
export function WizardStepChains({
  chains,
  onChange,
  onContinue,
  onBack,
}: WizardStepChainsProps): JSX.Element {
  const { network, kind: networkKind, refetch } = useNetwork();
  const {
    patch: patchNetwork,
    pending,
    error: networkError,
  } = useNetworkPatch();

  // Local optimistic mode so the editor reveals immediately on `custom`, even
  // before the PATCH/refetch round-trips. Falls back to the resolved value.
  const [localMode, setLocalMode] = useState<NetworkMode | null>(null);
  const mode: NetworkMode = localMode ?? network?.network ?? 'mainnet';

  // Local custom RPC URLs, seeded from GET once it resolves.
  const [evmUrl, setEvmUrl] = useState('');
  const [solUrl, setSolUrl] = useState('');
  useEffect(() => {
    if (network?.endpoints) {
      setEvmUrl(network.endpoints.evmUrl ?? '');
      setSolUrl(network.endpoints.solUrl ?? '');
    }
  }, [network?.endpoints]);

  function handleNetworkChange(next: NetworkMode): void {
    if (next === mode) return;
    setLocalMode(next);
    void patchNetwork(
      next,
      () => refetch(),
      next === 'custom' ? { evmUrl, solUrl } : undefined
    ).catch(() => {
      /* error surfaces via networkError; localMode keeps the UI responsive */
    });
  }

  function handleEndpointsChange(nextEvmUrl: string, nextSolUrl: string): void {
    setEvmUrl(nextEvmUrl);
    setSolUrl(nextSolUrl);
    if (mode !== 'custom') return;
    void patchNetwork('custom', () => refetch(), {
      evmUrl: nextEvmUrl,
      solUrl: nextSolUrl,
    }).catch(() => {
      /* error surfaces via networkError */
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-geist-sans text-xl font-semibold text-ink tracking-tight-20">
          Network
        </h2>
        <p className="font-geist-sans text-sm text-ink/60 mt-1">
          Pick the network tier your node runs on. Defaults to mainnet. Choose
          custom to supply explicit chains, RPCs and signing keys.
        </p>
      </div>

      <NetworkSelector
        value={mode}
        onChange={handleNetworkChange}
        status={network?.status}
        nodeEnv={network?.nodeEnv}
        evmUrl={evmUrl}
        solUrl={solUrl}
        onEndpointsChange={handleEndpointsChange}
        disabled={pending || networkKind === 'loading'}
      />
      {networkError && (
        <p role="alert" className="font-geist-sans text-sm text-red-600">
          {networkError}
        </p>
      )}

      {mode === 'custom' && (
        <>
          {chains.length > 0 && (
            <ul className="flex flex-col gap-2">
              {chains.map((c) => (
                <li
                  key={c.chainId}
                  className="flex items-center justify-between gap-3 rounded-md shadow-border px-3 py-2"
                >
                  <span className="font-geist-sans text-sm font-medium text-ink">
                    {c.chainType.toUpperCase()} · {c.chainId}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      onChange(chains.filter((x) => x.chainId !== c.chainId))
                    }
                    aria-label={`Remove ${c.chainId}`}
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <ChainAddForm onAdd={(entry) => onChange(upsert(chains, entry))} />
        </>
      )}

      <div className="flex items-center justify-between gap-3 pt-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
