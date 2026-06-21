import { useState } from 'react';
import { Shell } from '@/components/primitives/Shell';
import { StateShell } from '@/components/primitives/StateShell';
import { TypeChip } from '@/components/primitives/TypeChip';
import { StatusDot } from '@/components/primitives/StatusDot';
import { MetricBlock } from '@/components/primitives/MetricBlock';
import { BreakdownPill } from '@/components/primitives/BreakdownPill';
import { Button } from '@/components/primitives/Button';
import { AddressBlock } from '@/components/AddressBlock';
import { WithdrawModal } from '@/components/WithdrawModal';
import { RevealSeedModal } from '@/components/RevealSeedModal';
import { useWalletKeys } from '@/hooks/useWalletKeys';
import { useWalletBalances } from '@/hooks/useWalletBalances';
import { formatVolume } from '@/lib/format-volume';
import type { NodeType, NodeKeyInfo, WalletBalanceEntry } from '@toon-protocol/hub';

// ── Types ─────────────────────────────────────────────────────────────────────

const NODE_TYPES: NodeType[] = ['town', 'mill', 'dvm'];

const NODE_LABELS: Record<NodeType, string> = {
  town: 'Town',
  mill: 'Mill',
  dvm: 'DVM',
};

// ── BalanceCard ───────────────────────────────────────────────────────────────

interface BalanceCardProps {
  nodeType: NodeType;
  keyInfo: NodeKeyInfo;
  entries: WalletBalanceEntry[];
}

function BalanceCard({ nodeType, keyInfo, entries }: BalanceCardProps) {
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  const evmEntries = entries.filter((e) => e.nodeType === nodeType && e.family === 'evm');
  const solEntry = entries.find((e) => e.nodeType === nodeType && e.family === 'solana');
  const minaEntry = entries.find((e) => e.nodeType === nodeType && e.family === 'mina');

  // Build BreakdownPill segments for EVM family
  const breakdownSegments = evmEntries
    .filter((e) => e.available)
    .map((e) => ({
      label: e.token,
      value: formatVolume(e.balance, e.scale),
    }));

  return (
    <>
      <div className="shadow-border rounded-lg p-4 flex flex-col gap-4">
        {/* Card header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TypeChip type={nodeType} />
            <StatusDot state="ok" />
            <span className="font-geist-sans text-sm font-medium text-ink">{NODE_LABELS[nodeType]}</span>
          </div>
        </div>

        {/* Nostr identity row */}
        <div className="shadow-border rounded-md p-3 flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="font-geist-sans text-xs text-ink/50">Nostr pubkey</span>
          </div>
          <div className="flex items-center gap-2">
            <MetricBlock
              value={`${keyInfo.nostrPubkey.slice(0, 8)}…${keyInfo.nostrPubkey.slice(-4)}`}
              label="Nostr identity"
              variant="compact"
              aria-label={`Nostr public key: ${keyInfo.nostrPubkey}`}
            />
            <button
              type="button"
              className="font-geist-sans text-xs text-ink/50 hover:text-ink shrink-0 ml-auto"
              onClick={() => void navigator.clipboard.writeText(keyInfo.nostrPubkey)}
              aria-label="Copy Nostr pubkey"
            >
              Copy
            </button>
          </div>
          <span
            className="font-geist-mono text-xs text-ink/40"
            aria-label={`Nostr derivation path: ${keyInfo.nostrDerivationPath}`}
          >
            {keyInfo.nostrDerivationPath}
          </span>
        </div>

        {/* EVM address block */}
        <div className="flex flex-col gap-2">
          {evmEntries.map((entry) => (
            <AddressBlock
              key={`${entry.token}-${entry.address}`}
              family="evm"
              token={entry.token as 'ETH' | 'USDC'}
              address={entry.address}
              derivationPath={keyInfo.evmDerivationPath}
              nodeType={nodeType}
              balance={entry.balance}
              scale={entry.scale}
              available={entry.available}
            />
          ))}
        </div>

        {/* Solana (Mill only) */}
        {solEntry && keyInfo.solanaAddress && (
          <AddressBlock
            family="solana"
            token="SOL"
            address={keyInfo.solanaAddress}
            derivationPath="m/44'/501'/1'/0/0"
            nodeType={nodeType}
            balance={solEntry.balance}
            scale={solEntry.scale}
            available={solEntry.available}
          />
        )}

        {/* Mina (Mill only) */}
        {minaEntry && keyInfo.minaAddress && (
          <AddressBlock
            family="mina"
            token="MINA"
            address={keyInfo.minaAddress}
            derivationPath="m/44'/12586'/1'/0/0"
            nodeType={nodeType}
            balance={minaEntry.balance}
            scale={minaEntry.scale}
            available={minaEntry.available}
          />
        )}

        {/* EVM total roll-up */}
        {breakdownSegments.length > 0 && (
          <BreakdownPill segments={breakdownSegments} />
        )}

        {/* Withdraw CTA */}
        <Button onClick={() => setWithdrawOpen(true)} aria-label={`Withdraw from ${NODE_LABELS[nodeType]}`}>
          Withdraw…
        </Button>
      </div>

      <WithdrawModal
        nodeType={nodeType}
        balances={entries}
        open={withdrawOpen}
        onClose={() => setWithdrawOpen(false)}
      />
    </>
  );
}

// ── WalletView ────────────────────────────────────────────────────────────────

const BACKUP_ACKED_KEY = 'hub.wallet.backupAcked';

/** Read the backup-acked timestamp safely. SSR / sandboxed environments may
 *  not expose `localStorage` at all — the guard prevents a ReferenceError at
 *  module evaluation. Only ISO-shaped values count as a valid ack to defeat
 *  truthiness traps like the literal string `"false"`. */
function readBackupAcked(): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(BACKUP_ACKED_KEY);
    if (!raw) return null;
    // Validate: parsable date.
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return null;
    return raw;
  } catch {
    return null;
  }
}

function relativeBackupAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function WalletView() {
  const { keys, status: keysStatus } = useWalletKeys();
  const { entries, status: balancesStatus } = useWalletBalances();
  const [revealOpen, setRevealOpen] = useState(false);
  const [backupAckedAt, setBackupAckedAt] = useState<string | null>(() => readBackupAcked());

  // Render skeleton until BOTH keys are known (we render one card per key) AND
  // balances have at least had a chance to populate. AND-gate previously hid
  // the spinner the moment `keys` resolved, leaving an empty page.
  const loading = keysStatus === 'loading' || balancesStatus === 'loading';
  const error = keysStatus === 'error' || balancesStatus === 'error';
  const empty = keysStatus === 'ready' && keys.length === 0;

  function handleDismissBanner() {
    const stamp = new Date().toISOString();
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(BACKUP_ACKED_KEY, stamp);
      }
    } catch { /* ignore quota / private mode */ }
    setBackupAckedAt(stamp);
  }

  return (
    <Shell
      header={
        <div className="flex items-center justify-between gap-4">
          <h1 className="font-geist-sans font-semibold text-2xl tracking-tight-24 text-ink">Wallet & Keys</h1>
        </div>
      }
    >
      <StateShell
        state={loading ? 'loading' : error ? 'error' : empty ? 'empty' : 'ready'}
        errorSlot={
          <p className="font-geist-sans text-sm text-ink/60 p-4">
            Could not load wallet. Is <code className="font-geist-mono">pnpm dev:docker</code> running?
          </p>
        }
        emptySlot={
          <p className="font-geist-sans text-sm text-ink/60 p-4">
            Wallet not initialized — run <code className="font-geist-mono">hub init</code> to derive your keys.
          </p>
        }
      >
        <div className="flex flex-col gap-6 p-4">
          {/* Backup banner */}
          {!backupAckedAt ? (
            <div className="shadow-border rounded-lg p-4 flex items-center justify-between gap-4">
              <p className="font-geist-sans text-sm text-ink">Have you backed up your seed phrase?</p>
              <div className="flex items-center gap-2">
                <Button onClick={() => setRevealOpen(true)}>Reveal seed phrase</Button>
                <button
                  type="button"
                  className="font-geist-sans text-xs text-ink/50 hover:text-ink"
                  onClick={handleDismissBanner}
                  aria-label="Dismiss backup reminder"
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : (
            <div className="shadow-border rounded-lg p-3 flex items-center justify-between gap-4">
              <p className="font-geist-sans text-xs text-ink/50">
                Last backup verified {relativeBackupAge(backupAckedAt)}
              </p>
              <button
                type="button"
                className="font-geist-sans text-xs text-ink/50 hover:text-ink"
                onClick={() => setRevealOpen(true)}
              >
                Reveal again
              </button>
            </div>
          )}

          {/* Balance cards */}
          <div className="flex flex-col gap-4">
            {NODE_TYPES.map((nodeType) => {
              const keyInfo = keys.find((k) => k.nodeType === nodeType);
              if (!keyInfo) return null;
              return (
                <BalanceCard
                  key={nodeType}
                  nodeType={nodeType}
                  keyInfo={keyInfo}
                  entries={entries}
                />
              );
            })}
          </div>
        </div>
      </StateShell>

      <RevealSeedModal open={revealOpen} onClose={() => setRevealOpen(false)} />
    </Shell>
  );
}
