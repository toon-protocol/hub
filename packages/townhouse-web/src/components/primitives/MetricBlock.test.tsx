import { render, screen } from '@testing-library/react';
import { MetricBlock } from './MetricBlock';

describe('MetricBlock', () => {
  it('renders value and label with single accessible group', () => {
    render(<MetricBlock value={42} label="Clients" />);
    expect(screen.getByRole('group', { name: 'Clients: 42' })).toBeDefined();
    expect(screen.getByText('42')).toBeDefined();
    expect(screen.getByText('Clients')).toBeDefined();
  });

  it('includes unit in accessible name when provided', () => {
    render(<MetricBlock value={128} label="Bandwidth" unit="MB/s" />);
    expect(screen.getByRole('group', { name: 'Bandwidth: 128 MB/s' })).toBeDefined();
    expect(screen.getByText('MB/s')).toBeDefined();
  });

  it('includes positive trend in accessible name', () => {
    render(<MetricBlock value={10} label="Events" trend={5} />);
    expect(screen.getByRole('group', { name: /trend \+5/ })).toBeDefined();
    expect(screen.getByText('+5')).toBeDefined();
  });

  it('includes negative trend in accessible name', () => {
    render(<MetricBlock value={10} label="Events" trend={-3} />);
    expect(screen.getByRole('group', { name: /trend -3/ })).toBeDefined();
    expect(screen.getByText('-3')).toBeDefined();
  });

  it('omits trend indicator when trend is 0', () => {
    render(<MetricBlock value={10} label="Events" trend={0} />);
    expect(screen.queryByText('+0')).toBeNull();
    expect(screen.queryByText('-0')).toBeNull();
  });

  it('omits trend indicator when trend is NaN', () => {
    render(<MetricBlock value={10} label="Events" trend={Number.NaN} />);
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(screen.getByRole('group').getAttribute('aria-label')).not.toMatch(/trend/);
  });

  it('omits trend indicator when trend is Infinity', () => {
    render(<MetricBlock value={10} label="Events" trend={Number.POSITIVE_INFINITY} />);
    expect(screen.queryByText(/Infinity/)).toBeNull();
    expect(screen.getByRole('group').getAttribute('aria-label')).not.toMatch(/trend/);
  });

  it('compact variant renders without error', () => {
    render(<MetricBlock value={5} label="Nodes" variant="compact" />);
    expect(screen.getByText('Nodes')).toBeDefined();
  });
});
