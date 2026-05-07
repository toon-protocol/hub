import type { Meta, StoryObj } from '@storybook/react';
import { Shell } from './Shell';

const meta: Meta<typeof Shell> = {
  title: 'Primitives/Shell',
  component: Shell,
  parameters: { layout: 'fullscreen' },
};
export default meta;

type Story = StoryObj<typeof Shell>;

export const Default: Story = {
  args: { children: <p>Main content area</p> },
};

export const WithHeader: Story = {
  args: {
    header: <h1 className="text-lg font-semibold">Townhouse</h1>,
    children: <p>Main content</p>,
  },
};

export const WithHeaderAndFooter: Story = {
  args: {
    header: <h1 className="text-lg font-semibold">Townhouse</h1>,
    footer: <span>v0.1.0</span>,
    children: <p>Main content</p>,
  },
};
