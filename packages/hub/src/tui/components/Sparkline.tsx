import { Text } from 'ink';
import type { ReactElement } from 'react';

const BLOCKS = '▁▂▃▄▅▆▇█';
const PLACEHOLDER = '·······';

interface SparklineProps {
  values: number[];
  width: number;
}

export function Sparkline({ values, width }: SparklineProps): ReactElement | null {
  // Collapse the row entirely at <60ch — return null so the layout doesn't
  // reserve a blank row (wireframe degrade ladder: sparkline drops first).
  if (width < 60) {
    return null;
  }

  if (values.length === 0) {
    return <Text>{PLACEHOLDER}  7d</Text>;
  }

  // Filter NaN / Infinity / negative values; treat negatives as 0 floor.
  const safe = values
    .filter((v) => Number.isFinite(v))
    .map((v) => (v < 0 ? 0 : v));

  if (safe.length === 0) {
    return <Text>{PLACEHOLDER}  7d</Text>;
  }

  // Use reduce to avoid Math.max(...arr) stack overflow on large arrays.
  const max = safe.reduce((m, v) => (v > m ? v : m), 0);
  const chars = safe
    .map((v) => {
      if (max === 0) return BLOCKS[0] ?? '▁';
      const idx = Math.floor((v / max) * (BLOCKS.length - 1));
      return BLOCKS[idx] ?? '▁';
    })
    .join('');

  return <Text>{chars}  7d</Text>;
}
