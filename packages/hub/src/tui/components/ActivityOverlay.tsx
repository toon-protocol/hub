import { Box, Text, useStdout, useInput } from 'ink';
import { useEffect, useState, type ReactElement } from 'react';
import type { RecentClaim } from '../types.js';
import { formatUsdcMicro } from '../format.js';
import { COPY } from '../copy.js';

const MIN_OVERLAY_WIDTH = 40;
const MAX_PEER_ID_WIDTH = 24;
// Default fallback only. App.tsx provides the authoritative cap (MAX_BUFFER_SIZE in
// the ring-buffer hook) via the `maxBufferSize` prop so there is one source of truth.
// Tests that mount the overlay directly fall back to this default.
const DEFAULT_MAX_BUFFER_SIZE = 200;

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

function truncatePeerId(id: string): string {
  if (id.length <= MAX_PEER_ID_WIDTH) return id;
  return id.slice(0, MAX_PEER_ID_WIDTH - 1) + '…';
}

function arrowFor(direction: RecentClaim['direction']): string {
  return direction === 'inbound' ? '←' : direction === 'outbound' ? '→' : COPY.activityOverlay.directionUnknown;
}

function directionLabel(direction: RecentClaim['direction']): string {
  return direction === 'inbound'
    ? COPY.activityOverlay.directionInbound
    : direction === 'outbound'
      ? COPY.activityOverlay.directionOutbound
      : COPY.activityOverlay.directionUnknown;
}

function formatRow(claim: RecentClaim): string {
  const time = formatTime(claim.at);
  const peer = truncatePeerId(claim.peerId);
  const arrow = arrowFor(claim.direction);
  const amount = formatUsdcMicro(claim.amount, claim.assetScale);
  const dir = directionLabel(claim.direction);
  return `${time} · ${peer} · ${arrow} ${amount} ${claim.assetCode} · ${dir}`;
}

function claimKeyForReact(c: RecentClaim): string {
  return `${c.peerId}|${c.at}|${c.amount}|${c.assetCode}|${c.direction}`;
}

export interface ActivityOverlayProps {
  claims: RecentClaim[];
  onClose: () => void;
  columns?: number;
  rows?: number;
  maxBufferSize?: number;
}

export function ActivityOverlay({
  claims,
  onClose,
  columns: columnsProp,
  rows: rowsProp,
  maxBufferSize = DEFAULT_MAX_BUFFER_SIZE,
}: ActivityOverlayProps): ReactElement {
  const { stdout } = useStdout();
  const columns = columnsProp ?? (stdout?.columns || 80);
  const rows = rowsProp ?? (stdout?.rows || 24);

  const modalWidth = Math.max(MIN_OVERLAY_WIDTH, Math.floor(columns * 0.7));
  const visibleRows = Math.max(5, rows - 5);

  const [scroll, setScroll] = useState(0);
  const maxScroll = Math.max(0, claims.length - visibleRows);

  // Reconcile scroll when maxScroll shrinks under it — terminal resize that grows
  // `visibleRows` (or any future shrink of `claims`) would otherwise leave the slice
  // pointing past the data, hiding the newest entries until the operator presses k.
  useEffect(() => {
    if (scroll > maxScroll) setScroll(maxScroll);
  }, [maxScroll, scroll]);

  useInput((input, key) => {
    // ESC must be checked BEFORE the ctrl/meta guard — Ink's input parser sets
    // `key.meta` on a bare `\x1b` byte (Alt-prefix detection), which would
    // otherwise eat the close action.
    if (key.escape) {
      onClose();
      return;
    }
    // Guard against Ctrl-* and Alt-* — they MUST NOT trigger close/scroll.
    if (key.ctrl || key.meta) return;
    if (input === 'q' || input === 'Q') {
      onClose();
      return;
    }
    if (input === 'j' || key.downArrow) {
      setScroll((s) => Math.min(maxScroll, s + 1));
      return;
    }
    if (input === 'k' || key.upArrow) {
      setScroll((s) => Math.max(0, s - 1));
    }
  });

  const displayedCount = Math.min(claims.length, maxBufferSize);
  const title = `${COPY.activityOverlay.titlePrefix}${displayedCount} of ${maxBufferSize}`;
  const window = claims.slice(scroll, scroll + visibleRows);
  const hint = claims.length === 0 ? COPY.activityOverlay.scrollHintEmpty : COPY.activityOverlay.scrollHint;

  return (
    <Box flexDirection="column" alignItems="center" width={columns}>
      <Box flexDirection="column" borderStyle="round" width={modalWidth} paddingX={1}>
        <Text bold>{title}</Text>
        {claims.length === 0 ? (
          <Text dimColor>{COPY.activityOverlay.emptyHint}</Text>
        ) : (
          window.map((c, i) => (
            <Text key={`${claimKeyForReact(c)}-${scroll + i}`}>{formatRow(c)}</Text>
          ))
        )}
        <Text dimColor>{hint}</Text>
      </Box>
    </Box>
  );
}
