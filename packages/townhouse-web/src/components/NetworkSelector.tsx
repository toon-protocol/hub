import type { NetworkMode } from '@toon-protocol/townhouse';
import type { NetworkFamilyStatus, NetworkNodeEnv } from '@/hooks/useNetwork';

export interface NetworkSelectorProps {
  /** Currently selected network mode. */
  value: NetworkMode;
  /** Fired when the operator picks a different mode. */
  onChange: (mode: NetworkMode) => void;
  /** Per-family settlement readiness (from GET /api/network). */
  status?: NetworkFamilyStatus;
  /** Resolved read-only endpoints for the non-custom tiers. */
  nodeEnv?: NetworkNodeEnv;
  /** Operator-entered EVM RPC URL (controlled; only used in custom mode). */
  evmUrl?: string;
  /** Operator-entered Solana RPC URL (controlled; only used in custom mode). */
  solUrl?: string;
  /** Fired when either RPC URL input changes. */
  onEndpointsChange?: (evmUrl: string, solUrl: string) => void;
  /** Disable the whole control while a PATCH is in flight. */
  disabled?: boolean;
}

interface ModeMeta {
  mode: NetworkMode;
  label: string;
  blurb: string;
  isDefault?: boolean;
}

const MODES: ModeMeta[] = [
  {
    mode: 'mainnet',
    label: 'Mainnet',
    blurb: 'Public Base + Arbitrum, Solana mainnet-beta, Mina mainnet.',
    isDefault: true,
  },
  {
    mode: 'testnet',
    label: 'Testnet',
    blurb: 'Base / Arbitrum Sepolia, Solana testnet, Mina devnet.',
  },
  {
    mode: 'devnet',
    label: 'Devnet',
    blurb: 'Public Sepolia plus Solana / Mina public devnets.',
  },
  {
    mode: 'custom',
    label: 'Custom',
    blurb:
      "Paste RPC URLs to point at the project's dev chains (e.g. the Akash-hosted anvil/solana), or use the full chain editor below to supply explicit chains, RPCs and signing keys for real chains.",
  },
];

const FAMILIES: { key: keyof NetworkFamilyStatus; label: string }[] = [
  { key: 'evm', label: 'EVM' },
  { key: 'solana', label: 'Solana' },
  { key: 'mina', label: 'Mina' },
];

/** Honest, non-alarming copy for each settlement-readiness state. */
function statusNote(state: 'configured' | 'unconfigured'): string {
  return state === 'configured'
    ? 'Settlement contracts deployed.'
    : 'RPC configured — settlement pending contract deploy.';
}

/**
 * Network-mode selector: four tiers (mainnet default / testnet / devnet /
 * custom) that drive chain + RPC for BOTH the apex connector and the child
 * nodes. The non-custom tiers render resolved read-only endpoints + per-family
 * settlement status; `custom` reveals two optional RPC-URL inputs here plus the
 * per-chain editor in the parent.
 */
export function NetworkSelector({
  value,
  onChange,
  status,
  nodeEnv,
  evmUrl,
  solUrl,
  onEndpointsChange,
  disabled,
}: NetworkSelectorProps): JSX.Element {
  return (
    <section aria-labelledby="network-heading" className="flex flex-col gap-3">
      <div>
        <h3
          id="network-heading"
          className="font-geist-sans text-sm font-semibold text-ink tracking-tight-14"
        >
          Network
        </h3>
        <p className="font-geist-sans text-xs text-ink/60 mt-0.5">
          Drives chain + RPC for the connector and every node. Changing it
          restarts the connector.
        </p>
      </div>

      <div
        className="flex flex-col gap-2"
        role="radiogroup"
        aria-label="Network mode"
      >
        {MODES.map((m) => (
          <label
            key={m.mode}
            className={`bg-canvas shadow-border rounded-lg p-3 flex items-start gap-3 ${
              disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'
            } ${value === m.mode ? 'ring-1 ring-ink/20' : ''}`}
          >
            <input
              type="radio"
              name="network-mode"
              value={m.mode}
              aria-label={m.label}
              checked={value === m.mode}
              disabled={disabled}
              onChange={() => onChange(m.mode)}
              className="mt-1 accent-ink"
            />
            <div className="flex flex-col gap-0.5">
              <span className="font-geist-sans text-sm font-medium text-ink">
                {m.label}
                {m.isDefault && (
                  <span className="ml-2 font-geist-sans text-[10px] uppercase tracking-tight-14 text-ink/50">
                    Default
                  </span>
                )}
              </span>
              <p className="font-geist-sans text-xs text-ink/70">{m.blurb}</p>
            </div>
          </label>
        ))}
      </div>

      {/* Custom: operator can paste RPC URLs to point at the project's dev
          chains (e.g. the Akash-hosted anvil/solana), a lighter alternative to
          the full per-chain editor rendered by the parent. */}
      {value === 'custom' && (
        <div className="rounded-md shadow-border px-3 py-3 flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-geist-sans text-xs font-medium text-ink">
              EVM RPC URL
            </span>
            <input
              type="text"
              aria-label="EVM RPC URL"
              value={evmUrl ?? ''}
              disabled={disabled}
              placeholder="https://…"
              onChange={(e) =>
                onEndpointsChange?.(e.target.value, solUrl ?? '')
              }
              className="bg-canvas shadow-border rounded-md px-2 py-1.5 font-geist-mono text-xs text-ink"
            />
            <span className="font-geist-sans text-[11px] text-green-700">
              Settlement-capable — anvil EVM with registry + token deployed.
            </span>
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-geist-sans text-xs font-medium text-ink">
              Solana RPC URL
            </span>
            <input
              type="text"
              aria-label="Solana RPC URL"
              value={solUrl ?? ''}
              disabled={disabled}
              placeholder="https://…"
              onChange={(e) =>
                onEndpointsChange?.(evmUrl ?? '', e.target.value)
              }
              className="bg-canvas shadow-border rounded-md px-2 py-1.5 font-geist-mono text-xs text-ink"
            />
            <span className="font-geist-sans text-[11px] text-ink/60">
              RPC only — settlement pending program deploy.
            </span>
          </label>
        </div>
      )}

      {/* Resolved read-only view for the non-custom tiers. */}
      {value !== 'custom' && (
        <div className="rounded-md shadow-border px-3 py-3 flex flex-col gap-3">
          {status && (
            <ul className="flex flex-col gap-1">
              {FAMILIES.map(({ key, label }) => (
                <li
                  key={key}
                  className="flex items-center justify-between gap-3"
                  data-testid={`network-status-${key}`}
                >
                  <span className="font-geist-sans text-xs font-medium text-ink">
                    {label}
                  </span>
                  <span
                    className={`font-geist-sans text-xs ${
                      status[key] === 'configured'
                        ? 'text-green-700'
                        : 'text-ink/60'
                    }`}
                  >
                    {statusNote(status[key])}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {nodeEnv && (nodeEnv.EVM_RPC_URL || nodeEnv.SOLANA_RPC_URL) && (
            <dl className="flex flex-col gap-1 shadow-[inset_0_1px_0_0_rgba(0,0,0,0.08)] pt-2">
              {nodeEnv.EVM_RPC_URL && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="font-geist-sans text-xs text-ink/60">
                    EVM RPC
                  </dt>
                  <dd className="font-geist-mono text-xs text-ink truncate max-w-[60%]">
                    {nodeEnv.EVM_RPC_URL}
                  </dd>
                </div>
              )}
              {nodeEnv.SOLANA_RPC_URL && (
                <div className="flex items-center justify-between gap-3">
                  <dt className="font-geist-sans text-xs text-ink/60">
                    Solana RPC
                  </dt>
                  <dd className="font-geist-mono text-xs text-ink truncate max-w-[60%]">
                    {nodeEnv.SOLANA_RPC_URL}
                  </dd>
                </div>
              )}
            </dl>
          )}
        </div>
      )}
    </section>
  );
}
