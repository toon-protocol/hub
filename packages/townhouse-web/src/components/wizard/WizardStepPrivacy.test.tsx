import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WizardStepPrivacy } from './WizardStepPrivacy';
import type { TransportStatusPayload } from '@toon-protocol/hub';

const ATOR_STATUS: TransportStatusPayload = {
  mode: 'ator',
  socksProxy: 'socks5h://proxy.ator.io:9050',
  reachable: true,
  latencyProxyMs: 90,
  latencyDirectMs: 5,
  lastProbedAt: Date.now(),
  probeError: null,
  ts: Date.now(),
};

// Mock useTransportStatus
vi.mock('@/hooks/useTransportStatus', () => ({
  useTransportStatus: () => ({
    status: ATOR_STATUS,
    statusKind: 'ready' as const,
    refetch: vi.fn(),
  }),
}));

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(ATOR_STATUS));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WizardStepPrivacy', () => {
  it('renders transport radio options', () => {
    render(
      <WizardStepPrivacy
        transport="direct"
        onChange={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.getByRole('radio', { name: /direct/i })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /ator/i })).toBeInTheDocument();
  });

  it('shows live ATOR preview panel when ATOR is selected', () => {
    render(
      <WizardStepPrivacy
        transport="ator"
        onChange={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
      />
    );
    // The TransportStatusPanel should be visible (ATOR + reachable → "Reachable")
    expect(screen.getByText(/ATOR · Reachable/i)).toBeInTheDocument();
  });

  it('does not show live panel when Direct is selected', () => {
    render(
      <WizardStepPrivacy
        transport="direct"
        onChange={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
      />
    );
    // No ATOR panel when Direct is selected
    expect(screen.queryByText(/ATOR · Reachable/i)).toBeNull();
  });

  it('calls onChange when radio is changed', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <WizardStepPrivacy
        transport="direct"
        onChange={onChange}
        onContinue={vi.fn()}
        onBack={vi.fn()}
      />
    );
    await user.click(screen.getByRole('radio', { name: /ator/i }));
    expect(onChange).toHaveBeenCalledWith('ator');
  });

  it('does NOT contain the "Coming soon" caption (removed in 21.15)', () => {
    render(
      <WizardStepPrivacy
        transport="direct"
        onChange={vi.fn()}
        onContinue={vi.fn()}
        onBack={vi.fn()}
      />
    );
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(screen.queryByText(/story 21\.15/i)).toBeNull();
  });
});
