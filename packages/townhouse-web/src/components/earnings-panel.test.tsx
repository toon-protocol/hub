/**
 * Tests for EarningsPanel (Story 47.2).
 *
 * Tests cover:
 *   - Panel renders with apex routing fees + peer earnings.
 *   - Loading state before any data.
 *   - Empty state when apex/peers are both empty.
 *   - Per-row delta visibility (mixed row payload).
 *   - `connector_unavailable` wire-level banner.
 *   - External peer type fallback.
 *   - formatSats / truncateHash utilities.
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  EarningsPanel,
  formatSats,
  truncateHash,
  type AggregatedEarnings,
} from './earnings-panel';

const SAMPLE_PAYLOAD: AggregatedEarnings = {
  status: 'ok',
  apex: {
    routingFees: {
      USD: { lifetime: '12345', today: '0', month: '0', year: '0' },
    },
  },
  peers: [
    {
      id: 'peer-town-01',
      type: 'town',
      byAsset: {
        USD: { lifetime: '10000', today: '0', month: '0', year: '0' },
      },
    },
    {
      id: 'peer-mill-01',
      type: 'mill',
      byAsset: {
        USD: { lifetime: '2000', today: '0', month: '0', year: '0' },
      },
    },
  ],
};

describe('EarningsPanel', () => {
  it('renders the panel with apex routing fees and peer earnings sections', () => {
    render(
      <EarningsPanel initialData={SAMPLE_PAYLOAD} fetchEnabled={false} />
    );

    expect(screen.getByLabelText(/^Earnings$/)).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Apex routing fees: 12,345 USD/)
    ).toBeInTheDocument();
    expect(screen.getAllByLabelText(/Apex routing fees/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('region', { name: 'Peer earnings' })).toBeInTheDocument();
    expect(screen.getByLabelText('Peer earnings rows')).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Town peer peer-town-01: 10,000 USD lifetime/i)
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Mill peer peer-mill-01: 2,000 USD lifetime/i)
    ).toBeInTheDocument();
  });

  it('shows "loading…" status before any data arrives', () => {
    render(<EarningsPanel fetchEnabled={false} />);
    expect(screen.getByText('loading…')).toBeInTheDocument();
  });

  it('shows empty-state placeholder when apex and peers are both empty', () => {
    const empty: AggregatedEarnings = {
      status: 'ok',
      apex: { routingFees: {} },
      peers: [],
    };
    render(<EarningsPanel initialData={empty} fetchEnabled={false} />);
    expect(screen.getByText(/No routing fees yet/i)).toBeInTheDocument();
    expect(screen.getByText(/No peer earnings yet/i)).toBeInTheDocument();
    // Empty-state aria-label distinguishes "no fees" from "lifetime 0 of UNIT".
    expect(screen.getByLabelText(/Apex routing fees: none yet/i)).toBeInTheDocument();
  });

  it('renders delta column when deltas are non-zero', () => {
    const withDeltas: AggregatedEarnings = {
      status: 'ok',
      apex: {
        routingFees: {
          USD: { lifetime: '5000', today: '100', month: '500', year: '1000' },
        },
      },
      peers: [],
    };
    render(<EarningsPanel initialData={withDeltas} fetchEnabled={false} />);
    expect(screen.getByText(/\+100 today/i)).toBeInTheDocument();
  });

  it('hides delta column when all deltas are "0" (per-row check)', () => {
    // Mixed payload: apex has non-zero deltas, peer rows have all-zero deltas.
    // The "today" indicator must show on the apex row and be ABSENT on peer rows.
    const mixed: AggregatedEarnings = {
      status: 'ok',
      apex: {
        routingFees: {
          USD: { lifetime: '5000', today: '100', month: '500', year: '1000' },
        },
      },
      peers: [
        {
          id: 'peer-town-quiet',
          type: 'town',
          byAsset: {
            USD: { lifetime: '200', today: '0', month: '0', year: '0' },
          },
        },
      ],
    };
    render(<EarningsPanel initialData={mixed} fetchEnabled={false} />);

    // Apex row: "+100 today" is rendered.
    const apexSection = screen.getByRole('region', { name: 'Apex routing fees' });
    expect(within(apexSection).getByText(/\+100 today/)).toBeInTheDocument();

    // Peer row: no "today" indicator anywhere inside the peer rows.
    const peerRows = screen.getByLabelText('Peer earnings rows');
    expect(within(peerRows).queryByText(/today/i)).not.toBeInTheDocument();
  });

  it('renders connector_unavailable banner when wire status flips', () => {
    const unavailable: AggregatedEarnings = {
      status: 'connector_unavailable',
      apex: { routingFees: {} },
      peers: [],
    };
    render(<EarningsPanel initialData={unavailable} fetchEnabled={false} />);

    expect(screen.getByLabelText(/Connector unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/Connector unreachable/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/earnings metric unavailable/i)).toBeInTheDocument();

    // Status indicator flips to "unavailable" (not "live", not "loading…").
    expect(screen.getByText('unavailable')).toBeInTheDocument();

    // Peer table reflects the unavailable state.
    expect(
      screen.getByText(/Connector unavailable — no peer earnings to show\./i)
    ).toBeInTheDocument();
  });

  it('renders external peer type correctly', () => {
    const withExternal: AggregatedEarnings = {
      status: 'ok',
      apex: { routingFees: {} },
      peers: [
        {
          id: 'peer-unknown-x',
          type: 'external',
          byAsset: {
            USD: { lifetime: '77', today: '0', month: '0', year: '0' },
          },
        },
      ],
    };
    render(<EarningsPanel initialData={withExternal} fetchEnabled={false} />);
    expect(
      screen.getByLabelText(/External peer peer-unknown-x: 77 USD lifetime/i)
    ).toBeInTheDocument();
  });
});

describe('formatSats', () => {
  it('formats with thousands separators', () => {
    expect(formatSats('1234567')).toBe('1,234,567');
  });

  it('handles zero', () => {
    expect(formatSats('0')).toBe('0');
  });

  it('handles BigInt-sized values', () => {
    const big = '99999999999999999999';
    expect(formatSats(big)).toBe(BigInt(big).toLocaleString('en-US'));
  });

  it('returns the raw string when input is not a valid bigint', () => {
    expect(formatSats('not-a-number')).toBe('not-a-number');
  });
});

describe('truncateHash', () => {
  it('truncates an EVM tx hash to 0xaaaaaa…aaaa (8 + ellipsis + 4)', () => {
    const h = '0x' + 'a'.repeat(64);
    expect(truncateHash(h)).toBe('0xaaaaaa…aaaa');
  });

  it('truncates a Solana base58 signature to 8 chars + ellipsis + 4 chars', () => {
    const sig = '1'.repeat(88);
    expect(truncateHash(sig)).toBe('11111111…1111');
  });

  it('keeps short strings intact', () => {
    expect(truncateHash('short')).toBe('short');
  });
});
