import { useState } from 'react';
import { Shell } from '@/components/primitives/Shell';
import { Button } from '@/components/primitives/Button';
import { WizardStepNodes } from '@/components/wizard/WizardStepNodes';
import { WizardStepWallet } from '@/components/wizard/WizardStepWallet';
import { WizardStepPrivacy } from '@/components/wizard/WizardStepPrivacy';
import { WizardStepFees } from '@/components/wizard/WizardStepFees';
import { WizardStepChains } from '@/components/wizard/WizardStepChains';
import { WizardStepLaunch } from '@/components/wizard/WizardStepLaunch';
import { WizardStepLaunching } from '@/components/wizard/WizardStepLaunching';
import { useWizardSubmit } from '@/hooks/useWizardSubmit';
import type { WizardError } from '@/hooks/useWizardSubmit';
import type { NodeType } from '@toon-protocol/hub';
import type {
  WizardInitRequest,
  ChainProviderEntry,
} from '@toon-protocol/hub';

type WizardStep = 1 | 2 | 3 | 4 | 5 | 6 | 'launching' | 'cancelled';

interface WizardDraft {
  nodes: { town: boolean; mill: boolean; dvm: boolean };
  mnemonic: string;
  password: string;
  mnemonicMode: 'generate' | 'import';
  backupAck: boolean;
  transport: 'direct' | 'ator';
  townFeePerEvent: number;
  millFeeBasisPoints: number;
  dvmFeePerJob: number;
  chainProviders: ChainProviderEntry[];
}

const STEP_LABELS: Record<number, string> = {
  1: 'Choose nodes',
  2: 'Set up wallet',
  3: 'Choose transport',
  4: 'Set fees',
  5: 'Settlement chains',
  6: 'Review',
};

const TOTAL_STEPS = 6;

export function WizardView() {
  const { submit, previewMnemonic } = useWizardSubmit();

  const [step, setStep] = useState<WizardStep>(1);
  const [draft, setDraft] = useState<WizardDraft>({
    nodes: { town: false, mill: false, dvm: false },
    mnemonic: '',
    password: '',
    mnemonicMode: 'generate',
    backupAck: false,
    transport: 'direct',
    townFeePerEvent: 100,
    millFeeBasisPoints: 30,
    dvmFeePerJob: 5000,
    chainProviders: [],
  });
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<WizardError | null>(null);

  const enabledNodes: NodeType[] = (
    ['town', 'mill', 'dvm'] as NodeType[]
  ).filter((t) => draft.nodes[t]);

  const hasWorkingDraft = Boolean(
    draft.password || draft.mnemonic || enabledNodes.length > 0
  );

  function handleCancel() {
    if (
      hasWorkingDraft &&
      !window.confirm(
        'Cancel setup? Your wallet password and seed phrase will be discarded.'
      )
    ) {
      return;
    }
    // Cancel does NOT navigate to '/' — Home auto-redirects back to /wizard
    // whenever config_exists is false, which would create an infinite loop.
    // Instead, surface a terminal cancelled state with instructions.
    setDraft((d) => ({ ...d, password: '', mnemonic: '' }));
    setStep('cancelled');
  }

  async function handleLaunch(): Promise<void> {
    setLaunching(true);
    setLaunchError(null);
    const req: WizardInitRequest = {
      password: draft.password,
      password_confirm: draft.password,
      mnemonic_mode: draft.mnemonicMode,
      mnemonic: draft.mnemonic.trim(),
      backup_ack: draft.backupAck,
      nodes: {
        town: { enabled: draft.nodes.town, feePerEvent: draft.townFeePerEvent },
        mill: {
          enabled: draft.nodes.mill,
          feeBasisPoints: draft.millFeeBasisPoints,
        },
        dvm: { enabled: draft.nodes.dvm, feePerJob: draft.dvmFeePerJob },
      },
      transport: { mode: draft.transport },
      ...(draft.chainProviders.length > 0
        ? { chainProviders: draft.chainProviders }
        : {}),
    };

    const result = await submit(req);
    if ('code' in result) {
      setLaunchError(result);
      setLaunching(false);
    } else {
      // 202 Accepted — transition to launching view
      setStep('launching');
      setLaunching(false);
    }
  }

  function handleRetryFromLaunching() {
    // AC-19 — return to the review step with draft intact so the operator can
    // retry without losing the password/seed phrase they already entered.
    setLaunchError(null);
    setStep(6);
  }

  const stepNum = typeof step === 'number' ? step : null;
  const showCancel = step !== 'launching' && step !== 'cancelled';

  return (
    <Shell
      header={
        <div className="flex items-center justify-between">
          <span className="font-geist-sans font-semibold text-ink tracking-tight-16">
            Hub Setup
          </span>
          {showCancel && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCancel}
              aria-label="Cancel setup"
            >
              Cancel
            </Button>
          )}
        </div>
      }
    >
      <div className="max-w-lg mx-auto">
        {/* Progress indicator */}
        {stepNum !== null && (
          <div className="mb-6 flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <span className="font-geist-sans text-xs text-ink/50">
                Step {stepNum} of {TOTAL_STEPS}
              </span>
              <span className="font-geist-sans text-xs text-ink/50">
                {STEP_LABELS[stepNum]}
              </span>
            </div>
            <div className="h-1 bg-ink/10 rounded-full overflow-hidden">
              <div
                className="h-full bg-ink/40 transition-all duration-300"
                style={{ width: `${(stepNum / TOTAL_STEPS) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Step content */}
        {step === 1 && (
          <WizardStepNodes
            selection={draft.nodes}
            onChange={(nodes) => setDraft((d) => ({ ...d, nodes }))}
            onContinue={() => setStep(2)}
          />
        )}

        {step === 2 && (
          <WizardStepWallet
            draft={{
              mnemonic: draft.mnemonic,
              password: draft.password,
              mnemonicMode: draft.mnemonicMode,
              backupAck: draft.backupAck,
            }}
            onChange={(w) =>
              setDraft((d) => ({
                ...d,
                mnemonic: w.mnemonic,
                password: w.password,
                mnemonicMode: w.mnemonicMode,
                backupAck: w.backupAck,
              }))
            }
            onContinue={() => setStep(3)}
            onBack={() => setStep(1)}
            fetchMnemonic={previewMnemonic}
          />
        )}

        {step === 3 && (
          <WizardStepPrivacy
            transport={draft.transport}
            onChange={(mode) => setDraft((d) => ({ ...d, transport: mode }))}
            onContinue={() => setStep(4)}
            onBack={() => setStep(2)}
          />
        )}

        {step === 4 && (
          <WizardStepFees
            fees={{
              townFeePerEvent: draft.townFeePerEvent,
              millFeeBasisPoints: draft.millFeeBasisPoints,
              dvmFeePerJob: draft.dvmFeePerJob,
            }}
            nodesEnabled={draft.nodes}
            onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
            onContinue={() => setStep(5)}
            onBack={() => setStep(3)}
          />
        )}

        {step === 5 && (
          <WizardStepChains
            chains={draft.chainProviders}
            onChange={(chainProviders) =>
              setDraft((d) => ({ ...d, chainProviders }))
            }
            onContinue={() => setStep(6)}
            onBack={() => setStep(4)}
          />
        )}

        {step === 6 && (
          <WizardStepLaunch
            summary={{
              enabledNodes,
              transport: draft.transport,
              townFeePerEvent: draft.townFeePerEvent,
              millFeeBasisPoints: draft.millFeeBasisPoints,
              dvmFeePerJob: draft.dvmFeePerJob,
            }}
            onLaunch={() => void handleLaunch()}
            onBack={() => setStep(5)}
            launching={launching}
            error={launchError}
          />
        )}

        {step === 'launching' && (
          <WizardStepLaunching onRetry={handleRetryFromLaunching} />
        )}

        {step === 'cancelled' && (
          <div className="flex flex-col gap-4 text-center py-12">
            <h2 className="font-geist-sans text-xl font-semibold text-ink tracking-tight-20">
              Setup cancelled
            </h2>
            <p className="font-geist-sans text-sm text-ink/60">
              Close this tab and stop the{' '}
              <code className="font-geist-mono">hub setup</code> process
              (Ctrl+C in the terminal). Re-run{' '}
              <code className="font-geist-mono">hub setup</code> when
              you&apos;re ready to continue.
            </p>
          </div>
        )}
      </div>
    </Shell>
  );
}
