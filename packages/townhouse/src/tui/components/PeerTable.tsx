import { Box, Text, useStdout } from 'ink';
import type { ReactElement } from 'react';
import type { AggregatedEarnings, NodeEarnings, PerAsset } from '../types.js';
import { formatUsdc, formatRelativeTime, USDC_FALLBACK } from '../format.js';
import { COPY } from '../copy.js';

const USDC_SCALE = 6;
const MAX_DATA_ROWS = 4;
const MIN_COL_WIDTH = 6;

interface AssetRow {
  peerId: string;
  type: string;
  assetCode: string;
  perAsset: PerAsset;
  lastClaimAt: string | null;
  isFirstRowOfPeer: boolean;
}

function flattenPeers(peers: NodeEarnings[]): AssetRow[] {
  const out: AssetRow[] = [];
  for (const peer of peers) {
    const assetCodes = Object.keys(peer.byAsset).sort();
    if (assetCodes.length === 0) continue;
    let isFirst = true;
    for (const assetCode of assetCodes) {
      const perAsset = peer.byAsset[assetCode];
      if (perAsset === undefined) continue;
      out.push({
        peerId: peer.id,
        type: peer.type,
        assetCode,
        perAsset,
        lastClaimAt: peer.lastClaimAt,
        isFirstRowOfPeer: isFirst,
      });
      isFirst = false;
    }
  }
  return out;
}

export interface PeerTableProps {
  peers: AggregatedEarnings['peers'];
  now?: Date;
  /** Override terminal column width. Defaults to useStdout(). Inject in tests to pin width. */
  columns?: number;
}

export function PeerTable({ peers, now = new Date(), columns: columnsProp }: PeerTableProps): ReactElement {
  const { stdout } = useStdout();
  // `??` only coalesces null/undefined — a detached/piped tty can ship `columns === 0`,
  // which would clamp every column to MIN_COL_WIDTH and garble the header. Fall back to 80.
  const columns = columnsProp ?? (stdout?.columns || 80);

  const rows = flattenPeers(peers).slice(0, MAX_DATA_ROWS);

  if (rows.length === 0) {
    return <Text dimColor>{COPY.peerTable.empty}</Text>;
  }

  const showLastClaim = columns >= 60;
  const shortType = columns < 70;
  const dropAgoSuffix = columns < 70;

  const totalCols = showLastClaim ? 5 : 4;
  const colWidth = Math.max(Math.floor(columns / totalCols), MIN_COL_WIDTH);

  const header = (
    <Box>
      <Box width={colWidth}><Text dimColor>PEER</Text></Box>
      <Box width={colWidth}><Text dimColor>TYPE</Text></Box>
      <Box width={colWidth}><Text dimColor>ASSET</Text></Box>
      <Box width={colWidth}><Text dimColor>NET (MONTH)</Text></Box>
      {showLastClaim ? <Box width={colWidth}><Text dimColor>LAST CLAIM</Text></Box> : null}
    </Box>
  );

  return (
    <Box flexDirection="column">
      {header}
      {rows.map((row, i) => {
        const peerCell = row.isFirstRowOfPeer ? row.peerId : '';
        const typeRaw = row.isFirstRowOfPeer ? row.type : '';
        const typeCell = shortType && typeRaw.length > 0 ? typeRaw.slice(0, 3) : typeRaw;
        let netFmt: string;
        try {
          netFmt = formatUsdc(row.perAsset.month, USDC_SCALE);
        } catch {
          netFmt = USDC_FALLBACK;
        }
        let lastClaim = formatRelativeTime(row.lastClaimAt, now);
        if (dropAgoSuffix && lastClaim.endsWith(' ago')) {
          lastClaim = lastClaim.slice(0, -' ago'.length);
        }
        return (
          <Box key={`${row.peerId}-${row.assetCode}-${i}`}>
            <Box width={colWidth}><Text>{peerCell}</Text></Box>
            <Box width={colWidth}><Text>{typeCell}</Text></Box>
            <Box width={colWidth}><Text>{row.assetCode}</Text></Box>
            <Box width={colWidth}><Text>{netFmt}</Text></Box>
            {showLastClaim ? <Box width={colWidth}><Text>{lastClaim}</Text></Box> : null}
          </Box>
        );
      })}
    </Box>
  );
}
