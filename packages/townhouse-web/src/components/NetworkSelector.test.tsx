import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NetworkSelector } from './NetworkSelector';
import type { NetworkFamilyStatus, NetworkNodeEnv } from '@/hooks/useNetwork';

const ALL_UNCONFIGURED: NetworkFamilyStatus = {
  evm: 'unconfigured',
  solana: 'unconfigured',
  mina: 'unconfigured',
};

const RESOLVED_ENV: NetworkNodeEnv = {
  EVM_RPC_URL: 'https://base.public.rpc',
  SOLANA_RPC_URL: 'https://solana.public.rpc',
};

describe('<NetworkSelector />', () => {
  it('renders all four tier options with mainnet marked default', () => {
    render(<NetworkSelector value="mainnet" onChange={() => {}} />);
    for (const name of [/mainnet/i, /testnet/i, /devnet/i, /custom/i]) {
      expect(screen.getByRole('radio', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /mainnet/i })).toBeChecked();
  });

  it('calls onChange with the chosen mode', async () => {
    const onChange = vi.fn();
    render(<NetworkSelector value="mainnet" onChange={onChange} />);
    await userEvent.click(screen.getByRole('radio', { name: /testnet/i }));
    expect(onChange).toHaveBeenCalledWith('testnet');
  });

  it('shows per-family settlement status with the honest non-alarming note', () => {
    render(
      <NetworkSelector
        value="mainnet"
        onChange={() => {}}
        status={ALL_UNCONFIGURED}
      />
    );
    expect(screen.getByTestId('network-status-evm')).toHaveTextContent(/EVM/);
    expect(screen.getByTestId('network-status-solana')).toHaveTextContent(
      /Solana/
    );
    expect(screen.getByTestId('network-status-mina')).toHaveTextContent(/Mina/);
    // Honest copy — RPC works, settlement pending; NOT an error.
    expect(
      screen.getAllByText(
        /RPC configured — settlement pending contract deploy/i
      )
    ).toHaveLength(3);
  });

  it('shows "Settlement contracts deployed" for configured families', () => {
    render(
      <NetworkSelector
        value="mainnet"
        onChange={() => {}}
        status={{ ...ALL_UNCONFIGURED, evm: 'configured' }}
      />
    );
    expect(
      screen.getByText(/Settlement contracts deployed/i)
    ).toBeInTheDocument();
  });

  it('renders resolved read-only endpoints for non-custom tiers', () => {
    render(
      <NetworkSelector
        value="mainnet"
        onChange={() => {}}
        status={ALL_UNCONFIGURED}
        nodeEnv={RESOLVED_ENV}
      />
    );
    expect(screen.getByText('https://base.public.rpc')).toBeInTheDocument();
    expect(screen.getByText('https://solana.public.rpc')).toBeInTheDocument();
  });

  it('hides the resolved status/endpoint block when custom is selected', () => {
    render(
      <NetworkSelector
        value="custom"
        onChange={() => {}}
        status={ALL_UNCONFIGURED}
        nodeEnv={RESOLVED_ENV}
      />
    );
    expect(screen.queryByTestId('network-status-evm')).not.toBeInTheDocument();
    expect(
      screen.queryByText('https://base.public.rpc')
    ).not.toBeInTheDocument();
  });

  it('disables the radios while a patch is in flight', () => {
    render(<NetworkSelector value="mainnet" onChange={() => {}} disabled />);
    expect(screen.getByRole('radio', { name: /testnet/i })).toBeDisabled();
  });
});
