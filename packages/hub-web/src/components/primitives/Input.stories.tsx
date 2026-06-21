import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Input, type ChipValue } from './Input';

const meta: Meta<typeof Input> = {
  title: 'Primitives/Input',
  component: Input,
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj<typeof Input>;

export const Default: Story = {
  args: { placeholder: 'Type here...', 'aria-label': 'Default input' },
};

export const Numeric: Story = {
  args: { variant: 'numeric', placeholder: '100', 'aria-label': 'Fee amount' },
};

export const Disabled: Story = {
  args: { disabled: true, placeholder: 'Disabled', 'aria-label': 'Disabled input' },
};

export const Slider: Story = {
  render: () => {
    const [value, setValue] = useState(50);
    return (
      <div style={{ width: 320 }}>
        <Input
          variant="slider"
          aria-label="Fee"
          min={0}
          max={100}
          step={1}
          value={value}
          onChange={(_e, parsed) => setValue(parsed)}
        />
        <p style={{ marginTop: 8, fontFamily: 'Geist Mono, monospace', fontSize: 12 }}>
          {value}
        </p>
      </div>
    );
  },
};

export const Chip: Story = {
  render: () => {
    const [chips, setChips] = useState<ChipValue[]>([
      { id: 'kind-1', label: 'kind:1' },
      { id: 'kind-7', label: 'kind:7' },
      { id: 'kind-30000', label: 'kind:30000' },
    ]);
    const [text, setText] = useState('');
    return (
      <div style={{ width: 480 }}>
        <Input
          variant="chip"
          aria-label="Filter kinds"
          chips={chips}
          onChipRemove={(id) => setChips((c) => c.filter((chip) => chip.id !== id))}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Add kind…"
        />
      </div>
    );
  },
};
