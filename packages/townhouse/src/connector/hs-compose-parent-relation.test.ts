/**
 * Regression test for finding #4 — the parent↔child "free packet" relation.
 *
 * Children apply the connector's `parent` relation (so they accept apex-forwarded
 * paid PREPAREs for free) ONLY when their configured parent-peer-id equals the
 * apex connector's auth-declared nodeId. The connector keys peerRelations by the
 * inbound session's auth peerId, so the long-standing literal `apex` never
 * matched the real nodeId `g.townhouse` → every child F06/T00-rejected paid
 * traffic forwarded by the apex.
 *
 * This asserts the shipped HS compose template wires the correct value into both
 * the town service (reads PARENT_PEER_ID, mapped to TOON_PARENT_PEER_ID by
 * entrypoint-town) and the mill service (reads TOON_PARENT_PEER_ID directly).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const COMPOSE_PATH = join(__dirname, '..', '..', 'compose', 'townhouse-hs.yml');

// The apex connector's nodeId — must match config-generator's APEX_ILP_ADDRESS.
const APEX_NODE_ID = 'g.townhouse';

interface ComposeService {
  environment?: Record<string, string>;
}
interface Compose {
  services: Record<string, ComposeService>;
}

describe('townhouse-hs.yml parent-peer-id (finding #4)', () => {
  const compose = parse(readFileSync(COMPOSE_PATH, 'utf-8')) as Compose;

  it('town service sets PARENT_PEER_ID to the apex nodeId (not the literal "apex")', () => {
    const env = compose.services['town']?.environment ?? {};
    expect(env['PARENT_PEER_ID']).toBe(APEX_NODE_ID);
    expect(env['PARENT_PEER_ID']).not.toBe('apex');
  });

  it('mill service sets TOON_PARENT_PEER_ID to the apex nodeId', () => {
    // entrypoint-mill reads TOON_PARENT_PEER_ID directly (no PARENT_PEER_ID map).
    const env = compose.services['mill']?.environment ?? {};
    expect(env['TOON_PARENT_PEER_ID']).toBe(APEX_NODE_ID);
  });

  // Issue #157 — the mill service MUST advertise the same ILP self-route the
  // apex forwards swaps to (`g.townhouse.mill`). entrypoint-mill maps
  // ILP_ADDRESS → TOON_ILP_ADDRESS → the embedded connector's self-route.
  // Without it the mill self-routes on `g.toon.mill.<pubkey>`, the forwarded
  // swap PREPARE misses the self-route, falls through to the up-to-parent route,
  // and the per-packet-claim-service T00-rejects on the unresolvable parent.
  it('mill service sets ILP_ADDRESS to g.townhouse.mill (issue #157)', () => {
    const env = compose.services['mill']?.environment ?? {};
    expect(env['ILP_ADDRESS']).toBe(`${APEX_NODE_ID}.mill`);
  });

  it('no service still ships the broken literal parent id "apex"', () => {
    for (const [name, svc] of Object.entries(compose.services)) {
      const env = svc.environment ?? {};
      expect(
        env['PARENT_PEER_ID'],
        `${name}.PARENT_PEER_ID must not be the literal "apex"`
      ).not.toBe('apex');
      expect(
        env['TOON_PARENT_PEER_ID'],
        `${name}.TOON_PARENT_PEER_ID must not be the literal "apex"`
      ).not.toBe('apex');
    }
  });
});
