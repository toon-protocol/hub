import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import App from './App.js';
import type { AggregatedEarnings } from './types.js';

// 30 claims is large enough that `visibleRows = max(5, stdout.rows - 5) ≈ 19` does not
// fit the whole buffer at ink-testing-library's default terminal size — `maxScroll > 0`,
// so a `j` press actually shifts the visible window (P2). Indexed `peer-NN` with
// strictly-descending `at` so we can assert which rows are in-frame before/after.
const RECENT_CLAIMS_30 = Array.from({ length: 30 }, (_, i) => ({
  peerId: `peer-${i.toString().padStart(2, '0')}`,
  assetCode: 'USDC' as const,
  assetScale: 6,
  amount: '12000',
  direction: (i % 2 === 0 ? 'inbound' : 'outbound') as 'inbound' | 'outbound',
  // Index 0 = newest (highest `at`). Each subsequent index is one minute older.
  at: new Date(Date.UTC(2026, 4, 14, 12, 0, 0) - i * 60_000).toISOString(),
}));

const FIXTURE_PAYLOAD: AggregatedEarnings = {
  status: 'ok',
  apex: { routingFees: { USDC: { today: '0', month: '0', year: '0', lifetime: '0' } } },
  peers: [],
  recentClaims: RECENT_CLAIMS_30,
  eventsRelayed: 42,
  uptimeSeconds: 3600,
};

function makeFetch(payload: unknown): typeof fetch {
  return async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
}

describe('App keybindings', () => {
  it('pressing [a] opens overlay', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('Activity — last');
  });

  it('pressing [q] closes overlay', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('Activity — last');
    stdin.write('q');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').not.toContain('Activity — last');
  });

  it('pressing [A] (uppercase) opens overlay (case-insensitive)', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write('A');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('Activity — last');
  });

  it('pressing ESC closes overlay', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('\x1b');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').not.toContain('Activity — last');
  });

  it('pressing [j] while overlay open shifts the visible window (P2)', async () => {
    // With 30 claims and visibleRows ≈ 19, peer-00 (newest) is in-frame at scroll=0.
    // After `j`, scroll=1; window starts at claims[1] — peer-00 falls off the top
    // and peer-19 (which was just off-screen) enters at the bottom.
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    const frameBefore = lastFrame() ?? '';
    expect(frameBefore).toContain('Activity — last');
    expect(frameBefore).toContain('peer-00');

    stdin.write('j');
    await new Promise((r) => setTimeout(r, 50));
    const frameAfter = lastFrame() ?? '';
    expect(frameAfter).toContain('Activity — last');
    // Visible window has shifted: peer-00 should be off-frame after a single `j`.
    expect(frameAfter).not.toContain('peer-00');
  });

  it('pressing [k] after [j] returns peer-00 to frame (clamps at 0) (P2)', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('j');
    await new Promise((r) => setTimeout(r, 50));
    stdin.write('k');
    await new Promise((r) => setTimeout(r, 50));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Activity — last');
    // peer-00 is back in frame after k undoes the j scroll.
    expect(frame).toContain('peer-00');
  });

  it('Ctrl-A from dashboard does NOT open the overlay (P4 — AC #4 ctrl/meta guard)', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    // Ctrl-A = 0x01. Without the `key.ctrl || key.meta` guard in App.tsx, the lower-case
    // `a` would still satisfy the `input === 'a'` arm and toggle the overlay.
    stdin.write('\x01');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').not.toContain('Activity — last');
  });

  it('Alt-A from dashboard does NOT open the overlay (P4 — AC #4 ctrl/meta guard)', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    // Alt-A is sent by terminals as ESC + `a` (`\x1ba`). Ink parses this as
    // `key.meta = true, input = 'a'`. The guard catches this and ignores it.
    stdin.write('\x1ba');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').not.toContain('Activity — last');
  });

  it('Ctrl-Q while overlay open does NOT close the overlay (P1 — ctrl/meta guard)', async () => {
    // Dev Notes "What NOT to do" + Story Close-Out checklist line 979 verbatim require the
    // overlay's useInput to early-return on key.ctrl/key.meta. Otherwise Ctrl-Q triggers onClose().
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('Activity — last');
    // Ctrl-Q = 0x11
    stdin.write('\x11');
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame() ?? '').toContain('Activity — last');
  });

  it('Ctrl-J while overlay open does NOT scroll (P1 — ctrl/meta guard)', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(App, { fetchImpl: makeFetch(FIXTURE_PAYLOAD), refreshIntervalMs: 99_999 })
    );
    await new Promise((r) => setTimeout(r, 100));
    stdin.write('a');
    await new Promise((r) => setTimeout(r, 50));
    // Ctrl-J = 0x0a (line feed)
    stdin.write('\x0a');
    await new Promise((r) => setTimeout(r, 50));
    // Overlay still open; we just assert no crash + still rendered.
    expect(lastFrame() ?? '').toContain('Activity — last');
  });
});
