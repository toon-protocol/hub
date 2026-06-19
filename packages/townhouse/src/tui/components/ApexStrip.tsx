import { Text } from 'ink';
import type { ReactElement } from 'react';
import type { AggregatedEarnings } from '../types.js';
import { formatUsdc, USDC_FALLBACK } from '../format.js';
import { COPY } from '../copy.js';

const USDC_SCALE = 6;
const ASSET = 'USDC';
const DECIMAL_RE = /^-?\d+$/;

function addDecimalStrings(a: string, b: string): string {
  // Defensive: malformed peer amounts must not crash the render tree.
  if (!DECIMAL_RE.test(b)) return a;
  try {
    return (BigInt(a) + BigInt(b)).toString();
  } catch {
    return a;
  }
}

export interface ApexStripProps {
  apex: AggregatedEarnings['apex'];
  peers: AggregatedEarnings['peers'];
}

export function ApexStrip({ apex, peers }: ApexStripProps): ReactElement {
  const apexMonth = apex.routingFees[ASSET]?.month ?? '0';
  const apexValid = DECIMAL_RE.test(apexMonth);
  const apexMonthBig = apexValid ? BigInt(apexMonth) : 0n;

  let totalMonth = apexMonthBig;
  for (const peer of peers) {
    const peerMonth = peer.byAsset[ASSET]?.month ?? '0';
    totalMonth = BigInt(addDecimalStrings(totalMonth.toString(), peerMonth));
  }

  let apexFmt: string;
  try {
    apexFmt = formatUsdc(apexMonth, USDC_SCALE);
  } catch {
    apexFmt = USDC_FALLBACK;
  }
  const hasMillPeer = peers.some((p) => p.type === 'mill');

  // Malformed apex.month: render the formatUsdc fallback alone — adding the Mill upsell
  // would mix a wire-anomaly signal with a "you have no Mill" signal.
  if (!apexValid) {
    return (
      <Text dimColor italic>
        {COPY.apex.routingPrefix}{apexFmt}
      </Text>
    );
  }

  if (apexMonthBig === 0n) {
    const upsell = hasMillPeer ? '' : ` ${COPY.apex.routingEmpty}`;
    return (
      <Text dimColor italic>
        {COPY.apex.routingPrefix}{apexFmt}{upsell}
      </Text>
    );
  }

  // Defensive: negative apex (refund/chargeback, wire-legal per `^-?\d+$`) can let peers
  // exactly cancel apex; totalMonth === 0n would throw on BigInt division. Omit instead.
  const pct = totalMonth === 0n ? null : Number((apexMonthBig * 100n) / totalMonth);
  return (
    <Text>
      {COPY.apex.routingPrefix}{apexFmt}{pct !== null ? ` (${pct}%)` : ''}
    </Text>
  );
}
