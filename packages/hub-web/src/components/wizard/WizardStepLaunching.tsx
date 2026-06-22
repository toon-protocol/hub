import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PullProgressList } from '@/components/PullProgressList';
import { useWizardProgress } from '@/hooks/useWizardProgress';

export interface WizardStepLaunchingProps {
  /** AC-19: invoked when the operator clicks "Try again" — returns to step 5
   *  with WizardDraft intact so they can retry without re-entering the password
   *  or seed phrase. */
  onRetry?: () => void;
}

export function WizardStepLaunching({ onRetry }: WizardStepLaunchingProps = {}) {
  const { messages, status } = useWizardProgress();
  const navigate = useNavigate();

  const launchComplete = messages.some((m) => m.type === 'launch_complete');
  const hasError = messages.some((m) => m.type === 'error' || m.type === 'container_failed');

  useEffect(() => {
    if (launchComplete) {
      const timer = setTimeout(() => {
        navigate('/', { replace: true });
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, [launchComplete, navigate]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2
          id="wizard-step-heading"
          className="font-geist-sans text-xl font-semibold text-ink tracking-tight-20"
          aria-live="polite"
        >
          {launchComplete ? 'Setup complete' : 'Launching your nodes…'}
        </h2>
        <p className="font-geist-sans text-sm text-ink/60 mt-1">
          {launchComplete
            ? 'Opening dashboard…'
            : status === 'connecting'
              ? 'Connecting to API…'
              : 'Pulling Docker images and starting your nodes.'}
        </p>
      </div>

      {status === 'closed' && !launchComplete && !hasError && (
        <p className="font-geist-sans text-xs text-ink/50">
          Connection closed. If this takes too long, refresh the page.
        </p>
      )}

      <PullProgressList messages={messages} />

      {hasError && (
        <div role="alert" className="bg-canvas shadow-border rounded-md px-4 py-3">
          <p className="font-geist-sans text-sm text-red-500">
            {messages
              .filter((m) => m.type === 'error' || m.type === 'container_failed')
              .map((m) => ('message' in m ? m.message : 'reason' in m ? m.reason : ''))
              .join(', ')}
          </p>
          {onRetry ? (
            <button
              type="button"
              onClick={onRetry}
              className="font-geist-sans text-xs text-ink/60 mt-1 underline hover:text-ink"
            >
              Try again
            </button>
          ) : (
            <p className="font-geist-sans text-xs text-ink/60 mt-1">
              Close this tab and re-run <code className="font-geist-mono">hub setup</code> to try again.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
