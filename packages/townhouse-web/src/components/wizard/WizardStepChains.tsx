import type { ChainProviderEntry } from '@toon-protocol/townhouse';
import { Button } from '@/components/primitives/Button';
import { ChainAddForm } from '@/components/ChainAddForm';

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
 * Optional setup-wizard step: configure the settlement chains the node will
 * settle payment claims on. Skippable — chains can also be added later in
 * Settings; the connector starts with a dev placeholder otherwise.
 */
export function WizardStepChains({
  chains,
  onChange,
  onContinue,
  onBack,
}: WizardStepChainsProps): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h2 className="font-geist-sans text-xl font-semibold text-ink tracking-tight-20">
          Settlement chains
        </h2>
        <p className="font-geist-sans text-sm text-ink/60 mt-1">
          Optional. Add the chains your node settles payments on (EVM, Solana,
          Mina). You can skip this and configure chains later in Settings — the
          connector starts with a dev placeholder otherwise.
        </p>
      </div>

      {chains.length > 0 && (
        <ul className="flex flex-col gap-2">
          {chains.map((c) => (
            <li
              key={c.chainId}
              className="flex items-center justify-between gap-3 rounded-md border border-ink/10 px-3 py-2"
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

      <div className="flex items-center justify-between gap-3 pt-2">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button variant="primary" onClick={onContinue}>
          {chains.length > 0 ? 'Continue' : 'Skip for now'}
        </Button>
      </div>
    </div>
  );
}
