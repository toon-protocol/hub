/**
 * Unit tests for PullNarrator (Epic 49 Followup D).
 *
 * Pure stateful module — no I/O — so we drive it with a fake clock and
 * sequences of events, asserting the dedupe + throttle contract.
 */

import { describe, it, expect } from 'vitest';
import { PullNarrator, type PullProgressEvent } from './pull-narrator.js';

function ev(
  image: string,
  status: string,
  extra: { id?: string; progress?: string } = {}
): PullProgressEvent {
  return {
    image,
    status,
    ...(extra.id !== undefined ? { id: extra.id } : {}),
    ...(extra.progress !== undefined ? { progress: extra.progress } : {}),
  };
}

describe('PullNarrator', () => {
  it('formats a transition event verbatim (with optional progress suffix)', () => {
    const n = new PullNarrator();
    expect(n.format(ev('toon/connector', 'Pulling fs layer'))).toBe(
      '  [pull] toon/connector: Pulling fs layer'
    );
    expect(
      n.format(
        ev('toon/connector', 'Downloading', {
          progress: '[===>      ] 24.5 MB / 89.3 MB',
        })
      )
    ).toBe(
      '  [pull] toon/connector: Downloading [===>      ] 24.5 MB / 89.3 MB'
    );
  });

  it('drops events with empty status', () => {
    const n = new PullNarrator();
    expect(n.format(ev('toon/connector', ''))).toBeNull();
  });

  it('always prints status TRANSITIONS regardless of throttle', () => {
    let t = 0;
    const n = new PullNarrator({ now: () => t });
    // Same image, three different statuses in rapid succession — all printed.
    expect(n.format(ev('img', 'Pulling fs layer'))).not.toBeNull();
    t += 10;
    expect(n.format(ev('img', 'Downloading'))).not.toBeNull();
    t += 10;
    expect(n.format(ev('img', 'Extracting'))).not.toBeNull();
    t += 10;
    expect(n.format(ev('img', 'Pull complete'))).not.toBeNull();
  });

  it('throttles repeated Downloading events to 1Hz per image', () => {
    let t = 0;
    const n = new PullNarrator({ now: () => t, throttleMs: 1000 });

    // First Downloading event is a transition from Pulling → Downloading;
    // always printed.
    expect(n.format(ev('img', 'Pulling fs layer'))).not.toBeNull();
    expect(
      n.format(ev('img', 'Downloading', { progress: '1MB' }))
    ).not.toBeNull();

    // Subsequent Downloading events within the throttle window are dropped.
    t += 100;
    expect(n.format(ev('img', 'Downloading', { progress: '2MB' }))).toBeNull();
    t += 500;
    expect(n.format(ev('img', 'Downloading', { progress: '3MB' }))).toBeNull();
    t += 399;
    expect(n.format(ev('img', 'Downloading', { progress: '4MB' }))).toBeNull();

    // Crossing the 1 s boundary releases the next one.
    t += 1; // now elapsed === 1000
    expect(
      n.format(ev('img', 'Downloading', { progress: '5MB' }))
    ).not.toBeNull();
  });

  it('throttles Extracting independently per image', () => {
    let t = 0;
    const n = new PullNarrator({ now: () => t, throttleMs: 1000 });

    // image-a first Extracting at t=0 (transition from undefined → Extracting).
    expect(
      n.format(ev('image-a', 'Extracting', { progress: 'a1' }))
    ).not.toBeNull();
    // image-b first Extracting at t=500 — a different image, also printed.
    t = 500;
    expect(
      n.format(ev('image-b', 'Extracting', { progress: 'b1' }))
    ).not.toBeNull();

    // At t=999, both images are inside their own throttle windows
    // (a: 999 ms elapsed since t=0; b: 499 ms elapsed since t=500). Both
    // repeated Extracting events should be suppressed.
    t = 999;
    expect(
      n.format(ev('image-a', 'Extracting', { progress: 'a2' }))
    ).toBeNull();
    expect(
      n.format(ev('image-b', 'Extracting', { progress: 'b2' }))
    ).toBeNull();

    // At t=1000 image-a's window has closed but image-b's hasn't (it's at
    // 500 ms). Each image's throttle is independent.
    t = 1000;
    expect(
      n.format(ev('image-a', 'Extracting', { progress: 'a3' }))
    ).not.toBeNull();
    expect(
      n.format(ev('image-b', 'Extracting', { progress: 'b3' }))
    ).toBeNull();
  });

  it('reset() clears per-image state so transitions re-fire from scratch', () => {
    let t = 0;
    const n = new PullNarrator({ now: () => t });
    n.format(ev('img', 'Downloading'));
    t += 100;
    expect(n.format(ev('img', 'Downloading'))).toBeNull(); // throttled
    n.reset();
    // After reset, Downloading is once again a transition (no prior status).
    expect(n.format(ev('img', 'Downloading'))).not.toBeNull();
  });

  it('passes through final status (Pull complete) verbatim', () => {
    const n = new PullNarrator();
    n.format(ev('img', 'Downloading'));
    expect(n.format(ev('img', 'Pull complete'))).toBe(
      '  [pull] img: Pull complete'
    );
  });

  it('passes through "Already exists" so cached layers narrate too', () => {
    const n = new PullNarrator();
    expect(n.format(ev('img', 'Already exists', { id: 'abc' }))).toBe(
      '  [pull] img: Already exists'
    );
  });
});
