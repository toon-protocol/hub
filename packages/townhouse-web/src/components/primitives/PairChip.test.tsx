import { render, screen } from '@testing-library/react';
import { PairChip } from './PairChip';

const EVM_USDC = { asset: 'USDC', chain: 'evm:base:31337' };
const SOL_USDC = { asset: 'USDC', chain: 'solana:devnet' };
const MINA_USDC = { asset: 'USDC', chain: 'mina:devnet' };

describe('PairChip', () => {
  it('renders EVM↔Solana pair', () => {
    render(<PairChip from={EVM_USDC} to={SOL_USDC} />);
    expect(screen.getAllByText('USDC')).toHaveLength(2);
    expect(screen.getByText('↔')).toBeDefined();
  });

  it('renders EVM↔Mina pair', () => {
    render(<PairChip from={EVM_USDC} to={MINA_USDC} />);
    expect(screen.getAllByText('USDC')).toHaveLength(2);
  });

  it('renders optional rate text', () => {
    render(<PairChip from={EVM_USDC} to={SOL_USDC} rate="1.0" />);
    expect(screen.getByText('1.0')).toBeDefined();
  });

  it('does not render rate text when omitted', () => {
    render(<PairChip from={EVM_USDC} to={SOL_USDC} />);
    expect(screen.queryByText('1.0')).toBeNull();
  });
});
