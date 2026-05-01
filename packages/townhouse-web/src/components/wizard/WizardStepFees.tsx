import { Input } from '@/components/primitives/Input';
import { Button } from '@/components/primitives/Button';
import { TypeChip } from '@/components/primitives/TypeChip';

export interface FeesDraft {
  townFeePerEvent: number;
  millFeeBasisPoints: number;
  dvmFeePerJob: number;
}

export interface WizardStepFeesProps {
  fees: FeesDraft;
  nodesEnabled: { town: boolean; mill: boolean; dvm: boolean };
  /**
   * Called with a partial patch (e.g. `{ townFeePerEvent: 200 }`) — the parent
   * merges this atomically into its own state. We deliberately do NOT spread
   * the full `fees` prop here: under fast slider input, the prop captured by
   * one slider's closure can be stale relative to a sibling's just-committed
   * value, and a full-object onChange would clobber it.
   */
  onChange: (patch: Partial<FeesDraft>) => void;
  onContinue: () => void;
  onBack: () => void;
}

export function WizardStepFees({ fees, nodesEnabled, onChange, onContinue, onBack }: WizardStepFeesProps) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2
          id="wizard-step-heading"
          className="font-geist-sans text-xl font-semibold text-ink tracking-tight-20"
          aria-live="polite"
        >
          Set your fees
        </h2>
        <p className="font-geist-sans text-sm text-ink/60 mt-1">
          Choose how much to charge for your node services. You can change this any time.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {nodesEnabled.town && (
          <div className="bg-canvas shadow-border rounded-lg p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <TypeChip type="town" />
              <span className="font-geist-sans text-sm font-medium text-ink">Write fee</span>
            </div>
            <Input
              variant="slider"
              label="Town write fee (millisats per event)"
              value={fees.townFeePerEvent}
              onChange={(_e, value) => onChange({ townFeePerEvent: value })}
              min={0}
              max={1000}
              step={10}
            />
            <div className="flex justify-between">
              <span className="font-geist-mono text-xs text-ink/70">{fees.townFeePerEvent} msats/event</span>
              <span className="font-geist-sans text-xs text-ink/60">
                Est. {((fees.townFeePerEvent * 5000) / 1000).toFixed(0)} sats/day at 5,000 events/day (assumed)
              </span>
            </div>
          </div>
        )}

        {nodesEnabled.mill && (
          <div className="bg-canvas shadow-border rounded-lg p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <TypeChip type="mill" />
              <span className="font-geist-sans text-sm font-medium text-ink">Swap fee</span>
            </div>
            <Input
              variant="slider"
              label="Mill swap fee (basis points)"
              value={fees.millFeeBasisPoints}
              onChange={(_e, value) => onChange({ millFeeBasisPoints: value })}
              min={0}
              max={100}
              step={1}
            />
            <div className="flex justify-between">
              <span className="font-geist-mono text-xs text-ink/70">{fees.millFeeBasisPoints} bps</span>
              <span className="font-geist-sans text-xs text-ink/60">
                Earn ~{(fees.millFeeBasisPoints * 0.01).toFixed(2)}% per swap volume routed
              </span>
            </div>
          </div>
        )}

        {nodesEnabled.dvm && (
          <div className="bg-canvas shadow-border rounded-lg p-4 flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <TypeChip type="dvm" />
              <span className="font-geist-sans text-sm font-medium text-ink">Job fee</span>
            </div>
            <Input
              variant="slider"
              label="DVM job fee (millisats per job)"
              value={fees.dvmFeePerJob}
              onChange={(_e, value) => onChange({ dvmFeePerJob: value })}
              min={0}
              max={100000}
              step={1000}
            />
            <div className="flex justify-between">
              <span className="font-geist-mono text-xs text-ink/70">{fees.dvmFeePerJob} msats/job</span>
              <span className="font-geist-sans text-xs text-ink/60">
                Each job earns up to {(fees.dvmFeePerJob / 1000).toFixed(1)} sats
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="flex gap-3 justify-between">
        <Button variant="secondary" onClick={onBack}>Back</Button>
        <Button onClick={onContinue}>Continue</Button>
      </div>
    </div>
  );
}
