import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HeroBand } from './components/HeroBand.js';
import { Sparkline } from './components/Sparkline.js';
import type { AggregatedEarnings } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ZERO_APEX: AggregatedEarnings['apex'] = {
  routingFees: { USDC: { lifetime: '0', today: '0', month: '0', year: '0' } },
};
const NONZERO_APEX: AggregatedEarnings['apex'] = {
  routingFees: {
    USDC: {
      lifetime: '5000000',
      today: '100000',
      month: '1000000',
      year: '3000000',
    },
  },
};
const EMPTY_PEERS: AggregatedEarnings['peers'] = [];

describe('HeroBand component', () => {
  it('renders four scalar USDC columns with formatted values', () => {
    const { lastFrame } = render(
      React.createElement(HeroBand, {
        apex: NONZERO_APEX,
        peers: EMPTY_PEERS,
        eventsRelayed: 0,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('$0.10');
    expect(frame).toContain('$1.00');
    expect(frame).toContain('$5.00');
  });

  it('shows empty-state qualifier when all month values are zero', () => {
    const { lastFrame } = render(
      React.createElement(HeroBand, {
        apex: ZERO_APEX,
        peers: EMPTY_PEERS,
        eventsRelayed: 7,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain("you're early");
    expect(frame).toContain('7 events relayed');
    expect(frame).toContain('MONTH $0.00');
  });

  it('hides qualifier when apex month > 0', () => {
    const { lastFrame } = render(
      React.createElement(HeroBand, {
        apex: NONZERO_APEX,
        peers: EMPTY_PEERS,
        eventsRelayed: 0,
      })
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain("you're early");
  });

  it('survives malformed peer USDC amount (defense in depth — P4)', () => {
    const peersWithJunk: AggregatedEarnings['peers'] = [
      {
        id: 'junk-peer',
        type: 'town',
        byAsset: {
          USDC: { lifetime: 'not-a-number', today: '0', month: '0', year: '0' },
        },
        lastClaimAt: null,
      },
    ];
    expect(() =>
      render(
        React.createElement(HeroBand, {
          apex: ZERO_APEX,
          peers: peersWithJunk,
          eventsRelayed: 0,
        })
      )
    ).not.toThrow();
  });
});

describe('Sparkline width degradation (AC #6)', () => {
  it('returns null (no row reserved) when width < 60', () => {
    const { lastFrame } = render(
      React.createElement(Sparkline, { values: [1, 2, 3, 4, 5], width: 50 })
    );
    expect(lastFrame()).toBe('');
  });

  it('boundary: width = 59 collapses (last collapsing width)', () => {
    const { lastFrame } = render(
      React.createElement(Sparkline, { values: [1, 2, 3, 4, 5], width: 59 })
    );
    expect(lastFrame()).toBe('');
  });

  it('boundary: width = 60 renders (first rendering width)', () => {
    const { lastFrame } = render(
      React.createElement(Sparkline, { values: [1, 2, 3, 4, 5], width: 60 })
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toBe('');
    expect(frame).toContain('7d');
  });

  it('renders placeholder dots when values is empty', () => {
    const { lastFrame } = render(
      React.createElement(Sparkline, { values: [], width: 80 })
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('·······');
    expect(frame).toContain('7d');
  });

  it('survives NaN / Infinity / negative values (P5)', () => {
    expect(() =>
      render(
        React.createElement(Sparkline, {
          values: [NaN, Infinity, -5, 2, 3],
          width: 80,
        })
      )
    ).not.toThrow();
  });
});

describe('Hardcoded copy smoke check (AC #9)', () => {
  it('no hardcoded copy strings in tui *.tsx files — all copy from copy.ts', () => {
    // Extended from components/ to ALL tui *.tsx files — App.tsx lives one dir up
    // and also renders COPY-driven UI. P19.
    const tuiDir = __dirname;
    const componentsDir = resolve(__dirname, 'components');

    const collectTsx = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true })
        .filter(
          (d) =>
            d.isFile() &&
            d.name.endsWith('.tsx') &&
            !d.name.endsWith('.test.tsx')
        )
        .map((d) => join(dir, d.name));

    const files = [...collectTsx(tuiDir), ...collectTsx(componentsDir)];

    const FORBIDDEN_RE =
      /["'`](you're early|warming up|first packet en route|Fetching earnings|Connector not reachable|Last refresh failed|Starting up —|↳ apex routing|enable mill to route|no peers yet|recent: |\[a\] activity|no settlements yet|j\/k to scroll|Activity — last|\(no activity yet\))/i;
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      expect(
        FORBIDDEN_RE.test(content),
        `${file} contains a hardcoded copy string — use COPY.* from copy.ts instead`
      ).toBe(false);
    }
  });
});

describe('Ink render options (AC #7, AC #11)', () => {
  // Ink's `render` export is non-configurable, so vi.spyOn cannot intercept it
  // without re-exporting through a wrapper. Smoke check against the source
  // string is sufficient: mountTui is a 4-line function and the option-bag is
  // a literal. Drift would be visible in a diff.
  it('mountTui source sets patchConsole: false (tmux-safe per AC #7)', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf-8');
    expect(source).toMatch(/patchConsole:\s*false/);
  });

  it('mountTui source sets exitOnCtrlC: true (AC #1 — Ctrl-C resolves waitUntilExit)', () => {
    const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf-8');
    expect(source).toMatch(/exitOnCtrlC:\s*true/);
  });
});
