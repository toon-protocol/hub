import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  StatusPills,
  resolveNodePill,
  resolveTransportPill,
  PILL_ORDER,
} from './status-pills';
import type { TransportStatusPayload } from '@toon-protocol/townhouse';

const TRANSPORT_DIRECT_OK: {
  status: TransportStatusPayload;
  statusKind: 'ready';
} = {
  status: {
    mode: 'direct',
    reachable: true,
    latencyProxyMs: null,
    latencyDirectMs: 5,
    lastProbedAt: Date.now(),
    probeError: null,
    ts: Date.now(),
  },
  statusKind: 'ready',
};

describe('StatusPills', () => {
  it('renders one pill for each of the four services', () => {
    render(
      <StatusPills
        town={{ enabled: true, state: 'running' }}
        mill={{ enabled: true, state: 'running' }}
        dvm={{ enabled: true, state: 'running' }}
        transport={TRANSPORT_DIRECT_OK}
      />
    );

    const region = screen.getByRole('region', { name: /service status/i });
    expect(region).toBeInTheDocument();
    // All four service rows present, in the locked order.
    const items = region.querySelectorAll('li[data-service]');
    expect(items.length).toBe(4);
    expect(items[0]?.getAttribute('data-service')).toBe('town');
    expect(items[1]?.getAttribute('data-service')).toBe('mill');
    expect(items[2]?.getAttribute('data-service')).toBe('dvm');
    expect(items[3]?.getAttribute('data-service')).toBe('ator');
    expect(PILL_ORDER).toEqual(['town', 'mill', 'dvm', 'ator']);
  });

  it('green dot when running (color reflects status)', () => {
    render(
      <StatusPills
        town={{ enabled: true, state: 'running' }}
        mill={{ enabled: true, state: 'running' }}
        dvm={{ enabled: true, state: 'running' }}
        transport={TRANSPORT_DIRECT_OK}
      />
    );
    expect(screen.getByLabelText(/town status: ok/i)).toBeInTheDocument();
    // The pill itself records data-state for snapshot stability.
    const townPill = screen
      .getByRole('region', { name: /service status/i })
      .querySelector('li[data-service="town"]');
    expect(townPill?.getAttribute('data-state')).toBe('ok');
  });

  it('renders down state when a node is exited', () => {
    render(
      <StatusPills
        town={{ enabled: true, state: 'exited' }}
        mill={{ enabled: true, state: 'running' }}
        dvm={{ enabled: true, state: 'running' }}
        transport={TRANSPORT_DIRECT_OK}
      />
    );
    expect(screen.getByLabelText(/town status: down/i)).toBeInTheDocument();
  });

  it('renders disabled node as off (unknown dot)', () => {
    render(
      <StatusPills
        town={{ enabled: true, state: 'running' }}
        mill={{ enabled: true, state: 'running' }}
        dvm={{ enabled: false, state: undefined }}
        transport={TRANSPORT_DIRECT_OK}
      />
    );
    expect(screen.getByLabelText(/dvm disabled/i)).toBeInTheDocument();
  });

  it('renders ator pill as unknown while transport is loading (error path)', () => {
    render(
      <StatusPills
        town={{ enabled: true, state: 'running' }}
        mill={{ enabled: true, state: 'running' }}
        dvm={{ enabled: true, state: 'running' }}
        transport={{ status: null, statusKind: 'loading' }}
      />
    );
    expect(screen.getByLabelText(/ator status: probing/i)).toBeInTheDocument();
  });

  it('renders ator pill as unknown when transport status is error', () => {
    render(
      <StatusPills
        town={{ enabled: true, state: 'running' }}
        mill={{ enabled: true, state: 'running' }}
        dvm={{ enabled: true, state: 'running' }}
        transport={{ status: null, statusKind: 'error' }}
      />
    );
    expect(screen.getByLabelText(/ator status: unknown/i)).toBeInTheDocument();
  });

  it('shows ator on when ATOR mode is reachable', () => {
    render(
      <StatusPills
        town={{ enabled: true, state: 'running' }}
        mill={{ enabled: true, state: 'running' }}
        dvm={{ enabled: true, state: 'running' }}
        transport={{
          status: {
            mode: 'ator',
            socksProxy: 'socks5h://127.0.0.1:28050',
            reachable: true,
            latencyProxyMs: 90,
            latencyDirectMs: 5,
            lastProbedAt: Date.now(),
            probeError: null,
            ts: Date.now(),
          },
          statusKind: 'ready',
        }}
      />
    );
    expect(
      screen.getByLabelText(/ator status: reachable via proxy/i)
    ).toBeInTheDocument();
  });

  it('shows ator down when ATOR is configured but unreachable', () => {
    render(
      <StatusPills
        town={{ enabled: true, state: 'running' }}
        mill={{ enabled: true, state: 'running' }}
        dvm={{ enabled: true, state: 'running' }}
        transport={{
          status: {
            mode: 'ator',
            socksProxy: 'socks5h://127.0.0.1:28050',
            reachable: false,
            latencyProxyMs: null,
            latencyDirectMs: 5,
            lastProbedAt: Date.now(),
            probeError: 'ECONNREFUSED',
            ts: Date.now(),
          },
          statusKind: 'ready',
        }}
      />
    );
    expect(screen.getByLabelText(/ator status: unreachable/i)).toBeInTheDocument();
  });
});

describe('resolveNodePill', () => {
  it('maps running → ok', () => {
    const r = resolveNodePill('town', { enabled: true, state: 'running' });
    expect(r.dotState).toBe('ok');
    expect(r.caption).toBe('ok');
  });

  it('maps paused → degraded with raw state caption', () => {
    const r = resolveNodePill('mill', { enabled: true, state: 'paused' });
    expect(r.dotState).toBe('degraded');
    expect(r.caption).toBe('paused');
  });

  it('returns off when disabled', () => {
    const r = resolveNodePill('dvm', { enabled: false, state: undefined });
    expect(r.dotState).toBe('unknown');
    expect(r.caption).toBe('off');
  });
});

describe('resolveTransportPill', () => {
  it('returns ok+direct for direct mode', () => {
    const r = resolveTransportPill(
      TRANSPORT_DIRECT_OK.status,
      TRANSPORT_DIRECT_OK.statusKind
    );
    expect(r.dotState).toBe('ok');
    expect(r.caption).toBe('direct');
  });

  it('returns unknown when status is null', () => {
    const r = resolveTransportPill(null, 'ready');
    expect(r.dotState).toBe('unknown');
  });
});
