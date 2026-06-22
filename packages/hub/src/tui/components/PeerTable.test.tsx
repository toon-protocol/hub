import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { PeerTable } from './PeerTable.js';
import { COPY } from '../copy.js';
import type { AggregatedEarnings } from '../types.js';

const FIXED_NOW = new Date('2026-05-14T12:00:00Z');

function makePeer(
  id: string,
  type: AggregatedEarnings['peers'][number]['type'],
  assets: Record<string, string>,
  lastClaimAt: string | null = null
): AggregatedEarnings['peers'][number] {
  const byAsset: Record<string, { lifetime: string; today: string; month: string; year: string }> = {};
  for (const [code, month] of Object.entries(assets)) {
    byAsset[code] = { lifetime: month, today: '0', month, year: '0' };
  }
  return { id, type, byAsset, lastClaimAt };
}

describe('PeerTable component', () => {
  it('renders 1 header + 1 data row for one peer with one asset', () => {
    const peers = [makePeer('alice', 'town', { USDC: '1234567' }, '2026-05-12T12:00:00Z')];
    const { lastFrame } = render(React.createElement(PeerTable, { peers, now: FIXED_NOW }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('PEER');
    expect(frame).toContain('NET (MONTH)');
    expect(frame).toContain('alice');
    expect(frame).toContain('$1.23');
    expect(frame).toContain('2d ago');
  });

  it('renders 1 header + 3 data rows for one peer with 3 assets (UX-DR7 stacking)', () => {
    const peers = [
      makePeer('bob', 'mill', {
        'USDC': '100000',
        'USDC-evm': '200000',
        'USDC-sol': '300000',
      }),
    ];
    const { lastFrame } = render(React.createElement(PeerTable, { peers, now: FIXED_NOW }));
    const frame = lastFrame() ?? '';

    // Header present
    expect(frame).toContain('PEER');
    // peer id appears exactly once (first row of group)
    const bobCount = (frame.match(/bob/g) ?? []).length;
    expect(bobCount).toBe(1);
    // TYPE cell appears exactly once (UX-DR7: type belongs to first row of peer group)
    const millCount = (frame.match(/mill/g) ?? []).length;
    expect(millCount).toBe(1);
    // All three assets appear
    expect(frame).toContain('USDC');
    expect(frame).toContain('USDC-evm');
    expect(frame).toContain('USDC-sol');
  });

  it('truncates to 4 data rows when peer/asset cross-product exceeds 4', () => {
    const peers = [
      makePeer('multi', 'town', {
        'USDC-a': '100',
        'USDC-b': '200',
        'USDC-c': '300',
        'USDC-d': '400',
        'USDC-e': '500',
        'USDC-f': '600',
      }),
    ];
    const { lastFrame } = render(React.createElement(PeerTable, { peers, now: FIXED_NOW }));
    const frame = lastFrame() ?? '';
    // Only first 4 assets (alphabetical) should appear; USDC-e and USDC-f should not
    expect(frame).toContain('USDC-a');
    expect(frame).toContain('USDC-d');
    expect(frame).not.toContain('USDC-e');
    expect(frame).not.toContain('USDC-f');
  });

  it('renders empty-state copy when peers is empty', () => {
    const { lastFrame } = render(React.createElement(PeerTable, { peers: [], now: FIXED_NOW }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain(COPY.peerTable.empty);
    expect(frame).not.toContain('PEER');
  });

  it('shows lastClaimNever (—) for null lastClaimAt', () => {
    const peers = [makePeer('alice', 'town', { USDC: '0' }, null)];
    const { lastFrame } = render(React.createElement(PeerTable, { peers, now: FIXED_NOW }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('—');
  });

  it('width 65: TYPE column truncates to 3 chars, LAST CLAIM drops ago suffix', () => {
    const peers = [makePeer('peer-x', 'town', { USDC: '500000' }, '2026-05-14T11:55:00Z')];
    const { lastFrame } = render(
      React.createElement(PeerTable, { peers, now: FIXED_NOW, columns: 65 })
    );
    const frame = lastFrame() ?? '';
    // TYPE = 'town' → first 3 chars = 'tow' at <70ch
    expect(frame).toContain('tow');
    // 5m ago → 5m (ago suffix dropped)
    expect(frame).toContain('5m');
    expect(frame).not.toContain('5m ago');
  });

  it('width 55: LAST CLAIM column dropped entirely', () => {
    const peers = [makePeer('peer-y', 'mill', { USDC: '100000' }, '2026-05-12T12:00:00Z')];
    const { lastFrame } = render(
      React.createElement(PeerTable, { peers, now: FIXED_NOW, columns: 55 })
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('LAST CLAIM');
    expect(frame).not.toContain('ago');
    // Core columns still present
    expect(frame).toContain('NET (MONTH)');
  });
});
