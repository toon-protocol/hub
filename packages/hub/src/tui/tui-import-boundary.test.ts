import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPONENTS_DIR = resolve(__dirname, 'components');

// Allow-list per AC #7: components import only from react/ink/copy/format/types
// and sibling components. Anything else is a boundary violation.
const ALLOWED_IMPORT_RE =
  /^(react|ink(\/[\w-]+)?|\.\.\/(copy|format|types)\.js|\.\/[\w-]+\.js)$/;

// Match all import-source forms: static (import|from), dynamic (import('...')),
// across single/double/backtick quotes.
const IMPORT_RE =
  /(?:from|import)\s*[`'"]([^`'"]+)[`'"]|import\s*\(\s*[`'"]([^`'"]+)[`'"]\s*\)/g;

describe('TUI component import boundary (AC #7)', () => {
  it('component files import only from react/ink/copy/format/types/sibling components', () => {
    const componentFiles = readdirSync(COMPONENTS_DIR).filter((f) => {
      if (f.endsWith('.test.tsx') || f.endsWith('.test.ts')) return false;
      return f.endsWith('.tsx') || f.endsWith('.ts');
    });
    for (const file of componentFiles) {
      const source = readFileSync(join(COMPONENTS_DIR, file), 'utf-8');
      for (const match of source.matchAll(IMPORT_RE)) {
        const spec = match[1] ?? match[2] ?? '';
        expect(
          ALLOWED_IMPORT_RE.test(spec),
          `${file} imports from disallowed path '${spec}'`
        ).toBe(true);
      }
    }
  });
});
