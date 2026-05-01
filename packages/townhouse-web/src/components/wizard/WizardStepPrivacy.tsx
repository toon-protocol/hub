import { Button } from '@/components/primitives/Button';

export interface WizardStepPrivacyProps {
  transport: 'direct' | 'ator';
  onChange: (mode: 'direct' | 'ator') => void;
  onContinue: () => void;
  onBack: () => void;
}

export function WizardStepPrivacy({ transport, onChange, onContinue, onBack }: WizardStepPrivacyProps) {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2
          id="wizard-step-heading"
          className="font-geist-sans text-xl font-semibold text-ink tracking-tight-20"
          aria-live="polite"
        >
          Choose transport
        </h2>
        <p className="font-geist-sans text-sm text-ink/60 mt-1">
          How your node connects to the network.
        </p>
      </div>

      <div className="flex flex-col gap-3" role="radiogroup" aria-label="Transport mode">
        {(['direct', 'ator'] as const).map((mode) => (
          <label
            key={mode}
            className={`bg-canvas shadow-border rounded-lg p-4 flex items-start gap-3 cursor-pointer ${transport === mode ? 'ring-1 ring-ink/20' : ''}`}
          >
            <input
              type="radio"
              name="transport"
              value={mode}
              checked={transport === mode}
              onChange={() => onChange(mode)}
              className="mt-1 accent-ink"
            />
            <div className="flex flex-col gap-1">
              <span className="font-geist-sans text-sm font-medium text-ink">
                {mode === 'direct' ? 'Direct' : 'ATOR'}
              </span>
              <p className="font-geist-sans text-xs text-ink/70">
                {mode === 'direct'
                  ? 'Faster, less private. Recommended for now. Connect directly to the internet.'
                  : 'Slower, more private. Routes through public ATOR proxies. Coming soon: live ATOR connectivity status (story 21.15).'}
              </p>
            </div>
          </label>
        ))}
      </div>

      <div className="flex gap-3 justify-between">
        <Button variant="secondary" onClick={onBack}>Back</Button>
        <Button onClick={onContinue}>Continue</Button>
      </div>
    </div>
  );
}
