import { useState } from 'react';
import { Input } from '@/components/primitives/Input';
import { Button } from '@/components/primitives/Button';
import { MnemonicGrid } from '@/components/primitives/MnemonicGrid';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

export interface WalletDraft {
  mnemonic: string;
  password: string;
  mnemonicMode: 'generate' | 'import';
  backupAck: boolean;
}

export interface WizardStepWalletProps {
  draft: WalletDraft;
  onChange: (draft: WalletDraft) => void;
  onContinue: () => void;
  onBack: () => void;
  fetchMnemonic: () => Promise<string>;
}

/** BIP-39 valid word counts. The server's validateMnemonic accepts any of these. */
const VALID_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

export function WizardStepWallet({ draft, onChange, onContinue, onBack, fetchMnemonic }: WizardStepWalletProps) {
  const [tab, setTab] = useState<'generate' | 'import'>(draft.mnemonicMode);
  const [confirmPassword, setConfirmPassword] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generateError, setGenerateError] = useState('');
  const [regenerateNotice, setRegenerateNotice] = useState('');
  const [confirmRequested, setConfirmRequested] = useState(false);

  const isImport = tab === 'import';
  const trimmedMnemonic = draft.mnemonic.trim();
  const mnemonicWords = trimmedMnemonic.length > 0 ? trimmedMnemonic.split(/\s+/) : [];
  const hasMnemonic = trimmedMnemonic.length > 0;
  const passwordTrimmed = draft.password === draft.password.trim();
  const passwordOk = draft.password.length >= 8 && passwordTrimmed && draft.password === confirmPassword;

  // Server-aligned validation: any valid BIP-39 length is accepted.
  const importMnemonicValid =
    isImport &&
    hasMnemonic &&
    VALID_WORD_COUNTS.has(mnemonicWords.length) &&
    validateMnemonic(trimmedMnemonic, wordlist);

  const canContinue = isImport
    ? importMnemonicValid && passwordOk && draft.backupAck
    : hasMnemonic && passwordOk && draft.backupAck;

  async function handleGenerate() {
    if (hasMnemonic) {
      if (!confirmRequested) {
        setConfirmRequested(true);
        setRegenerateNotice('Click Generate again to discard your current phrase and create a new one.');
        return;
      }
      setConfirmRequested(false);
    }
    setGenerating(true);
    setGenerateError('');
    setRegenerateNotice('');
    onChange({ ...draft, backupAck: false });
    try {
      const mnemonic = await fetchMnemonic();
      onChange({ ...draft, mnemonic, mnemonicMode: 'generate', backupAck: false });
    } catch {
      setGenerateError('Failed to generate phrase — is the API running?');
    } finally {
      setGenerating(false);
    }
  }

  function handleTabSwitch(newTab: 'generate' | 'import') {
    setTab(newTab);
    onChange({ ...draft, mnemonic: '', mnemonicMode: newTab, backupAck: false });
    setConfirmPassword('');
    setConfirmRequested(false);
    setGenerateError('');
    setRegenerateNotice('');
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2
          id="wizard-step-heading"
          className="font-geist-sans text-xl font-semibold text-ink tracking-tight-20"
          aria-live="polite"
        >
          Set up your wallet
        </h2>
        <p className="font-geist-sans text-sm text-ink/60 mt-1">
          Your seed phrase controls all node keys. Keep it safe.
        </p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-2 shadow-border rounded-md overflow-hidden" role="tablist">
        {(['generate', 'import'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => handleTabSwitch(t)}
            className={`flex-1 py-2 font-geist-sans text-sm font-medium transition-colors ${tab === t ? 'bg-ink text-canvas' : 'bg-canvas text-ink hover:bg-ink/5'}`}
          >
            {t === 'generate' ? 'Generate new' : 'Import existing'}
          </button>
        ))}
      </div>

      {tab === 'generate' && (
        <div className="flex flex-col gap-4">
          <Button variant="secondary" onClick={() => void handleGenerate()} loading={generating}>
            {generating ? 'Generating…' : hasMnemonic ? 'Regenerate phrase' : 'Generate seed phrase'}
          </Button>
          {generateError && (
            <p className="font-geist-sans text-xs text-red-500/80" role="alert">{generateError}</p>
          )}
          {regenerateNotice && (
            <p
              className="font-geist-sans text-xs text-ink/70 bg-ink/5 rounded-md px-3 py-2"
              role="status"
            >
              {regenerateNotice}
            </p>
          )}
          {hasMnemonic && (
            <>
              <MnemonicGrid words={mnemonicWords} />
              <p className="font-geist-sans text-xs text-red-500/80">
                Anyone with this phrase can take your funds. Write it down on paper. Never share it.
              </p>
            </>
          )}
        </div>
      )}

      {tab === 'import' && (
        <div className="flex flex-col gap-3">
          <label className="font-geist-sans text-sm text-ink" htmlFor="import-mnemonic">
            Enter your 12, 15, 18, 21, or 24 word seed phrase
          </label>
          <textarea
            id="import-mnemonic"
            value={draft.mnemonic}
            onChange={(e) => onChange({ ...draft, mnemonic: e.target.value, mnemonicMode: 'import' })}
            rows={3}
            placeholder="word1 word2 word3 ..."
            className="bg-canvas shadow-border rounded-md px-3 py-2 font-geist-mono text-sm text-ink outline-none resize-none placeholder:text-ink/40 tracking-tight-14"
          />
          {hasMnemonic && !VALID_WORD_COUNTS.has(mnemonicWords.length) && (
            <p className="font-geist-sans text-xs text-red-500/80" role="alert">
              Please enter a valid BIP-39 phrase (12, 15, 18, 21, or 24 words).
            </p>
          )}
          {hasMnemonic &&
            VALID_WORD_COUNTS.has(mnemonicWords.length) &&
            !validateMnemonic(trimmedMnemonic, wordlist) && (
              <p className="font-geist-sans text-xs text-red-500/80" role="alert">
                Phrase appears invalid — please double-check each word.
              </p>
            )}
        </div>
      )}

      {/* Password section */}
      <div className="flex flex-col gap-3">
        <Input
          id="wallet-password"
          type="password"
          label="Wallet password"
          value={draft.password}
          onChange={(e) => onChange({ ...draft, password: (e.target as HTMLInputElement).value })}
          placeholder="Password (8+ characters)"
        />
        <Input
          id="wallet-password-confirm"
          type="password"
          label="Confirm password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword((e.target as HTMLInputElement).value)}
          placeholder="Confirm password"
        />
        {confirmPassword.length > 0 && draft.password !== confirmPassword && (
          <p className="font-geist-sans text-xs text-red-500/80" role="alert">
            Passwords do not match.
          </p>
        )}
        {draft.password.length > 0 && !passwordTrimmed && (
          <p className="font-geist-sans text-xs text-red-500/80" role="alert">
            Password cannot start or end with whitespace.
          </p>
        )}
      </div>

      {/* Backup ack */}
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={draft.backupAck}
          onChange={(e) => onChange({ ...draft, backupAck: e.target.checked })}
          className="mt-0.5 accent-ink"
        />
        <span className="font-geist-sans text-sm text-ink">
          {isImport
            ? 'I have stored this phrase securely and have access to it.'
            : "I've backed this up — I've written down my seed phrase and stored it safely."}
        </span>
      </label>

      <div className="flex gap-3 justify-between">
        <Button variant="secondary" onClick={onBack}>Back</Button>
        <Button onClick={onContinue} disabled={!canContinue}>Continue</Button>
      </div>
    </div>
  );
}
