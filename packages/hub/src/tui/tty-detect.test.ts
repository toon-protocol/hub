import { describe, it, expect, afterEach } from 'vitest';
import { shouldRenderInk, isTmux } from './tty-detect.js';

describe('shouldRenderInk', () => {
  const origIsTTY = process.stdout.isTTY;
  const origCI = process.env['CI'];
  const origNO_TUI = process.env['NO_TUI'];
  const origTERM = process.env['TERM'];

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: origIsTTY,
      writable: true,
    });
    if (origCI === undefined) {
      delete process.env['CI'];
    } else {
      process.env['CI'] = origCI;
    }
    if (origNO_TUI === undefined) {
      delete process.env['NO_TUI'];
    } else {
      process.env['NO_TUI'] = origNO_TUI;
    }
    if (origTERM === undefined) {
      delete process.env['TERM'];
    } else {
      process.env['TERM'] = origTERM;
    }
  });

  it('returns true when TTY is set and no disabling env vars', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
    });
    delete process.env['CI'];
    delete process.env['NO_TUI'];
    process.env['TERM'] = 'xterm-256color';
    expect(shouldRenderInk()).toBe(true);
  });

  it('returns false when not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      writable: true,
    });
    expect(shouldRenderInk()).toBe(false);
  });

  it('returns false when CI=true', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
    });
    process.env['CI'] = 'true';
    expect(shouldRenderInk()).toBe(false);
  });

  it('returns false when TERM=dumb', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
    });
    delete process.env['CI'];
    process.env['TERM'] = 'dumb';
    expect(shouldRenderInk()).toBe(false);
  });

  it('returns false when NO_TUI=1', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
    });
    delete process.env['CI'];
    process.env['NO_TUI'] = '1';
    process.env['TERM'] = 'xterm-256color';
    expect(shouldRenderInk()).toBe(false);
  });

  it('returns false when NO_TUI=true (broadened truthy match)', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
    });
    delete process.env['CI'];
    process.env['NO_TUI'] = 'true';
    process.env['TERM'] = 'xterm-256color';
    expect(shouldRenderInk()).toBe(false);
  });

  it('returns true when NO_TUI=0 (explicitly disabled)', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
    });
    delete process.env['CI'];
    process.env['NO_TUI'] = '0';
    process.env['TERM'] = 'xterm-256color';
    expect(shouldRenderInk()).toBe(true);
  });

  it('returns true when NO_TUI is empty string', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      writable: true,
    });
    delete process.env['CI'];
    process.env['NO_TUI'] = '';
    process.env['TERM'] = 'xterm-256color';
    expect(shouldRenderInk()).toBe(true);
  });
});

describe('isTmux', () => {
  const origTMUX = process.env['TMUX'];
  const origTERM = process.env['TERM'];

  afterEach(() => {
    if (origTMUX === undefined) {
      delete process.env['TMUX'];
    } else {
      process.env['TMUX'] = origTMUX;
    }
    if (origTERM === undefined) {
      delete process.env['TERM'];
    } else {
      process.env['TERM'] = origTERM;
    }
  });

  it('returns true when TMUX is set', () => {
    process.env['TMUX'] = '/tmp/tmux-1000/default,12345,0';
    delete process.env['TERM'];
    expect(isTmux()).toBe(true);
  });

  it('returns true when TERM starts with screen', () => {
    delete process.env['TMUX'];
    process.env['TERM'] = 'screen-256color';
    expect(isTmux()).toBe(true);
  });
});
