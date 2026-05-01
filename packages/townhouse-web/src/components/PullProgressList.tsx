import { StatusDot } from '@/components/primitives/StatusDot';
import type { StatusDotProps } from '@/components/primitives/StatusDot';
import type { WizardProgressMessage } from '@toon-protocol/townhouse';

export interface PullProgressListProps {
  messages: WizardProgressMessage[];
}

type DotState = NonNullable<StatusDotProps['state']>;

interface RowState {
  name: string;
  status: string;
  progress?: string;
  dotState: DotState;
}

/** Parse a Docker progress string like "53%: 12.3MB / 23.0MB" to a 0-100 number */
function parseProgressPct(progress?: string): number | null {
  if (!progress) return null;
  const match = progress.match(/(\d+)%/);
  if (match) return Math.min(100, Number(match[1]));
  return null;
}

/**
 * Groups WizardProgressMessages by image/container name and renders a live
 * progress row for each, with StatusDot + thin CSS progress bar.
 */
export function PullProgressList({ messages }: PullProgressListProps) {
  if (messages.length === 0) {
    return (
      <p className="font-geist-sans text-sm text-ink/50">
        Waiting for progress…
      </p>
    );
  }

  // Build latest state per name
  const rowMap = new Map<string, RowState>();

  for (const msg of messages) {
    if (msg.type === 'pull_progress') {
      const existing = rowMap.get(msg.image);
      rowMap.set(msg.image, {
        name: msg.image,
        status: msg.status,
        progress: msg.progress,
        dotState: existing?.dotState === 'ok' ? 'ok' : 'degraded',
      });
    } else if (msg.type === 'container_starting') {
      const existing = rowMap.get(msg.name);
      rowMap.set(msg.name, {
        name: msg.name,
        status: 'Container starting…',
        dotState: 'degraded',
        progress: existing?.progress,
      });
    } else if (msg.type === 'container_healthy') {
      rowMap.set(msg.name, {
        name: msg.name,
        status: 'Healthy',
        dotState: 'ok',
      });
    } else if (msg.type === 'container_failed') {
      rowMap.set(msg.name, {
        name: msg.name,
        status: `Failed: ${msg.reason}`,
        dotState: 'down',
      });
    }
    // launch_complete: no row, handled by parent
  }

  if (rowMap.size === 0) return null;

  return (
    <ul className="flex flex-col gap-2" aria-label="Image pull progress">
      {[...rowMap.values()].map((row) => {
        const pct = parseProgressPct(row.progress);
        return (
          <li key={row.name} className="bg-canvas shadow-border rounded-md p-3 flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <StatusDot state={row.dotState} aria-label={row.dotState === 'ok' ? 'Healthy' : row.dotState === 'down' ? 'Failed' : 'In progress'} />
              <span className="font-geist-mono text-xs text-ink flex-1 truncate">{row.name}</span>
              <span className="font-geist-sans text-xs text-ink/60 shrink-0">{row.status}</span>
            </div>
            {pct !== null && (
              <div className="h-0.5 w-full bg-canvas-2 rounded-full overflow-hidden" role="progressbar" aria-label={`${row.name} download progress`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className="h-full bg-ink/70 transition-all duration-300 ease-out"
                  style={{ width: `${pct}%` }}
                />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
