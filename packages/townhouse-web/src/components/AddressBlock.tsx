import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { ChainIcon } from '@/components/primitives/ChainIcon';
import { TokenIcon } from '@/components/primitives/TokenIcon';
import { MetricBlock } from '@/components/primitives/MetricBlock';
import { formatVolume } from '@/lib/format-volume';
import { colors } from '@/theme/tokens';
import { cn } from '@/lib/utils';

export interface AddressBlockProps {
  family: 'evm' | 'solana' | 'mina';
  token: 'ETH' | 'USDC' | 'SOL' | 'MINA';
  address: string;
  derivationPath: string;
  /** Node type for accent color on derivation path account index */
  nodeType?: 'town' | 'mill' | 'dvm';
  /** Raw decimal string; absent renders '—' */
  balance?: string;
  /** Decimal places for display formatting */
  scale?: number;
  /** false renders 'unavailable' caption */
  available?: boolean;
}

const ACCENT_CLASS: Record<string, string> = {
  town: 'text-type-town',
  mill: 'text-type-mill',
  dvm: 'text-type-dvm',
};

/** Parse derivation path and wrap the account-index *digit* with an accent span.
 *  Spec example wraps the bare `0` in `m/44'/60'/0'/0/0`, not the hardened `0'`,
 *  so the accent only paints the numeric portion of the segment. */
function formatDerivationPath(path: string, accentClass: string): React.ReactElement {
  const parts = path.split('/');
  return (
    <span>
      {parts.map((part, i) => {
        if (i > 0 && i === 3) {
          // Account segment — split off optional hardened tick so the accent
          // wraps the digit only.
          const match = /^(\d+)('?)$/.exec(part);
          if (match) {
            return (
              <span key={i}>
                /
                <span className={accentClass}>{match[1]}</span>
                {match[2]}
              </span>
            );
          }
        }
        return <span key={i}>{i > 0 && '/'}{part}</span>;
      })}
    </span>
  );
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function AddressBlock({
  family,
  token,
  address,
  derivationPath,
  nodeType,
  balance,
  scale = 18,
  available = true,
}: AddressBlockProps) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'err'>('idle');
  const [qrOpen, setQrOpen] = useState(false);

  const accentClass = nodeType ? (ACCENT_CLASS[nodeType] ?? '') : '';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied('ok');
      setTimeout(() => setCopied('idle'), 1500);
    } catch {
      setCopied('err');
      setTimeout(() => setCopied('idle'), 1500);
    }
  };

  const displayBalance = !available
    ? '—'
    : balance !== undefined
      ? formatVolume(balance, scale)
      : '—';

  return (
    <div className="shadow-border rounded-md p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <ChainIcon chain={family} size={16} />
        <TokenIcon token={token} size={16} />
        <code
          className="font-geist-mono text-xs text-ink min-w-0 flex-1 truncate"
          title={address}
          aria-label={`${token} address: ${address}`}
        >
          {truncateAddress(address)}
        </code>
        <button
          type="button"
          className="font-geist-sans text-xs text-ink/50 hover:text-ink shrink-0"
          onClick={() => void handleCopy()}
          aria-label={`Copy ${token} address`}
        >
          {copied === 'ok' ? 'Copied ✓' : copied === 'err' ? 'Error' : 'Copy'}
        </button>
      </div>

      <div className="flex items-center justify-between gap-2">
        <span
          className={cn('font-geist-mono text-xs text-ink/50')}
          aria-label={`Derivation path: ${derivationPath}`}
        >
          {formatDerivationPath(derivationPath, accentClass)}
        </span>
        <MetricBlock
          value={displayBalance}
          label={token}
          variant="compact"
          aria-label={available ? `${token} balance: ${displayBalance}` : `${token} balance unavailable`}
        />
      </div>

      <details onToggle={(e) => setQrOpen((e.target as HTMLDetailsElement).open)}>
        <summary className="font-geist-sans text-xs text-ink/50 hover:text-ink cursor-pointer">
          {qrOpen ? 'Hide QR' : 'QR'}
        </summary>
        <div className="mt-2 flex flex-col items-start gap-1">
          <div className="shadow-border rounded p-2 inline-flex">
            <QRCodeSVG
              value={address}
              size={128}
              fgColor={colors.ink}
              bgColor={colors.canvas}
              level="M"
              aria-label={`Deposit address QR code: ${truncateAddress(address)}`}
            />
          </div>
          <span className="font-geist-mono text-xs text-ink/50 break-all">{address}</span>
        </div>
      </details>
    </div>
  );
}
