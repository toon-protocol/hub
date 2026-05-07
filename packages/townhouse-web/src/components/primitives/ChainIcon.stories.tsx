import type { Meta, StoryObj } from '@storybook/react';
import { ChainIcon } from './ChainIcon';

const meta: Meta<typeof ChainIcon> = {
  component: ChainIcon,
  title: 'Primitives/ChainIcon',
};
export default meta;
type Story = StoryObj<typeof ChainIcon>;

export const Evm: Story = { args: { chain: 'evm', size: 20 } };
export const Solana: Story = { args: { chain: 'solana', size: 20 } };
export const Mina: Story = { args: { chain: 'mina', size: 20 } };
export const WithAriaLabel: Story = { args: { chain: 'evm', size: 20, 'aria-label': 'Ethereum' } };
