import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TransportStatusPanel } from './TransportStatusPanel';
import type { TransportStatusPayload } from '@toon-protocol/hub';

const DIRECT_STATUS: TransportStatusPayload = {
  mode: 'direct',
  reachable: true,
  latencyProxyMs: null,
  latencyDirectMs: 5,
  lastProbedAt: Date.now() - 10_000,
  probeError: null,
  ts: Date.now(),
};

const ATOR_OK_STATUS: TransportStatusPayload = {
  mode: 'ator',
  socksProxy: 'socks5h://proxy.ator.io:9050',
  reachable: true,
  latencyProxyMs: 120,
  latencyDirectMs: 5,
  lastProbedAt: Date.now() - 5_000,
  probeError: null,
  ts: Date.now(),
};

const ATOR_DOWN_STATUS: TransportStatusPayload = {
  mode: 'ator',
  socksProxy: 'socks5h://proxy.ator.io:9050',
  reachable: false,
  latencyProxyMs: null,
  latencyDirectMs: 5,
  lastProbedAt: Date.now() - 30_000,
  probeError: 'ECONNREFUSED',
  ts: Date.now(),
};

describe('TransportStatusPanel', () => {
  it('renders loading state', () => {
    render(<TransportStatusPanel status={null} statusKind="loading" />);
    expect(screen.getByText(/probing transport/i)).toBeInTheDocument();
  });

  it('renders error state', () => {
    render(<TransportStatusPanel status={null} statusKind="error" />);
    expect(screen.getByText(/transport status unavailable/i)).toBeInTheDocument();
  });

  it('renders direct mode correctly', () => {
    render(<TransportStatusPanel status={DIRECT_STATUS} statusKind="ready" />);
    expect(screen.getByText(/Direct · Reachable/i)).toBeInTheDocument();
    // Mode line shows "Direct"
    expect(screen.getAllByText(/^Direct$/i).length).toBeGreaterThanOrEqual(1);
    // No proxy line in direct mode
    expect(screen.queryByText(/Proxy/i)).toBeNull();
  });

  it('renders ATOR reachable correctly', () => {
    render(<TransportStatusPanel status={ATOR_OK_STATUS} statusKind="ready" />);
    expect(screen.getByText(/ATOR · Reachable/i)).toBeInTheDocument();
    expect(screen.getByText(/proxy\.ator\.io/)).toBeInTheDocument();
    expect(screen.getByText(/~120 ms/)).toBeInTheDocument();
    // No recovery button when reachable
    expect(screen.queryByRole('button', { name: /switch to direct/i })).toBeNull();
  });

  it('renders ATOR unreachable with recovery button', () => {
    const onSwitch = vi.fn();
    render(
      <TransportStatusPanel
        status={ATOR_DOWN_STATUS}
        statusKind="ready"
        onSwitchToDirect={onSwitch}
      />
    );
    expect(screen.getByText(/ATOR · Unreachable/i)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /switch to direct/i });
    expect(btn).toBeInTheDocument();
  });

  it('calls onSwitchToDirect when recovery button clicked', async () => {
    const onSwitch = vi.fn();
    const user = userEvent.setup();
    render(
      <TransportStatusPanel
        status={ATOR_DOWN_STATUS}
        statusKind="ready"
        onSwitchToDirect={onSwitch}
      />
    );
    await user.click(screen.getByRole('button', { name: /switch to direct/i }));
    expect(onSwitch).toHaveBeenCalledOnce();
  });

  it('compact mode: no proxy line, no recovery button', () => {
    render(
      <TransportStatusPanel
        status={ATOR_DOWN_STATUS}
        statusKind="ready"
        onSwitchToDirect={vi.fn()}
        compact
      />
    );
    // No proxy line in compact mode
    expect(screen.queryByText(/Proxy/i)).toBeNull();
    // No recovery button in compact mode
    expect(screen.queryByRole('button', { name: /switch to direct/i })).toBeNull();
  });

  it('shows relative probe time', () => {
    render(<TransportStatusPanel status={DIRECT_STATUS} statusKind="ready" />);
    // "Probed N s ago" or "Probed just now"
    expect(screen.getByText(/probed/i)).toBeInTheDocument();
  });
});
