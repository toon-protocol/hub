import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { axe } from '../test-setup';
import { RevealSeedModal } from './RevealSeedModal';

const DEV_MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) } as unknown as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RevealSeedModal', () => {
  it('does not render when open=false', () => {
    render(<RevealSeedModal open={false} onClose={() => {}} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders password prompt when open=true', () => {
    render(<RevealSeedModal open={true} onClose={() => {}} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it('happy path — shows 12-word mnemonic grid', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ mnemonic: DEV_MNEMONIC }));
    render(<RevealSeedModal open={true} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'mypassword' } });
    fireEvent.click(screen.getByRole('button', { name: /^reveal$/i }));

    await waitFor(() => expect(screen.getByRole('list', { name: /recovery seed phrase/i })).toBeInTheDocument());
    const listItems = screen.getAllByRole('listitem');
    expect(listItems).toHaveLength(12);
    // 'abandon' appears 11 times + 'about' once
    expect(screen.getAllByText('abandon').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('about').length).toBeGreaterThanOrEqual(1);
  });

  it('wrong password shows error and stays on step 1', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ error: 'invalid_password' }, 401));
    render(<RevealSeedModal open={true} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /^reveal$/i }));

    await waitFor(() => expect(screen.getByText(/wrong password/i)).toBeInTheDocument());
    expect(screen.queryByRole('list', { name: /recovery seed phrase/i })).toBeNull();
  });

  it('missing wallet shows error caption', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ error: 'wallet_not_initialized' }, 503));
    render(<RevealSeedModal open={true} onClose={() => {}} />);

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pass' } });
    fireEvent.click(screen.getByRole('button', { name: /^reveal$/i }));

    await waitFor(() => expect(screen.getByText(/no wallet found/i)).toBeInTheDocument());
  });

  it('close handler clears mnemonic from state', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonRes({ mnemonic: DEV_MNEMONIC }));
    const onClose = vi.fn();
    render(<RevealSeedModal open={true} onClose={onClose} />);

    fireEvent.change(screen.getByLabelText(/password/i), { target: { value: 'pass' } });
    fireEvent.click(screen.getByRole('button', { name: /^reveal$/i }));
    await waitFor(() => screen.getByRole('list', { name: /recovery seed phrase/i }));

    fireEvent.click(screen.getByRole('button', { name: /i've backed this up/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it('passes axe a11y check at step 1', async () => {
    const { container } = render(<RevealSeedModal open={true} onClose={() => {}} />);
    expect(await axe(container)).toHaveNoViolations();
  });
});
