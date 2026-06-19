import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ActivityOverlay } from './ActivityOverlay.js';
import { COPY } from '../copy.js';
import type { RecentClaim } from '../types.js';

function makeClaim(overrides: Partial<RecentClaim> = {}): RecentClaim {
  return {
    peerId: 'town-01',
    assetCode: 'USDC',
    assetScale: 6,
    amount: '12000',
    direction: 'inbound',
    at: '2026-05-14T14:32:08Z',
    ...overrides,
  };
}

function makeClaims(n: number): RecentClaim[] {
  return Array.from({ length: n }, (_, i) =>
    makeClaim({
      peerId: `peer-${i.toString().padStart(2, '0')}`,
      at: new Date(Date.UTC(2026, 4, 14, 14, 32, i)).toISOString(),
    })
  );
}

describe('ActivityOverlay', () => {
  it('renders title row with claim count', () => {
    const claims = makeClaims(5);
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims,
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    expect(lastFrame() ?? '').toContain('Activity — last 5 of 200');
  });

  it('renders body rows for the first visibleRows of claims', () => {
    const claims = makeClaims(20);
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims,
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('peer-00');
    expect(frame).toContain('peer-01');
  });

  it('renders bottom hint row', () => {
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: makeClaims(3),
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    expect(lastFrame() ?? '').toContain(COPY.activityOverlay.scrollHint);
  });

  it('empty claims renders title with last 0 of 200 and empty hint', () => {
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: [],
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Activity — last 0 of 200');
    expect(frame).toContain(COPY.activityOverlay.emptyHint);
  });

  it('empty claims shows scrollHintEmpty (q to close), NOT j/k hint (P16)', () => {
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: [],
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(COPY.activityOverlay.scrollHintEmpty);
    expect(frame).not.toContain('j/k to scroll');
  });

  it('non-empty claims show scrollHint with j/k (P16)', () => {
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: makeClaims(3),
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(COPY.activityOverlay.scrollHint);
  });

  it('inbound claim row formats with ← arrow, in direction, and HH:MM:SS time (P15)', () => {
    const claim = makeClaim({ direction: 'inbound', amount: '12000', assetScale: 6, peerId: 'town-01', at: '2026-05-14T14:32:08Z' });
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: [claim],
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('←');
    expect(frame).toContain('$0.0120');
    expect(frame).toContain('USDC');
    expect(frame).toContain('· in');
    // P15: pin the time-column format. `toLocaleTimeString('en-GB', {hour12:false})`
    // emits HH:MM:SS in 24h form. We assert the SHAPE (zero-padded HH:MM:SS) rather
    // than a specific UTC literal so the test is portable across CI timezones — a
    // regression that swaps locale to `'en-US'` (AM/PM) or drops `hour12:false` fails.
    expect(frame).toMatch(/\b\d{2}:\d{2}:\d{2}\b/);
  });

  it('outbound claim row formats with → arrow and out direction', () => {
    const claim = makeClaim({ direction: 'outbound' });
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: [claim],
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('→');
    expect(frame).toContain('· out');
  });

  it('peerId longer than MAX_PEER_ID_WIDTH is truncated with ellipsis', () => {
    const longId = 'a'.repeat(30);
    const claim = makeClaim({ peerId: longId });
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: [claim],
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('…');
    expect(frame).not.toContain(longId);
  });

  it('malformed at renders --:--:-- (no crash)', () => {
    const claim = makeClaim({ at: 'not-a-date' });
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: [claim],
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    expect(lastFrame() ?? '').toContain('--:--:--');
  });

  it('unknown direction renders directionUnknown arrow + label (P6 — future enum drift)', () => {
    const claim = makeClaim({ direction: 'refund' as RecentClaim['direction'] });
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: [claim],
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain(COPY.activityOverlay.directionUnknown);
    expect(frame).not.toContain('←');
    expect(frame).not.toContain('→');
  });

  it('malformed amount renders USDC_MICRO_FALLBACK (no crash)', () => {
    const claim = makeClaim({ amount: 'bad' });
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims: [claim],
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    expect(lastFrame() ?? '').toContain('$?.????');
  });

  it('title clamps to MAX_BUFFER_SIZE even if claims.length exceeds it (P3 — defensive cap)', () => {
    // useActivityBuffer clamps upstream, but the overlay must defensively cap N in the title too.
    const claims = makeClaims(250);
    const { lastFrame } = render(
      React.createElement(ActivityOverlay, {
        claims,
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    expect(lastFrame() ?? '').toContain('Activity — last 200 of 200');
  });

  it('columns=80 → modalWidth=56; columns=40 → modalWidth=40 (P14 — verified via border-row length)', () => {
    // Ink's borderStyle="round" renders the top border as `╭` + `─`-runs + `╮`.
    // The longest contiguous `─` run inside the modal equals modalWidth - 2.
    //   columns=80 → modalWidth = max(40, floor(80*0.7)) = max(40, 56) = 56 → 54 dashes.
    //   columns=40 → modalWidth = max(40, floor(40*0.7)) = max(40, 28) = 40 → 38 dashes.
    // A swapped Math.min/Math.max (clamp inversion) would give 28 dashes at columns=40 — caught.
    const longestDashRun = (frame: string): number => {
      const matches = frame.match(/─+/g);
      if (!matches) return 0;
      return matches.reduce((max, run) => Math.max(max, run.length), 0);
    };

    const { lastFrame: frame80 } = render(
      React.createElement(ActivityOverlay, {
        claims: makeClaims(1),
        onClose: () => {},
        columns: 80,
        rows: 24,
      })
    );
    const { lastFrame: frame40 } = render(
      React.createElement(ActivityOverlay, {
        claims: makeClaims(1),
        onClose: () => {},
        columns: 40,
        rows: 24,
      })
    );
    expect(longestDashRun(frame80() ?? '')).toBe(54);
    expect(longestDashRun(frame40() ?? '')).toBe(38);
  });
});
