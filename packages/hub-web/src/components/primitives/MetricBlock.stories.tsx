import type { Meta, StoryObj } from '@storybook/react';
import { MetricBlock } from './MetricBlock';

const meta: Meta<typeof MetricBlock> = {
  title: 'Primitives/MetricBlock',
  component: MetricBlock,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof MetricBlock>;

export const Default: Story = {
  args: { value: 42, label: 'Connected clients' },
};

export const WithUnit: Story = {
  args: { value: '128', label: 'Bandwidth', unit: 'MB/s' },
};

export const WithPositiveTrend: Story = {
  args: { value: 1024, label: 'Packets forwarded', trend: 128 },
};

export const WithNegativeTrend: Story = {
  args: { value: 256, label: 'Packets rejected', trend: -12 },
};

export const Compact: Story = {
  args: { value: 3, label: 'Active nodes', variant: 'compact' },
};
