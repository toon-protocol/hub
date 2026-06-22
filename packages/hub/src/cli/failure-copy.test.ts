import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderFailure } from './failure-copy.js';
import { OrchestratorError } from '../docker/orchestrator.js';

describe('renderFailure', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let originalNoColor: string | undefined;
  let originalTerm: string | undefined;
  let originalColorterm: string | undefined;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    originalNoColor = process.env['NO_COLOR'];
    originalTerm = process.env['TERM'];
    originalColorterm = process.env['COLORTERM'];
    // Default: unicode-capable terminal so we get proper symbols
    delete process.env['NO_COLOR'];
    process.env['TERM'] = 'xterm-256color';
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    if (originalNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = originalNoColor;
    if (originalTerm === undefined) delete process.env['TERM'];
    else process.env['TERM'] = originalTerm;
    if (originalColorterm === undefined) delete process.env['COLORTERM'];
    else process.env['COLORTERM'] = originalColorterm;
  });

  it('returns exitCode 1 for all error classes', () => {
    const result = renderFailure(new Error('some random error'));
    expect(result.exitCode).toBe(1);
  });

  it('anon-timeout: OrchestratorError with HS hostname publication timeout', () => {
    const err = new OrchestratorError(
      'HS hostname publication timeout after 120000ms (no response)'
    );
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain("Hidden service didn't publish in time.");
    expect(written).toContain(
      'Re-run with DEBUG=hub:* for verbose anon logs.'
    );
  });

  it('anon-timeout: OrchestratorError with anon-disabled message (orchestrator wrapped 503)', () => {
    const err = new OrchestratorError(
      'connector is anon-disabled — set anon.enabled: true in the connector config'
    );
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    // OrchestratorError + anon-disabled → anon-timeout class (AC #16)
    expect(written).toContain("Hidden service didn't publish in time.");
  });

  it('anon-disabled: plain Error with anon-disabled (HTTP 503) — from idempotency probe', () => {
    const err = new Error('connector is anon-disabled (HTTP 503)');
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Connector is anon-disabled.');
    expect(written).toContain(
      'Edit ~/.hub/connector.yaml and set anon.enabled: true.'
    );
  });

  it('image-pull-failure: OrchestratorError with stderr containing "failed to pull"', () => {
    const err = new OrchestratorError(
      'docker compose up failed (exit 1): failed to pull image',
      {
        stderr: 'failed to pull ghcr.io/toon-protocol/connector: not found',
      }
    );
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Image pull failed.');
    expect(written).toContain('Check your network and try again.');
  });

  it('image-pull-failure: OrchestratorError with stderr containing "pull access denied"', () => {
    const err = new OrchestratorError('docker compose up failed', {
      stderr: 'pull access denied for private/image',
    });
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Image pull failed.');
  });

  it('port-collision: OrchestratorError with stderr "address already in use"', () => {
    const err = new OrchestratorError('docker compose up failed', {
      stderr:
        'Bind for 0.0.0.0:9401 failed: port is already allocated\naddress already in use',
    });
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Port already in use.');
    expect(written).toContain('Stop the conflicting service');
  });

  it('port-collision: OrchestratorError with stderr "port is already allocated"', () => {
    const err = new OrchestratorError('docker compose up failed', {
      stderr: 'Bind for 127.0.0.1:9401 failed: port is already allocated',
    });
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Port already in use.');
  });

  it('missing-docker-sock: stderr "Cannot connect to the Docker daemon"', () => {
    const err = new OrchestratorError('docker compose up failed', {
      stderr:
        'Cannot connect to the Docker daemon at unix:///var/run/docker.sock',
    });
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Docker daemon unreachable.');
    expect(written).toContain('Start Docker and re-run');
  });

  it('missing-docker-sock: message "docker CLI not found on PATH"', () => {
    const err = new OrchestratorError(
      'docker CLI not found on PATH (ENOENT): docker: command not found'
    );
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Docker daemon unreachable.');
  });

  it('generic: unknown error falls through', () => {
    const err = new Error('something totally unexpected happened');
    const result = renderFailure(err);
    expect(result.exitCode).toBe(1);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('Apex boot failed.');
    expect(written).toContain('something totally unexpected happened');
    expect(written).toContain('Run with DEBUG=hub:*');
  });

  it('ASCII fallback when NO_COLOR is set', () => {
    process.env['NO_COLOR'] = '1';
    const err = new OrchestratorError(
      'HS hostname publication timeout after 120000ms'
    );
    renderFailure(err);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('[X]');
    expect(written).toContain('->');
    expect(written).not.toContain('✕');
    expect(written).not.toContain('→');
  });

  it('uses unicode symbols when NO_COLOR is not set', () => {
    const err = new OrchestratorError(
      'HS hostname publication timeout after 120000ms'
    );
    renderFailure(err);
    const written = stderrSpy.mock.calls.map((c) => c[0]).join('');
    expect(written).toContain('✕');
    expect(written).toContain('→');
  });

  it('three lines rendered: headline, explanation, nextStep', () => {
    const err = new OrchestratorError(
      'HS hostname publication timeout after 120000ms'
    );
    renderFailure(err);
    expect(stderrSpy.mock.calls.length).toBe(3);
  });
});
