/**
 * Placeholder Home page (21.8.5 smoke check only).
 * Real Home view ships in story 21.9-lite.
 * Renders Shell + one TypeChip per child node from GET /api/nodes.
 */

import { useEffect, useState } from 'react';
import { Shell } from '@/components/primitives/Shell';
import { TypeChip } from '@/components/primitives/TypeChip';
import { StateShell } from '@/components/primitives/StateShell';
import type { ShellState } from '@/components/primitives/StateShell';
import type { NodeType } from '@toon-protocol/townhouse';

interface NodeInfo {
  type: NodeType;
  enabled: boolean;
  state: string;
}

export function Home() {
  const [nodes, setNodes] = useState<NodeInfo[]>([]);
  const [uiState, setUiState] = useState<ShellState>('loading');

  useEffect(() => {
    fetch('/api/nodes')
      .then((r) => r.json())
      .then((data: NodeInfo[]) => {
        setNodes(data);
        setUiState(data.length === 0 ? 'empty' : 'ready');
      })
      .catch(() => setUiState('error'));
  }, []);

  return (
    <Shell header={<span className="font-semibold tracking-tight-16">Townhouse</span>}>
      <StateShell state={uiState}>
        <div className="flex flex-wrap gap-3">
          {nodes.map((node) => (
            <TypeChip key={node.type} type={node.type} />
          ))}
        </div>
      </StateShell>
    </Shell>
  );
}
