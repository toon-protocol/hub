import { useState } from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input, type ChipValue } from './Input';

describe('Input', () => {
  it('renders an input element', () => {
    render(<Input aria-label="Email" />);
    expect(screen.getByRole('textbox', { name: 'Email' })).toBeDefined();
  });

  it('numeric variant renders a number input', () => {
    render(<Input variant="numeric" aria-label="Fee" />);
    expect(screen.getByRole('spinbutton', { name: 'Fee' })).toBeDefined();
  });

  it('renders placeholder', () => {
    render(<Input placeholder="Search..." aria-label="Search" />);
    const input = screen.getByRole('textbox', { name: 'Search' });
    expect(input).toHaveAttribute('placeholder', 'Search...');
  });

  it('is disabled when disabled prop set', () => {
    render(<Input disabled aria-label="Disabled" />);
    expect(screen.getByRole('textbox', { name: 'Disabled' })).toBeDisabled();
  });

  it('label prop wires htmlFor → input id', () => {
    render(<Input label="Email" />);
    const input = screen.getByRole('textbox', { name: 'Email' });
    const labelEl = screen.getByText('Email');
    expect(input.id).toBeTruthy();
    expect(labelEl.getAttribute('for')).toBe(input.id);
  });

  it('caller-provided id is preserved', () => {
    render(<Input id="custom-id" aria-label="Custom" />);
    const input = screen.getByRole('textbox', { name: 'Custom' });
    expect(input.id).toBe('custom-id');
  });

  describe('slider variant', () => {
    it('renders a range input', () => {
      render(<Input variant="slider" aria-label="Volume" min={0} max={100} value={50} onChange={() => {}} />);
      const slider = screen.getByRole('slider', { name: 'Volume' });
      expect(slider).toHaveAttribute('type', 'range');
      expect(slider).toHaveAttribute('min', '0');
      expect(slider).toHaveAttribute('max', '100');
    });

    it('onChange receives parsed numeric value', () => {
      function Harness() {
        const [v, setV] = useState(10);
        return (
          <Input
            variant="slider"
            aria-label="Volume"
            min={0}
            max={100}
            value={v}
            onChange={(_e, parsed) => setV(parsed)}
          />
        );
      }
      render(<Harness />);
      const slider = screen.getByRole('slider', { name: 'Volume' }) as HTMLInputElement;
      fireEvent.change(slider, { target: { value: '75' } });
      expect(slider.value).toBe('75');
    });
  });

  describe('chip variant', () => {
    it('renders existing chips with remove buttons', () => {
      const chips: ChipValue[] = [
        { id: 'kind-1', label: 'kind:1' },
        { id: 'kind-7', label: 'kind:7' },
      ];
      render(<Input variant="chip" chips={chips} aria-label="Filter kinds" onChipRemove={() => {}} />);
      expect(screen.getByText('kind:1')).toBeDefined();
      expect(screen.getByText('kind:7')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Remove kind:1' })).toBeDefined();
      expect(screen.getByRole('button', { name: 'Remove kind:7' })).toBeDefined();
    });

    it('clicking × calls onChipRemove with chip id', async () => {
      const onChipRemove = vi.fn();
      const chips: ChipValue[] = [{ id: 'kind-7', label: 'kind:7' }];
      render(
        <Input
          variant="chip"
          chips={chips}
          aria-label="Filter kinds"
          onChipRemove={onChipRemove}
        />
      );
      await userEvent.click(screen.getByRole('button', { name: 'Remove kind:7' }));
      expect(onChipRemove).toHaveBeenCalledWith('kind-7');
    });

    it('renders text input alongside chips', () => {
      render(<Input variant="chip" chips={[]} aria-label="Filter kinds" />);
      expect(screen.getByRole('textbox', { name: 'Filter kinds' })).toBeDefined();
    });
  });
});
