import { Box, Text, useStdout } from 'ink';
import type { ReactElement } from 'react';
import type { AggregatedEarnings } from '../types.js';
import { formatUsdc, USDC_FALLBACK } from '../format.js';
import { Sparkline } from './Sparkline.js';
import { Qualifier } from './Qualifier.js';

const USDC_SCALE = 6;
const ASSET = 'USDC';
const DECIMAL_RE = /^-?\d+$/;
const MIN_COL_WIDTH = 8;

function addDecimalStrings(a: string, b: string): string {
  // Defensive: malformed peer/apex amounts must not crash the render tree.
  // `formatUsdc` will degrade to '$?.??' on a non-decimal accumulator.
  if (!DECIMAL_RE.test(b)) return a;
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return a;
  }
}

interface HeroBandProps {
  apex: AggregatedEarnings['apex'];
  peers: AggregatedEarnings['peers'];
  eventsRelayed: number;
}

interface Scalars {
  today: string;
  month: string;
  year: string;
  lifetime: string;
}

function computeScalars(
  apex: AggregatedEarnings['apex'],
  peers: AggregatedEarnings['peers']
): Scalars {
  let today = '0';
  let month = '0';
  let year = '0';
  let lifetime = '0';

  const apexUsdc = apex.routingFees[ASSET];
  if (apexUsdc !== undefined) {
    today = addDecimalStrings(today, apexUsdc.today);
    month = addDecimalStrings(month, apexUsdc.month);
    year = addDecimalStrings(year, apexUsdc.year);
    lifetime = addDecimalStrings(lifetime, apexUsdc.lifetime);
  }

  for (const peer of peers) {
    const peerUsdc = peer.byAsset[ASSET];
    if (peerUsdc !== undefined) {
      today = addDecimalStrings(today, peerUsdc.today);
      month = addDecimalStrings(month, peerUsdc.month);
      year = addDecimalStrings(year, peerUsdc.year);
      lifetime = addDecimalStrings(lifetime, peerUsdc.lifetime);
    }
  }

  return { today, month, year, lifetime };
}

function isEmptyState(
  apex: AggregatedEarnings['apex'],
  peers: AggregatedEarnings['peers']
): boolean {
  const apexMonth = apex.routingFees[ASSET]?.month ?? '0';
  if (apexMonth !== '0') return false;
  for (const peer of peers) {
    const peerMonth = peer.byAsset[ASSET]?.month ?? '0';
    if (peerMonth !== '0') return false;
  }
  return true;
}

export function HeroBand({ apex, peers, eventsRelayed }: HeroBandProps): ReactElement {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  const scalars = computeScalars(apex, peers);
  const showQualifier = isEmptyState(apex, peers);

  // computeScalars always produces valid decimal strings (BigInt arithmetic, starting at zero),
  // but guard defensively for forward-compatibility.
  let todayFmt: string;
  let monthFmt: string;
  let yearFmt: string;
  let lifetimeFmt: string;
  try {
    todayFmt = formatUsdc(scalars.today, USDC_SCALE);
    monthFmt = formatUsdc(scalars.month, USDC_SCALE);
    yearFmt = formatUsdc(scalars.year, USDC_SCALE);
    lifetimeFmt = formatUsdc(scalars.lifetime, USDC_SCALE);
  } catch {
    todayFmt = USDC_FALLBACK;
    monthFmt = USDC_FALLBACK;
    yearFmt = USDC_FALLBACK;
    lifetimeFmt = USDC_FALLBACK;
  }

  const shortLabels = columns < 70;
  const labelLifetime = shortLabels ? 'LIFE' : 'LIFETIME';

  // Clamp: at very narrow widths (<32ch) Ink would collapse <Box width={0}>
  // and truncate scalar values into garbage. Floor to a usable per-column width.
  const colWidth = Math.max(Math.floor(columns / 4), MIN_COL_WIDTH);

  return (
    <Box flexDirection="column">
      <Box>
        <Box width={colWidth}><Text dimColor>TODAY</Text></Box>
        <Box width={colWidth}><Text dimColor>MONTH</Text></Box>
        <Box width={colWidth}><Text dimColor>YEAR</Text></Box>
        <Box width={colWidth}><Text dimColor>{labelLifetime}</Text></Box>
      </Box>
      <Box>
        <Box width={colWidth}>
          <Text color={scalars.today !== '0' ? 'green' : undefined}>{todayFmt}</Text>
        </Box>
        <Box width={colWidth}>
          <Text color={scalars.month !== '0' ? 'green' : undefined}>{monthFmt}</Text>
        </Box>
        <Box width={colWidth}>
          <Text color={scalars.year !== '0' ? 'green' : undefined}>{yearFmt}</Text>
        </Box>
        <Box width={colWidth}>
          <Text color={scalars.lifetime !== '0' ? 'green' : undefined}>{lifetimeFmt}</Text>
        </Box>
      </Box>
      <Sparkline values={[]} width={columns} />
      {showQualifier ? <Qualifier eventsRelayed={eventsRelayed} /> : null}
    </Box>
  );
}
