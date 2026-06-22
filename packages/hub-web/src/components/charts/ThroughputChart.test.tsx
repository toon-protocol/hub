import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ThroughputChart } from './ThroughputChart';
import { colors } from '@/theme/tokens';

const DVM_COLOR = colors.type.dvm;

const BUCKETS = [
  { ts: Date.now() - 3600_000, count: 5 },
  { ts: Date.now() - 1800_000, count: 3 },
  { ts: Date.now(), count: 7 },
];

describe('ThroughputChart', () => {
  it('renders loading spinner when status=loading', () => {
    const { container } = render(
      <ThroughputChart status="loading" buckets={[]} count={0} color={DVM_COLOR} />
    );
    expect(container.querySelector('[role="status"]')).not.toBeNull();
  });

  it('renders unavailable message when status=unavailable', () => {
    render(
      <ThroughputChart status="unavailable" buckets={[]} count={0} color={DVM_COLOR} />
    );
    expect(screen.getByText(/connector v3\.4\+/i)).toBeDefined();
  });

  it('renders error message when status=error', () => {
    render(
      <ThroughputChart status="error" buckets={[]} count={0} color={DVM_COLOR} />
    );
    expect(screen.getByText(/Could not load chart data/i)).toBeDefined();
  });

  it('renders chart when status=ready with buckets', () => {
    const { container } = render(
      <ThroughputChart status="ready" buckets={BUCKETS} count={15} color={DVM_COLOR} />
    );
    // Recharts' actual SVG doesn't always materialize in JSDOM (ResponsiveContainer
    // measures width); assert we're in the chart-rendered branch by ruling out
    // the loading/error/unavailable copy and confirming the chart wrapper exists.
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(screen.queryByText(/Could not load chart data/)).toBeNull();
    expect(screen.queryByText(/connector v3\.4\+/i)).toBeNull();
    expect(container.querySelector('.recharts-wrapper, [data-chart]')).not.toBeNull();
  });

  it('renders earningsEst caption when count > 0 and earningsEst is provided', () => {
    render(
      <ThroughputChart
        status="ready"
        buckets={BUCKETS}
        count={15}
        color={DVM_COLOR}
        earningsEst="Approx earnings: ~0.000150"
      />
    );
    expect(screen.getByText(/Approx earnings/)).toBeDefined();
  });

  it('does not render earningsEst when count=0', () => {
    render(
      <ThroughputChart
        status="ready"
        buckets={[]}
        count={0}
        color={DVM_COLOR}
        earningsEst="some estimate"
      />
    );
    expect(screen.queryByText(/some estimate/)).toBeNull();
  });

  it('renders the empty earningsEst placeholder when caller passes "—"', () => {
    // Mill's view passes "Approx earnings at current fee: —" when count is
    // > 0 but volume data isn't yet stable; the chart must still render it
    // so behavior matches the pre-hoist VolumeChart's fallback branch.
    render(
      <ThroughputChart
        status="ready"
        buckets={BUCKETS}
        count={1}
        color={DVM_COLOR}
        earningsEst="Approx earnings at current fee: —"
      />
    );
    expect(screen.getByText('Approx earnings at current fee: —')).not.toBeNull();
  });
});
