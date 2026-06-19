import { describe, it, expect } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { ApexStrip } from './ApexStrip.js';
import { USDC_FALLBACK } from '../format.js';
import type { AggregatedEarnings } from '../types.js';

const EMPTY_PEERS: AggregatedEarnings['peers'] = [];

const MILL_PEER: AggregatedEarnings['peers'] = [
  {
    id: 'mill-peer',
    type: 'mill',
    byAsset: { USDC: { lifetime: '0', today: '0', month: '0', year: '0' } },
    lastClaimAt: null,
  },
];

function makeApex(month: string): AggregatedEarnings['apex'] {
  return { routingFees: { USDC: { lifetime: month, today: '0', month, year: '0' } } };
}

describe('ApexStrip component', () => {
  it('renders routing fee with percentage (floor behavior)', () => {
    // apex.month = 1234567, peers contribute 2302873 USDC → total = 3537440
    // 1234567 / 3537440 = 0.34908... → floor = 34, round = 35; pins floor behavior
    const apex = makeApex('1234567');
    const peers: AggregatedEarnings['peers'] = [
      {
        id: 'town-peer',
        type: 'town',
        byAsset: { USDC: { lifetime: '2302873', today: '0', month: '2302873', year: '0' } },
        lastClaimAt: null,
      },
    ];
    const { lastFrame } = render(React.createElement(ApexStrip, { apex, peers }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↳ apex routing: $1.23');
    expect(frame).toContain('(34%)');
    expect(frame).not.toContain('(35%)');
  });

  it('renders upsell when apex=0 and no Mill peer exists', () => {
    const apex = makeApex('0');
    const { lastFrame } = render(React.createElement(ApexStrip, { apex, peers: EMPTY_PEERS }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↳ apex routing: $0.00');
    expect(frame).toContain('(enable mill to route)');
  });

  it('renders no upsell when apex=0 and a Mill peer exists', () => {
    const apex = makeApex('0');
    const { lastFrame } = render(React.createElement(ApexStrip, { apex, peers: MILL_PEER }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↳ apex routing: $0.00');
    expect(frame).not.toContain('(enable mill to route)');
  });

  it('renders 100% when apex is the only contributor (peers empty)', () => {
    const apex = makeApex('1000000');
    const { lastFrame } = render(React.createElement(ApexStrip, { apex, peers: EMPTY_PEERS }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↳ apex routing: $1.00');
    expect(frame).toContain('(100%)');
  });

  it('omits percentage parenthetical when negative apex exactly cancels with peer (defensive edge)', () => {
    // Negative apex (refund/chargeback) is wire-legal per `^-?\d+$`. When a peer's positive
    // contribution exactly cancels, totalMonth reaches 0n — division would throw, so we omit.
    const apex = makeApex('-1000');
    const peers: AggregatedEarnings['peers'] = [
      {
        id: 'town-peer',
        type: 'town',
        byAsset: { USDC: { lifetime: '0', today: '0', month: '1000', year: '0' } },
        lastClaimAt: null,
      },
    ];
    const { lastFrame } = render(React.createElement(ApexStrip, { apex, peers }));
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('%');
  });

  it('renders USDC_FALLBACK with no upsell and no percentage when apex.month is malformed', () => {
    const apex: AggregatedEarnings['apex'] = {
      routingFees: { USDC: { lifetime: '0', today: '0', month: 'not-a-number', year: '0' } },
    };
    const { lastFrame } = render(React.createElement(ApexStrip, { apex, peers: EMPTY_PEERS }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↳ apex routing:');
    expect(frame).toContain(USDC_FALLBACK);
    expect(frame).not.toContain('(enable mill to route)');
    expect(frame).not.toContain('%');
  });

  it('USDC-only filter: non-USDC peer assets do not contribute to percentage denominator', () => {
    // peer has only USDC-sol (not the literal 'USDC' key) — should not affect apex %
    const apex = makeApex('1000000');
    const peers: AggregatedEarnings['peers'] = [
      {
        id: 'sol-peer',
        type: 'town',
        byAsset: {
          'USDC-sol': { lifetime: '9000000', today: '0', month: '9000000', year: '0' },
        },
        lastClaimAt: null,
      },
    ];
    const { lastFrame } = render(React.createElement(ApexStrip, { apex, peers }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↳ apex routing: $1.00');
    // USDC-sol does not count → totalMonth = apex = 1000000n → 100%
    expect(frame).toContain('(100%)');
  });
});
