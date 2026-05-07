import type { Meta, StoryObj } from '@storybook/react';
import { TokenIcon } from './TokenIcon';

const meta: Meta<typeof TokenIcon> = {
  component: TokenIcon,
  title: 'Primitives/TokenIcon',
};
export default meta;
type Story = StoryObj<typeof TokenIcon>;

export const USDC: Story = { args: { token: 'USDC', size: 20 } };
export const ETH: Story = { args: { token: 'ETH', size: 20 } };
export const SOL: Story = { args: { token: 'SOL', size: 20 } };
export const MINA: Story = { args: { token: 'MINA', size: 20 } };
