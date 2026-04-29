import type { Meta, StoryObj } from '@storybook/react';
import { StatusDot } from './StatusDot';

const meta: Meta<typeof StatusDot> = {
  title: 'Primitives/StatusDot',
  component: StatusDot,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof StatusDot>;

export const Ok: Story = { args: { state: 'ok' } };
export const Degraded: Story = { args: { state: 'degraded' } };
export const Down: Story = { args: { state: 'down' } };
export const Unknown: Story = { args: { state: 'unknown' } };

export const AllStates: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <StatusDot state="ok" aria-label="Online" />
      <StatusDot state="degraded" aria-label="Degraded" />
      <StatusDot state="down" aria-label="Offline" />
      <StatusDot state="unknown" aria-label="Unknown" />
    </div>
  ),
};
