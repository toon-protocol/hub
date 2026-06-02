import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WizardStepChains } from './WizardStepChains';
import type { ChainProviderEntry } from '@toon-protocol/townhouse';

const EVM: ChainProviderEntry = {
  chainType: 'evm',
  chainId: 'evm:base:8453',
  rpcUrl: 'https://x',
  registryAddress: '0xa',
  tokenAddress: '0xb',
  keyId: '0xc',
};

describe('<WizardStepChains />', () => {
  it('lists chains and removes one', async () => {
    const onChange = vi.fn();
    render(
      <WizardStepChains
        chains={[EVM]}
        onChange={onChange}
        onContinue={() => {}}
        onBack={() => {}}
      />
    );
    expect(screen.getByText('EVM · evm:base:8453')).toBeInTheDocument();
    await userEvent.click(screen.getByLabelText('Remove evm:base:8453'));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it('shows "Skip for now" when no chains are configured', () => {
    render(
      <WizardStepChains
        chains={[]}
        onChange={() => {}}
        onContinue={() => {}}
        onBack={() => {}}
      />
    );
    expect(screen.getByText('Skip for now')).toBeInTheDocument();
  });

  it('adds a chain via the form', async () => {
    const onChange = vi.fn();
    render(
      <WizardStepChains
        chains={[]}
        onChange={onChange}
        onContinue={() => {}}
        onBack={() => {}}
      />
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
