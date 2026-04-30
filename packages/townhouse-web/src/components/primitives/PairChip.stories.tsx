import type { Meta, StoryObj } from '@storybook/react';
import { PairChip } from './PairChip';

const meta: Meta<typeof PairChip> = {
  component: PairChip,
  title: 'Primitives/PairChip',
};
export default meta;
type Story = StoryObj<typeof PairChip>;

export const EvmToSolana: Story = {
  args: {
    from: { asset: 'USDC', chain: 'evm:base:31337' },
    to: { asset: 'USDC', chain: 'solana:devnet' },
  },
};

export const EvmToMina: Story = {
  args: {
    from: { asset: 'USDC', chain: 'evm:base:31337' },
    to: { asset: 'USDC', chain: 'mina:devnet' },
  },
};

export const WithRate: Story = {
  args: {
    from: { asset: 'USDC', chain: 'evm:base:31337' },
    to: { asset: 'USDC', chain: 'solana:devnet' },
    rate: '1.0',
  },
};
