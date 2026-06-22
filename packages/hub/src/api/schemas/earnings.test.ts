/**
 * Schema validation tests for `earningsResponseSchema` (Story 47.4).
 *
 * Uses Ajv directly to validate/reject — Fastify's response schema is a
 * SERIALIZER (fast-json-stringify), not a validator, so these tests guard
 * against the silent-drop trap described in the route's Task 4.4 note.
 *
 * `strict: true` (default) catches typos in schema keywords; `ajv-formats`
 * registers `format: 'date-time'` so AC #1's ISO-8601 timestamp invariant
 * is actually enforced (rather than silently ignored).
 */

import { describe, it, expect } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { earningsResponseSchema } from './earnings.js';

const ajv = new Ajv();
addFormats(ajv);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const responseSchema = (earningsResponseSchema.response as any)[200];
const validate = ajv.compile(responseSchema);

const validFixture = {
  status: 'ok',
  apex: {
    routingFees: {
      USD: {
        lifetime: '1000000',
        today: '10000',
        month: '50000',
        year: '1000000',
      },
    },
  },
  peers: [
    {
      id: 'peer-town-01',
      type: 'town',
      byAsset: {
        USD: {
          lifetime: '500000',
          today: '5000',
          month: '25000',
          year: '500000',
        },
      },
      lastClaimAt: '2026-05-13T12:00:00.000Z',
    },
    {
      id: 'peer-unknown-99',
      type: 'external',
      byAsset: {
        ETH: {
          lifetime: '1000000000000000000',
          today: '0',
          month: '0',
          year: '0',
        },
      },
      lastClaimAt: null,
    },
  ],
  recentClaims: [
    {
      peerId: 'peer-town-01',
      assetCode: 'USD',
      assetScale: 6,
      amount: '100000',
      direction: 'inbound',
      at: '2026-05-13T12:00:00.000Z',
    },
  ],
  eventsRelayed: 42789,
  uptimeSeconds: 86400,
};

describe('earningsResponseSchema', () => {
  it('accepts a valid AggregatedEarnings fixture', () => {
    expect(validate(validFixture)).toBe(true);
  });

  it('rejects unknown top-level key (additionalProperties: false)', () => {
    const bad = { ...validFixture, unexpectedField: 'should be rejected' };
    expect(validate(bad)).toBe(false);
  });

  it('rejects missing required top-level field (recentClaims)', () => {
    const { recentClaims: _removed, ...bad } = validFixture;
    expect(validate(bad)).toBe(false);
  });

  it('rejects invalid peer.type value (not in enum)', () => {
    const bad = {
      ...validFixture,
      peers: [{ ...validFixture.peers[0], type: 'unknown-type' }],
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects invalid status value (not in enum)', () => {
    const bad = { ...validFixture, status: 'partially_ok' };
    expect(validate(bad)).toBe(false);
  });

  it('accepts connector_unavailable fixture with zeros', () => {
    const unavailable = {
      status: 'connector_unavailable',
      apex: { routingFees: {} },
      peers: [],
      recentClaims: [],
      eventsRelayed: 0,
      uptimeSeconds: 0,
    };
    expect(validate(unavailable)).toBe(true);
  });

  // AC #1 format enforcement — D4 resolution (2026-05-13).

  it('rejects non-decimal amount string (pattern enforcement)', () => {
    const bad = {
      ...validFixture,
      apex: {
        routingFees: {
          USD: {
            lifetime: '1.5e3',
            today: '10000',
            month: '50000',
            year: '1000000',
          },
        },
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects malformed ISO timestamp on recentClaim.at (format: date-time)', () => {
    const bad = {
      ...validFixture,
      recentClaims: [{ ...validFixture.recentClaims[0], at: '2026/05/13' }],
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects malformed ISO timestamp on peer.lastClaimAt', () => {
    const bad = {
      ...validFixture,
      peers: [{ ...validFixture.peers[0], lastClaimAt: 'not-a-date' }],
    };
    expect(validate(bad)).toBe(false);
  });

  it('accepts unknown field on recentClaim (D2 pass-through subobject)', () => {
    // The pass-through subobjects (recentClaim, perAsset) intentionally omit
    // `additionalProperties: false` so future connector fields flow through
    // without forcing a Hub schema bump.
    const withFutureField = {
      ...validFixture,
      recentClaims: [{ ...validFixture.recentClaims[0], txHash: '0xdeadbeef' }],
    };
    expect(validate(withFutureField)).toBe(true);
  });

  it('accepts unknown field on perAsset (D2 pass-through subobject)', () => {
    const withFutureField = {
      ...validFixture,
      apex: {
        routingFees: {
          USD: {
            lifetime: '1000000',
            today: '10000',
            month: '50000',
            year: '1000000',
            week: '5000', // future field
          },
        },
      },
    };
    expect(validate(withFutureField)).toBe(true);
  });

  it('still rejects unknown field on peer (Hub-owned shape stays closed)', () => {
    const bad = {
      ...validFixture,
      peers: [{ ...validFixture.peers[0], unexpectedPeerField: 'rejected' }],
    };
    expect(validate(bad)).toBe(false);
  });
});
