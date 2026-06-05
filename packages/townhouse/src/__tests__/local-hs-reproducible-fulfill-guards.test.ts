/**
 * Local-HS reproducible-FULFILL harness guards (no Docker / no infra).
 *
 * These source-assertion guards lock in the harness fixes that make a clean
 * `LOCAL_CHAINS=1 E2E_MINA=1 bash scripts/townhouse-e2e-local-hs.sh up --local`
 * reach a live Mina (and Solana/EVM) paid-publish → town FULFILL WITHOUT any
 * manual container/env patching. They run with no Docker + no infra and fail
 * loudly if a fix regresses.
 *
 * Covered fixes:
 *   1. Town parent-dial. The HS compose `town` service supplies the UN-prefixed
 *      CONNECTOR_URL / ILP_ADDRESS / PARENT_PEER_ID that entrypoint-town maps to
 *      the TOON_-prefixed names the town reads → the town dials its parent and
 *      opens the inbound BTP session the apex's g.townhouse.town route delivers
 *      over. (Get it wrong → T00/F06, no FULFILL.)
 *   2. In-container EVM RPC. start_town_relay passes EVM_RPC_URL_INTERNAL (the
 *      compose service name, reachable in-container) to the town — NOT the
 *      host-loopback $EVM_RPC_URL (dead inside the container).
 *   3. BTP-bypass gated to local-e2e. The committed btp-bypass proxy + its
 *      ANYONE_PROXY_URLS override are wired ONLY in the `--local` (LOCAL_BYPASS)
 *      path; the compose default keeps the public-ATOR `.anon` production
 *      transport.
 *   4. Current client image. `up --local` BUILDS toon-client from the working
 *      tree (Dockerfile.toon-client), so a clean run uses the #113 client.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
const REPO_ROOT = join(thisFile, '..', '..', '..', '..', '..');

const HARNESS = join(REPO_ROOT, 'scripts', 'townhouse-e2e-local-hs.sh');
const HS_COMPOSE = join(
  REPO_ROOT,
  'packages',
  'townhouse',
  'compose',
  'townhouse-hs.yml'
);
const TOWN_ENTRYPOINT = join(REPO_ROOT, 'docker', 'src', 'entrypoint-town.ts');
const CLIENT_COMPOSE = join(REPO_ROOT, 'docker-compose-e2e-local-client.yml');
const BYPASS_PROXY = join(REPO_ROOT, 'infra', 'btp-bypass', 'proxy.mjs');

function read(path: string): string {
  expect(existsSync(path), `expected file to exist: ${path}`).toBe(true);
  return readFileSync(path, 'utf-8');
}

describe('local-HS reproducible-FULFILL harness guards', () => {
  // ── Fix 1: town parent-dial (compose env + entrypoint mapping) ──────────────
  it('HS compose town service supplies the un-prefixed parent-dial env', () => {
    const src = read(HS_COMPOSE);
    const townIdx = src.indexOf('\n  town:');
    expect(
      townIdx,
      'town service should exist in townhouse-hs.yml'
    ).toBeGreaterThanOrEqual(0);
    // Bound the slice to the town service block (up to the next top-level service).
    const after = src.slice(townIdx + 1);
    const nextSvc = after.search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const townBlock = nextSvc >= 0 ? after.slice(0, nextSvc) : after;
    expect(townBlock).toContain('CONNECTOR_URL: ws://connector:3000');
    expect(townBlock).toContain('ILP_ADDRESS: g.townhouse.town');
    expect(townBlock).toContain('PARENT_PEER_ID: g.townhouse');
  });

  it('entrypoint-town maps the un-prefixed parent-dial env to the TOON_-prefixed names the town reads', () => {
    const src = read(TOWN_ENTRYPOINT);
    expect(src).toMatch(
      /process\.env\['TOON_CONNECTOR_URL'\]\s*=\s*process\.env\['CONNECTOR_URL'\]/
    );
    expect(src).toMatch(
      /process\.env\['TOON_ILP_ADDRESS'\]\s*=\s*process\.env\['ILP_ADDRESS'\]/
    );
    expect(src).toMatch(
      /process\.env\['TOON_PARENT_PEER_ID'\]\s*=\s*process\.env\['PARENT_PEER_ID'\]/
    );
  });

  // ── Fix 2: in-container EVM RPC for the town ────────────────────────────────
  it('start_town_relay passes EVM_RPC_URL_INTERNAL (not host-loopback) to the town container', () => {
    const src = read(HARNESS);
    const fnIdx = src.indexOf('start_town_relay() {');
    expect(fnIdx, 'start_town_relay should exist').toBeGreaterThanOrEqual(0);
    const fnEnd = src.indexOf('\n}', fnIdx);
    const fnBody = src.slice(fnIdx, fnEnd);
    // The town env block must reference the INTERNAL RPC view…
    expect(
      fnBody.includes('EVM_RPC_URL="$EVM_RPC_URL_INTERNAL"'),
      'town container EVM_RPC_URL must be the internal compose-service address'
    ).toBe(true);
    // …and must NOT pass the bare host-loopback $EVM_RPC_URL to the town.
    expect(
      /EVM_RPC_URL="\$EVM_RPC_URL"\s*\\/.test(fnBody),
      'town container must not receive the host-loopback $EVM_RPC_URL'
    ).toBe(false);
  });

  // ── Fix 2b: town registered relation:'child' (free parent→child forward) ────
  it("start_town_relay registers the town as relation:'child' so the apex forwards for free (avoids T00)", () => {
    const src = read(HARNESS);
    const fnIdx = src.indexOf('start_town_relay() {');
    const fnBody = src.slice(fnIdx, src.indexOf('\n}', fnIdx));
    // Must POST /admin/peers for id 'town' with relation child (not just a route).
    expect(fnBody).toContain('/admin/peers');
    expect(fnBody).toMatch(/"id":"town"/);
    expect(fnBody).toMatch(/"relation":"child"/);
    // MUST NOT set transport:'direct' on the town peer — a successful outbound
    // connector→town dial opens a competing session on which the town's BTP
    // server treats the apex as a non-parent → F06. The default (anon SOCKS5)
    // transport fails to dial the internal hostname, leaving the parent inbound
    // session as the delivery path (verified live: direct → F06, default →
    // FULFILL).
    const peerPostIdx = fnBody.indexOf('"id":"town"');
    const peerPostLine = fnBody.slice(peerPostIdx, peerPostIdx + 200);
    expect(peerPostLine).not.toContain('transport');
  });

  // ── Fix: apex Mina signer resolution (derive from keyId, not log-grep) ───────
  it('resolve_apex_mina_signer falls back to deriving the pubkey from the connector.yaml Mina keyId', () => {
    const src = read(HARNESS);
    const fnIdx = src.indexOf('resolve_apex_mina_signer() {');
    expect(
      fnIdx,
      'resolve_apex_mina_signer should exist'
    ).toBeGreaterThanOrEqual(0);
    const fnBody = src.slice(fnIdx, src.indexOf('\n}', fnIdx));
    // Reads connector.yaml + derives via the committed helper.
    expect(fnBody).toContain('connector.yaml');
    expect(fnBody).toContain('derive-mina-pubkey.mjs');
    // The derive helper artifact is committed.
    const helper = read(join(REPO_ROOT, 'scripts', 'derive-mina-pubkey.mjs'));
    expect(helper).toContain('derivePublicKey');
    expect(helper).toContain('mina-signer');
  });

  // ── Fix 3: BTP-bypass committed + gated to local-e2e only ───────────────────
  it('btp-bypass proxy artifact is committed', () => {
    const src = read(BYPASS_PROXY);
    expect(src).toContain('SOCKS5 fixed-upstream proxy');
    expect(src).toContain('UPSTREAM_HOST');
  });

  it('the bypass + ANYONE_PROXY_URLS override are gated strictly behind LOCAL_BYPASS / --local', () => {
    const src = read(HARNESS);
    // The bypass is only enabled by `--local` under LOCAL_CHAINS.
    expect(src).toContain('LOCAL_BYPASS=1');
    expect(src).toMatch(/start_btp_bypass\b/);
    // The client proxy override is conditional on LOCAL_BYPASS == 1.
    const upIdx = src.indexOf('up_local_client() {');
    const upBody = src.slice(upIdx, src.indexOf('\n}', upIdx + 1));
    expect(upBody).toMatch(/if \[\[ "\$LOCAL_BYPASS" == "1" \]\]/);
    expect(upBody).toContain('socks5h://${BYPASS_CONTAINER}:1080');
  });

  it('production transport is unchanged: client compose defaults ANYONE_PROXY_URLS to public ATOR', () => {
    const src = read(CLIENT_COMPOSE);
    // The default (when ANYONE_PROXY_URLS is unset/empty) must be the public
    // ATOR proxies — the production `.anon` transport, untouched by the bypass.
    const defaultLine = src
      .split('\n')
      .find((l) => /^\s*ANYONE_PROXY_URLS:/.test(l));
    expect(
      defaultLine,
      'ANYONE_PROXY_URLS default line should exist'
    ).toBeTruthy();
    expect(defaultLine).toMatch(
      /\$\{ANYONE_PROXY_URLS:-socks5h:\/\/[\d.]+:9052/
    );
    // The DEFAULT value must NOT be the bypass proxy (it may appear in a comment
    // explaining the local-e2e override, but never as the compose default).
    expect(defaultLine).not.toContain('btp-bypass');
  });

  // ── Fix 4: `up --local` builds the current client ───────────────────────────
  it('`up --local` builds the toon-client image from the working tree', () => {
    const src = read(HARNESS);
    // --local sets LOCAL_BUILD=1, which routes up_local_client through
    // build_local_client_image (Dockerfile.toon-client) instead of a registry pull.
    expect(src).toContain('build_local_client_image');
    expect(src).toContain('docker/Dockerfile.toon-client');
    const upIdx = src.indexOf('up_local_client() {');
    const upBody = src.slice(upIdx, src.indexOf('\n}', upIdx + 1));
    expect(upBody).toMatch(/if \[\[ "\$LOCAL_BUILD" == "1" \]\]/);
  });
});
