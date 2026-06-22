import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { axe } from '../test-setup';
import { WithdrawModal } from './WithdrawModal';
import type { WalletBalanceEntry } from '@toon-protocol/hub';

const MOCK_BALANCES: WalletBalanceEntry[] = [
  { nodeType: 'town', family: 'evm', token: 'ETH', address: '0x1111', balance: '1000000000000000000000', scale: 18, available: true },
  { nodeType: 'town', family: 'evm', token: 'USDC', address: '0x1111', balance: '1000000000', scale: 6, available: true },
];

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

const VALID_RECIPIENT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WithdrawModal', () => {
  it('does not render when open=false', () => {
    render(<WithdrawModal nodeType="town" balances={MOCK_BALANCES} open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders step 1 when open=true', () => {
    render(<WithdrawModal nodeType="town" balances={MOCK_BALANCES} open={true} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Select chain')).toBeInTheDocument();
  });

  it('Solana radio is disabled with explanatory caption', () => {
    render(<WithdrawModal nodeType="mill" balances={MOCK_BALANCES} open={true} onClose={() => {}} />);
    const solanaRadio = screen.getByDisplayValue('solana') as HTMLInputElement;
    expect(solanaRadio.disabled).toBe(true);
    expect(screen.getByText(/Solana withdrawal coming soon/i)).toBeInTheDocument();
  });

  it('Escape key closes the modal', () => {
    const onClose = vi.fn();
    render(<WithdrawModal nodeType="town" balances={MOCK_BALANCES} open={true} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('validates invalid recipient address', async () => {
    render(<WithdrawModal nodeType="town" balances={MOCK_BALANCES} open={true} onClose={() => {}} />);
    // Go to step 2 then step 3
    fireEvent.click(screen.getByText('Next →'));
    await waitFor(() => expect(screen.getByText('Select token')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Next →'));
    await waitFor(() => expect(screen.getByLabelText(/recipient address/i)).toBeInTheDocument());
    const recipientInput = screen.getByLabelText(/recipient address/i);
    fireEvent.change(recipientInput, { target: { value: 'not-valid' } });
    expect(screen.getByText(/invalid address/i)).toBeInTheDocument();
  });

  it('happy path — completes withdrawal', async () => {
    const mockTxHash = '0x' + 'ab'.repeat(32);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonRes({ estimatedGas: '21000', estimatedFee: '21000000000000' }))
      .mockResolvedValueOnce(jsonRes({ txHash: mockTxHash, chainId: 31337 }))
      .mockResolvedValue(jsonRes({ status: 'success', blockNumber: 42, txHash: mockTxHash }));

    render(<WithdrawModal nodeType="town" balances={MOCK_BALANCES} open={true} onClose={() => {}} />);

    // Step 1: chain
    fireEvent.click(screen.getByText('Next →'));
    // Step 2: token
    await waitFor(() => screen.getByText('Select token'));
    fireEvent.click(screen.getByText('Next →'));
    // Step 3: recipient
    await waitFor(() => screen.getByLabelText(/recipient address/i));
    fireEvent.change(screen.getByLabelText(/recipient address/i), { target: { value: VALID_RECIPIENT } });
    fireEvent.click(screen.getByText('Next →'));
    // Step 4: amount
    await waitFor(() => screen.getByLabelText(/amount/i));
    fireEvent.change(screen.getByLabelText(/amount/i), { target: { value: '100000000000000000' } });
    fireEvent.click(screen.getByText(/Review/i));
    // Step 5: review
    await waitFor(() => screen.getByText('Review transaction'));
    fireEvent.click(screen.getByText('Send'));
    // Step 6: result — assert *confirmed* specifically. The previous regex
    // matched "Waiting" which is rendered immediately on entering step 6, so
    // the assertion passed regardless of whether the receipt poll completed.
    await waitFor(() => expect(screen.getByText(/Transaction confirmed/i)).toBeInTheDocument(), { timeout: 3000 });
  });

  it('passes axe a11y check at step 1', async () => {
    const { container } = render(
      <WithdrawModal nodeType="town" balances={MOCK_BALANCES} open={true} onClose={() => {}} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
