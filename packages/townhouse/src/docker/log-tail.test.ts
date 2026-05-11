/**
 * Unit tests for the structured log-line parser (Story D6).
 *
 * Covers four levels (info/warn/error/debug) across the supported wire
 * shapes (Pino JSON, bracketed text, free-form), plus the multiplexed
 * Docker stream framing strip and container-name → service mapping.
 */

import { describe, it, expect } from 'vitest';
import {
  parseLogLine,
  stripDockerFrame,
  serviceFromContainerName,
  LineSplitter,
} from './log-tail.js';

describe('parseLogLine', () => {
  it('parses Pino JSON info logs', () => {
    const line = JSON.stringify({
      level: 30,
      time: 1700000000000,
      msg: 'connector accepting BTP peer',
    });
    const evt = parseLogLine(line, 'connector');
    expect(evt).not.toBeNull();
    expect(evt!.level).toBe('info');
    expect(evt!.service).toBe('connector');
    expect(evt!.msg).toBe('connector accepting BTP peer');
    expect(evt!.ts).toBe(new Date(1700000000000).toISOString());
    expect(evt!.raw).toBe(line);
  });

  it('parses Pino JSON warn logs (numeric level 40)', () => {
    const line = JSON.stringify({ level: 40, msg: 'high memory pressure' });
    const evt = parseLogLine(line, 'mill');
    expect(evt!.level).toBe('warn');
    expect(evt!.service).toBe('mill');
    expect(evt!.msg).toBe('high memory pressure');
  });

  it('parses Pino JSON error logs (numeric level 50)', () => {
    const line = JSON.stringify({
      level: 50,
      time: '2026-04-01T12:00:00.000Z',
      msg: 'swap claim failed',
    });
    const evt = parseLogLine(line, 'mill');
    expect(evt!.level).toBe('error');
    expect(evt!.msg).toBe('swap claim failed');
    expect(evt!.ts).toBe('2026-04-01T12:00:00.000Z');
  });

  it('parses Pino JSON debug logs (numeric level 20)', () => {
    const line = JSON.stringify({ level: 20, msg: 'tx pool tick' });
    const evt = parseLogLine(line, 'dvm');
    expect(evt!.level).toBe('debug');
    expect(evt!.msg).toBe('tx pool tick');
  });

  it('parses bracketed [INFO] text', () => {
    const evt = parseLogLine('[INFO] relay accepted event', 'town');
    expect(evt!.level).toBe('info');
    expect(evt!.msg).toBe('relay accepted event');
    expect(evt!.service).toBe('town');
  });

  it('parses [WARN] text', () => {
    const evt = parseLogLine('[WARN] slow handler', 'town');
    expect(evt!.level).toBe('warn');
    expect(evt!.msg).toBe('slow handler');
  });

  it('parses ERROR: prefix', () => {
    const evt = parseLogLine('ERROR: db connection refused', 'town');
    expect(evt!.level).toBe('error');
    expect(evt!.msg).toBe('db connection refused');
  });

  it('parses DEBUG prefix without brackets', () => {
    const evt = parseLogLine('DEBUG ping handler invoked', 'dvm');
    expect(evt!.level).toBe('debug');
    expect(evt!.msg).toBe('ping handler invoked');
  });

  it('falls back to info for free-form lines', () => {
    const evt = parseLogLine('hello there', 'town');
    expect(evt!.level).toBe('info');
    expect(evt!.msg).toBe('hello there');
    expect(evt!.raw).toBe('hello there');
  });

  it('returns null for empty / whitespace lines', () => {
    expect(parseLogLine('', 'town')).toBeNull();
    expect(parseLogLine('   \r', 'town')).toBeNull();
  });

  it('handles malformed JSON gracefully (falls back to text)', () => {
    const evt = parseLogLine('{not really json', 'town');
    expect(evt).not.toBeNull();
    expect(evt!.level).toBe('info');
    expect(evt!.msg).toBe('{not really json');
  });

  it('handles Pino with string level field', () => {
    const line = JSON.stringify({ level: 'error', msg: 'boom' });
    const evt = parseLogLine(line, 'mill');
    expect(evt!.level).toBe('error');
    expect(evt!.msg).toBe('boom');
  });
});

describe('stripDockerFrame', () => {
  it('strips a single stdout frame', () => {
    const payload = Buffer.from('hello world\n', 'utf8');
    const header = Buffer.from([1, 0, 0, 0, 0, 0, 0, payload.length]);
    const framed = Buffer.concat([header, payload]);
    expect(stripDockerFrame(framed).toString('utf8')).toBe('hello world\n');
  });

  it('strips multiple consecutive frames (stdout + stderr)', () => {
    const a = Buffer.from('out1\n', 'utf8');
    const b = Buffer.from('err1\n', 'utf8');
    const ha = Buffer.from([1, 0, 0, 0, 0, 0, 0, a.length]);
    const hb = Buffer.from([2, 0, 0, 0, 0, 0, 0, b.length]);
    const framed = Buffer.concat([ha, a, hb, b]);
    expect(stripDockerFrame(framed).toString('utf8')).toBe('out1\nerr1\n');
  });

  it('passes raw bytes through when no header is present (TTY mode)', () => {
    const raw = Buffer.from('plain bytes\n', 'utf8');
    expect(stripDockerFrame(raw).toString('utf8')).toBe('plain bytes\n');
  });
});

describe('serviceFromContainerName', () => {
  it('maps single-instance container names', () => {
    expect(serviceFromContainerName('townhouse-town')).toBe('town');
    expect(serviceFromContainerName('townhouse-mill')).toBe('mill');
    expect(serviceFromContainerName('townhouse-dvm')).toBe('dvm');
    expect(serviceFromContainerName('townhouse-connector')).toBe('connector');
  });

  it('strips a leading slash that dockerode sometimes emits', () => {
    expect(serviceFromContainerName('/townhouse-town')).toBe('town');
  });

  it('maps preset multi-instance container names', () => {
    expect(serviceFromContainerName('townhouse-dev-town-01')).toBe('town');
    expect(serviceFromContainerName('townhouse-dev-mill-02')).toBe('mill');
    expect(serviceFromContainerName('townhouse-dev-dvm-01')).toBe('dvm');
  });

  it('returns null for non-townhouse containers', () => {
    expect(serviceFromContainerName('redis')).toBeNull();
    expect(serviceFromContainerName('townhouse-foo')).toBeNull();
  });
});

describe('LineSplitter', () => {
  it('emits complete lines and buffers the partial tail', () => {
    const s = new LineSplitter();
    const out1 = s.push(Buffer.from('hello\nworld', 'utf8'));
    expect(out1).toEqual(['hello']);
    const out2 = s.push(Buffer.from('!\nfoo\n', 'utf8'));
    expect(out2).toEqual(['world!', 'foo']);
    const flushed = s.flush();
    expect(flushed).toEqual([]);
  });

  it('flushes a trailing partial line with no newline', () => {
    const s = new LineSplitter();
    s.push(Buffer.from('partial', 'utf8'));
    expect(s.flush()).toEqual(['partial']);
  });

  it('strips Docker frame headers transparently', () => {
    const s = new LineSplitter();
    const payload = Buffer.from('framed line\n', 'utf8');
    const header = Buffer.from([1, 0, 0, 0, 0, 0, 0, payload.length]);
    const out = s.push(Buffer.concat([header, payload]));
    expect(out).toEqual(['framed line']);
  });
});
