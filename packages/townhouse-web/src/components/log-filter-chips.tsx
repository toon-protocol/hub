import * as React from 'react';
import type { LogService, LogLevel } from '@toon-protocol/townhouse';
import { tokens, colors } from '@/theme/tokens';

export const LOG_SERVICES: readonly LogService[] = [
  'town',
  'mill',
  'dvm',
  'connector',
] as const;

export const LOG_LEVELS: readonly LogLevel[] = [
  'info',
  'warn',
  'error',
  'debug',
] as const;

/**
 * Per-service colour stripe — drawn from the existing accent tokens. The
 * `connector` row reuses the ink colour so it sits visually behind the
 * three node accents (it's plumbing, not a node).
 */
export const SERVICE_COLOR: Record<LogService, string> = {
  town: tokens.accent.town,
  mill: tokens.accent.mill,
  dvm: tokens.accent.dvm,
  connector: colors.ink,
};

/** Per-level Tailwind text class. Avoids inline hex; opacity tokens are
 *  already exposed via the shared theme. */
export const LEVEL_CLASS: Record<LogLevel, string> = {
  info: 'text-ink/50',
  warn: 'text-type-mill', // amber-ish brand accent
  error: 'text-type-dvm', // red-ish brand accent
  debug: 'text-ink/40',
};

interface ChipProps {
  label: string;
  active: boolean;
  swatch?: string;
  onToggle: () => void;
}

function Chip({ label, active, swatch, onToggle }: ChipProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      className={`font-geist-mono inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs transition-colors ${
        active ? 'bg-ink/10 text-ink' : 'bg-ink/[0.03] text-ink/40 hover:text-ink/70'
      }`}
    >
      {swatch && (
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 rounded-full"
          style={{ backgroundColor: swatch }}
        />
      )}
      {label}
    </button>
  );
}

export interface LogFilterChipsProps {
  services: Set<LogService>;
  levels: Set<LogLevel>;
  onServicesChange: (next: Set<LogService>) => void;
  onLevelsChange: (next: Set<LogLevel>) => void;
}

export function LogFilterChips({
  services,
  levels,
  onServicesChange,
  onLevelsChange,
}: LogFilterChipsProps) {
  const toggleService = (s: LogService) => {
    const next = new Set(services);
    if (next.has(s)) next.delete(s);
    else next.add(s);
    onServicesChange(next);
  };
  const toggleLevel = (l: LogLevel) => {
    const next = new Set(levels);
    if (next.has(l)) next.delete(l);
    else next.add(l);
    onLevelsChange(next);
  };

  return (
    <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Log filters">
      <div className="flex items-center gap-1.5" aria-label="Filter by service">
        <span className="font-geist-sans text-xs text-ink/40">service</span>
        {LOG_SERVICES.map((s) => (
          <Chip
            key={s}
            label={s}
            swatch={SERVICE_COLOR[s]}
            active={services.has(s)}
            onToggle={() => toggleService(s)}
          />
        ))}
      </div>
      <div className="flex items-center gap-1.5" aria-label="Filter by level">
        <span className="font-geist-sans text-xs text-ink/40">level</span>
        {LOG_LEVELS.map((l) => (
          <Chip
            key={l}
            label={l}
            active={levels.has(l)}
            onToggle={() => toggleLevel(l)}
          />
        ))}
      </div>
    </div>
  );
}
