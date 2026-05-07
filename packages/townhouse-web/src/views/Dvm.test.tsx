/**
 * DVM view tests (AC-22, AC-24, Story 21.12).
 */
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { axe } from '../test-setup';
import { DvmView } from './Dvm';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const DVM_NODE = {
  id: 'dev-dvm-01',
  type: 'dvm',
  enabled: true,
  state: 'running',
  uptimeSeconds: 120,
  image: 'toon:dvm',
};

const DVM_DETAIL = {
  ...DVM_NODE,
  config: { enabled: true, feePerJob: 10 },
  metrics: { packetsForwarded: 5, packetsRejected: 0, bytesSent: 500, attribution: 'aggregate', available: true },
};

const DVM_HEALTH = {
  status: 'ok',
  version: '1.0.0',
  nodePubkey: 'a'.repeat(64),
  uptimeSec: 120,
  handlerKinds: [5094, 5250],
  kindPricing: { '5094': '10', '5250': '10000' },
  basePricePerByte: '10',
  jobsRecent: {
    total: 3,
    byKind: [{ kind: 5094, count: 2 }, { kind: 5250, count: 1 }],
    byStatus: { processing: 0, success: 3, error: 0, partial: 0 },
  },
};

const JOBS_RECENT = {
  count: 3,
  volume: '1500000',
  byKind: [
    { kind: 5094, count: 2, volume: '1000000' },
    { kind: 5250, count: 1, volume: '500000' },
  ],
  byStatus: { processing: 0, success: 3, error: 0, partial: 0 },
};

const TIMESERIES = { buckets: [] };
const DEPOSIT_ADDRESSES = { chains: [{ family: 'evm', address: '0xdeadbeef' }] };
const BANDWIDTH = null;

function setupFetch(nodesList = [DVM_NODE]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url === '/api/nodes') return jsonRes(nodesList);
    if (url === '/api/nodes/dvm') return jsonRes(DVM_DETAIL);
    if (/\/api\/nodes\/[^/]+\/health/.test(url)) return jsonRes(DVM_HEALTH);
    if (/\/api\/nodes\/[^/]+\/jobs\/recent/.test(url)) return jsonRes(JOBS_RECENT);
    if (/\/api\/nodes\/dvm\/packets\/timeseries/.test(url)) return jsonRes(TIMESERIES);
    if (/\/api\/nodes\/[^/]+\/deposit-addresses/.test(url)) return jsonRes(DEPOSIT_ADDRESSES);
    if (/\/api\/nodes\/dvm\/bandwidth/.test(url)) return jsonRes(BANDWIDTH);
    return jsonRes({}, 404);
  });
}

beforeEach(() => setupFetch());
afterEach(() => vi.restoreAllMocks());

function renderDvm() {
  return render(
    <MemoryRouter>
      <DvmView />
    </MemoryRouter>
  );
}

describe('DvmView', () => {
  it('renders the DVM node card after data loads', async () => {
    const { getByText } = renderDvm();
    await waitFor(() => expect(getByText('dev-dvm-01')).toBeDefined());
  });

  it('shows empty state when no DVM nodes exist', async () => {
    setupFetch([]);
    const { getByText } = renderDvm();
    await waitFor(() =>
      expect(getByText(/No DVM nodes are enabled/i)).toBeDefined()
    );
  });

  it('shows error state when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));
    const { getByText } = renderDvm();
    await waitFor(() =>
      expect(getByText(/Could not load DVM nodes/i)).toBeDefined()
    );
  });

  it('renders TypeChip — DVM label visible in card', async () => {
    const { container } = renderDvm();
    await waitFor(() => screen.getByText('dev-dvm-01'));
    // TypeChip renders uppercase "DVM" for type=dvm
    const allText = container.textContent ?? '';
    expect(allText).toContain('DVM');
  });

  it('renders handler-kinds row with Arweave and Dungeon labels', async () => {
    renderDvm();
    // Handler kinds come from health data — wait for health to load
    await waitFor(
      () => {
        const allText = document.body.textContent ?? '';
        expect(allText).toContain('Arweave');
      },
      { timeout: 3000 }
    );
    expect(document.body.textContent).toContain('Dungeon');
  });

  it('renders job queue counter MetricBlocks once jobs data loads', async () => {
    renderDvm();
    // Wait for jobs data to populate the StateShell (total=3 means state=ready)
    await waitFor(
      () => {
        expect(screen.getByText('Completed')).toBeDefined();
      },
      { timeout: 3000 }
    );
    expect(screen.getByText('Failed')).toBeDefined();
  });

  it('renders BreakdownPill with Revenue label', async () => {
    renderDvm();
    await waitFor(() => {
      expect(screen.getByText('Revenue 5m')).toBeDefined();
    });
    expect(screen.getByText('Storage cost')).toBeDefined();
    expect(screen.getByText('Net')).toBeDefined();
  });

  it('renders Add Funds disclosure', async () => {
    renderDvm();
    await waitFor(() => {
      expect(screen.getByText('Add Funds')).toBeDefined();
    });
  });

  it('passes axe-core WCAG 2.1 AA — ready state', async () => {
    const { container } = renderDvm();
    await waitFor(() => screen.getByText('dev-dvm-01'));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('passes axe-core WCAG 2.1 AA — empty state', async () => {
    setupFetch([]);
    const { container } = renderDvm();
    await waitFor(() => screen.getByText(/No DVM nodes are enabled/i));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('passes axe-core WCAG 2.1 AA — error state', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));
    const { container } = renderDvm();
    await waitFor(() => screen.getByText(/Could not load DVM nodes/i));
    expect(await axe(container)).toHaveNoViolations();
  });
});
