/**
 * Axe-core WCAG 2.1 AA baseline — renders each primitive in default + interactive
 * variants and asserts zero violations. This is the floor that view stories must maintain.
 */
import { render } from '@testing-library/react';
import { axe } from '../test-setup';
import { Shell } from '@/components/primitives/Shell';
import { Button } from '@/components/primitives/Button';
import { Input } from '@/components/primitives/Input';
import { StatusDot } from '@/components/primitives/StatusDot';
import { StateShell } from '@/components/primitives/StateShell';
import { TypeChip } from '@/components/primitives/TypeChip';
import { MetricBlock } from '@/components/primitives/MetricBlock';
import { LiquidityBar } from '@/components/primitives/LiquidityBar';
import { ChainIcon } from '@/components/primitives/ChainIcon';
import { TokenIcon } from '@/components/primitives/TokenIcon';
import { PairChip } from '@/components/primitives/PairChip';

describe('a11y baseline — WCAG 2.1 AA', () => {
  it('Shell — default', async () => {
    const { container } = render(<Shell>Content</Shell>);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Shell — with header and footer', async () => {
    const { container } = render(
      <Shell header={<h1>Townhouse</h1>} footer={<span>v0.1.0</span>}>
        Content
      </Shell>
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Button — primary enabled', async () => {
    const { container } = render(<Button>Submit</Button>);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Button — disabled', async () => {
    const { container } = render(<Button disabled>Submit</Button>);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Button — loading', async () => {
    const { container } = render(<Button loading>Saving</Button>);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Input — default', async () => {
    const { container } = render(<Input aria-label="Search" placeholder="Type here" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Input — numeric', async () => {
    const { container } = render(<Input variant="numeric" aria-label="Fee" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Input — with label (htmlFor association)', async () => {
    const { container } = render(<Input label="Email" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Input — slider', async () => {
    const { container } = render(
      <Input variant="slider" aria-label="Fee" min={0} max={100} value={50} onChange={() => {}} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Input — chip', async () => {
    const { container } = render(
      <Input
        variant="chip"
        aria-label="Filter kinds"
        chips={[
          { id: 'k1', label: 'kind:1' },
          { id: 'k7', label: 'kind:7' },
        ]}
        onChipRemove={() => {}}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StatusDot — ok', async () => {
    const { container } = render(<StatusDot state="ok" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StatusDot — degraded', async () => {
    const { container } = render(<StatusDot state="degraded" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StatusDot — down', async () => {
    const { container } = render(<StatusDot state="down" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StatusDot — unknown', async () => {
    const { container } = render(<StatusDot state="unknown" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StateShell — ready', async () => {
    const { container } = render(<StateShell state="ready"><p>Content</p></StateShell>);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StateShell — loading', async () => {
    const { container } = render(<StateShell state="loading" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StateShell — empty', async () => {
    const { container } = render(<StateShell state="empty" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('StateShell — error', async () => {
    const { container } = render(<StateShell state="error" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('TypeChip — town', async () => {
    const { container } = render(<TypeChip type="town" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('TypeChip — mill', async () => {
    const { container } = render(<TypeChip type="mill" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('TypeChip — dvm', async () => {
    const { container } = render(<TypeChip type="dvm" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('MetricBlock — default', async () => {
    const { container } = render(<MetricBlock value={42} label="Clients" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('MetricBlock — with trend', async () => {
    const { container } = render(<MetricBlock value={1024} label="Packets" trend={128} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('MetricBlock — compact', async () => {
    const { container } = render(<MetricBlock value={3} label="Active nodes" variant="compact" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('LiquidityBar — static', async () => {
    const { container } = render(
      <LiquidityBar allocated={30n} inActiveSwaps={20n} available={50n} total={100n} chainLabel="evm:base" assetCode="USDC" />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('LiquidityBar — pulsing', async () => {
    const { container } = render(
      <LiquidityBar allocated={30n} inActiveSwaps={20n} available={50n} total={100n} chainLabel="evm:base" assetCode="USDC" pulse={true} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('ChainIcon — evm', async () => {
    const { container } = render(<ChainIcon chain="evm" aria-label="Ethereum" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('ChainIcon — solana', async () => {
    const { container } = render(<ChainIcon chain="solana" aria-label="Solana" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('ChainIcon — mina', async () => {
    const { container } = render(<ChainIcon chain="mina" aria-label="Mina" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('TokenIcon — USDC', async () => {
    const { container } = render(<TokenIcon token="USDC" aria-label="USD Coin" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('TokenIcon — ETH', async () => {
    const { container } = render(<TokenIcon token="ETH" aria-label="Ether" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('PairChip — evm↔solana', async () => {
    const { container } = render(
      <PairChip from={{ asset: 'USDC', chain: 'evm:base:31337' }} to={{ asset: 'USDC', chain: 'solana:devnet' }} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('PairChip — with rate', async () => {
    const { container } = render(
      <PairChip from={{ asset: 'USDC', chain: 'evm:base:31337' }} to={{ asset: 'USDC', chain: 'solana:devnet' }} rate="1.0" />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
