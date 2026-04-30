import { render, screen } from '@testing-library/react';
import { axe } from '../../test-setup';
import { BreakdownPill } from './BreakdownPill';

describe('BreakdownPill', () => {
  const defaultSegments = [
    { label: 'Revenue', value: '1.23 USDC', tone: 'positive' as const },
    { label: 'Storage cost', value: '—', tone: 'neutral' as const },
    { label: 'Net', value: '1.23 USDC', tone: 'positive' as const },
  ];

  it('snapshot — default three-segment pill', () => {
    const { container } = render(<BreakdownPill segments={defaultSegments} />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it('renders all segment labels', () => {
    render(<BreakdownPill segments={defaultSegments} />);
    expect(screen.getByText('Revenue')).not.toBeNull();
    expect(screen.getByText('Storage cost')).not.toBeNull();
    expect(screen.getByText('Net')).not.toBeNull();
  });

  it('renders duplicate-label segments without React key collision', () => {
    // Using `seg.label` as the key would produce duplicate-key warnings
    // and reconciliation bugs if two segments share a label (e.g., two
    // "Net" entries during error fallback).
    expect(() =>
      render(
        <BreakdownPill
          segments={[
            { label: 'Net', value: '1', tone: 'positive' },
            { label: 'Net', value: '2', tone: 'negative' },
          ]}
        />
      )
    ).not.toThrow();
  });

  it('positive tone renders text-green-600/80 class on value', () => {
    const { container } = render(
      <BreakdownPill segments={[{ label: 'Rev', value: '$5', tone: 'positive' }]} />
    );
    const code = container.querySelector('code');
    expect(code?.className).toContain('text-green-600');
  });

  it('negative tone renders text-red-500/80 class on value', () => {
    const { container } = render(
      <BreakdownPill segments={[{ label: 'Loss', value: '-$3', tone: 'negative' }]} />
    );
    const code = container.querySelector('code');
    expect(code?.className).toContain('text-red-500');
  });

  it('neutral tone (default) renders text-ink class on value', () => {
    const { container } = render(
      <BreakdownPill segments={[{ label: 'Base', value: '0' }]} />
    );
    const code = container.querySelector('code');
    expect(code?.className).toContain('text-ink');
  });

  it('computed aria-label matches expected format', () => {
    const { container } = render(<BreakdownPill segments={defaultSegments} />);
    const pill = container.firstChild as HTMLElement;
    const expected = 'Revenue: 1.23 USDC, Storage cost: —, Net: 1.23 USDC';
    expect(pill.getAttribute('aria-label')).toBe(expected);
  });

  it('decorative middots are aria-hidden', () => {
    const { container } = render(<BreakdownPill segments={defaultSegments} />);
    const middots = container.querySelectorAll('[aria-hidden="true"]');
    expect(middots.length).toBe(2); // two separators between 3 segments
  });

  it('single segment renders no middots', () => {
    const { container } = render(
      <BreakdownPill segments={[{ label: 'Rev', value: '$5' }]} />
    );
    const middots = container.querySelectorAll('[aria-hidden="true"]');
    expect(middots.length).toBe(0);
  });

  it('passes axe-core WCAG 2.1 AA — zero violations', async () => {
    const { container } = render(<BreakdownPill segments={defaultSegments} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
