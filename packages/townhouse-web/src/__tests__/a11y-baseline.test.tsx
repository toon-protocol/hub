/**
 * Axe-core WCAG 2.1 AA baseline — renders each primitive in default + interactive
 * variants and asserts zero violations. This is the floor that view stories must maintain.
 */
import { render } from '@testing-library/react';
import { vi } from 'vitest';
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
import { BreakdownPill } from '@/components/primitives/BreakdownPill';
import { AddressBlock } from '@/components/AddressBlock';
import { WithdrawModal } from '@/components/WithdrawModal';
import { RevealSeedModal } from '@/components/RevealSeedModal';
import type { WalletBalanceEntry } from '@toon-protocol/hub';

// Mock qrcode.react for baseline tests
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, 'aria-label': ariaLabel }: { value: string; 'aria-label'?: string }) => (
    <svg data-testid="qr-code" aria-label={ariaLabel}><title>{value}</title></svg>
  ),
}));

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

  it('BreakdownPill — default (positive/neutral/negative tones)', async () => {
    const { container } = render(
      <BreakdownPill
        segments={[
          { label: 'Revenue', value: '1.23 USDC', tone: 'positive' },
          { label: 'Storage cost', value: '—', tone: 'neutral' },
          { label: 'Net', value: '1.23 USDC', tone: 'positive' },
        ]}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('BreakdownPill — single segment', async () => {
    const { container } = render(
      <BreakdownPill segments={[{ label: 'Revenue', value: '0.00 USDC' }]} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('BreakdownPill — tone mixed variants', async () => {
    const { container } = render(
      <BreakdownPill
        segments={[
          { label: 'Good', value: '+5', tone: 'positive' },
          { label: 'Bad', value: '-3', tone: 'negative' },
          { label: 'Meh', value: '0', tone: 'neutral' },
        ]}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  // ── Story 21.13: Wallet components ─────────────────────────────────────────

  it('AddressBlock — EVM with balance', async () => {
    const { container } = render(
      <AddressBlock
        family="evm"
        token="ETH"
        address="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
        derivationPath="m/44'/60'/0'/0/0"
        nodeType="town"
        balance="1000000000000000000"
        scale={18}
        available={true}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('AddressBlock — Solana with balance', async () => {
    const { container } = render(
      <AddressBlock
        family="solana"
        token="SOL"
        address="SolanaTestAddr123"
        derivationPath="m/44'/501'/1'/0/0"
        nodeType="mill"
        balance="10000000000"
        scale={9}
        available={true}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('AddressBlock — Mina unavailable', async () => {
    const { container } = render(
      <AddressBlock
        family="mina"
        token="MINA"
        address="B62TestAddr"
        derivationPath="m/44'/12586'/1'/0/0"
        nodeType="mill"
        available={false}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('WithdrawModal — step 1 (chain selector)', async () => {
    const balances: WalletBalanceEntry[] = [
      { nodeType: 'town', family: 'evm', token: 'ETH', address: '0x1111', balance: '1000', scale: 18, available: true },
    ];
    const { container } = render(
      <WithdrawModal nodeType="town" balances={balances} open={true} onClose={() => {}} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('RevealSeedModal — step 1 (password prompt)', async () => {
    const { container } = render(
      <RevealSeedModal open={true} onClose={() => {}} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  // Wizard surfaces (AC-27)
  it('MnemonicGrid — 12 words', async () => {
    const { MnemonicGrid } = await import('@/components/primitives/MnemonicGrid');
    const words = Array.from({ length: 12 }, (_, i) => `word${i + 1}`);
    const { container } = render(<MnemonicGrid words={words} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('PullProgressList — with messages', async () => {
    const { PullProgressList } = await import('@/components/PullProgressList');
    const { container } = render(
      <PullProgressList messages={[
        { type: 'pull_progress', image: 'toon:town', status: 'Pulling', progress: '50%', ts: Date.now() },
        { type: 'container_healthy', name: 'townhouse-connector', ts: Date.now() },
      ]} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('WizardStepNodes — step 1', async () => {
    const { WizardStepNodes } = await import('@/components/wizard/WizardStepNodes');
    const { container } = render(
      <WizardStepNodes
        selection={{ town: false, mill: false, dvm: false }}
        onChange={() => {}}
        onContinue={() => {}}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('WizardStepPrivacy — step 3', async () => {
    const { WizardStepPrivacy } = await import('@/components/wizard/WizardStepPrivacy');
    const { container } = render(
      <WizardStepPrivacy
        transport="direct"
        onChange={() => {}}
        onContinue={() => {}}
        onBack={() => {}}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('WizardStepFees — step 4 (all nodes enabled)', async () => {
    const { WizardStepFees } = await import('@/components/wizard/WizardStepFees');
    const { container } = render(
      <WizardStepFees
        fees={{ townFeePerEvent: 100, millFeeBasisPoints: 30, dvmFeePerJob: 5000 }}
        nodesEnabled={{ town: true, mill: true, dvm: true }}
        onChange={() => {}}
        onContinue={() => {}}
        onBack={() => {}}
      />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
