import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Shell } from '@/components/primitives/Shell';
import { Button } from '@/components/primitives/Button';
import { TransportStatusPanel } from '@/components/TransportStatusPanel';
import { useTransportStatus } from '@/hooks/useTransportStatus';
import { useTransportPatch } from '@/hooks/useTransportPatch';
import type { TransportPatchRequest } from '@toon-protocol/townhouse';

export function SettingsView() {
  const { status, statusKind, refetch } = useTransportStatus();
  const { patch, pending, error: patchError } = useTransportPatch();

  // Local state holds the operator's selection until Save is clicked
  const [localMode, setLocalMode] = useState<'direct' | 'ator' | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Derive the current mode from live status or fall back to local selection
  const currentMode = status?.mode ?? 'direct';
  const selectedMode = localMode ?? currentMode;

  const noOp = selectedMode === currentMode;

  async function handleSave() {
    if (noOp || pending) return;
    setSuccessMessage(null);

    const req: TransportPatchRequest = { mode: selectedMode };
    try {
      const res = await patch(req, refetch);
      setLocalMode(null);
      if (res.restartTriggered && res.restartedAt) {
        const time = new Date(res.restartedAt).toLocaleTimeString();
        setSuccessMessage(
          `Connector restarted with ${selectedMode === 'ator' ? 'ATOR' : 'Direct'} transport at ${time}.`
        );
      }
    } catch {
      // patchError state is set by the hook
    }
  }

  function handleSwitchToDirect() {
    if (pending) return;
    setSuccessMessage(null);
    void patch({ mode: 'direct' }, refetch)
      .then(() => {
        setLocalMode(null);
        setSuccessMessage('Switched to Direct transport.');
      })
      .catch(() => {
        // Error surfaces in `patchError` (rendered below). Keep `localMode`
        // unchanged so the radio reflects the operator's last explicit choice.
      });
  }

  return (
    <Shell
      header={
        <div className="flex items-center justify-between gap-3">
          <span className="font-semibold tracking-tight-16">Settings</span>
          <Link
            to="/"
            className="font-geist-sans text-xs text-ink/60 hover:text-ink"
            aria-label="Back to home"
          >
            ← Home
          </Link>
        </div>
      }
    >
      <div className="mx-auto max-w-2xl flex flex-col gap-8">
        {/* Transport section */}
        <section aria-labelledby="transport-heading">
          <h2
            id="transport-heading"
            className="font-geist-sans text-lg font-semibold text-ink tracking-tight-20 mb-1"
          >
            Transport
          </h2>
          <p className="font-geist-sans text-sm text-ink/60 mb-4">
            Where your node connects through. Switching modes restarts the
            connector — packets in flight may be dropped briefly.
          </p>

          {/* Radio group */}
          <div
            className="flex flex-col gap-3 mb-4"
            role="radiogroup"
            aria-label="Transport mode"
          >
            {(['direct', 'ator'] as const).map((mode) => (
              <label
                key={mode}
                className={`bg-canvas shadow-border rounded-lg p-4 flex items-start gap-3 cursor-pointer ${
                  selectedMode === mode ? 'ring-1 ring-ink/20' : ''
                } ${pending ? 'opacity-60 pointer-events-none' : ''}`}
              >
                <input
                  type="radio"
                  name="transport"
                  value={mode}
                  checked={selectedMode === mode}
                  onChange={() => {
                    setLocalMode(mode);
                    setSuccessMessage(null);
                  }}
                  disabled={pending}
                  className="mt-1 accent-ink"
                />
                <div className="flex flex-col gap-1">
                  <span className="font-geist-sans text-sm font-medium text-ink">
                    {mode === 'direct' ? 'Direct' : 'ATOR'}
                  </span>
                  <p className="font-geist-sans text-xs text-ink/70">
                    {mode === 'direct'
                      ? 'Faster, less private. Connect directly to the internet.'
                      : 'Slower, more private. Routes through public ATOR proxies.'}
                  </p>
                </div>
              </label>
            ))}
          </div>

          {/* Live status panel */}
          <div className="mb-4">
            <TransportStatusPanel
              status={status}
              statusKind={statusKind}
              onSwitchToDirect={handleSwitchToDirect}
              recoveryPending={pending}
            />
          </div>

          {/* Custom proxy note */}
          <p className="font-geist-sans text-xs text-ink/40 mb-4">
            Custom proxy URLs: edit{' '}
            <code className="font-geist-mono text-xs">
              ~/.townhouse/config.yaml
            </code>
            .
          </p>

          {/* Success message */}
          {successMessage && (
            <p
              role="status"
              className="font-geist-sans text-sm text-green-600 mb-4"
            >
              {successMessage}
            </p>
          )}

          {/* Error message */}
          {patchError && (
            <p
              role="alert"
              className="font-geist-sans text-sm text-red-600 mb-4"
            >
              {patchError}
            </p>
          )}

          {/* Save button */}
          <Button
            onClick={() => void handleSave()}
            disabled={noOp || pending}
            aria-busy={pending}
          >
            {pending ? 'Saving…' : 'Save & restart connector'}
          </Button>
        </section>
      </div>
    </Shell>
  );
}
