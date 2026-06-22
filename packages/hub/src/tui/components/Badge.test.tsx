import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Badge } from './Badge.js';
import { COPY } from '../copy.js';
import type { AggregatedEarnings } from '../types.js';

const EMPTY_PEERS: AggregatedEarnings['peers'] = [];

function makeApex(lifetime: string): AggregatedEarnings['apex'] {
  return { routingFees: { USDC: { lifetime, today: '0', month: '0', year: '0' } } };
}

function makePeer(
  id: string,
  lifetime: string,
  assetCode = 'USDC'
): AggregatedEarnings['peers'][number] {
  return {
    id,
    type: 'town',
    byAsset: { [assetCode]: { lifetime, today: '0', month: '0', year: '0' } },
    lastClaimAt: null,
  };
}

// Pin rotation index 0 — Math.floor(0 / 30_000) % 3 === 0 → COPY.heroEarlyRotation[0]
const PINNED_NOW = new Date(0);

describe('Badge component', () => {
  it('renders when lifetime < $1.00 AND uptime < 7d (both triggers)', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('500000'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 3600,
        now: PINNED_NOW,
      })
    );
    expect(lastFrame() ?? '').toContain(COPY.heroEarlyRotation[0]);
  });

  it('renders when lifetime >= $1.00 AND uptime < 7d (only uptime triggers)', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('2000000'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 3600,
        now: PINNED_NOW,
      })
    );
    expect(lastFrame() ?? '').toContain(COPY.heroEarlyRotation[0]);
  });

  it('renders when lifetime < $1.00 AND uptime >= 7d (only lifetime triggers)', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('500000'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 8 * 24 * 60 * 60,
        now: PINNED_NOW,
      })
    );
    expect(lastFrame() ?? '').toContain(COPY.heroEarlyRotation[0]);
  });

  it('returns null when lifetime >= $1.00 AND uptime >= 7d (silent disappearance)', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('2000000'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 8 * 24 * 60 * 60,
        now: PINNED_NOW,
      })
    );
    expect(lastFrame() ?? '').toBe('');
  });

  it('boundary: lifetime === $1.00 exactly AND uptime === 7d exactly → null', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('1000000'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 604800,
        now: PINNED_NOW,
      })
    );
    expect(lastFrame() ?? '').toBe('');
  });

  it('boundary: lifetime === 999_999 AND uptime === 604_799 → visible', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('999999'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 604799,
        now: PINNED_NOW,
      })
    );
    expect(lastFrame() ?? '').toContain(COPY.heroEarlyRotation[0]);
  });

  it('asymmetric boundary: lifetime === 0 AND uptime === 604_800 → visible (only-lifetime triggers at exact uptime threshold)', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('0'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 604800,
        now: PINNED_NOW,
      })
    );
    expect(lastFrame() ?? '').toContain(COPY.heroEarlyRotation[0]);
  });

  it('sums lifetime across apex + multiple peers (total < threshold → visible)', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('500000'),
        peers: [makePeer('p1', '200000'), makePeer('p2', '200000')],
        uptimeSeconds: 8 * 24 * 60 * 60,
        now: PINNED_NOW,
      })
    );
    // total = 900_000n < 1_000_000n → lifetime trigger fires
    expect(lastFrame() ?? '').toContain(COPY.heroEarlyRotation[0]);
  });

  it('sums lifetime across apex + multiple peers (total >= threshold → null)', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('500000'),
        peers: [makePeer('p1', '500000'), makePeer('p2', '500000')],
        uptimeSeconds: 8 * 24 * 60 * 60,
        now: PINNED_NOW,
      })
    );
    // total = 1_500_000n >= 1_000_000n AND uptime above → null
    expect(lastFrame() ?? '').toBe('');
  });

  it('defensive: malformed apex.lifetime treated as 0n', () => {
    const apex: AggregatedEarnings['apex'] = {
      routingFees: { USDC: { lifetime: 'not-a-number', today: '0', month: '0', year: '0' } },
    };
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex,
        peers: [makePeer('p1', '2000000')],
        uptimeSeconds: 8 * 24 * 60 * 60,
        now: PINNED_NOW,
      })
    );
    // malformed apex → 0n; peer = 2_000_000n; total >= threshold AND uptime above → null
    expect(lastFrame() ?? '').toBe('');
  });

  it('USDC-only filter: USDC-sol peer lifetime does not contribute', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('500000'),
        peers: [makePeer('sol', '5000000', 'USDC-sol')],
        uptimeSeconds: 8 * 24 * 60 * 60,
        now: PINNED_NOW,
      })
    );
    // apex=500_000 only; non-USDC peer ignored; total < threshold → lifetime trigger fires
    expect(lastFrame() ?? '').toContain(COPY.heroEarlyRotation[0]);
  });

  it("rotation index 0 (now=0) → \"you're early\"", () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('0'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 0,
        now: new Date(0),
      })
    );
    expect(lastFrame() ?? '').toContain("you're early");
  });

  it('rotation index 1 (now=35_000ms) → "warming up"', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('0'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 0,
        now: new Date(35_000),
      })
    );
    expect(lastFrame() ?? '').toContain('warming up');
  });

  it('rotation index 2 (now=65_000ms) → "first packet en route"', () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('0'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 0,
        now: new Date(65_000),
      })
    );
    expect(lastFrame() ?? '').toContain('first packet en route');
  });

  it("rotation wraps at index 3 → back to \"you're early\"", () => {
    const { lastFrame } = render(
      React.createElement(Badge, {
        apex: makeApex('0'),
        peers: EMPTY_PEERS,
        uptimeSeconds: 0,
        now: new Date(95_000), // floor(95000 / 30000) = 3; 3 % 3 = 0
      })
    );
    expect(lastFrame() ?? '').toContain("you're early");
  });
});
