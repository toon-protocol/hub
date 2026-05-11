/**
 * Tests for EarningsPanel (Story D4, AC-D4-4).
 *
 * Test gate (per build sheet):
 *   - renders the panel
 *   - hover/click reveals a tooltip on rows
 *   - explorer link href matches schema
 */

import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  EarningsPanel,
  formatSats,
  truncateHash,
  type EarningsPayload,
} from './earnings-panel';

const SAMPLE_PAYLOAD: EarningsPayload = {
  since: '2026-05-04T10:00:00.000Z',
  totals: { sats: '12345', tokens: {} },
  by_source: {
    relay: { sats: '10000', tokens: {} },
    mill: { sats: '2000', tokens: {} },
    dvm: { sats: '345', tokens: {} },
    connector: { sats: '0', tokens: {} },
  },
  items: [
    {
      ts: '2026-05-04T11:00:00.000Z',
      source: 'relay',
      asset: { symbol: 'sats', decimals: 0 },
      amount: '100',
    },
    {
      ts: '2026-05-04T11:01:00.000Z',
      source: 'mill',
      asset: { symbol: 'sats', decimals: 0 },
      amount: '50',
      txHash: '0x' + 'a'.repeat(64),
      explorerUrl: 'https://blockscout.example/tx/0x' + 'a'.repeat(64),
    },
  ],
};

describe('EarningsPanel', () => {
  it('renders the panel with hero total and per-source breakdown', () => {
    render(
      <EarningsPanel initialData={SAMPLE_PAYLOAD} fetchEnabled={false} />
    );

    expect(screen.getByLabelText(/^Earnings$/)).toBeInTheDocument();
    // Hero total — formatted with thousands separator
    expect(
      screen.getByLabelText(/Total sats earned: 12,345/)
    ).toBeInTheDocument();
    // Per-source rail
    expect(
      screen.getByLabelText(/Relay earnings: 10,000 sats/)
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Mill earnings: 2,000 sats/)
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/DVM earnings: 345 sats/)
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(/Connector earnings: 0 sats/)
    ).toBeInTheDocument();
  });

  it('shows "loading…" status before any data arrives', () => {
    render(<EarningsPanel fetchEnabled={false} />);
    expect(screen.getByText(/loading…/i)).toBeInTheDocument();
  });

  it('shows the empty placeholder when items array is empty', () => {
    const empty: EarningsPayload = {
      ...SAMPLE_PAYLOAD,
      items: [],
    };
    render(<EarningsPanel initialData={empty} fetchEnabled={false} />);
    expect(
      screen.getByText(/No paid events in the current window/i)
    ).toBeInTheDocument();
  });

  it('hover/click reveals tooltip with txid and explorer link', async () => {
    const user = userEvent.setup();
    render(
      <EarningsPanel initialData={SAMPLE_PAYLOAD} fetchEnabled={false} />
    );

    // Two rows — only the second has a txHash + explorerUrl. Find it by
    // its source label and open the disclosure.
    const rowsList = screen.getByLabelText(/Earnings rows/i);
    const millRow = within(rowsList)
      .getAllByRole('group', { hidden: true })
      // group role is on the hidden inner div; fall back to data-source
      .find(() => true);
    expect(millRow).toBeDefined();

    // Click the mill row's summary to expand the details disclosure.
    const summaries = rowsList.querySelectorAll('summary');
    expect(summaries.length).toBe(2);
    // Mill row is index 1 (relay first, mill second)
    await user.click(summaries[1]);

    // Now the txid badge + explorer link should be visible. The badge is
    // built from two text nodes ("txid " + truncated hash), so we match
    // against the badge's aria-label which carries the full hash.
    expect(
      screen.getByLabelText(/Transaction hash 0xa{64}/)
    ).toBeInTheDocument();

    const link = screen.getByRole('link', {
      name: /View transaction on block explorer/i,
    });
    expect(link).toHaveAttribute(
      'href',
      `https://blockscout.example/tx/0x${'a'.repeat(64)}`
    );
    // AC-D4-3: explorer URL schema MUST be `${blockscout.url}/tx/${txHash}`
    expect(link.getAttribute('href')).toMatch(
      /^https:\/\/[^/]+\/tx\/0x[0-9a-f]{64}$/
    );
    // Open in new tab + rel for security
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('rows without txHash do not render their own explorer link', () => {
    // Render a payload where ONLY the relay row exists — no mill row to
    // contaminate the DOM. The relay row has no txHash so the conditional
    // details block must not render at all.
    const payload: EarningsPayload = {
      ...SAMPLE_PAYLOAD,
      items: [
        {
          ts: '2026-05-04T11:00:00.000Z',
          source: 'relay',
          asset: { symbol: 'sats', decimals: 0 },
          amount: '100',
        },
      ],
    };
    render(<EarningsPanel initialData={payload} fetchEnabled={false} />);

    expect(screen.queryByText(/^txid /)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', {
        name: /View transaction on block explorer/i,
      })
    ).not.toBeInTheDocument();
    // The summary still renders the row, but the chevron caret is also
    // suppressed when hasDetails is false.
    expect(screen.queryByText('›')).not.toBeInTheDocument();
  });

  it('renders an explorer link when a Solana row has an explorerUrl', () => {
    const sig = '5'.repeat(88);
    const solanaRpc = 'http://localhost:28899';
    const customUrl = encodeURIComponent(solanaRpc);
    const payload: EarningsPayload = {
      ...SAMPLE_PAYLOAD,
      items: [
        {
          ts: '2026-05-04T11:00:00.000Z',
          source: 'mill',
          asset: { symbol: 'sats', decimals: 0, chain: 'solana' },
          amount: '500',
          txHash: sig,
          explorerUrl: `https://explorer.solana.com/tx/${sig}?cluster=custom&customUrl=${customUrl}`,
        },
      ],
    };

    render(<EarningsPanel initialData={payload} fetchEnabled={false} />);

    // The summary itself becomes interactable — open the row to see the
    // link without simulating a hover (jsdom hover semantics are unstable).
    const summary = document.querySelector('summary');
    expect(summary).not.toBeNull();
    summary!.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    const link = screen.getByRole('link', {
      name: /View transaction on block explorer/i,
    });
    expect(link.getAttribute('href')).toContain('cluster=custom');
    expect(link.getAttribute('href')).toContain(customUrl);
  });

  it('handles BigInt sats totals beyond Number.MAX_SAFE_INTEGER', () => {
    const huge = '9007199254740993000'; // > 2^53
    const payload: EarningsPayload = {
      ...SAMPLE_PAYLOAD,
      totals: { sats: huge, tokens: {} },
      by_source: {
        relay: { sats: huge, tokens: {} },
        mill: { sats: '0', tokens: {} },
        dvm: { sats: '0', tokens: {} },
        connector: { sats: '0', tokens: {} },
      },
    };
    render(<EarningsPanel initialData={payload} fetchEnabled={false} />);

    // Format must preserve every digit — Number(huge) would round.
    const formatted = BigInt(huge).toLocaleString('en-US');
    expect(
      screen.getByLabelText(`Total sats earned: ${formatted}`)
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
