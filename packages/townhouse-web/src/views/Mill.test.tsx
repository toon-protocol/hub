/**
 * Mill view tests (AC-11, AC-13, AC-19, AC-20, Story 21.11).
 */
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { axe } from '../test-setup';
import { colors } from '@/theme/tokens';
// Mock ThroughputChart so we can directly assert the props Mill passes —
// in particular the `color` prop wired to the mill accent token. Without
// this, JSDOM + Recharts ResponsiveContainer make the rendered <Line>'s
// stroke attribute unobservable.
const throughputChartProps: Array<Record<string, unknown>> = [];
vi.mock('@/components/charts/ThroughputChart', () => ({
  ThroughputChart: (props: Record<string, unknown>) => {
    throughputChartProps.push(props);
    return null;
  },
}));
import { MillView } from './Mill';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const MILL_NODE = {
  id: 'mill',
  type: 'mill',
  enabled: true,
  state: 'running',
  uptimeSeconds: 60,
  image: 'toon:mill',
};

const MILL_DETAIL = {
  ...MILL_NODE,
  config: { enabled: true, feeBasisPoints: 50 },
  metrics: { packetsForwarded: 10, packetsRejected: 0, bytesSent: 100, attribution: 'aggregate', available: true },
};

// Production-shape mill /health response — chains is MillChainKind[]
// (chain *family*), not full chain identifiers.
const MILL_HEALTH = {
  status: 'ok',
  version: '1.0.0',
  nodePubkey: 'a'.repeat(64),
  swapPairsCount: 1,
  chains: ['evm', 'solana'],
  uptimeSec: 60,
  inventory: {
    'USDC:evm:base:31337': '1000000',
    'evm:base:31337': '1000000',
    'USDC:solana:devnet': '500000',
    'solana:devnet': '500000',
  },
  swapPairs: [
    {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:31337' },
      to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
      rate: '1.0',
    },
  ],
  inventoryAvailable: {
    'USDC:evm:base:31337': '600000',
    'evm:base:31337': '600000',
    'USDC:solana:devnet': '400000',
    'solana:devnet': '400000',
  },
};

const SWAPS_RECENT = { count: 3, volume: '3000000', byPair: [] };
const TIMESERIES = { buckets: [] };
const DEPOSIT_ADDRESSES = { chains: [{ family: 'evm', address: '0x1234' }] };

interface FetchOverrides {
  health?: typeof MILL_HEALTH | (() => typeof MILL_HEALTH);
  nodes?: Array<typeof MILL_NODE>;
}

function setupFetch(overrides: FetchOverrides = {}) {
  const nodesList = overrides.nodes ?? [MILL_NODE];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url === '/api/nodes') return jsonRes(nodesList);
    if (url === '/api/nodes/mill') return jsonRes(MILL_DETAIL);
    if (/\/api\/nodes\/[^/]+\/health/.test(url)) {
      const payload =
        typeof overrides.health === 'function'
          ? overrides.health()
          : overrides.health ?? MILL_HEALTH;
      return jsonRes(payload);
    }
    if (/\/api\/nodes\/[^/]+\/swaps\/recent/.test(url)) return jsonRes(SWAPS_RECENT);
    if (url.includes('/api/nodes/mill/packets/timeseries')) return jsonRes(TIMESERIES);
    if (/\/api\/nodes\/[^/]+\/deposit-addresses/.test(url)) return jsonRes(DEPOSIT_ADDRESSES);
    if (url.includes('/api/nodes/mill/bandwidth')) return jsonRes(null);
    return jsonRes({}, 404);
  });
}

beforeEach(() => {
  throughputChartProps.length = 0;
  setupFetch();
});
afterEach(() => vi.restoreAllMocks());

function renderMill() {
  return render(
    <MemoryRouter>
      <MillView />
    </MemoryRouter>
  );
}

describe('MillView', () => {
  it('AC-11: renders mill node card', async () => {
    renderMill();
    await waitFor(() => expect(screen.getByText('Mill swap instances')).toBeDefined());
    expect(screen.getByRole('article', { name: /mill.*mill node/ })).toBeDefined();
  });

  it('AC-11: shows empty state when no mill nodes', async () => {
    setupFetch({ nodes: [] });
    renderMill();
    await waitFor(() => expect(screen.getByText(/No Mill nodes are enabled/)).toBeDefined());
  });

  it('AC-11: shows error state on fetch failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    renderMill();
    await waitFor(() => expect(screen.getByRole('alert')).toBeDefined());
    expect(screen.getByText(/Could not load Mill nodes/)).toBeDefined();
  });

  it('AC-13: renders LiquidityBar per chain family with production health shape', async () => {
    renderMill();
    await waitFor(() => expect(screen.getAllByRole('meter').length).toBeGreaterThan(0));
    const meters = screen.getAllByRole('meter');
    // Two chain families in the fixture (evm, solana) → two LiquidityBars.
    expect(meters).toHaveLength(2);
    // The LiquidityBar's aria-label embeds the resolved full chain identifier
    // (not the bare family) so we know the key derivation worked.
    const labels = meters.map((m) => m.getAttribute('aria-label') ?? '');
    expect(labels.some((l) => l.includes('evm:base:31337'))).toBe(true);
    expect(labels.some((l) => l.includes('solana:devnet'))).toBe(true);
  });

  it('AC-13: rebal-pulse appears when inventoryAvailable shifts between polls', async () => {
    let pollIndex = 0;
    setupFetch({
      health: () => {
        pollIndex += 1;
        // First poll: baseline. Subsequent polls: shift evm:base:31337
        // available — the delta detector should fire on the second poll.
        if (pollIndex === 1) return MILL_HEALTH;
        return {
          ...MILL_HEALTH,
          inventoryAvailable: {
            ...MILL_HEALTH.inventoryAvailable,
            'USDC:evm:base:31337': '550000',
            'evm:base:31337': '550000',
          },
        };
      },
    });
    renderMill();
    await waitFor(() => expect(screen.getAllByRole('meter').length).toBeGreaterThan(0));

    await waitFor(
      () => {
        const meters = screen.getAllByRole('meter');
        const pulsing = meters.some((m) => m.className.includes('animate-rebal-pulse'));
        expect(pulsing).toBe(true);
      },
      { timeout: 7_000 }
    );
  }, 10_000);

  it('AC-16: fee slider Apply button is present', async () => {
    renderMill();
    await waitFor(() => expect(screen.getByText('Apply')).toBeDefined());
  });

  it('AC-16: earnings preview is rendered below the slider when volume > 0', async () => {
    renderMill();
    await waitFor(() =>
      expect(screen.getAllByText(/Approx earnings at current fee/).length).toBeGreaterThan(0)
    );
  });

  it('AC-17: Add Funds disclosure present', async () => {
    renderMill();
    await waitFor(() => expect(screen.getByText('Add Funds')).toBeDefined());
  });

  it('AC-19: passes axe-core WCAG 2.1 AA', async () => {
    const { container } = renderMill();
    await waitFor(() => expect(screen.getByText('Mill swap instances')).toBeDefined());
    // Allow slight settle time for all async renders
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('Task 13.2: passes the mill accent color to ThroughputChart', async () => {
    renderMill();
    await waitFor(() => expect(screen.getByText('Mill swap instances')).toBeDefined());
    await waitFor(() => expect(throughputChartProps.length).toBeGreaterThan(0));
    const lastProps = throughputChartProps[throughputChartProps.length - 1]!;
    expect(lastProps['color']).toBe(colors.type.mill);
  });

  it('AC-20: renders two cards side-by-side for multi-mill dev stack', async () => {
    setupFetch({
      nodes: [
        { ...MILL_NODE, id: 'dev-mill-01' },
        { ...MILL_NODE, id: 'dev-mill-02' },
      ],
    });
    renderMill();
    await waitFor(() => {
      const articles = screen.getAllByRole('article');
      expect(articles.length).toBe(2);
    });
    expect(screen.getByRole('article', { name: /dev-mill-01.*mill node/ })).toBeDefined();
    expect(screen.getByRole('article', { name: /dev-mill-02.*mill node/ })).toBeDefined();
  });
});
