/**
 * Story 49.3 schema-contract DoD — ajv-validates the request + response
 * shapes the persistent Akash foreign-TOON-client pod emits against the
 * canonical schema at packages/townhouse/contracts/foreign-publish.schema.json.
 *
 * Schema drift between the deployed pod's wire shape and the schema file =
 * build break (this test fails in the normal unit suite — runs without
 * Docker and without a live pod). Mirrors faucet-contract.test.ts.
 *
 * The pod entrypoint at docker/src/entrypoint-foreign-pod.ts imports the
 * SAME schema file via JSON import — producer and consumer both ajv-validate
 * against one source of truth.
 */

import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../contracts/foreign-publish.schema.json'
);

function loadSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as Record<
    string,
    unknown
  >;
}

function makeAjvWithSchema(): {
  ajv: Ajv;
  schema: Record<string, unknown>;
} {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const schema = loadSchema();
  ajv.addSchema(schema, 'foreign-publish');
  return { ajv, schema };
}

function getValidator(name: string): ReturnType<Ajv['getSchema']> {
  const { ajv } = makeAjvWithSchema();
  const v = ajv.getSchema(`foreign-publish#/definitions/${name}`);
  if (!v) throw new Error(`definition not found: ${name}`);
  return v;
}

// Real-shape Nostr event fixture — kind:1 with a Schnorr-shaped sig.
// Values are syntactically valid hex but NOT cryptographically signed —
// the schema validates SHAPE only, not crypto.
const FIXTURE_EVENT = {
  id: 'a'.repeat(64),
  pubkey: 'b'.repeat(64),
  created_at: 1700000000,
  kind: 1,
  tags: [['t', '49.3-smoke']],
  content: 'hello world',
  sig: 'c'.repeat(128),
};

// Capture a real-world v3-shaped hostname from 49.1's smoke output. Used to
// assert the regex accepts real production strings rather than only synthetic ones.
const REAL_HOSTNAME =
  'jhxqkj7kmd2dybsoubtjwcjmuk75xbjvfppc4f6gjcw5sl3byo7lhmid.anyone';

describe('foreign-publish.schema.json — schema-contract DoD (story 49.3 Task 6)', () => {
  it('loads as valid JSON Schema (whole document addSchema succeeds)', () => {
    expect(() => makeAjvWithSchema()).not.toThrow();
  });

  it('every named definition resolves to a callable validator', () => {
    const schema = loadSchema();
    const defs = schema['definitions'] as Record<string, unknown> | undefined;
    for (const name of Object.keys(defs ?? {})) {
      expect(() => getValidator(name), `definition ${name}`).not.toThrow();
    }
  });

  it('carries the AC #7 idempotency $comment at the top level', () => {
    const schema = loadSchema();
    expect(typeof schema['$comment']).toBe('string');
    expect(schema['$comment']).toContain('event.id = SHA-256');
    expect(schema['$comment']).toContain('stateless');
  });

  describe('AnyoneHostname', () => {
    it('accepts a real v3-shaped .anyone hostname', () => {
      const validate = getValidator('AnyoneHostname');
      expect(validate(REAL_HOSTNAME)).toBe(true);
    });

    it('accepts a .anon TLD (locally-published HS variant)', () => {
      const validate = getValidator('AnyoneHostname');
      expect(
        validate(
          'jhxqkj7kmd2dybsoubtjwcjmuk75xbjvfppc4f6gjcw5sl3byo7lhmid.anon'
        )
      ).toBe(true);
    });

    it('rejects bare TLDs (no host part) — pattern requires at least one char', () => {
      const validate = getValidator('AnyoneHostname');
      expect(validate('.anyone')).toBe(false);
      expect(validate('.anon')).toBe(false);
    });

    it('rejects non-base32 alphabet (rate-limit-via-shape guard)', () => {
      const validate = getValidator('AnyoneHostname');
      // '1' and '8' are NOT in v3 base32 [a-z2-7]
      expect(validate('abc1.anyone')).toBe(false);
      expect(validate('abc8.anyone')).toBe(false);
      expect(validate('ABC.anyone')).toBe(false); // uppercase rejected
    });

    it('rejects unknown TLDs', () => {
      const validate = getValidator('AnyoneHostname');
      expect(validate('abcdef.com')).toBe(false);
      expect(validate('abcdef.onion')).toBe(false);
    });
  });

  describe('NostrEvent', () => {
    it('accepts the fixture event shape', () => {
      const validate = getValidator('NostrEvent');
      expect(validate(FIXTURE_EVENT)).toBe(true);
    });

    it('rejects missing required fields', () => {
      const validate = getValidator('NostrEvent');
      const { id: _id, ...rest } = FIXTURE_EVENT;
      expect(validate(rest)).toBe(false);
    });

    it('rejects malformed id (must be 64 lowercase hex chars)', () => {
      const validate = getValidator('NostrEvent');
      expect(validate({ ...FIXTURE_EVENT, id: 'short' })).toBe(false);
      expect(
        validate({ ...FIXTURE_EVENT, id: FIXTURE_EVENT.id.toUpperCase() })
      ).toBe(false);
    });

    it('rejects malformed sig (must be 128 lowercase hex chars)', () => {
      const validate = getValidator('NostrEvent');
      expect(
        validate({ ...FIXTURE_EVENT, sig: FIXTURE_EVENT.sig.slice(0, 100) })
      ).toBe(false);
    });

    it('rejects additionalProperties', () => {
      const validate = getValidator('NostrEvent');
      expect(validate({ ...FIXTURE_EVENT, rogue: 'field' })).toBe(false);
    });
  });

  describe('PublishRequest', () => {
    it('accepts valid {event, targetHostname} shape', () => {
      const validate = getValidator('PublishRequest');
      expect(
        validate({
          event: FIXTURE_EVENT,
          targetHostname: REAL_HOSTNAME,
        })
      ).toBe(true);
    });

    it('rejects missing targetHostname', () => {
      const validate = getValidator('PublishRequest');
      expect(validate({ event: FIXTURE_EVENT })).toBe(false);
    });

    it('rejects missing event', () => {
      const validate = getValidator('PublishRequest');
      expect(validate({ targetHostname: REAL_HOSTNAME })).toBe(false);
    });

    it('rejects bad hostname (non-base32 or wrong TLD)', () => {
      const validate = getValidator('PublishRequest');
      expect(
        validate({
          event: FIXTURE_EVENT,
          targetHostname: 'abcdef.com',
        })
      ).toBe(false);
    });

    it('rejects additionalProperties on the top-level request', () => {
      const validate = getValidator('PublishRequest');
      expect(
        validate({
          event: FIXTURE_EVENT,
          targetHostname: REAL_HOSTNAME,
          settlementAddress: '0xabc', // not part of the contract
        })
      ).toBe(false);
    });

    it('rejects malformed nested event', () => {
      const validate = getValidator('PublishRequest');
      expect(
        validate({
          event: { ...FIXTURE_EVENT, id: 'too-short' },
          targetHostname: REAL_HOSTNAME,
        })
      ).toBe(false);
    });
  });

  describe('PublishSuccessResponse', () => {
    it('accepts the happy-path 202 shape', () => {
      const validate = getValidator('PublishSuccessResponse');
      expect(
        validate({
          eventId: FIXTURE_EVENT.id,
          claimHash: '0x' + 'a'.repeat(64),
          chainId: 31337,
          publishedAt: '2026-05-19T12:34:56.789Z',
          durationMs: 1234,
        })
      ).toBe(true);
    });

    it('rejects missing required fields', () => {
      const validate = getValidator('PublishSuccessResponse');
      expect(
        validate({
          eventId: FIXTURE_EVENT.id,
          claimHash: '0xabcdef',
          chainId: 31337,
        })
      ).toBe(false);
    });

    it('rejects bad publishedAt (must be ISO-8601)', () => {
      const validate = getValidator('PublishSuccessResponse');
      expect(
        validate({
          eventId: FIXTURE_EVENT.id,
          claimHash: '0xabc',
          chainId: 31337,
          publishedAt: 'yesterday',
          durationMs: 100,
        })
      ).toBe(false);
    });

    it('rejects negative durationMs', () => {
      const validate = getValidator('PublishSuccessResponse');
      expect(
        validate({
          eventId: FIXTURE_EVENT.id,
          claimHash: '0xabc',
          chainId: 31337,
          publishedAt: '2026-05-19T00:00:00.000Z',
          durationMs: -1,
        })
      ).toBe(false);
    });
  });

  describe('PublishRateLimitedResponse', () => {
    it('accepts the 429 shape', () => {
      const validate = getValidator('PublishRateLimitedResponse');
      expect(validate({ error: 'rate_limited', retryAfterSec: 30 })).toBe(true);
    });

    it('rejects a wrong error tag', () => {
      const validate = getValidator('PublishRateLimitedResponse');
      expect(validate({ error: 'throttled', retryAfterSec: 30 })).toBe(false);
    });

    it('rejects retryAfterSec < 1', () => {
      const validate = getValidator('PublishRateLimitedResponse');
      expect(validate({ error: 'rate_limited', retryAfterSec: 0 })).toBe(false);
    });
  });

  describe('PublishClientErrorResponse', () => {
    it('accepts a 400 with field hint', () => {
      const validate = getValidator('PublishClientErrorResponse');
      expect(
        validate({
          error: 'targetHostname required',
          field: 'targetHostname',
        })
      ).toBe(true);
    });

    it('accepts a 400 with ajvErrors array', () => {
      const validate = getValidator('PublishClientErrorResponse');
      expect(
        validate({
          error: 'invalid_request',
          ajvErrors: [
            {
              path: '/event/id',
              message: 'pattern mismatch',
              keyword: 'pattern',
            },
          ],
        })
      ).toBe(true);
    });

    it('rejects ajvErrors with extra fields per entry', () => {
      const validate = getValidator('PublishClientErrorResponse');
      expect(
        validate({
          error: 'invalid_request',
          ajvErrors: [{ path: '/event/id', message: 'bad', extra: 1 }],
        })
      ).toBe(false);
    });
  });

  describe('PublishServerErrorResponse', () => {
    it('accepts a 502 with retryable=true', () => {
      const validate = getValidator('PublishServerErrorResponse');
      expect(
        validate({
          error: 'relay timeout',
          retryable: true,
        })
      ).toBe(true);
    });

    it('accepts a 502 with relayAck', () => {
      const validate = getValidator('PublishServerErrorResponse');
      expect(
        validate({
          error: 'relay rejected',
          relayAck: 'F02 cannot route',
          retryable: false,
        })
      ).toBe(true);
    });

    it('rejects missing retryable', () => {
      const validate = getValidator('PublishServerErrorResponse');
      expect(validate({ error: 'relay timeout' })).toBe(false);
    });
  });

  describe('HealthzResponse', () => {
    it('accepts the happy-path shape', () => {
      const validate = getValidator('HealthzResponse');
      expect(
        validate({
          anyoneReady: true,
          evmAddr: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
          solAddr: 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3',
          balances: {
            evm: '100000000000000000000',
            sol: 1000000000,
          },
          bootedAt: '2026-05-19T12:00:00.000Z',
        })
      ).toBe(true);
    });

    it('rejects missing anyoneReady', () => {
      const validate = getValidator('HealthzResponse');
      expect(
        validate({
          evmAddr: '0x' + 'a'.repeat(40),
          solAddr: 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3',
          balances: { evm: '0', sol: 0 },
          bootedAt: '2026-05-19T12:00:00.000Z',
        })
      ).toBe(false);
    });
  });

  describe('SignerInfoResponse', () => {
    it('accepts the happy-path shape with socks5h transport', () => {
      const validate = getValidator('SignerInfoResponse');
      expect(
        validate({
          evm: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
          sol: 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3',
          balances: { evm: '0', sol: 0 },
          bootedAt: '2026-05-19T12:00:00.000Z',
          transport: {
            type: 'socks5',
            socksProxy: 'socks5h://127.0.0.1:9050',
          },
        })
      ).toBe(true);
    });

    it('rejects socks5:// (no "h" suffix — DNS-leak risk)', () => {
      const validate = getValidator('SignerInfoResponse');
      expect(
        validate({
          evm: '0x' + 'a'.repeat(40),
          sol: 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3',
          balances: { evm: '0', sol: 0 },
          bootedAt: '2026-05-19T12:00:00.000Z',
          transport: { type: 'socks5', socksProxy: 'socks5://127.0.0.1:9050' },
        })
      ).toBe(false);
    });

    it('rejects unknown transport type', () => {
      const validate = getValidator('SignerInfoResponse');
      expect(
        validate({
          evm: '0x' + 'a'.repeat(40),
          sol: 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3',
          balances: { evm: '0', sol: 0 },
          bootedAt: '2026-05-19T12:00:00.000Z',
          transport: { type: 'http', socksProxy: 'socks5h://127.0.0.1:9050' },
        })
      ).toBe(false);
    });
  });
});
