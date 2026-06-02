import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { SettingsView } from './Settings';
import type { TransportStatusPayload } from '@toon-protocol/townhouse';

const DIRECT_STATUS: TransportStatusPayload = {
  mode: 'direct',
  reachable: true,
  latencyProxyMs: null,
  latencyDirectMs: 5,
  lastProbedAt: Date.now(),
  probeError: null,
  ts: Date.now(),
};

const ATOR_DOWN_STATUS: TransportStatusPayload = {
  mode: 'ator',
  socksProxy: 'socks5h://proxy.ator.io:9050',
  reachable: false,
  latencyProxyMs: null,
  latencyDirectMs: 5,
  lastProbedAt: Date.now(),
  probeError: 'ECONNREFUSED',
  ts: Date.now(),
};

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function renderSettings() {
  return render(
    <MemoryRouter>
      <SettingsView />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(DIRECT_STATUS));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SettingsView', () => {
  it('renders the Transport section', async () => {
    renderSettings();
    await waitFor(() =>
      expect(screen.getByText('Transport')).toBeInTheDocument()
    );
    expect(
      screen.getByRole('radiogroup', { name: /transport mode/i })
    ).toBeInTheDocument();
  });

  it('radio reflects current mode from hook', async () => {
    renderSettings();
    await waitFor(() => {
      const directRadio = screen.getByRole('radio', { name: /direct/i });
      expect(directRadio).toBeChecked();
    });
  });

  it('Save button disabled when selection equals current mode', async () => {
    renderSettings();
    await waitFor(() => {
      const saveBtn = screen.getByRole('button', { name: /save/i });
      expect(saveBtn).toBeDisabled();
    });
  });

  it('Save button enabled after selecting a different mode', async () => {
    const user = userEvent.setup();
    renderSettings();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /direct/i })).toBeChecked()
    );

    await user.click(screen.getByRole('radio', { name: /ator/i }));
    const saveBtn = screen.getByRole('button', { name: /save/i });
    expect(saveBtn).not.toBeDisabled();
  });

  it('clicking Save calls PATCH /api/transport', async () => {
    const patchResponse = {
      mode: 'ator',
      restartTriggered: true,
      restartedAt: Date.now(),
    };
    // URL/method-aware: the Settings view now also fetches /api/chains on mount,
    // so call-order mocks would desync. Dispatch on URL + method instead.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/api/chains'))
        return Promise.resolve(jsonRes({ chainProviders: [] }));
      if (url.includes('/api/transport') && init?.method === 'PATCH')
        return Promise.resolve(jsonRes(patchResponse));
      return Promise.resolve(jsonRes(DIRECT_STATUS));
    });

    const user = userEvent.setup();
    renderSettings();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /direct/i })).toBeChecked()
    );

    await user.click(screen.getByRole('radio', { name: /ator/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      // Verify PATCH was called
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const patchCall = calls.find(
        ([url, opts]) => url === '/api/transport' && opts?.method === 'PATCH'
      );
      expect(patchCall).toBeDefined();
    });
  });

  it('shows success message after successful flip', async () => {
    const patchResponse = {
      mode: 'ator',
      restartTriggered: true,
      restartedAt: Date.now(),
    };
    // URL/method-aware: the Settings view now also fetches /api/chains on mount,
    // so call-order mocks would desync. Dispatch on URL + method instead.
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/api/chains'))
        return Promise.resolve(jsonRes({ chainProviders: [] }));
      if (url.includes('/api/transport') && init?.method === 'PATCH')
        return Promise.resolve(jsonRes(patchResponse));
      return Promise.resolve(jsonRes(DIRECT_STATUS));
    });

    const user = userEvent.setup();
    renderSettings();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /direct/i })).toBeChecked()
    );

    await user.click(screen.getByRole('radio', { name: /ator/i }));
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  });

  it('shows error message when PATCH fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = String(input);
      if (url.includes('/api/chains'))
        return Promise.resolve(jsonRes({ chainProviders: [] }));
      if (url.includes('/api/transport') && init?.method === 'PATCH')
        return Promise.resolve(
          jsonRes(
            { error: 'connector_restart_failed', message: 'docker error' },
            500
          )
        );
      return Promise.resolve(jsonRes(DIRECT_STATUS));
    });

    const user = userEvent.setup();
    renderSettings();
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /direct/i })).toBeChecked()
    );

    await user.click(screen.getByRole('radio', { name: /ator/i }));

    await act(async () => {
      await user.click(screen.getByRole('button', { name: /save/i }));
    });

    await waitFor(() => {
      const alert = screen.getByRole('alert');
      expect(alert).toBeInTheDocument();
    });
  });

  it('shows recovery button when ATOR is unreachable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(ATOR_DOWN_STATUS));
    renderSettings();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /switch to direct/i })
      ).toBeInTheDocument()
    );
  });

  it('renders Back to Home link', async () => {
    renderSettings();
    await waitFor(() => {
      const link = screen.getByRole('link', { name: /back to home/i });
      expect(link).toBeInTheDocument();
      expect(link.getAttribute('href')).toBe('/');
    });
  });
});
