import { useState } from 'react';
import type { ChainProviderEntry, ChainType } from '@toon-protocol/hub';
import { Button } from './primitives/Button';

const inputClass =
  'w-full rounded-md border border-ink/15 bg-canvas px-2 py-1 font-geist-sans text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:ring-2 focus:ring-ink/20';

export interface NewChainForm {
  chainType: ChainType;
  chainId: string;
  rpcUrl: string;
  wsUrl: string;
  registry: string;
  tokenAddress: string;
  tokenMint: string;
  programId: string;
  graphqlUrl: string;
  zkapp: string;
  keyId: string;
}

export const EMPTY_FORM: NewChainForm = {
  chainType: 'evm',
  chainId: '',
  rpcUrl: '',
  wsUrl: '',
  registry: '',
  tokenAddress: '',
  tokenMint: '',
  programId: '',
  graphqlUrl: '',
  zkapp: '',
  keyId: '',
};

/** Build a typed chain-provider entry from the form, or an error message. */
export function buildEntryFromForm(
  f: NewChainForm
): ChainProviderEntry | { error: string } {
  const chainId = f.chainId.trim();
  if (!chainId) return { error: 'Chain ID is required' };

  if (f.chainType === 'evm') {
    if (!f.rpcUrl || !f.registry || !f.tokenAddress || !f.keyId) {
      return { error: 'EVM needs RPC URL, registry, token address, and key' };
    }
    return {
      chainType: 'evm',
      chainId,
      rpcUrl: f.rpcUrl.trim(),
      registryAddress: f.registry.trim(),
      tokenAddress: f.tokenAddress.trim(),
      keyId: f.keyId.trim(),
    };
  }
  if (f.chainType === 'solana') {
    if (!f.rpcUrl || !f.programId || !f.keyId) {
      return { error: 'Solana needs RPC URL, program ID, and key' };
    }
    return {
      chainType: 'solana',
      chainId,
      rpcUrl: f.rpcUrl.trim(),
      ...(f.wsUrl ? { wsUrl: f.wsUrl.trim() } : {}),
      programId: f.programId.trim(),
      ...(f.tokenMint ? { tokenMint: f.tokenMint.trim() } : {}),
      keyId: f.keyId.trim(),
    };
  }
  // mina
  if (!f.graphqlUrl || !f.zkapp) {
    return { error: 'Mina needs GraphQL URL and zkApp address' };
  }
  return {
    chainType: 'mina',
    chainId,
    graphqlUrl: f.graphqlUrl.trim(),
    zkAppAddress: f.zkapp.trim(),
    ...(f.keyId ? { keyId: f.keyId.trim() } : {}),
  };
}

export interface ChainAddFormProps {
  onAdd: (entry: ChainProviderEntry) => void;
}

/**
 * Add-a-chain form with fields that adapt to the selected chain type. Shared by
 * the dashboard ChainsPanel and the setup-wizard chain step.
 */
export function ChainAddForm({ onAdd }: ChainAddFormProps): JSX.Element {
  const [form, setForm] = useState<NewChainForm>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);

  const setField = (k: keyof NewChainForm, v: string): void =>
    setForm((f) => ({ ...f, [k]: v }));

  function handleAdd(): void {
    const built = buildEntryFromForm(form);
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setError(null);
    onAdd(built);
    setForm(EMPTY_FORM);
  }

  return (
    <div className="rounded-md border border-ink/10 p-3 flex flex-col gap-2">
      <span className="font-geist-sans text-sm font-medium text-ink">
        Add a chain
      </span>
      <select
        aria-label="Chain type"
        className={inputClass}
        value={form.chainType}
        onChange={(e) => setField('chainType', e.target.value)}
      >
        <option value="evm">EVM</option>
        <option value="solana">Solana</option>
        <option value="mina">Mina</option>
      </select>
      <input
        className={inputClass}
        placeholder="chain ID (e.g. evm:base:8453)"
        value={form.chainId}
        onChange={(e) => setField('chainId', e.target.value)}
      />
      {form.chainType === 'evm' && (
        <>
          <input
            className={inputClass}
            placeholder="RPC URL"
            value={form.rpcUrl}
            onChange={(e) => setField('rpcUrl', e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="registry address (0x…)"
            value={form.registry}
            onChange={(e) => setField('registry', e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="token address (0x…)"
            value={form.tokenAddress}
            onChange={(e) => setField('tokenAddress', e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="signing key (0x…)"
            value={form.keyId}
            onChange={(e) => setField('keyId', e.target.value)}
          />
        </>
      )}
      {form.chainType === 'solana' && (
        <>
          <input
            className={inputClass}
            placeholder="RPC URL"
            value={form.rpcUrl}
            onChange={(e) => setField('rpcUrl', e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="WS URL (optional)"
            value={form.wsUrl}
            onChange={(e) => setField('wsUrl', e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="program ID"
            value={form.programId}
            onChange={(e) => setField('programId', e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="token mint (optional)"
            value={form.tokenMint}
            onChange={(e) => setField('tokenMint', e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="signing key"
            value={form.keyId}
            onChange={(e) => setField('keyId', e.target.value)}
          />
        </>
      )}
      {form.chainType === 'mina' && (
        <>
          <input
            className={inputClass}
            placeholder="GraphQL URL"
            value={form.graphqlUrl}
            onChange={(e) => setField('graphqlUrl', e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="zkApp address"
            value={form.zkapp}
            onChange={(e) => setField('zkapp', e.target.value)}
          />
          <input
            className={inputClass}
            placeholder="signing key (optional)"
            value={form.keyId}
            onChange={(e) => setField('keyId', e.target.value)}
          />
        </>
      )}
      {error && <p className="font-geist-sans text-xs text-red-600">{error}</p>}
      <div>
        <Button variant="secondary" size="sm" onClick={handleAdd}>
          Add chain
        </Button>
      </div>
    </div>
  );
}
