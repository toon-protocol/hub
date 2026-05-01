import { useMemo } from 'react';
import type { WizardInitRequest } from '@toon-protocol/townhouse';

export interface WizardError {
  code: string;
  message?: string;
  httpStatus?: number;
}

export interface UseWizardSubmitResult {
  submit: (req: WizardInitRequest) => Promise<{ status: 'launching' } | WizardError>;
  previewMnemonic: () => Promise<string>;
}

interface UseWizardSubmitOptions {
  initUrl?: string;
  previewUrl?: string;
}

/**
 * React hook providing single-shot POST helpers for wizard init and mnemonic
 * preview. The returned object reference is stable across re-renders so it
 * can be safely listed in useEffect dependency arrays.
 *
 * SECURITY: previewMnemonic result is never cached — caller must store it if needed.
 */
export function useWizardSubmit(options: UseWizardSubmitOptions = {}): UseWizardSubmitResult {
  const { initUrl = '/api/wizard/init', previewUrl = '/api/wizard/mnemonic-preview' } = options;

  return useMemo<UseWizardSubmitResult>(() => {
    async function submit(req: WizardInitRequest): Promise<{ status: 'launching' } | WizardError> {
      let res: Response;
      try {
        res = await fetch(initUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        });
      } catch {
        return { code: 'network_error', message: 'Network error — is the API running?' };
      }

      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        return { code: 'parse_error', message: `Unexpected response (${res.status})`, httpStatus: res.status };
      }

      if (!res.ok) {
        const err = parsed as { code?: string; message?: string };
        return { code: err.code ?? 'unknown_error', message: err.message, httpStatus: res.status };
      }

      return parsed as { status: 'launching' };
    }

    async function previewMnemonic(): Promise<string> {
      const res = await fetch(previewUrl, { method: 'POST' });
      if (!res.ok) {
        throw new Error(`Failed to preview mnemonic: ${res.status}`);
      }
      const { mnemonic } = (await res.json()) as { mnemonic: string };
      return mnemonic;
    }

    return { submit, previewMnemonic };
  }, [initUrl, previewUrl]);
}
