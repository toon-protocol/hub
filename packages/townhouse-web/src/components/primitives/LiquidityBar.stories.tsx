import type { Meta, StoryObj } from '@storybook/react';
import { LiquidityBar } from './LiquidityBar';

const meta: Meta<typeof LiquidityBar> = {
  component: LiquidityBar,
  title: 'Primitives/LiquidityBar',
};
export default meta;
type Story = StoryObj<typeof LiquidityBar>;

export const Default: Story = {
  args: {
    allocated: 30n,
    inActiveSwaps: 20n,
    available: 50n,
    total: 100n,
    chainLabel: 'evm:base',
    assetCode: 'USDC',
  },
};

export const Pulsing: Story = {
  args: { ...Default.args, pulse: true },
};

export const EmptyPool: Story = {
  args: {
    allocated: 0n,
    inActiveSwaps: 0n,
    available: 0n,
    total: 0n,
    chainLabel: 'solana:devnet',
    assetCode: 'USDC',
  },
};
