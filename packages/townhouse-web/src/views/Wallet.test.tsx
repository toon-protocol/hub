import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { axe } from '../test-setup';
import { WalletView } from './Wallet';

// Mock qrcode.react
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value, 'aria-label': ariaLabel }: { value: string; 'aria-label'?: string }) => (
    <svg data-testid="qr-code" aria-label={ariaLabel}><title>{value}</title></svg>
  ),
}));

const KEYS_PAYLOAD = {
  keys: [
    { nodeType: 'town', nostrPubkey: 'a'.repeat(64), evmAddress: '0x1111111111111111111111111111111111111111', nostrDerivationPath: "m/44'/1237'/0'/0/0", evmDerivationPath: "m/44'/60'/0'/0/0" },
    { nodeType: 'mill', nostrPubkey: 'b'.repeat(64), evmAddress: '0x2222222222222222222222222222222222222222', nostrDerivationPath: "m/44'/1237'/1'/0/0", evmDerivationPath: "m/44'/60'/1'/0/0", solanaAddress: 'SolanaAddr1234', minaAddress: 'B62abcdef' },
    { nodeType: 'dvm',  nostrPubkey: 'c'.repeat(64), evmAddress: '0x3333333333333333333333333333333333333333', nostrDerivationPath: "m/44'/1237'/2'/0/0", evmDerivationPath: "m/44'/60'/2'/0/0" },
  ],
};

const BALANCES_PAYLOAD = {
  entries: [
    { nodeType: 'town', family: 'evm', token: 'ETH', address: '0x1111111111111111111111111111111111111111', balance: '1000000000000000000', scale: 18, available: true },
    { nodeType: 'town', family: 'evm', token: 'USDC', address: '0x1111111111111111111111111111111111111111', balance: '1000000', scale: 6, available: true },
    { nodeType: 'mill', family: 'evm', token: 'ETH', address: '0x2222222222222222222222222222222222222222', balance: '500000000000000000', scale: 18, available: true },
    { nodeType: 'mill', family: 'evm', token: 'USDC', address: '0x2222222222222222222222222222222222222222', balance: '500000', scale: 6, available: true },
    { nodeType: 'mill', family: 'solana', token: 'SOL', address: 'SolanaAddr1234', balance: '10000000000', scale: 9, available: true },
    { nodeType: 'mill', family: 'mina', token: 'MINA', address: 'B62abcdef', balance: '1000000000000', scale: 9, available: true },
    { nodeType: 'dvm',  family: 'evm', token: 'ETH', address: '0x3333333333333333333333333333333333333333', balance: '200000000000000000', scale: 18, available: true },
    { nodeType: 'dvm',  family: 'evm', token: 'USDC', address: '0x3333333333333333333333333333333333333333', balance: '200000', scale: 6, available: true },
  ],
  ts: Date.now(),
};

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.removeItem('townhouse.wallet.backupAcked');
});

function renderWalletView() {
  return render(
    <MemoryRouter>
      <WalletView />
    </MemoryRouter>
  );
}

describe('WalletView', () => {
  it('renders three balance cards once keys and balances load', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = url.toString();
      if (u.includes('/api/wallet') && !u.includes('/balances')) return Promise.resolve(jsonRes(KEYS_PAYLOAD));
      if (u.includes('/balances')) return Promise.resolve(jsonRes(BALANCES_PAYLOAD));
      return Promise.resolve(jsonRes(BALANCES_PAYLOAD));
    });

    renderWalletView();
    // Each card has a TypeChip showing the node type label
    await waitFor(() => {
      expect(screen.getAllByText('Town').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Mill').length).toBeGreaterThan(0);
      expect(screen.getAllByText('DVM').length).toBeGreaterThan(0);
    });
  });

  it('backup banner is visible by default', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = url.toString();
      if (u.includes('/api/wallet') && !u.includes('/balances')) return Promise.resolve(jsonRes(KEYS_PAYLOAD));
      return Promise.resolve(jsonRes(BALANCES_PAYLOAD));
    });
    renderWalletView();
    await waitFor(() => screen.getByText(/backed up your seed phrase/i));
    expect(screen.getByText(/backed up your seed phrase/i)).toBeInTheDocument();
  });

  it('Withdraw button opens withdraw modal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = url.toString();
      if (u.includes('/api/wallet') && !u.includes('/balances')) return Promise.resolve(jsonRes(KEYS_PAYLOAD));
      return Promise.resolve(jsonRes(BALANCES_PAYLOAD));
    });
    renderWalletView();
    await waitFor(() => screen.getAllByRole('button', { name: /withdraw/i }));
    const withdrawBtns = screen.getAllByRole('button', { name: /withdraw/i });
    fireEvent.click(withdrawBtns[0]!);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });

  it('Reveal button opens reveal seed modal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = url.toString();
      if (u.includes('/api/wallet') && !u.includes('/balances')) return Promise.resolve(jsonRes(KEYS_PAYLOAD));
      return Promise.resolve(jsonRes(BALANCES_PAYLOAD));
    });
    renderWalletView();
    await waitFor(() => screen.getByText(/backed up your seed phrase/i));
    fireEvent.click(screen.getByRole('button', { name: /reveal seed phrase/i }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });

  it('passes axe a11y check in ready state', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const u = url.toString();
      if (u.includes('/api/wallet') && !u.includes('/balances')) return Promise.resolve(jsonRes(KEYS_PAYLOAD));
      return Promise.resolve(jsonRes(BALANCES_PAYLOAD));
    });
    const { container } = renderWalletView();
    await waitFor(() => screen.getAllByText('Town').length > 0);
    expect(await axe(container)).toHaveNoViolations();
  });
});
