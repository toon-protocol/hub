import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COPY } from './copy.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MARKDOWN_PATH = resolve(
  __dirname,
  '../../../../_bmad-output/design/empty-state-copy.md'
);

function getLeafStrings(
  obj: unknown,
  prefix = ''
): { key: string; value: string }[] {
  if (typeof obj === 'string') {
    return [{ key: prefix, value: obj }];
  }
  if (typeof obj === 'function') {
    return [];
  }
  if (Array.isArray(obj)) {
    return obj.flatMap((item, i) => getLeafStrings(item, `${prefix}[${i}]`));
  }
  if (typeof obj === 'object' && obj !== null) {
    return Object.entries(obj).flatMap(([k, v]) =>
      getLeafStrings(v, prefix ? `${prefix}.${k}` : k)
    );
  }
  return [];
}

describe('copy-sync: copy.ts ↔ empty-state-copy.md', () => {
  it('every leaf string in COPY appears in the empty-state-copy.md', () => {
    const markdown = readFileSync(MARKDOWN_PATH, 'utf-8');
    const leaves = getLeafStrings(COPY);

    for (const { key, value } of leaves) {
      expect(
        markdown.includes(value),
        `COPY.${key} = "${value}" not found in empty-state-copy.md`
      ).toBe(true);
    }
  });
});
