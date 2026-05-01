import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { MnemonicGrid } from '@/components/primitives/MnemonicGrid';
import { useWalletReveal } from '@/hooks/useWalletReveal';

export interface RevealSeedModalProps {
  open: boolean;
  onClose: () => void;
}

export function RevealSeedModal({ open, onClose }: RevealSeedModalProps) {
  const { reveal } = useWalletReveal();
  const [password, setPassword] = useState('');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  const firstFocusRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPassword('');
      setMnemonic(null);
      setError('');
      setLoading(false);
      setCopied(false);
      setTimeout(() => firstFocusRef.current?.focus(), 50);
    }
  }, [open]);

  const handleClose = () => {
    // Drop the mnemonic reference from React state before closing. JS strings
    // are immutable so we can't true-zero the buffer; future hardening would
    // require a Uint8Array-shaped reveal endpoint (tracked in deferred-work).
    setMnemonic(null);
    setPassword('');
    setError('');
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const handleReveal = async () => {
    if (!password) return;
    setLoading(true);
    setError('');
    try {
      const res = await reveal(password);
      if ('mnemonic' in res) {
        setMnemonic(res.mnemonic);
      } else if ('error' in res) {
        if (res.error === 'invalid_password') {
          setError('Wrong password — try again.');
        } else if (res.error === 'wallet_not_initialized') {
          setError('No wallet found. Run `townhouse init` first.');
        } else {
          setError(`Wallet error: ${res.error}. Check logs for details.`);
        }
      }
    } catch {
      setError('Network error — is the API running?');
    } finally {
      setLoading(false);
    }
  };

  const handleCopyMnemonic = async () => {
    if (!mnemonic) return;
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* ignore */ }
  };

  if (!open) return null;

  const words = mnemonic ? mnemonic.split(' ') : [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Reveal seed phrase"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="bg-canvas shadow-border rounded-lg p-6 w-full max-w-md flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="font-geist-sans font-semibold text-ink tracking-tight-16">Reveal seed phrase</h2>
          <button
            type="button"
            className="font-geist-sans text-xs text-ink/50 hover:text-ink"
            onClick={handleClose}
            aria-label="Close reveal seed modal"
          >
            ✕
          </button>
        </div>

        {!mnemonic ? (
          /* Step 1: Password prompt */
          <div className="flex flex-col gap-3">
            <label className="font-geist-sans text-sm text-ink" htmlFor="reveal-password">
              Enter your wallet password to reveal the seed phrase
            </label>
            <Input
              ref={firstFocusRef}
              id="reveal-password"
              type="password"
              value={password}
              onChange={(e) => setPassword((e.target as HTMLInputElement).value)}
              placeholder="Password"
              onKeyDown={(e) => { if (e.key === 'Enter') void handleReveal(); }}
              aria-describedby={error ? 'reveal-password-error' : undefined}
            />
            {error && (
              <p id="reveal-password-error" className="font-geist-sans text-xs text-red-500">{error}</p>
            )}
            <Button onClick={() => void handleReveal()} disabled={!password || loading}>
              {loading ? 'Revealing…' : 'Reveal'}
            </Button>
          </div>
        ) : (
          /* Step 2: Mnemonic display */
          <div className="flex flex-col gap-4">
            <MnemonicGrid words={words} />

            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => void handleCopyMnemonic()}>
                {copied ? 'Copied ✓' : 'Copy mnemonic'}
              </Button>
            </div>

            <p className="font-geist-sans text-xs text-red-500/80">
              Anyone with this phrase can take your funds. Write it down on paper. Never share it.
            </p>

            <Button onClick={handleClose}>I've backed this up — close</Button>
          </div>
        )}
      </div>
    </div>
  );
}
