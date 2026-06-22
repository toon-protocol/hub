import * as React from 'react';
import type { LogEvent, LogService, LogLevel } from '@toon-protocol/hub';
import {
  LogFilterChips,
  LOG_SERVICES,
  LOG_LEVELS,
  SERVICE_COLOR,
  LEVEL_CLASS,
} from './log-filter-chips';

const MAX_LINES = 500;
const SSE_URL = '/api/logs/stream';

export interface LogTailProps {
  /**
   * Override the SSE endpoint (test injection only — production should let
   * this default). Pass null to disable EventSource entirely (snapshot tests).
   */
  endpoint?: string | null;
  /**
   * Inject a pre-baked stream of events for tests. When supplied, no
   * EventSource is opened and these events are rendered directly.
   */
  initialEvents?: LogEvent[];
}

interface ConnectionState {
  status: 'connecting' | 'open' | 'closed' | 'error';
}

function isLogEvent(v: unknown): v is LogEvent {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ts === 'string' &&
    typeof o.service === 'string' &&
    typeof o.level === 'string' &&
    typeof o.msg === 'string'
  );
}

/** Format an ISO timestamp as HH:MM:SS.mmm — short, monospace-friendly. */
function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--:--';
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    const ms = String(d.getMilliseconds()).padStart(3, '0');
    return `${hh}:${mm}:${ss}.${ms}`;
  } catch {
    return '--:--:--';
  }
}

/**
 * LogTail panel — most-recent-first SSE-fed log viewer.
 *
 * Implements AC-D6-2/3/4: filter chips for service + level (multi-select,
 * default all on), monospace rendering with color-coded service stripe,
 * pause-on-hover for auto-scroll, capped at 500 lines.
 */
export function LogTail({ endpoint = SSE_URL, initialEvents }: LogTailProps) {
  const [events, setEvents] = React.useState<LogEvent[]>(initialEvents ?? []);
  const [conn, setConn] = React.useState<ConnectionState>({
    status: endpoint === null ? 'closed' : 'connecting',
  });
  const [services, setServices] = React.useState<Set<LogService>>(
    () => new Set(LOG_SERVICES)
  );
  const [levels, setLevels] = React.useState<Set<LogLevel>>(
    () => new Set(LOG_LEVELS)
  );
  const [paused, setPaused] = React.useState(false);
  const listRef = React.useRef<HTMLDivElement | null>(null);

  // Open SSE
  React.useEffect(() => {
    if (endpoint === null) return;
    if (typeof EventSource === 'undefined') return; // jsdom guard

    let es: EventSource;
    try {
      es = new EventSource(endpoint);
    } catch {
      setConn({ status: 'error' });
      return;
    }

    setConn({ status: 'connecting' });
    es.onopen = () => setConn({ status: 'open' });
    es.onerror = () => setConn({ status: 'error' });
    es.onmessage = (msg) => {
      try {
        const parsed: unknown = JSON.parse(msg.data);
        if (!isLogEvent(parsed)) return;
        setEvents((prev) => {
          const next = [parsed, ...prev];
          if (next.length > MAX_LINES) next.length = MAX_LINES;
          return next;
        });
      } catch {
        // ignore malformed payloads
      }
    };

    return () => {
      try {
        es.close();
      } catch {
        /* best-effort */
      }
    };
  }, [endpoint]);

  // Auto-scroll to top (most-recent-first) when new events arrive, unless paused
  React.useEffect(() => {
    if (paused) return;
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [events, paused]);

  const visible = React.useMemo(
    () => events.filter((e) => services.has(e.service) && levels.has(e.level)),
    [events, services, levels]
  );

  const statusLabel =
    conn.status === 'open'
      ? `live · ${visible.length}/${events.length} lines`
      : conn.status === 'connecting'
        ? 'connecting…'
        : conn.status === 'error'
          ? 'reconnecting…'
          : 'idle';

  return (
    <section
      className="shadow-border flex flex-col gap-3 rounded-lg bg-canvas p-4"
      aria-label="Live container logs"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="font-geist-sans text-sm font-medium text-ink">
            Live logs
          </h2>
          <span
            aria-live="polite"
            className="font-geist-mono text-xs text-ink/40"
          >
            {statusLabel}
          </span>
          {paused && (
            <span
              className="font-geist-mono rounded bg-ink/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink/60"
              aria-label="auto-scroll paused"
            >
              paused
            </span>
          )}
        </div>
        <LogFilterChips
          services={services}
          levels={levels}
          onServicesChange={setServices}
          onLevelsChange={setLevels}
        />
      </header>

      <div
        ref={listRef}
        role="log"
        aria-label="Container log lines"
        aria-live={paused ? 'off' : 'polite'}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
        className="shadow-border font-geist-mono h-72 overflow-y-auto rounded bg-ink/[0.02] text-xs leading-relaxed"
      >
        {visible.length === 0 ? (
          <p className="font-geist-sans px-3 py-4 text-xs text-ink/40">
            {events.length === 0
              ? 'Waiting for log lines…'
              : 'No lines match the current filters.'}
          </p>
        ) : (
          <ul className="flex flex-col">
            {visible.map((e, idx) => (
              <LogLine key={`${e.ts}-${idx}`} event={e} />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface LogLineProps {
  event: LogEvent;
}

function LogLine({ event }: LogLineProps) {
  return (
    <li
      className="relative flex items-start gap-2 py-1 pl-3 pr-2.5 hover:bg-ink/[0.03]"
      data-service={event.service}
      data-level={event.level}
    >
      {/* Service colour stripe (drawn as a span — avoids raw CSS borders). */}
      <span
        aria-hidden="true"
        className="absolute left-0 top-0 h-full w-0.5"
        style={{ backgroundColor: SERVICE_COLOR[event.service] }}
      />
      <span className="text-ink/40 tabular-nums" aria-hidden="true">
        {formatTime(event.ts)}
      </span>
      <span
        className="w-16 shrink-0 truncate uppercase"
        style={{ color: SERVICE_COLOR[event.service] }}
      >
        {event.service}
      </span>
      <span className={`w-10 shrink-0 uppercase ${LEVEL_CLASS[event.level]}`}>
        {event.level}
      </span>
      <span className="flex-1 break-words text-ink">{event.msg}</span>
    </li>
  );
}
