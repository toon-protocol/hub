import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ActivityTicker } from './ActivityTicker.js';
import { USDC_MICRO_FALLBACK } from '../format.js';
import { COPY } from '../copy.js';
import type { RecentClaim } from '../types.js';

const NOW = new Date('2026-05-14T12:00:00Z');

function makeClaim(overrides: Partial<RecentClaim> = {}): RecentClaim {
  return {
    peerId: 'town-01',
    assetCode: 'USDC',
    assetScale: 6,
    amount: '12000',
    direction: 'inbound',
    at: '2026-05-14T11:55:00Z',
    ...overrides,
  };
}

describe('ActivityTicker', () => {
  it('empty recentClaims renders empty-state copy AND no populated artifacts (P11)', () => {
    const { lastFrame } = render(
      React.createElement(ActivityTicker, { recentClaims: [], now: NOW })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(COPY.activityTicker.empty);
    // Defense against an additive double-render bug: populated content (arrows,
    // amount markers, `recent: ` prefix) MUST NOT coexist with the empty state.
    expect(frame).not.toContain('←');
    expect(frame).not.toContain('→');
    expect(frame).not.toContain('recent: ');
  });

  it('inbound claim renders with ← arrow and 4-decimal amount', () => {
    const { lastFrame } = render(
      React.createElement(ActivityTicker, {
        recentClaims: [makeClaim({ direction: 'inbound', amount: '12000', assetScale: 6 })],
        now: NOW,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('recent: ');
    expect(frame).toContain('town-01');
    expect(frame).toContain('←');
    expect(frame).toContain('$0.0120');
    expect(frame).toContain('USDC');
    expect(frame).toContain(COPY.activityTicker.keybind);
  });

  it('outbound claim renders with → arrow', () => {
    const { lastFrame } = render(
      React.createElement(ActivityTicker, {
        recentClaims: [makeClaim({ direction: 'outbound' })],
        now: NOW,
      })
    );
    expect(lastFrame() ?? '').toContain('→');
  });

  it('relative-time uses injected now prop deterministically', () => {
    const claimAt = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    const { lastFrame } = render(
      React.createElement(ActivityTicker, {
        recentClaims: [makeClaim({ at: claimAt })],
        now: NOW,
      })
    );
    expect(lastFrame() ?? '').toContain('5m ago');
  });

  it('only the newest (highest-at) claim is shown when multiple are provided', () => {
    // `first` has the EARLIER at; `second` is newer — defensive sort surfaces `second`.
    const { lastFrame } = render(
      React.createElement(ActivityTicker, {
        recentClaims: [
          makeClaim({ peerId: 'first', at: '2026-05-14T11:55:00Z' }),
          makeClaim({ peerId: 'second', at: '2026-05-14T11:58:00Z' }),
        ],
        now: NOW,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('second');
    expect(frame).not.toContain('first');
  });

  it('defensive sort surfaces the newest claim even when wire ships ascending order (P18)', () => {
    // Wire ordering is not contractually DESC. Ticker must sort defensively.
    const { lastFrame } = render(
      React.createElement(ActivityTicker, {
        recentClaims: [
          makeClaim({ peerId: 'oldest', at: '2026-05-14T11:50:00Z' }),
          makeClaim({ peerId: 'middle', at: '2026-05-14T11:55:00Z' }),
          makeClaim({ peerId: 'newest', at: '2026-05-14T11:59:00Z' }),
        ],
        now: NOW,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('newest');
    expect(frame).not.toContain('oldest');
    expect(frame).not.toContain('middle');
  });

  it('malformed amount renders formatUsdcMicro fallback', () => {
    const { lastFrame } = render(
      React.createElement(ActivityTicker, {
        recentClaims: [makeClaim({ amount: 'bad' })],
        now: NOW,
      })
    );
    expect(lastFrame() ?? '').toContain(USDC_MICRO_FALLBACK);
  });

  it('malformed at renders formatRelativeTime fallback (P12 — pinned at the relative-time slot)', () => {
    // amount is valid → formatUsdcMicro returns `$0.0120`, NOT the `$?.????` fallback.
    // Only formatRelativeTime should produce a `?` — assert at the row position
    // `· ?` so a separately-malformed-amount regression cannot satisfy the test.
    const { lastFrame } = render(
      React.createElement(ActivityTicker, {
        recentClaims: [makeClaim({ at: 'not-a-date', amount: '12000' })],
        now: NOW,
      })
    );
    expect(lastFrame() ?? '').toContain('· ?');
  });

  it('unknown direction renders directionUnknown arrow (P6 — future enum drift)', () => {
    // Wire schema enforces 'inbound' | 'outbound' on serialize; TUI does not re-validate on deserialize.
    // A future enum value like 'refund' must NOT silently render as outbound.
    const claim = makeClaim({ direction: 'refund' as RecentClaim['direction'] });
    const { lastFrame } = render(
      React.createElement(ActivityTicker, {
        recentClaims: [claim],
        now: NOW,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(COPY.activityOverlay.directionUnknown);
    expect(frame).not.toContain('←');
    expect(frame).not.toContain('→');
  });
});
