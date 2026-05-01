import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWizardSubmit } from './useWizardSubmit';
import type { WizardInitRequest } from '@toon-protocol/townhouse';

const VALID_REQ: WizardInitRequest = {
  password: 'test-pw',
  password_confirm: 'test-pw',
  mnemonic_mode: 'generate',
  mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  backup_ack: true,
  nodes: {
    town: { enabled: true, feePerEvent: 100 },
    mill: { enabled: false },
    dvm: { enabled: false },
  },
  transport: { mode: 'direct' },
};

function renderUseSubmit(opts: { initUrl?: string; previewUrl?: string } = {}) {
  return renderHook(() => useWizardSubmit(opts));
}

describe('useWizardSubmit', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('submit returns { status: launching } on 202', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 202,
      json: async () => ({ status: 'launching' }),
    }));

    const { result } = renderUseSubmit({ initUrl: '/test/wizard/init' });
    const out = await result.current.submit(VALID_REQ);
    expect(out).toEqual({ status: 'launching' });
  });

  it('submit maps 400 password_mismatch to WizardError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'password_mismatch', message: 'Passwords do not match.' }),
    }));

    const { result } = renderUseSubmit({ initUrl: '/test/wizard/init' });
    const out = await result.current.submit(VALID_REQ);
    expect('code' in out).toBe(true);
    if ('code' in out) expect(out.code).toBe('password_mismatch');
  });

  it('submit maps 400 backup_not_acknowledged to WizardError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ code: 'backup_not_acknowledged', message: 'You must confirm...' }),
    }));

    const { result } = renderUseSubmit({ initUrl: '/test/wizard/init' });
    const out = await result.current.submit(VALID_REQ);
    if ('code' in out) expect(out.code).toBe('backup_not_acknowledged');
  });

  it('submit maps 409 wallet_already_exists to WizardError', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ code: 'wallet_already_exists' }),
    }));

    const { result } = renderUseSubmit({ initUrl: '/test/wizard/init' });
    const out = await result.current.submit(VALID_REQ);
    if ('code' in out) expect(out.code).toBe('wallet_already_exists');
  });

  it('submit returns network_error on fetch throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

    const { result } = renderUseSubmit({ initUrl: '/test/wizard/init' });
    const out = await result.current.submit(VALID_REQ);
    if ('code' in out) expect(out.code).toBe('network_error');
  });

  it('previewMnemonic returns a mnemonic string', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ mnemonic: 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about' }),
    }));

    const { result } = renderUseSubmit({ previewUrl: '/test/wizard/mnemonic-preview' });
    const mnemonic = await result.current.previewMnemonic();
    expect(mnemonic.split(' ')).toHaveLength(12);
  });

  it('returns a stable object reference across re-renders (so it is safe in dep arrays)', () => {
    const { result, rerender } = renderUseSubmit({ initUrl: '/x', previewUrl: '/y' });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
