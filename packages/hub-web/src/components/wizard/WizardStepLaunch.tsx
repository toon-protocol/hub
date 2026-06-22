import { TypeChip } from '@/components/primitives/TypeChip';
import { Button } from '@/components/primitives/Button';
import type { NodeType } from '@toon-protocol/hub';
import type { WizardError } from '@/hooks/useWizardSubmit';

const ERROR_MESSAGES: Record<string, string> = {
  password_mismatch: 'Password mismatch — please retype.',
  password_invalid: 'Password is invalid — it must be 1–256 characters with no leading or trailing whitespace.',
  backup_not_acknowledged: 'You must confirm you have backed up your seed phrase.',
  mnemonic_invalid: 'Invalid seed phrase — please go back and check it.',
  no_nodes_selected: 'No nodes selected — please go back and choose at least one.',
  fee_out_of_range: 'A fee value is out of range — please go back and check.',
  transport_invalid: 'Invalid transport mode.',
  init_in_flight: 'Setup is already running. Wait for it to finish or refresh the page.',
  wallet_already_exists:
    'A wallet already exists in your Hub config directory. Stop the wizard, delete `wallet.enc` from your config directory, and re-run `hub setup`.',
  config_already_exists:
    'A config already exists in your Hub config directory. Stop the wizard, delete `config.yaml`, and re-run `hub setup`.',
};

export interface LaunchSummary {
  enabledNodes: NodeType[];
  transport: 'direct' | 'ator';
  townFeePerEvent: number;
  millFeeBasisPoints: number;
  dvmFeePerJob: number;
}

export interface WizardStepLaunchProps {
  summary: LaunchSummary;
  onLaunch: () => void;
  onBack: () => void;
  launching: boolean;
  error?: WizardError | null;
}

export function WizardStepLaunch({ summary, onLaunch, onBack, launching, error }: WizardStepLaunchProps) {
  const feeLabels: Record<NodeType, string> = {
    town: `${summary.townFeePerEvent} msats/event`,
    mill: `${summary.millFeeBasisPoints} bps`,
    dvm: `${summary.dvmFeePerJob} msats/job`,
  };

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2
          id="wizard-step-heading"
          className="font-geist-sans text-xl font-semibold text-ink tracking-tight-20"
          aria-live="polite"
        >
          Review and launch
        </h2>
        <p className="font-geist-sans text-sm text-ink/60 mt-1">
          Check your settings before launching your nodes.
        </p>
      </div>

      <div className="bg-canvas shadow-border rounded-lg p-4 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <span className="font-geist-sans text-xs font-medium text-ink/50 uppercase tracking-tight-14">Nodes</span>
          <div className="flex gap-2 flex-wrap">
            {summary.enabledNodes.map((type) => (
              <div key={type} className="flex items-center gap-1.5">
                <TypeChip type={type} />
                <span className="font-geist-mono text-xs text-ink/70">{feeLabels[type]}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <span className="font-geist-sans text-xs font-medium text-ink/50 uppercase tracking-tight-14">Transport</span>
          <span className="font-geist-sans text-sm text-ink capitalize">{summary.transport}</span>
        </div>
      </div>

      {error && (
        <div role="alert" className="bg-canvas shadow-border rounded-md px-4 py-3">
          <p className="font-geist-sans text-sm text-red-500">
            {ERROR_MESSAGES[error.code] ?? error.message ?? 'An unexpected error occurred. Please try again.'}
          </p>
        </div>
      )}

      <div className="flex gap-3 justify-between">
        <Button variant="secondary" onClick={onBack} disabled={launching}>Back</Button>
        <Button onClick={onLaunch} disabled={launching} loading={launching}>
          {launching ? 'Launching…' : 'Launch'}
        </Button>
      </div>
    </div>
  );
}
