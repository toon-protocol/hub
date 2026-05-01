import { TypeChip } from '@/components/primitives/TypeChip';
import { Button } from '@/components/primitives/Button';
import type { NodeType } from '@toon-protocol/townhouse';

const NODE_INFO: Record<NodeType, { description: string; bestFor: string }> = {
  town: {
    description: 'Run a Nostr relay and earn write fees from every event published through your node.',
    bestFor: 'Operators who want to contribute to the Nostr network and earn from event volume.',
  },
  mill: {
    description: 'Run a token swap peer and earn basis-point fees on every swap routed through you.',
    bestFor: 'Operators with liquidity who want passive swap income.',
  },
  dvm: {
    description: 'Run a compute job handler and earn per-job fees for processing DVM tasks.',
    bestFor: 'Operators with spare compute who want to monetize AI/compute capacity.',
  },
};

export interface NodesSelection {
  town: boolean;
  mill: boolean;
  dvm: boolean;
}

export interface WizardStepNodesProps {
  selection: NodesSelection;
  onChange: (selection: NodesSelection) => void;
  onContinue: () => void;
}

export function WizardStepNodes({ selection, onChange, onContinue }: WizardStepNodesProps) {
  const anySelected = selection.town || selection.mill || selection.dvm;

  function toggle(type: NodeType) {
    onChange({ ...selection, [type]: !selection[type] });
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2
          id="wizard-step-heading"
          className="font-geist-sans text-xl font-semibold text-ink tracking-tight-20"
          aria-live="polite"
        >
          Choose your nodes
        </h2>
        <p className="font-geist-sans text-sm text-ink/60 mt-1">
          Select the node types you want to run. You can change this later.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {(['town', 'mill', 'dvm'] as NodeType[]).map((type) => {
          const info = NODE_INFO[type];
          const checked = selection[type];
          return (
            <label
              key={type}
              className={`bg-canvas shadow-border rounded-lg p-4 flex items-start gap-3 cursor-pointer ${checked ? 'ring-1 ring-ink/20' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(type)}
                className="mt-1 accent-ink"
                aria-describedby={`node-${type}-desc`}
              />
              <div className="flex flex-col gap-1 flex-1">
                <div className="flex items-center gap-2">
                  <TypeChip type={type} />
                  <span className="font-geist-sans text-sm font-medium text-ink">
                    {type.charAt(0).toUpperCase() + type.slice(1)} Node
                  </span>
                </div>
                <p id={`node-${type}-desc`} className="font-geist-sans text-xs text-ink/70">
                  {info.description}
                </p>
                <p className="font-geist-sans text-xs text-ink/50 italic">
                  Best for: {info.bestFor}
                </p>
              </div>
            </label>
          );
        })}
      </div>

      {!anySelected && (
        <p className="font-geist-sans text-xs text-red-500/80" role="alert">
          Select at least one node type.
        </p>
      )}

      <div className="flex gap-3 justify-end">
        <Button onClick={onContinue} disabled={!anySelected}>
          Continue
        </Button>
      </div>
    </div>
  );
}
