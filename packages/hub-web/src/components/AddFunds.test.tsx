import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AddFunds } from './AddFunds';

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const EVM_ADDRESSES = {
  chains: [{ family: 'evm', address: '0xdeadbeef1234' }],
};

const DVM_EVM_ONLY = {
  chains: [{ family: 'evm', address: '0xdvmaddress' }],
};

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(EVM_ADDRESSES));
});

afterEach(() => vi.restoreAllMocks());

describe('AddFunds', () => {
  it('renders the disclosure summary', () => {
    render(<AddFunds nodeId="dev-mill-01" />);
    expect(screen.getByText('Add Funds')).toBeDefined();
  });

  it('renders EVM address after data loads', async () => {
    render(<AddFunds nodeId="dev-mill-01" />);
    await waitFor(() => expect(screen.getByText('0xdeadbeef1234')).toBeDefined());
  });

  it('type=dvm returns evm-only (no solana/mina)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes(DVM_EVM_ONLY));
    render(<AddFunds nodeId="dev-dvm-01" />);
    await waitFor(() => expect(screen.getByText('0xdvmaddress')).toBeDefined());
    // Assert the hook actually called the deposit-addresses endpoint —
    // without this, a regression that hits the wrong URL would pass.
    const calls = fetchMock.mock.calls.map((c) =>
      typeof c[0] === 'string' ? c[0] : (c[0] as URL).toString()
    );
    expect(calls.some((u) => /\/api\/nodes\/[^/]+\/deposit-addresses/.test(u))).toBe(true);
    expect(screen.queryByText('solana')).toBeNull();
    expect(screen.queryByText('mina')).toBeNull();
  });

  it('shows error when fetch fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fail'));
    render(<AddFunds nodeId="dev-dvm-01" />);
    await waitFor(() =>
      expect(screen.getByText(/Could not load deposit addresses/i)).toBeDefined()
    );
  });
});
