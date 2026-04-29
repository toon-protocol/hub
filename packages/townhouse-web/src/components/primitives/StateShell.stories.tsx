import type { Meta, StoryObj } from '@storybook/react';
import { StateShell } from './StateShell';

const meta: Meta<typeof StateShell> = {
  title: 'Primitives/StateShell',
  component: StateShell,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof StateShell>;

export const Ready: Story = {
  args: {
    state: 'ready',
    children: <div style={{ padding: 24 }}>Ready content</div>,
  },
};

export const Loading: Story = { args: { state: 'loading' } };
export const Empty: Story = { args: { state: 'empty' } };
export const Error: Story = { args: { state: 'error' } };
