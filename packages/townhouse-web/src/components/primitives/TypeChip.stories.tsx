import type { Meta, StoryObj } from '@storybook/react';
import { TypeChip } from './TypeChip';

const meta: Meta<typeof TypeChip> = {
  title: 'Primitives/TypeChip',
  component: TypeChip,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof TypeChip>;

export const Town: Story = { args: { type: 'town' } };
export const Mill: Story = { args: { type: 'mill' } };
export const Dvm: Story = { args: { type: 'dvm' } };

export const AllTypes: Story = {
  render: () => (
    <div style={{ display: 'flex', gap: 8 }}>
      <TypeChip type="town" />
      <TypeChip type="mill" />
      <TypeChip type="dvm" />
    </div>
  ),
};
