import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Home } from './Home';
import { axe } from '../test-setup';
import type { NodeInfo, NodeDetail } from '@toon-protocol/townhouse';

// Mock useWizardState to return config_exists: true by default (normal mode)
vi.mock('@/hooks/useWizardState', () => ({
  useWizardState: () => ({
    state: { config_exists: true, wallet_exists: true, containers_running: true, mode: 'normal', ts: Date.now() },
    status: 'ready',
    refetch: vi.fn(),
  }),
}));

// Mock useTransportStatus — default to direct/reachable.
// Use a mutable object so per-test overrides don't require re-mocking.
const mockTransportStatus = {
  status: { mode: 'direct' as const, reachable: true, latencyProxyMs: null as number | null, latencyDirectMs: 5 as number | null, lastProbedAt: Date.now(), probeError: null as string | null, ts: Date.now() },
  statusKind: 'ready' as const,
  refetch: vi.fn(),
};
vi.mock('@/hooks/useTransportStatus', () => ({
  useTransportStatus: () => mockTransportStatus,
}));

// Hand-rolled WebSocket mock — same pattern as useNodeStatusStream.test.ts
class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;
  static CLOSED = 3;
  url: string;
  readyState = 0;
  listeners = new Map<string, ((ev: { data?: unknown }) => void)[]>();
  closed = false;
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
    this.closed = true;
    this.readyState = MockWebSocket.CLOSED;
    queueMicrotask(() => this.fire('close'));
  }
  fire(type: string, data?: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
  acceptOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.fire('open');
  }
  pushMessage(payload: unknown) {
    this.fire('message', JSON.stringify(payload));
  }
}

const fixtureNodes: NodeInfo[] = [
  { id: 'town', type: 'town', enabled: true, state: 'running', uptimeSeconds: 3600, image: 'toon:town' },
  { id: 'mill', type: 'mill', enabled: true, state: 'running', uptimeSeconds: 1800, image: 'toon:mill' },
  { id: 'dvm', type: 'dvm', enabled: false, state: 'not-created', uptimeSeconds: null, image: 'toon:dvm' },
];

function makeDetail(type: 'town' | 'mill' | 'dvm', packets = 7): NodeDetail {
  return {
    id: type,
    type,
    enabled: true,
    state: 'running',
    uptimeSeconds: 1800,
    image: `toon:${type}`,
    config: { enabled: true, feePerEvent: 1 },
    metrics: {
      packetsForwarded: packets,
      packetsRejected: 0,
      bytesSent: 1024,
      attribution: 'aggregate',
      available: true,
    },
  };
}

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal('WebSocket', MockWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderHome() {
  return render(
    <MemoryRouter>
      <Home />
    </MemoryRouter>
  );
}

describe('Home view', () => {
  it('renders one card per enabled node with correct labels', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes(fixtureNodes);
      if (url === '/api/nodes/town') return jsonRes(makeDetail('town', 12));
      if (url === '/api/nodes/mill') return jsonRes(makeDetail('mill', 5));
      throw new Error('unexpected ' + url);
    });

    renderHome();

    await waitFor(() => {
      expect(screen.getByLabelText(/^town node$/i)).toBeInTheDocument();
    });
    expect(screen.getByLabelText(/^mill node$/i)).toBeInTheDocument();
    // dvm is disabled → not rendered
    expect(screen.queryByLabelText(/^dvm node$/i)).toBeNull();
  });

  it('renders empty state with link to /wizard (AC-12)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      jsonRes([
        { type: 'town', enabled: false, state: 'not-created', uptimeSeconds: null, image: '' },
      ])
    );
    renderHome();
    await waitFor(() => {
      expect(screen.getByText(/no nodes configured/i)).toBeInTheDocument();
    });
    const wizardLink = screen.getByRole('link', { name: /run wizard/i });
    expect(wizardLink.getAttribute('href')).toBe('/wizard');
  });

  it('renders error state with retry when /api/nodes fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 500));
    renderHome();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByText(/could not reach townhouse api/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('overrides node state from WS nodeState messages (AC-3, AC-10)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes(fixtureNodes);
      if (url === '/api/nodes/town') return jsonRes(makeDetail('town'));
      if (url === '/api/nodes/mill') return jsonRes(makeDetail('mill'));
      throw new Error('unexpected ' + url);
    });
    renderHome();

    // Wait for the cards to render.
    await waitFor(() =>
      expect(screen.getByLabelText(/^town node$/i)).toBeInTheDocument()
    );

    // WS opens, then a `nodeState` event flips town to paused → degraded dot.
    // Use the realistic `townhouse-town` name that DockerOrchestrator emits in
    // production (CONTAINER_PREFIX `townhouse-` + node type) — the hook strips
    // the prefix and keys `statesByName` by node type.
    expect(MockWebSocket.instances.length).toBe(1);
    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'townhouse-town', state: 'paused' },
        ts: Date.now(),
      });
    });

    expect(
      screen.getByLabelText('town node status: degraded')
    ).toBeInTheDocument();
  });

  it('ignores non-node container names (connector, pull:*) in WS messages', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes(fixtureNodes);
      if (url === '/api/nodes/town') return jsonRes(makeDetail('town'));
      if (url === '/api/nodes/mill') return jsonRes(makeDetail('mill'));
      throw new Error('unexpected ' + url);
    });
    renderHome();

    await waitFor(() =>
      expect(screen.getByLabelText(/^town node$/i)).toBeInTheDocument()
    );

    // Initial `running` from REST → ok dot.
    expect(
      screen.getByLabelText('town node status: ok')
    ).toBeInTheDocument();

    // Bombard the stream with non-node names — none should affect the town card.
    await act(async () => {
      MockWebSocket.instances[0]!.acceptOpen();
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'connector', state: 'restarted' },
        ts: Date.now(),
      });
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'townhouse-connector', state: 'running' },
        ts: Date.now(),
      });
      MockWebSocket.instances[0]!.pushMessage({
        type: 'nodeState',
        payload: { name: 'pull:toon-protocol/town:latest', state: 'pulling' },
        ts: Date.now(),
      });
    });

    // Town dot still reflects the REST-returned `running` state.
    expect(
      screen.getByLabelText('town node status: ok')
    ).toBeInTheDocument();
  });

  it('shows "—" with aria-label="metric unavailable" when metrics are unavailable (AC-4)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes([fixtureNodes[0]!]);
      if (url === '/api/nodes/town') {
        return jsonRes({
          ...makeDetail('town'),
          metrics: {
            packetsForwarded: 0,
            packetsRejected: 0,
            bytesSent: 0,
            attribution: 'aggregate',
            available: false,
          },
        });
      }
      throw new Error('unexpected ' + url);
    });
    renderHome();
    await waitFor(() =>
      expect(screen.getByLabelText('metric unavailable')).toBeInTheDocument()
    );
  });

  it('shows "(all nodes)" footnote when metrics use aggregate attribution', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes([fixtureNodes[0]!]);
      if (url === '/api/nodes/town') return jsonRes(makeDetail('town', 99));
      throw new Error('unexpected ' + url);
    });
    renderHome();
    await waitFor(() =>
      expect(screen.getByText(/\(all nodes\)/i)).toBeInTheDocument()
    );
  });

  it('renders transport indicator in header via useTransportStatus hook (AC-5)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes([fixtureNodes[0]!]));
    // useTransportStatus is mocked at module level to return direct/reachable
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    // The hook mock returns direct mode — expect a dot with role=img and name matching direct transport
    expect(screen.getByRole('img', { name: /direct transport/i })).toBeInTheDocument();
  });

  it('renders ATOR dot when transport hook reports ATOR reachable', async () => {
    // Override the mock status to ATOR/reachable
    Object.assign(mockTransportStatus, {
      status: {
        mode: 'ator' as const,
        socksProxy: 'socks5h://proxy.ator.io:9050',
        reachable: true,
        latencyProxyMs: 120,
        latencyDirectMs: 5,
        lastProbedAt: Date.now(),
        probeError: null,
        ts: Date.now(),
      },
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes([fixtureNodes[0]!]));
    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );
    // ATOR + reachable → dot label contains "connected"
    await waitFor(() =>
      expect(screen.getByRole('img', { name: /ator transport: connected/i })).toBeInTheDocument()
    );
    // Reset
    Object.assign(mockTransportStatus, { status: { mode: 'direct' as const, reachable: true, latencyProxyMs: null, latencyDirectMs: 5, lastProbedAt: Date.now(), probeError: null, ts: Date.now() } });
  });

  it('renders Settings link in header', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes(fixtureNodes);
      if (url === '/api/nodes/town') return jsonRes(makeDetail('town', 12));
      if (url === '/api/nodes/mill') return jsonRes(makeDetail('mill', 5));
      throw new Error('unexpected ' + url);
    });
    renderHome();
    await waitFor(() => screen.getByLabelText(/^town node$/i));
    const settingsLink = screen.getByRole('link', { name: /view settings/i });
    expect(settingsLink).toBeInTheDocument();
    expect(settingsLink.getAttribute('href')).toBe('/settings');
  });

  it('AC-8: passes axe-core WCAG 2.1 AA in ready state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes(fixtureNodes);
      if (url === '/api/nodes/town') return jsonRes(makeDetail('town', 12));
      if (url === '/api/nodes/mill') return jsonRes(makeDetail('mill', 5));
      throw new Error('unexpected ' + url);
    });
    const { container } = renderHome();
    await waitFor(() =>
      expect(screen.getByLabelText(/^town node$/i)).toBeInTheDocument()
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('AC-8: passes axe-core in empty state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes([]));
    const { container } = renderHome();
    await waitFor(() =>
      expect(screen.getByText(/no nodes configured/i)).toBeInTheDocument()
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('AC-8: passes axe-core in error state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({}, 500));
    const { container } = renderHome();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(await axe(container)).toHaveNoViolations();
  });

  it('AC-17: renders Wallet link in header (Story 21.13)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = typeof input === 'string' ? input : (input as URL).toString();
      if (url === '/api/nodes') return jsonRes(fixtureNodes);
      if (url === '/api/nodes/town') return jsonRes(makeDetail('town', 12));
      if (url === '/api/nodes/mill') return jsonRes(makeDetail('mill', 5));
      throw new Error('unexpected ' + url);
    });
    renderHome();
    await waitFor(() => screen.getByLabelText(/^town node$/i));
    const walletLink = screen.getByRole('link', { name: /view wallet and keys/i });
    expect(walletLink).toBeInTheDocument();
    expect(walletLink.getAttribute('href')).toBe('/wallet');
  });
});
