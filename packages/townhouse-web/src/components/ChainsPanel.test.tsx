import { describe, it, expect, vi, afterEach } from 'vitest';
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

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const CHAINS_BODY = {
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
};

function networkBody(network = 'mainnet') {
  return {
    network,
    status: {
      evm: 'unconfigured',
      solana: 'unconfigured',
      mina: 'unconfigured',
    },
    nodeEnv: { EVM_RPC_URL: 'https://base.public' },
    ts: Date.now(),
  };
}

/**
 * URL+method-aware fetch mock. ChainsPanel fetches BOTH /api/chains and
 * /api/network on mount, so call-order mocks would desync. `networkMode`
 * controls which tier GET /api/network resolves to.
 */
function mockFetch(networkMode = 'mainnet') {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/network')) {
        if (init?.method === 'PATCH') {
          return Promise.resolve(
            jsonRes({
              ...networkBody('custom'),
              restartTriggered: true,
              restartedAt: Date.now(),
            })
          );
        }
        return Promise.resolve(jsonRes(networkBody(networkMode)));
      }
      if (url.includes('/api/chains')) {
        return Promise.resolve(jsonRes(CHAINS_BODY));
      }
      return Promise.resolve(jsonRes({}));
    })
  );
}

describe('<ChainsPanel />', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the network selector with mainnet default checked', async () => {
    mockFetch('mainnet');
    render(<ChainsPanel />);
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /mainnet/i })).toBeChecked()
    );
    // Honest, non-alarming settlement note for the unconfigured families.
    expect(
      screen.getAllByText(/settlement pending contract deploy/i).length
    ).toBeGreaterThan(0);
  });

  it('hides the per-chain editor in non-custom modes', async () => {
    mockFetch('mainnet');
    render(<ChainsPanel />);
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /mainnet/i })).toBeChecked()
    );
    expect(screen.queryByText('Add a chain')).not.toBeInTheDocument();
    expect(screen.queryByText(/EVM · evm:base:8453/)).not.toBeInTheDocument();
  });

  it('lists configured chains and shows the add form in custom mode', async () => {
    mockFetch('custom');
    render(<ChainsPanel />);
    await waitFor(() =>
      expect(screen.getByText(/EVM · evm:base:8453/)).toBeInTheDocument()
    );
    expect(screen.getByText('Add a chain')).toBeInTheDocument();
  });

  it('shows Solana-specific fields when chain type is solana (custom mode)', async () => {
    mockFetch('custom');
    render(<ChainsPanel />);
    await waitFor(() => screen.getByText('Add a chain'));
    await userEvent.selectOptions(
      screen.getByLabelText('Chain type'),
      'solana'
    );
    expect(screen.getByPlaceholderText('program ID')).toBeInTheDocument();
  });

  it('PATCHes /api/network when a different tier is selected', async () => {
    mockFetch('mainnet');
    render(<ChainsPanel />);
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /mainnet/i })).toBeChecked()
    );
    await userEvent.click(screen.getByRole('radio', { name: /testnet/i }));
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const patchCall = calls.find(
        ([url, opts]) =>
          String(url).includes('/api/network') && opts?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
    });
  });
});
