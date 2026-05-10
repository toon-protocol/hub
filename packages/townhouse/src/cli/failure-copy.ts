/**
 * Sally's failure-state copy library — apex-side error classes (UX-DR5 partial, Story 45.4).
 * Covers: anon-timeout, anon-disabled, image-pull-failure, port-collision,
 * missing-docker-sock, and generic fallback.
 */

import { OrchestratorError } from '../docker/orchestrator.js';

interface FailureCopyEntry {
  headline: string;
  explanation: string;
  nextStep: string;
}

const FAILURE_COPY: Readonly<Record<string, FailureCopyEntry>> = {
  'anon-timeout': {
    headline: "Hidden service didn't publish in time.",
    explanation:
      'The .anyone descriptor did not publish within the allotted time.',
    nextStep: 'Re-run with DEBUG=townhouse:* for verbose anon logs.',
  },
  'anon-disabled': {
    headline: 'Connector is anon-disabled.',
    explanation: 'The connector config has anon.enabled: false.',
    nextStep: 'Edit ~/.townhouse/connector.yaml and set anon.enabled: true.',
  },
  'image-pull-failure': {
    headline: 'Image pull failed.',
    explanation: 'Docker could not pull the required townhouse images.',
    nextStep: 'Check your network and try again.',
  },
  'port-collision': {
    headline: 'Port already in use.',
    explanation: 'A required host port is already bound by another process.',
    nextStep:
      'Stop the conflicting service or override the port via --connector-admin-port.',
  },
  'missing-docker-sock': {
    headline: 'Docker daemon unreachable.',
    explanation:
      'The Docker socket is not accessible or Docker is not running.',
    nextStep: 'Start Docker and re-run `townhouse hs up`.',
  },
  generic: {
    headline: 'Apex boot failed.',
    explanation: '',
    nextStep: 'Run with DEBUG=townhouse:* for verbose logs.',
  },
};

function supportsUnicode(): boolean {
  const term = process.env['TERM'] ?? '';
  if (term === 'dumb') return false;
  if (/xterm|screen|tmux/i.test(term)) return true;
  if (process.env['COLORTERM'] !== undefined) return true;
  return false;
}

function useAscii(): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '')
    return true;
  return !supportsUnicode();
}

type ErrorClass =
  | 'anon-timeout'
  | 'anon-disabled'
  | 'image-pull-failure'
  | 'port-collision'
  | 'missing-docker-sock'
  | 'generic';

function classify(error: unknown): { key: ErrorClass; explanation: string } {
  const msg = error instanceof Error ? error.message : String(error);
  const isOrchError = error instanceof OrchestratorError;
  const stderr = isOrchError ? (error.stderr ?? '') : '';

  // Anon timeout: orchestrator exhausted the 120s polling budget.
  if (msg.includes('HS hostname publication timeout')) {
    return { key: 'anon-timeout', explanation: msg };
  }

  // Anon disabled: the orchestrator caught a 503 early-exit during polling
  // (OrchestratorError wrapping the anon-disabled signal) → treat as anon-timeout
  // so the operator gets actionable next steps (verbose logs to diagnose).
  if (isOrchError && msg.includes('anon-disabled')) {
    return { key: 'anon-timeout', explanation: msg };
  }

  // Anon disabled: direct 503 from the idempotency probe (plain Error, not OrchestratorError).
  if (!isOrchError && msg.includes('anon-disabled')) {
    return { key: 'anon-disabled', explanation: msg };
  }

  // Image pull failure: Docker couldn't fetch the image.
  if (
    stderr.includes('failed to pull') ||
    stderr.includes('pull access denied') ||
    msg.includes('failed to pull') ||
    msg.includes('pull access denied')
  ) {
    return { key: 'image-pull-failure', explanation: msg };
  }

  // Port collision: a required port is already in use.
  if (
    stderr.includes('address already in use') ||
    stderr.includes('port is already allocated') ||
    msg.includes('address already in use') ||
    msg.includes('port is already allocated')
  ) {
    return { key: 'port-collision', explanation: msg };
  }

  // Missing Docker: daemon not running or docker CLI not found.
  if (
    stderr.includes('Cannot connect to the Docker daemon') ||
    msg.includes('Cannot connect to the Docker daemon') ||
    msg.includes('docker CLI not found on PATH')
  ) {
    return { key: 'missing-docker-sock', explanation: msg };
  }

  return { key: 'generic', explanation: msg };
}

/**
 * Classify `error` and write Sally's three-line failure copy to stderr.
 * Returns `{ exitCode: 1 }` for the caller to propagate via `process.exitCode`.
 */
export function renderFailure(error: unknown): { exitCode: number } {
  const ascii = useAscii();
  const { key, explanation } = classify(error);

  const entry = FAILURE_COPY[key];
  if (!entry) {
    const xMark = ascii ? '[X]' : '✕';
    const arrow = ascii ? '->' : '→';
    process.stderr.write(`${xMark} Apex boot failed.\n`);
    process.stderr.write(`  ${explanation}\n`);
    process.stderr.write(
      `  ${arrow} Run with DEBUG=townhouse:* for verbose logs.\n`
    );
    return { exitCode: 1 };
  }

  const xMark = ascii ? '[X]' : '✕';
  const arrow = ascii ? '->' : '→';

  const explanationText = key === 'generic' ? explanation : entry.explanation;

  process.stderr.write(`${xMark} ${entry.headline}\n`);
  process.stderr.write(`  ${explanationText}\n`);
  process.stderr.write(`  ${arrow} ${entry.nextStep}\n`);

  return { exitCode: 1 };
}
