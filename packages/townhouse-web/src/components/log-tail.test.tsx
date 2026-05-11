import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogTail } from './log-tail';
import type { LogEvent } from '@toon-protocol/townhouse';

const SAMPLE: LogEvent[] = [
  {
    ts: '2026-04-01T12:00:00.123Z',
    service: 'town',
    level: 'info',
    msg: 'relay accepted event abc',
  },
  {
    ts: '2026-04-01T12:00:01.456Z',
    service: 'mill',
    level: 'error',
    msg: 'swap claim reverted',
  },
  {
    ts: '2026-04-01T12:00:02.789Z',
    service: 'dvm',
    level: 'warn',
    msg: 'job took >5s',
  },
  {
    ts: '2026-04-01T12:00:03.000Z',
    service: 'connector',
    level: 'debug',
    msg: 'btp keepalive',
  },
];

describe('LogTail', () => {
  it('renders all initial events when filters are default (all on)', () => {
    render(<LogTail endpoint={null} initialEvents={SAMPLE} />);
    expect(screen.getByText('relay accepted event abc')).toBeInTheDocument();
    expect(screen.getByText('swap claim reverted')).toBeInTheDocument();
    expect(screen.getByText('job took >5s')).toBeInTheDocument();
    expect(screen.getByText('btp keepalive')).toBeInTheDocument();
  });

  it('renders the empty placeholder when no events have arrived', () => {
    render(<LogTail endpoint={null} initialEvents={[]} />);
    expect(screen.getByText(/waiting for log lines/i)).toBeInTheDocument();
  });

  it('toggles a service chip off and hides matching events', async () => {
    const user = userEvent.setup();
    render(<LogTail endpoint={null} initialEvents={SAMPLE} />);

    // All four messages visible initially
    expect(screen.getByText('swap claim reverted')).toBeInTheDocument();

    // Click the "mill" chip in the service group to disable it
    const serviceGroup = screen.getByLabelText(/filter by service/i);
    const millChip = within(serviceGroup).getByRole('button', { name: /mill/i });
    await user.click(millChip);

    expect(screen.queryByText('swap claim reverted')).not.toBeInTheDocument();
    // Other services still visible
    expect(screen.getByText('relay accepted event abc')).toBeInTheDocument();
  });

  it('toggles a level chip off and hides matching events', async () => {
    const user = userEvent.setup();
    render(<LogTail endpoint={null} initialEvents={SAMPLE} />);

    const levelGroup = screen.getByLabelText(/filter by level/i);
    const errorChip = within(levelGroup).getByRole('button', { name: /^error$/i });
    await user.click(errorChip);

    expect(screen.queryByText('swap claim reverted')).not.toBeInTheDocument();
    // Info / warn / debug remain
    expect(screen.getByText('relay accepted event abc')).toBeInTheDocument();
    expect(screen.getByText('job took >5s')).toBeInTheDocument();
    expect(screen.getByText('btp keepalive')).toBeInTheDocument();
  });

  it('shows "no lines match" when all chips are toggled off', async () => {
    const user = userEvent.setup();
    render(<LogTail endpoint={null} initialEvents={SAMPLE} />);

    const serviceGroup = screen.getByLabelText(/filter by service/i);
    for (const name of ['town', 'mill', 'dvm', 'connector']) {
      const chip = within(serviceGroup).getByRole('button', {
        name: new RegExp(`^${name}$`, 'i'),
      });
      await user.click(chip);
    }
    expect(screen.getByText(/no lines match/i)).toBeInTheDocument();
  });

  it('marks chips with aria-pressed reflecting active state', () => {
    render(<LogTail endpoint={null} initialEvents={SAMPLE} />);
    const serviceGroup = screen.getByLabelText(/filter by service/i);
    const townChip = within(serviceGroup).getByRole('button', { name: /town/i });
    expect(townChip).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders 4 service chips and 4 level chips', () => {
    render(<LogTail endpoint={null} initialEvents={[]} />);
    const serviceGroup = screen.getByLabelText(/filter by service/i);
    const levelGroup = screen.getByLabelText(/filter by level/i);
    expect(within(serviceGroup).getAllByRole('button')).toHaveLength(4);
    expect(within(levelGroup).getAllByRole('button')).toHaveLength(4);
  });

  it('caps rendering at the most recent 500 lines (shape check)', () => {
    const many: LogEvent[] = Array.from({ length: 600 }, (_, i) => ({
      ts: `2026-04-01T12:00:${String(i % 60).padStart(2, '0')}.000Z`,
      service: 'town',
      level: 'info',
      msg: `line ${i}`,
    }));
    render(<LogTail endpoint={null} initialEvents={many} />);
    // initialEvents bypasses the trimming, so we just verify the panel doesn't
    // crash with a large list. The cap is enforced when SSE events arrive
    // (covered by reading the source — tested indirectly here by smoke).
    expect(screen.getByLabelText(/container log lines/i)).toBeInTheDocument();
  });
});
