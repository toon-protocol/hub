import { useEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { MemoryRouter } from 'react-router-dom';
import { Home } from './Home';
import type { NodeInfo, NodeDetail } from '@toon-protocol/hub';

// Storybook is the only sanctioned consumer of fixture data.
// `IS_STORYBOOK` is set in .storybook/main.ts → main.tsx guard.
(globalThis as Record<string, unknown>)['__USE_FIXTURES__'] = true;

const fixtureNodes: NodeInfo[] = [
  { type: 'town', enabled: true, state: 'running', uptimeSeconds: 86_400, image: 'toon:town' },
  { type: 'mill', enabled: true, state: 'running', uptimeSeconds: 3_600, image: 'toon:mill' },
  { type: 'dvm', enabled: true, state: 'running', uptimeSeconds: 600, image: 'toon:dvm' },
];

function makeDetail(type: 'town' | 'mill' | 'dvm', packets: number): NodeDetail {
  return {
    type,
    enabled: true,
    state: 'running',
    uptimeSeconds: 3_600,
    image: `toon:${type}`,
    config: { enabled: true, feePerEvent: 1 },
    metrics: {
      packetsForwarded: packets,
      packetsRejected: 0,
      bytesSent: 1024 * packets,
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

interface FixtureScenario {
  list: NodeInfo[];
  details?: Partial<Record<'town' | 'mill' | 'dvm', NodeDetail>>;
  failList?: number;
  /** Override the transport mode for preview (default: direct) */
  transportMode?: 'direct' | 'ator';
  /** Override ATOR reachability for preview (default: true) */
  transportReachable?: boolean;
}

class NoOpWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

/**
 * Storybook-only wrapper that installs the fetch + WebSocket fixtures and
 * RESTORES both globals on unmount. Earlier ref-callback "cleanup" was a
 * no-op in React 18 and leaked the stubs across stories.
 */
function FixtureProvider({
  scenario,
  children,
}: {
  scenario: FixtureScenario;
  children: React.ReactNode;
}) {
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    const originalFetch = globalThis.fetch;
    const originalWebSocket = (globalThis as Record<string, unknown>)['WebSocket'];

    const mode = scenario.transportMode ?? 'direct';
    const reachable = scenario.transportReachable ?? true;
    const transportPayload = {
      mode,
      ...(mode === 'ator' ? { socksProxy: 'socks5h://proxy.ator.io:9050' } : {}),
      reachable,
      latencyProxyMs: mode === 'ator' && reachable ? 120 : null,
      latencyDirectMs: 5,
      lastProbedAt: Date.now(),
      probeError: reachable ? null : 'ECONNREFUSED',
      ts: Date.now(),
    };

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/api/transport')) return jsonRes(transportPayload);
      if (url.endsWith('/api/nodes')) {
        if (scenario.failList) return jsonRes({}, scenario.failList);
        return jsonRes(scenario.list);
      }
      const match = /\/api\/nodes\/(town|mill|dvm)$/.exec(url);
      if (match) {
        const type = match[1] as 'town' | 'mill' | 'dvm';
        const detail = scenario.details?.[type];
        if (!detail) return jsonRes({}, 404);
        return jsonRes(detail);
      }
      return jsonRes({}, 404);
    }) as typeof fetch;

    (globalThis as Record<string, unknown>)['WebSocket'] = NoOpWebSocket;
    setInstalled(true);

    return () => {
      globalThis.fetch = originalFetch;
      (globalThis as Record<string, unknown>)['WebSocket'] = originalWebSocket;
    };
  }, [scenario]);

  // Defer first paint until the fixtures are installed so the underlying
  // hooks observe the stubs on their first render.
  if (!installed) return null;
  return <>{children}</>;
}

const meta: Meta<typeof Home> = {
  title: 'Views/Home',
  component: Home,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story, ctx) => {
      const scenario =
        (ctx.parameters['fixture'] as FixtureScenario) ?? { list: [] };
      return (
        <MemoryRouter>
          <FixtureProvider scenario={scenario}>
            <Story />
          </FixtureProvider>
        </MemoryRouter>
      );
    },
  ],
};
export default meta;

type Story = StoryObj<typeof Home>;

export const ThreeNodesRunning: Story = {
  parameters: {
    fixture: {
      list: fixtureNodes,
      details: {
        town: makeDetail('town', 142),
        mill: makeDetail('mill', 34),
        dvm: makeDetail('dvm', 8),
      },
    } satisfies FixtureScenario,
  },
};

export const Empty: Story = {
  parameters: {
    fixture: { list: [] } satisfies FixtureScenario,
  },
};

export const NetworkError: Story = {
  parameters: {
    fixture: { list: [], failList: 500 } satisfies FixtureScenario,
  },
};

export const AtorTransport: Story = {
  parameters: {
    fixture: {
      list: fixtureNodes.slice(0, 2),
      details: {
        town: makeDetail('town', 24),
        mill: makeDetail('mill', 7),
      },
      transportMode: 'ator',
      transportReachable: true,
    } satisfies FixtureScenario,
  },
};

export const AtorUnreachable: Story = {
  parameters: {
    fixture: {
      list: fixtureNodes.slice(0, 2),
      details: {
        town: makeDetail('town', 24),
        mill: makeDetail('mill', 7),
      },
      transportMode: 'ator',
      transportReachable: false,
    } satisfies FixtureScenario,
  },
};

/**
 * Header `Wallet →` link (added by story 21.13). The MemoryRouter wraps the
 * tree so `<Link>` renders an in-page anchor; clicking it would route to
 * `/wallet` if the story tree included that route. This story exists so the
 * wallet entry-point in the Home header is visually documented next to the
 * other transport-mode indicators.
 */
export const HeaderWalletLink: Story = {
  parameters: {
    fixture: {
      list: fixtureNodes,
      details: {
        town: makeDetail('town', 142),
        mill: makeDetail('mill', 34),
        dvm: makeDetail('dvm', 8),
      },
    } satisfies FixtureScenario,
  },
};
