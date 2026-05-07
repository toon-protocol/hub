/**
 * Town view tests (AC: #14, #16 — story 21.10, Task 10.1).
 *
 * Tests:
 *   - renders one card per enabled Town node
 *   - event feed has role="log" aria-live="polite"
 *   - fee slider is present
 *   - axe-core passes WCAG 2.1 AA in ready, empty, and error states
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { TownView } from './Town';
import { axe } from '../test-setup';
import type { NodeInfo } from '@toon-protocol/townhouse';

// ── MockWebSocket ─────────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  readyState = 0;
  listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (ev: { data?: unknown }) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  removeEventListener() {}
  close() {
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => this.fire('close'));
  }
  fire(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const fixtureTownNode: NodeInfo = {
  id: 'town-01',
  type: 'town',
  enabled: true,
  state: 'running',
  uptimeSeconds: 3600,
  image: 'toon:town',
};

const allNodes: NodeInfo[] = [
  fixtureTownNode,
  { id: 'mill', type: 'mill', enabled: true, state: 'running', uptimeSeconds: 1800, image: 'toon:mill' },
];

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderTownView() {
  return render(
    <MemoryRouter>
      <TownView />
    </MemoryRouter>
  );
}

function mockApiSuccess() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = typeof input === 'string' ? input : (input as URL).toString();
    if (url === '/api/nodes') return jsonRes(allNodes);
    if (url.startsWith('/api/nodes/town')) {
      if (url.includes('/bandwidth')) return jsonRes({ bytesIn: 1024, bytesOut: 2048, sampleAt: Date.now() });
      if (url.includes('/packets/timeseries')) return jsonRes({ buckets: [] });
      // GET /api/nodes/town
      return jsonRes({
        id: 'town',
        type: 'town',
        enabled: true,
        state: 'running',
        uptimeSeconds: 3600,
        image: 'toon:town',
        config: { enabled: true, feePerEvent: 100 },
        metrics: { packetsForwarded: 42, packetsRejected: 0, bytesSent: 1024, attribution: 'aggregate', available: true },
      });
    }
    throw new Error('unexpected ' + url);
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('TownView', () => {
  it('renders one card per enabled Town node with correct aria-label', async () => {
    mockApiSuccess();
    renderTownView();

    await waitFor(() => {
      expect(screen.getByLabelText(/town-01 town node/i)).toBeInTheDocument();
    });
  });

  it('event feed has role="log" and aria-live="polite" (AC-14)', async () => {
    mockApiSuccess();
    renderTownView();

    await waitFor(() => {
      expect(screen.getByLabelText(/town-01 town node/i)).toBeInTheDocument();
    });

    const feeds = screen.getAllByRole('log');
    expect(feeds.length).toBeGreaterThan(0);
    for (const feed of feeds) {
      expect(feed).toHaveAttribute('aria-live', 'polite');
    }
  });

  it('shows fee slider with Apply button', async () => {
    mockApiSuccess();
    renderTownView();

    await waitFor(() => {
      expect(screen.getByLabelText(/town-01 town node/i)).toBeInTheDocument();
    });

    const applyBtn = screen.getByRole('button', { name: /apply/i });
    expect(applyBtn).toBeInTheDocument();
  });

  it('clears isRestarting when PATCH fails (no stuck loading state)', async () => {
    // Deferred PATCH promise — lets us fire connectorRestarting in between click and response
    let resolvePatch!: (v: Response) => void;
    const patchPromise = new Promise<Response>((resolve) => { resolvePatch = resolve; });

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes(allNodes);
      if (url.includes('/bandwidth')) return jsonRes({ bytesIn: 0, bytesOut: 0, sampleAt: Date.now() });
      if (url.includes('/packets/timeseries')) return jsonRes({ buckets: [] });
      if (url.includes('/config')) return patchPromise; // deferred
      return jsonRes({ id: 'town', type: 'town', enabled: true, state: 'running', uptimeSeconds: 0,
        image: 'toon:town', config: { enabled: true, feePerEvent: 0 },
        metrics: { packetsForwarded: 0, packetsRejected: 0, bytesSent: 0, attribution: 'aggregate', available: true } });
    });
    renderTownView();

    // Wait for card to appear in ready state
    await waitFor(() => expect(screen.getByLabelText(/town-01 town node/i)).toBeInTheDocument());
    const applyBtn = screen.getByRole('button', { name: /apply/i });

    // Click Apply — triggers the deferred PATCH
    fireEvent.click(applyBtn);

    // Simulate connectorRestarting WS event (as the server would emit during PATCH processing)
    const metricsWs = MockWebSocket.instances.find((ws) => ws.url.includes('/api/metrics'));
    expect(metricsWs).toBeDefined();
    act(() => {
      metricsWs!.readyState = MockWebSocket.OPEN;
      metricsWs!.fire('message', JSON.stringify({ type: 'connectorRestarting' }));
    });

    // Cards should now be in loading state (spinner visible, content hidden)
    await waitFor(() => expect(screen.getAllByRole('status').length).toBeGreaterThan(0));
    expect(screen.queryByRole('button', { name: /apply/i })).toBeNull();

    // Resolve PATCH with 500 → handleApplyFee error path → setIsRestarting(false)
    await act(async () => {
      resolvePatch(jsonRes({ error: 'internal_error', message: 'Health check timeout' }, 500));
      // Flush microtasks so state updates propagate
      await Promise.resolve();
    });

    // Loading state should be cleared: Apply button visible again
    await waitFor(() => expect(screen.getByRole('button', { name: /apply/i })).toBeInTheDocument());
  });

  it('shows empty state when no Town nodes are enabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes([
        { id: 'mill', type: 'mill', enabled: true, state: 'running', uptimeSeconds: 0, image: 'toon:mill' },
      ]);
      return jsonRes(null);
    });
    renderTownView();

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });
    expect(screen.getByText(/no town nodes are enabled/i)).toBeInTheDocument();
  });

  it('shows error state when /api/nodes fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 500));
    renderTownView();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText(/could not load town nodes/i)).toBeInTheDocument();
  });

  it('AC-14: passes axe-core WCAG 2.1 AA in ready state', async () => {
    mockApiSuccess();
    const { container } = renderTownView();

    await waitFor(() => {
      expect(screen.getByLabelText(/town-01 town node/i)).toBeInTheDocument();
    });

    expect(await axe(container)).toHaveNoViolations();
  });

  it('AC-14: passes axe-core in empty state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes([]);
      return jsonRes(null);
    });
    const { container } = renderTownView();

    await waitFor(() => {
      expect(screen.getByRole('status')).toBeInTheDocument();
    });

    expect(await axe(container)).toHaveNoViolations();
  });

  it('AC-14: passes axe-core in error state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 500));
    const { container } = renderTownView();

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });

    expect(await axe(container)).toHaveNoViolations();
  });
});
