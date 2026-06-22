import { render, screen } from '@testing-library/react';
import { TypeChip } from './TypeChip';

describe('TypeChip', () => {
  it('renders Town with visible label as the only accessible content', () => {
    render(<TypeChip type="town" />);
    const chip = screen.getByText('Town');
    expect(chip).toBeDefined();
    // No aria-label override — visible text matches accessible text (WCAG 2.5.3).
    expect(chip).not.toHaveAttribute('aria-label');
  });

  it('renders Mill', () => {
    render(<TypeChip type="mill" />);
    expect(screen.getByText('Mill')).toBeDefined();
  });

  it('renders DVM', () => {
    render(<TypeChip type="dvm" />);
    expect(screen.getByText('DVM')).toBeDefined();
  });

  it('defaults to town type', () => {
    render(<TypeChip />);
    expect(screen.getByText('Town')).toBeDefined();
  });
});
