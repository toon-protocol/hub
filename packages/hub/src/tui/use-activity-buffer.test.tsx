import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React, { useEffect } from 'react';
import { useActivityBuffer, MAX_BUFFER_SIZE } from './use-activity-buffer.js';
import type { RecentClaim } from './types.js';

function makeClaim(overrides: Partial<RecentClaim> = {}): RecentClaim {
  return {
    peerId: 'town-01',
    assetCode: 'USDC',
    assetScale: 6,
    amount: '12000',
    direction: 'inbound',
    at: '2026-05-14T12:00:00Z',
    ...overrides,
  };
}

describe('useActivityBuffer', () => {
  it('first call returns incoming recentClaims sorted DESC by at', async () => {
    const older = makeClaim({ peerId: 'old', at: '2026-05-14T10:00:00Z' });
    const newer = makeClaim({ peerId: 'new', at: '2026-05-14T12:00:00Z' });
    let captured: RecentClaim[] = [];

    function Probe(): React.ReactElement {
      const buf = useActivityBuffer([older, newer]);
      useEffect(() => { captured = buf; }, [buf]);
      return React.createElement(React.Fragment, null);
    }

    render(React.createElement(Probe, null));
    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBe(2);
    expect(captured[0]?.peerId).toBe('new');
    expect(captured[1]?.peerId).toBe('old');
  });

  it('re-render with same-content (new ref) incoming does not change buffer reference', async () => {
    const claim = makeClaim();
    let captured: RecentClaim[] = [];

    function Probe({ incoming }: { incoming: RecentClaim[] }): React.ReactElement {
      const buf = useActivityBuffer(incoming);
      useEffect(() => { captured = buf; }, [buf]);
      return React.createElement(React.Fragment, null);
    }

    const { rerender } = render(React.createElement(Probe, { incoming: [claim] }));
    await new Promise((r) => setTimeout(r, 80));

    const bufAfterSettle = captured;

    // Provide a new array reference with the same content (simulates a new tick with same data)
    rerender(React.createElement(Probe, { incoming: [{ ...claim }] }));
    await new Promise((r) => setTimeout(r, 80));

    // Buffer reference should be unchanged (same-equality check in hook prevents setBuffer)
    expect(captured).toBe(bufAfterSettle);
  });

  it('second call with new claims merges and sorts correctly', async () => {
    const claim1 = makeClaim({ peerId: 'a', at: '2026-05-14T10:00:00Z' });
    const claim2 = makeClaim({ peerId: 'b', at: '2026-05-14T12:00:00Z' });
    let captured: RecentClaim[] = [];
    let setIncoming!: (c: RecentClaim[]) => void;

    function Probe(): React.ReactElement {
      const [incoming, setInc] = React.useState<RecentClaim[]>([claim1]);
      setIncoming = setInc;
      const buf = useActivityBuffer(incoming);
      useEffect(() => { captured = buf; }, [buf]);
      return React.createElement(React.Fragment, null);
    }

    render(React.createElement(Probe, null));
    await new Promise((r) => setTimeout(r, 50));
    setIncoming([claim1, claim2]);
    await new Promise((r) => setTimeout(r, 50));

    expect(captured.some((c) => c.peerId === 'a')).toBe(true);
    expect(captured.some((c) => c.peerId === 'b')).toBe(true);
    expect(captured[0]?.peerId).toBe('b');
  });

  it('duplicate claim (same 5-field key) is collapsed in the buffer', async () => {
    const claim = makeClaim({ peerId: 'x', at: '2026-05-14T12:00:00Z', amount: '1000' });
    const dup = { ...claim };
    let captured: RecentClaim[] = [];

    function Probe(): React.ReactElement {
      const buf = useActivityBuffer([claim, dup]);
      useEffect(() => { captured = buf; }, [buf]);
      return React.createElement(React.Fragment, null);
    }

    render(React.createElement(Probe, null));
    await new Promise((r) => setTimeout(r, 50));
    expect(captured.filter((c) => c.peerId === 'x').length).toBe(1);
  });

  it('multi-tick eviction: 200 on tick A + 50 newer on tick B → length 200, oldest 50 evicted (P17)', async () => {
    // Single-shot 250-feed (next test) only exercises the empty-buffer merge path.
    // This test exercises the realistic flow: buffer fills, then a later tick brings
    // newer claims; the cap holds at 200 and the oldest 50 get evicted in favor of the new arrivals.
    const tickA = Array.from({ length: 200 }, (_, i) =>
      makeClaim({
        peerId: `tickA-${i.toString().padStart(3, '0')}`,
        // tickA timestamps occupy seconds 0..199 of 2026-05-14T10:00:00Z.
        at: new Date(Date.UTC(2026, 4, 14, 10, 0, i)).toISOString(),
      })
    );
    const tickB = Array.from({ length: 50 }, (_, i) =>
      makeClaim({
        peerId: `tickB-${i.toString().padStart(3, '0')}`,
        // tickB timestamps are STRICTLY NEWER than every tickA entry (start at 11:00).
        at: new Date(Date.UTC(2026, 4, 14, 11, 0, i)).toISOString(),
      })
    );

    let captured: RecentClaim[] = [];
    let setIncoming!: (c: RecentClaim[]) => void;

    function Probe(): React.ReactElement {
      const [incoming, setInc] = React.useState<RecentClaim[]>(tickA);
      setIncoming = setInc;
      const buf = useActivityBuffer(incoming);
      useEffect(() => { captured = buf; }, [buf]);
      return React.createElement(React.Fragment, null);
    }

    render(React.createElement(Probe, null));
    await new Promise((r) => setTimeout(r, 80));
    expect(captured.length).toBe(MAX_BUFFER_SIZE);

    setIncoming(tickB);
    await new Promise((r) => setTimeout(r, 80));

    expect(captured.length).toBe(MAX_BUFFER_SIZE);
    // All 50 newest (tickB) survive.
    for (let i = 0; i < 50; i++) {
      expect(captured.some((c) => c.peerId === `tickB-${i.toString().padStart(3, '0')}`)).toBe(true);
    }
    // Oldest 50 of tickA (000..049) are evicted.
    for (let i = 0; i < 50; i++) {
      expect(captured.some((c) => c.peerId === `tickA-${i.toString().padStart(3, '0')}`)).toBe(false);
    }
    // Middle 150 of tickA (050..199) survive.
    expect(captured.some((c) => c.peerId === 'tickA-050')).toBe(true);
    expect(captured.some((c) => c.peerId === 'tickA-199')).toBe(true);
  });

  it('buffer truncates at MAX_BUFFER_SIZE: feed 250 claims → buffer length === 200', async () => {
    const claims = Array.from({ length: 250 }, (_, i) =>
      makeClaim({
        peerId: `p${i}`,
        at: new Date(Date.UTC(2026, 4, 14, 0, 0, i)).toISOString(),
      })
    );
    let captured: RecentClaim[] = [];

    function Probe(): React.ReactElement {
      const buf = useActivityBuffer(claims);
      useEffect(() => { captured = buf; }, [buf]);
      return React.createElement(React.Fragment, null);
    }

    render(React.createElement(Probe, null));
    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBe(MAX_BUFFER_SIZE);
  });

  it('recentClaims=undefined → buffer unchanged (no crash, no clear)', async () => {
    const claim = makeClaim({ peerId: 'initial' });
    let captured: RecentClaim[] = [];
    let setIncoming!: (c: RecentClaim[] | undefined) => void;

    function Probe(): React.ReactElement {
      const [incoming, setInc] = React.useState<RecentClaim[] | undefined>([claim]);
      setIncoming = setInc;
      const buf = useActivityBuffer(incoming);
      useEffect(() => { captured = buf; }, [buf]);
      return React.createElement(React.Fragment, null);
    }

    render(React.createElement(Probe, null));
    await new Promise((r) => setTimeout(r, 50));
    const beforeLen = captured.length;
    setIncoming(undefined);
    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBe(beforeLen);
  });

  it('malformed-at claim sorts to end and does not crash', async () => {
    const bad = makeClaim({ peerId: 'bad', at: 'not-a-date' });
    const good = makeClaim({ peerId: 'good', at: '2026-05-14T12:00:00Z' });
    let captured: RecentClaim[] = [];

    function Probe(): React.ReactElement {
      const buf = useActivityBuffer([bad, good]);
      useEffect(() => { captured = buf; }, [buf]);
      return React.createElement(React.Fragment, null);
    }

    render(React.createElement(Probe, null));
    await new Promise((r) => setTimeout(r, 50));
    expect(captured.length).toBe(2);
    expect(captured[0]?.peerId).toBe('good');
    expect(captured[1]?.peerId).toBe('bad');
  });

  it('mixing inbound and outbound preserves direction field', async () => {
    const inbound = makeClaim({ peerId: 'in', direction: 'inbound', at: '2026-05-14T12:00:00Z' });
    const outbound = makeClaim({ peerId: 'out', direction: 'outbound', at: '2026-05-14T11:00:00Z' });
    let captured: RecentClaim[] = [];

    function Probe(): React.ReactElement {
      const buf = useActivityBuffer([inbound, outbound]);
      useEffect(() => { captured = buf; }, [buf]);
      return React.createElement(React.Fragment, null);
    }

    render(React.createElement(Probe, null));
    await new Promise((r) => setTimeout(r, 50));
    const inClaim = captured.find((c) => c.peerId === 'in');
    const outClaim = captured.find((c) => c.peerId === 'out');
    expect(inClaim?.direction).toBe('inbound');
    expect(outClaim?.direction).toBe('outbound');
  });
});
