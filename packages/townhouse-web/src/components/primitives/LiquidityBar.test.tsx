import { render, screen } from '@testing-library/react';
import { LiquidityBar } from './LiquidityBar';

describe('LiquidityBar', () => {
  const baseProps = {
    allocated: 30n,
    inActiveSwaps: 20n,
    available: 50n,
    total: 100n,
    chainLabel: 'evm:base',
    assetCode: 'USDC',
  };

  it('renders role="meter" with correct aria attributes', () => {
    render(<LiquidityBar {...baseProps} />);
    const meter = screen.getByRole('meter');
    expect(meter).toBeDefined();
    expect(meter.getAttribute('aria-valuemin')).toBe('0');
    expect(meter.getAttribute('aria-valuemax')).toBe('100');
    expect(meter.getAttribute('aria-valuenow')).toBe('50');
  });

  it('includes chainLabel and assetCode in aria-label', () => {
    render(<LiquidityBar {...baseProps} />);
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-label')).toContain('evm:base');
    expect(meter.getAttribute('aria-label')).toContain('USDC');
  });

  it('applies animate-rebal-pulse class when pulse=true', () => {
    render(<LiquidityBar {...baseProps} pulse={true} />);
    const meter = screen.getByRole('meter');
    expect(meter.className).toContain('animate-rebal-pulse');
  });

  it('does not apply animate-rebal-pulse when pulse=false', () => {
    render(<LiquidityBar {...baseProps} pulse={false} />);
    const meter = screen.getByRole('meter');
    expect(meter.className).not.toContain('animate-rebal-pulse');
  });

  it('renders without error when total=0n', () => {
    render(<LiquidityBar {...baseProps} allocated={0n} inActiveSwaps={0n} available={0n} total={0n} />);
    const meter = screen.getByRole('meter');
    expect(meter.getAttribute('aria-valuemax')).toBe('0');
  });

  it('renders snapshot — proportions 50/30/20', () => {
    const { container } = render(
      <LiquidityBar allocated={50n} inActiveSwaps={30n} available={20n} total={100n} chainLabel="evm" assetCode="USDC" />
    );
    expect(container.innerHTML).toMatchSnapshot();
  });
});
