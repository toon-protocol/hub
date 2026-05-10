import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OnboardingRibbon } from './onboarding-ribbon.js';

describe('OnboardingRibbon', () => {
  let stdoutSpy: ReturnType<typeof vi.spyOn>;
  let originalTerm: string | undefined;
  let originalNoColor: string | undefined;
  let originalCI: string | undefined;
  let originalIsTTY: boolean | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    stdoutSpy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);
    originalTerm = process.env['TERM'];
    originalNoColor = process.env['NO_COLOR'];
    originalCI = process.env['CI'];
    originalIsTTY = process.stdout.isTTY;
  });

  afterEach(() => {
    vi.useRealTimers();
    stdoutSpy.mockRestore();
    if (originalTerm === undefined) delete process.env['TERM'];
    else process.env['TERM'] = originalTerm;
    if (originalNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = originalNoColor;
    if (originalCI === undefined) delete process.env['CI'];
    else process.env['CI'] = originalCI;
    // Restore isTTY
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
  });

  function setTty(tty: boolean): void {
    Object.defineProperty(process.stdout, 'isTTY', {
      value: tty,
      writable: true,
      configurable: true,
    });
  }

  describe('non-TTY fallback', () => {
    beforeEach(() => {
      setTty(false);
      process.env['TERM'] = 'dumb';
      delete process.env['NO_COLOR'];
    });

    it('emits a plain line for the pull phase', () => {
      const ribbon = new OnboardingRibbon();
      ribbon.start('pull');
      ribbon.stop();
      const output = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
      expect(output).toContain('Pulling apex image');
    });

    it('emits a plain line for the bootstrap phase', () => {
      const ribbon = new OnboardingRibbon();
      ribbon.start('bootstrap');
      ribbon.stop();
      const output = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
      expect(output).toContain('Bootstrapping hidden service');
    });

    it('emits the live line with detail', () => {
      const ribbon = new OnboardingRibbon();
      ribbon.start('live', 'abc123.anyone');
      ribbon.stop();
      const output = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
      expect(output).toContain('Apex live at abc123.anyone');
    });

    it('does NOT emit ANSI cursor-up escapes', () => {
      const ribbon = new OnboardingRibbon();
      ribbon.start('pull');
      ribbon.start('bootstrap');
      ribbon.stop();
      const output = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
      expect(output).not.toContain('\x1b[1A');
    });
  });

  describe('NO_COLOR disables animations', () => {
    beforeEach(() => {
      setTty(true);
      process.env['TERM'] = 'xterm-256color';
      process.env['NO_COLOR'] = '1';
    });

    it('does not start a spinner interval', () => {
      const ribbon = new OnboardingRibbon();
      ribbon.start('bootstrap');
      // Advance time — no spinner should fire
      vi.advanceTimersByTime(500);
      ribbon.stop();
      // Should only have the initial line, not repeated spinner frames
      const callCount = stdoutSpy.mock.calls.length;
      expect(callCount).toBe(1);
    });
  });

  describe('CI=true disables animations', () => {
    beforeEach(() => {
      setTty(true);
      process.env['TERM'] = 'xterm-256color';
      delete process.env['NO_COLOR'];
      process.env['CI'] = 'true';
    });

    it('emits plain lines without spinner', () => {
      const ribbon = new OnboardingRibbon();
      ribbon.start('pull');
      vi.advanceTimersByTime(500);
      ribbon.stop();
      expect(stdoutSpy.mock.calls.length).toBe(1);
    });
  });

  describe('stop() clears pending spinner interval', () => {
    beforeEach(() => {
      setTty(true);
      process.env['TERM'] = 'xterm-256color';
      delete process.env['NO_COLOR'];
      delete process.env['CI'];
    });

    it('no pending timers remain after stop()', () => {
      const ribbon = new OnboardingRibbon();
      ribbon.start('bootstrap');
      // Verify a spinner is ticking
      const callsBefore = stdoutSpy.mock.calls.length;
      vi.advanceTimersByTime(200);
      const callsDuring = stdoutSpy.mock.calls.length;
      // At least one spinner frame should have fired
      expect(callsDuring).toBeGreaterThan(callsBefore);

      ribbon.stop();
      const callsAfterStop = stdoutSpy.mock.calls.length;
      // Advance more time — no additional writes expected
      vi.advanceTimersByTime(500);
      expect(stdoutSpy.mock.calls.length).toBe(callsAfterStop);
    });
  });

  describe('TTY + unicode: ANSI rewrite mode', () => {
    beforeEach(() => {
      setTty(true);
      process.env['TERM'] = 'xterm-256color';
      delete process.env['NO_COLOR'];
      delete process.env['CI'];
    });

    it('emits ANSI cursor-up on second phase start after first', () => {
      const ribbon = new OnboardingRibbon();
      ribbon.start('pull');
      ribbon.start('bootstrap');
      ribbon.stop();
      const output = stdoutSpy.mock.calls.map((c) => c[0] as string).join('');
      // Second phase transition should emit cursor-up + line-clear
      expect(output).toContain('\x1b[1A\x1b[2K');
    });
  });
});
