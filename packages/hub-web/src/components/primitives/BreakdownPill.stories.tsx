import type { Meta, StoryObj } from '@storybook/react';
import { BreakdownPill } from './BreakdownPill';

const meta: Meta<typeof BreakdownPill> = {
  component: BreakdownPill,
  title: 'Primitives/BreakdownPill',
};
export default meta;
type Story = StoryObj<typeof BreakdownPill>;

export const Default: Story = {
  args: {
    segments: [
      { label: 'Revenue 5m', value: '12.34 USDC', tone: 'positive' },
      { label: 'Storage cost', value: '—', tone: 'neutral' },
      { label: 'Net', value: '12.34 USDC', tone: 'positive' },
    ],
  },
};

export const SingleSegment: Story = {
  args: {
    segments: [{ label: 'Revenue', value: '0.001 USDC', tone: 'positive' }],
  },
};

export const NegativeTone: Story = {
  args: {
    segments: [
      { label: 'Revenue', value: '5.00 USDC', tone: 'positive' },
      { label: 'Slippage', value: '0.42 USDC', tone: 'negative' },
      { label: 'Net', value: '4.58 USDC', tone: 'positive' },
    ],
  },
};

export const LongStringTruncation: Story = {
  args: {
    segments: [
      {
        label: 'A very long label that may overflow the pill width',
        value: '123456789012345678.123456 USDC',
        tone: 'neutral',
      },
    ],
  },
};
