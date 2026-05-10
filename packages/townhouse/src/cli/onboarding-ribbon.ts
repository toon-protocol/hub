/**
 * UX-DR4: Three-phase onboarding ribbon for `townhouse hs up` (Story 45.4).
 *
 * Phases: pull → bootstrap → live
 * TTY + unicode: in-place ANSI cursor-up + line-clear rewrite.
 * Fallback (non-TTY, NO_COLOR, CI, dumb terminal): plain lines + ASCII spinner.
 */

const PHASES = {
  pull: 'Pulling apex image…',
  bootstrap: 'Bootstrapping hidden service (this takes 30–90s)…',
} as const;

const SPINNER_FRAMES = ['|', '/', '-', '\\'];

function isTty(): boolean {
  return process.stdout.isTTY === true;
}

function supportsUnicode(): boolean {
  const term = process.env['TERM'] ?? '';
  if (term === 'dumb') return false;
  if (/xterm|screen|tmux/i.test(term)) return true;
  if (process.env['COLORTERM'] !== undefined) return true;
  return false;
}

function isAnimationDisabled(): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '')
    return true;
  if (process.env['CI'] === 'true') return true;
  return false;
}

function useAnsiRewrite(): boolean {
  return isTty() && supportsUnicode() && !isAnimationDisabled();
}

export type RibbonPhase = 'pull' | 'bootstrap' | 'live';

export class OnboardingRibbon {
  private currentPhase: RibbonPhase | null = null;
  private spinnerTimer: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private hasWrittenLine = false;

  start(phase: RibbonPhase, detail?: string): void {
    this._stopSpinner();

    if (phase === 'live') {
      const line = detail ? `Apex live at ${detail}` : 'Apex live.';
      this._writeLine(line);
      this.currentPhase = 'live';
      return;
    }

    const text = PHASES[phase];

    if (useAnsiRewrite() && this.hasWrittenLine) {
      // Move cursor up one line and clear it before writing the new phase.
      process.stdout.write('\x1b[1A\x1b[2K');
    }

    if (isAnimationDisabled() || !isTty()) {
      this._writeLine(text);
    } else {
      // Start a spinner for the bootstrap/pull phases.
      this._writeLine(`${text} ${SPINNER_FRAMES[0]}`);
      this.spinnerFrame = 1;
      this.spinnerTimer = setInterval(() => {
        const idx = this.spinnerFrame % SPINNER_FRAMES.length;
        const frame = SPINNER_FRAMES[idx] ?? '|';
        this.spinnerFrame++;
        if (useAnsiRewrite()) {
          process.stdout.write('\x1b[1A\x1b[2K');
          process.stdout.write(`${text} ${frame}\n`);
        } else {
          process.stdout.write(`${text} ${frame}\n`);
        }
      }, 100);
    }

    this.currentPhase = phase;
  }

  stop(): void {
    this._stopSpinner();
  }

  private _stopSpinner(): void {
    if (this.spinnerTimer !== null) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = null;
    }
  }

  private _writeLine(text: string): void {
    process.stdout.write(`${text}\n`);
    this.hasWrittenLine = true;
  }
}
