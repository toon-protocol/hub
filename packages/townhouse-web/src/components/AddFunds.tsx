import { useState } from 'react';
import { useDepositAddresses } from '@/hooks/useDepositAddresses';

export interface AddFundsProps {
  nodeId: string;
}

export function AddFunds({ nodeId }: AddFundsProps) {
  const { chains, status } = useDepositAddresses({ nodeId });
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopy = async (address: string, index: number) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedIndex(index);
      setTimeout(() => setCopiedIndex(null), 1500);
    } catch {
      setCopiedIndex(-1);
      setTimeout(() => setCopiedIndex(null), 1500);
    }
  };

  return (
    <details>
      <summary className="font-geist-sans cursor-pointer text-sm text-ink/70 hover:text-ink">
        Add Funds
      </summary>
      <div className="mt-2 flex flex-col gap-1.5">
        {status === 'loading' && (
          <p className="text-xs text-ink/40">Loading deposit addresses…</p>
        )}
        {status === 'error' && (
          <p className="text-xs text-ink/40">Could not load deposit addresses.</p>
        )}
        {status === 'ready' &&
          chains.map((entry, i) => {
            const family = entry.family;
            return (
              <div key={family} className="flex items-center gap-2">
                <span className="font-geist-mono text-xs text-ink/50 w-12">{family}</span>
                <code className="font-geist-mono min-w-0 flex-1 truncate text-xs text-ink">
                  {entry.address}
                </code>
                <button
                  type="button"
                  className="font-geist-sans shrink-0 text-xs text-ink/50 hover:text-ink"
                  onClick={() => void handleCopy(entry.address, i)}
                  aria-label={`Copy ${family} deposit address`}
                >
                  {copiedIndex === i ? 'Copied ✓' : copiedIndex === -1 ? 'Error' : 'Copy'}
                </button>
              </div>
            );
          })}
      </div>
    </details>
  );
}
