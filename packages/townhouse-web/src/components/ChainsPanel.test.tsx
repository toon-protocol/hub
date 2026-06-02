import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChainsPanel, buildEntryFromForm } from './ChainsPanel';

const baseForm = {
  chainType: 'evm' as const,
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

describe('buildEntryFromForm', () => {
  it('builds a valid EVM entry', () => {
    const r = buildEntryFromForm({
      ...baseForm,
      chainType: 'evm',
      chainId: 'evm:base:8453',
      rpcUrl: 'https://x',
      registry: '0xa',
      tokenAddress: '0xb',
      keyId: '0xc',
    });
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.chainType).toBe('evm');
  });

  it('errors when an EVM field is missing', () => {
    const r = buildEntryFromForm({
      ...baseForm,
      chainType: 'evm',
      chainId: 'evm:base:8453',
      rpcUrl: 'https://x',
    });
    expect('error' in r).toBe(true);
  });

  it('builds Solana and Mina entries', () => {
    const s = buildEntryFromForm({
      ...baseForm,
      chainType: 'solana',
      chainId: 'solana:devnet',
      rpcUrl: 'https://s',
      programId: 'P',
      keyId: 'k',
    });
    expect('error' in s).toBe(false);

    const m = buildEntryFromForm({
      ...baseForm,
      chainType: 'mina',
      chainId: 'mina:devnet',
      graphqlUrl: 'https://g',
      zkapp: 'B62',
    });
    expect('error' in m).toBe(false);
    if (!('error' in m)) expect(m.chainType).toBe('mina');
  });
});

describe('<ChainsPanel />', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          chainProviders: [
            {
              chainType: 'evm',
              chainId: 'evm:base:8453',
              rpcUrl: 'https://base',
              registryAddress: '0xa',
              tokenAddress: '0xb',
              keyId: '***',
            },
          ],
        }),
      }))
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists configured chains and shows the add form', async () => {
    render(<ChainsPanel />);
    await waitFor(() =>
      expect(screen.getByText(/EVM · evm:base:8453/)).toBeInTheDocument()
    );
    expect(screen.getByText('Add a chain')).toBeInTheDocument();
  });

  it('shows Solana-specific fields when chain type is solana', async () => {
    render(<ChainsPanel />);
    await waitFor(() => screen.getByText('Add a chain'));
    await userEvent.selectOptions(
      screen.getByLabelText('Chain type'),
      'solana'
    );
    expect(screen.getByPlaceholderText('program ID')).toBeInTheDocument();
  });
});
