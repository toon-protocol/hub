import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WizardStepChains } from './WizardStepChains';
import type { ChainProviderEntry } from '@toon-protocol/hub';

const EVM: ChainProviderEntry = {
  chainType: 'evm',
  chainId: 'evm:base:8453',
  rpcUrl: 'https://x',
  registryAddress: '0xa',
  tokenAddress: '0xb',
  keyId: '0xc',
};

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function networkPayload(network = 'mainnet') {
  return {
    network,
    status: {
      evm: 'unconfigured',
      solana: 'unconfigured',
      mina: 'unconfigured',
    },
    nodeEnv: {},
    ts: Date.now(),
  };
}

beforeEach(() => {
  // URL/method-aware: GET /api/network resolves the current mode; PATCH echoes.
  vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url.includes('/api/network')) {
      if (init?.method === 'PATCH') {
        return Promise.resolve(
          jsonRes({
            ...networkPayload('custom'),
            restartTriggered: true,
            restartedAt: Date.now(),
          })
        );
      }
      return Promise.resolve(jsonRes(networkPayload('mainnet')));
    }
    return Promise.resolve(jsonRes({}));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('<WizardStepChains />', () => {
  it('renders the network selector, default mainnet checked', async () => {
    render(
      <WizardStepChains
        chains={[]}
        onChange={() => {}}
        onContinue={() => {}}
        onBack={() => {}}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /mainnet/i })).toBeChecked()
    );
    expect(
      screen.getByRole('button', { name: 'Continue' })
    ).toBeInTheDocument();
  });

  it('hides the per-chain editor unless custom is selected', async () => {
    render(
      <WizardStepChains
        chains={[]}
        onChange={() => {}}
        onContinue={() => {}}
        onBack={() => {}}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /mainnet/i })).toBeChecked()
    );
    expect(screen.queryByText('Add a chain')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('radio', { name: /custom/i }));
    await waitFor(() =>
      expect(screen.getByText('Add a chain')).toBeInTheDocument()
    );
  });

  it('PATCHes /api/network when a tier is chosen', async () => {
    render(
      <WizardStepChains
        chains={[]}
        onChange={() => {}}
        onContinue={() => {}}
        onBack={() => {}}
      />
    );
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

  it('lists chains and removes one in custom mode', async () => {
    const onChange = vi.fn();
    render(
      <WizardStepChains
        chains={[EVM]}
        onChange={onChange}
        onContinue={() => {}}
        onBack={() => {}}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /mainnet/i })).toBeChecked()
    );
    await userEvent.click(screen.getByRole('radio', { name: /custom/i }));
    await waitFor(() =>
      expect(screen.getByText('EVM · evm:base:8453')).toBeInTheDocument()
    );
    await userEvent.click(screen.getByLabelText('Remove evm:base:8453'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('adds a chain via the form in custom mode', async () => {
    const onChange = vi.fn();
    render(
      <WizardStepChains
        chains={[]}
        onChange={onChange}
        onContinue={() => {}}
        onBack={() => {}}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /mainnet/i })).toBeChecked()
    );
    await userEvent.click(screen.getByRole('radio', { name: /custom/i }));
    await waitFor(() =>
      expect(
        screen.getByPlaceholderText('chain ID (e.g. evm:base:8453)')
      ).toBeInTheDocument()
    );

    await userEvent.type(
      screen.getByPlaceholderText('chain ID (e.g. evm:base:8453)'),
      'evm:base:8453'
    );
    await userEvent.type(screen.getByPlaceholderText('RPC URL'), 'https://x');
    await userEvent.type(
      screen.getByPlaceholderText('registry address (0x…)'),
      '0xa'
    );
    await userEvent.type(
      screen.getByPlaceholderText('token address (0x…)'),
      '0xb'
    );
    await userEvent.type(
      screen.getByPlaceholderText('signing key (0x…)'),
      '0xc'
    );
    await userEvent.click(screen.getByText('Add chain'));

    expect(onChange).toHaveBeenCalled();
    const arg = onChange.mock.calls[0]?.[0] as ChainProviderEntry[];
    expect(arg).toHaveLength(1);
    expect(arg[0]?.chainType).toBe('evm');
  });
});
