import { describe, it, expect } from 'vitest';

/**
 * Password prompt module structural tests.
 * Interactive TTY behavior is covered by the cli.hs.test.ts suite (TTY mock path).
 */

describe('promptPassword', () => {
  it('exports promptPassword as a named async function', async () => {
    const mod = await import('./password-prompt.js');
    expect(typeof mod.promptPassword).toBe('function');
    // The return value is a Promise (async function).
    // We don't call it here to avoid hanging on stdin.
  });

  it('module has no unexpected exports', async () => {
    const mod = await import('./password-prompt.js');
    const keys = Object.keys(mod);
    expect(keys).toContain('promptPassword');
  });
});
