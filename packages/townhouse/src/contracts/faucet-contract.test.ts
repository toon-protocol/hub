/**
 * Story 49.2 schema-contract DoD — ajv-validates the request + response
 * shapes the deployed dev-faucet emits against the canonical schema at
 * packages/townhouse/contracts/faucet.schema.json. Schema drift between
 * the deployed faucet's response shape and the schema file = build break
 * (this test fails in the normal unit suite — runs without Docker).
 *
 * Story 49.2 Task 6 instructs the file path to be under __integration__
 * but the test ITSELF is a pure unit test (no I/O, no Docker, no live
 * faucet). Placed here in `src/contracts/` so it runs under
 * `pnpm --filter @toon-protocol/townhouse test` (default vitest config)
 * rather than only under `test:integration`. See § "Project Structure
 * Notes" in 49-2-akash-devnet-faucets-and-ui.md for rationale.
 */

import { describe, expect, it } from 'vitest';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEMA_PATH = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../contracts/faucet.schema.json'
);

function loadSchema() {
  return JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
}

// Compile a definition by name from the schema. Uses addSchema + getSchema
// so internal $ref pointers (e.g., FaucetUnifiedRequest → #/definitions/Chain)
// resolve against the whole document.
function makeAjvWithSchema() {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  const schema = loadSchema();
  ajv.addSchema(schema, 'faucet');
  return { ajv, schema };
}

function getValidator(name: string) {
  const { ajv } = makeAjvWithSchema();
  const v = ajv.getSchema(`faucet#/definitions/${name}`);
  if (!v) throw new Error(`definition not found: ${name}`);
  return v;
}

describe('faucet.schema.json — schema-contract DoD (story 49.2 Task 6)', () => {
  it('loads as valid JSON Schema (whole document addSchema succeeds)', () => {
    expect(() => makeAjvWithSchema()).not.toThrow();
  });

  it('every named definition resolves to a callable validator', () => {
    const schema = loadSchema();
    for (const name of Object.keys(schema.definitions ?? {})) {
      expect(() => getValidator(name), `definition ${name}`).not.toThrow();
    }
  });

  it('valid FaucetUnifiedRequest shape passes', () => {
    const validate = getValidator('FaucetUnifiedRequest');
    expect(validate({ chain: 'evm', recipient: '0x' + 'a'.repeat(40) })).toBe(
      true
    );
    expect(
      validate({
        chain: 'solana',
        recipient: 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3',
        amount: 100,
      })
    ).toBe(true);
  });

  it('FaucetUnifiedRequest rejects unknown chain', () => {
    const validate = getValidator('FaucetUnifiedRequest');
    expect(validate({ chain: 'mina', recipient: '0x' + 'a'.repeat(40) })).toBe(
      false
    );
  });

  it('FaucetUnifiedRequest rejects additionalProperties', () => {
    const validate = getValidator('FaucetUnifiedRequest');
    expect(
      validate({
        chain: 'evm',
        recipient: '0x' + 'a'.repeat(40),
        rogue: 'field',
      })
    ).toBe(false);
  });

  it('FaucetUnifiedRequest rejects negative amount', () => {
    const validate = getValidator('FaucetUnifiedRequest');
    expect(
      validate({
        chain: 'evm',
        recipient: '0x' + 'a'.repeat(40),
        amount: -5,
      })
    ).toBe(false);
  });

  it('valid FaucetPathRequest shape passes for both chains', () => {
    const validate = getValidator('FaucetPathRequest');
    expect(validate({ address: '0x' + 'f'.repeat(40) })).toBe(true);
    expect(
      validate({ address: 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3' })
    ).toBe(true);
  });

  it('FaucetSuccessResponse — happy path passes; missing required fails', () => {
    const validate = getValidator('FaucetSuccessResponse');

    expect(
      validate({
        tx: '0xdeadbeef',
        chain: 'evm',
        recipient: '0x' + 'a'.repeat(40),
        balanceAfter: '10000',
        explorerUrl: 'https://explorer.example.com/tx/0xdeadbeef',
      })
    ).toBe(true);

    // Missing required `tx`.
    expect(validate({ chain: 'evm', recipient: '0x' + 'a'.repeat(40) })).toBe(
      false
    );

    // additionalProperties enforcement.
    expect(
      validate({
        tx: 'sig',
        chain: 'solana',
        recipient: 'ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3',
        rogue: true,
      })
    ).toBe(false);
  });

  it('FaucetClientErrorResponse — accepts 4xx body shape with waitMinutes', () => {
    const validate = getValidator('FaucetClientErrorResponse');
    expect(validate({ error: 'rate limit exceeded' })).toBe(true);
    expect(validate({ error: 'rate limit exceeded', waitMinutes: 1 })).toBe(
      true
    );
    // Missing required `error`.
    expect(validate({ waitMinutes: 1 })).toBe(false);
  });

  it('FaucetServerErrorResponse — accepts retryable flag + airdropSig for partial Sol success', () => {
    const validate = getValidator('FaucetServerErrorResponse');
    expect(
      validate({
        error: 'mint not found',
        retryable: false,
        airdropSig: 'sigBase58',
      })
    ).toBe(true);
    expect(validate({ error: 'transient RPC failure', retryable: true })).toBe(
      true
    );
  });

  it('RecentDripsResponse — accepts array of valid entries; rejects extras', () => {
    const validate = getValidator('RecentDripsResponse');

    expect(
      validate([
        {
          ts: '2026-05-18T12:34:56.000Z',
          address: '0x7a..3f',
          chain: 'evm',
          amount: 100,
          txid: '0xdeadbeef',
        },
        {
          ts: '2026-05-18T12:30:00.000Z',
          address: 'ATEh3…E8m3',
          chain: 'solana',
          amount: 100,
          txid: 'sigBase58',
        },
      ])
    ).toBe(true);

    // Bad chain.
    expect(
      validate([
        {
          ts: '2026-05-18T12:34:56.000Z',
          address: '0x7a..3f',
          chain: 'mina',
          amount: 100,
          txid: '0xdeadbeef',
        },
      ])
    ).toBe(false);

    // Extra field.
    expect(
      validate([
        {
          ts: '2026-05-18T12:34:56.000Z',
          address: '0x7a..3f',
          chain: 'evm',
          amount: 100,
          txid: '0xdeadbeef',
          rogue: true,
        },
      ])
    ).toBe(false);
  });

  it('EvmAddress pattern — checksummed real-world fixture passes', () => {
    const validate = getValidator('EvmAddress');
    // Anvil account[0] — real-world EVM address fixture.
    expect(validate('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266')).toBe(true);
    expect(validate('not-an-address')).toBe(false);
    expect(validate('0x0')).toBe(false);
  });

  it('SolanaAddress pattern — real-world base58 fixture passes', () => {
    const validate = getValidator('SolanaAddress');
    // Mock USDC faucet authority pubkey — real-world Solana address fixture.
    expect(validate('ATEh3koyCrwmCMr3cNBVEmARhSFmP9tHokjDxhtaE8m3')).toBe(true);
    // Token program ID — another real base58 string.
    expect(validate('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(true);
    // 0OIl forbidden chars.
    expect(validate('0' + 'a'.repeat(40))).toBe(false);
  });
});
