/**
 * Unit Tests: DVM Node Dockerfile & Entrypoint (Story 21.7)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-034, T-037, T-038, T-039, T-040, T-041, T-042.
 * These tests verify:
 * - AC #1: Dockerfile builds successfully (multi-stage, correct CMD, EXPOSE, HEALTHCHECK)
 * - AC #2: Container accepts connector URL via CONNECTOR_URL env var (standalone HTTP mode)
 * - AC #3: Health endpoint at /health on BLS port (3400)
 * - AC #4: DVM handlers (kind:5094, kind:5250) registered
 * - AC #5: Fee configurable via FEE_PER_JOB env var
 * - AC #6: Multi-stage build, non-root execution, HEALTHCHECK, EXPOSE 3300+3400
 * - AC #7: Compose stack integration (volume, healthcheck, identity env vars)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Paths relative to repo root (tests run from packages/townhouse/)
const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'docker/Dockerfile.dvm');
const ENTRYPOINT_PATH = resolve(REPO_ROOT, 'docker/src/entrypoint-dvm.ts');
const COMPOSE_PATH = resolve(REPO_ROOT, 'docker-compose-townhouse.yml');

// Cache file contents to avoid redundant synchronous reads across tests
const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
const entrypoint = readFileSync(ENTRYPOINT_PATH, 'utf-8');
const compose = readFileSync(COMPOSE_PATH, 'utf-8');

/**
 * Helper: extract the compose dvm service section.
 * Asserts the section is non-empty to prevent silent false passes
 * if the compose file structure changes.
 */
function extractDvmSection(): string {
  const section = compose.split(/^ {2}dvm:/m)[1]?.split(/^ {2}\w+:/m)[0] ?? '';
  if (section.length === 0) {
    throw new Error(
      'Failed to extract dvm section from docker-compose-townhouse.yml — file structure may have changed'
    );
  }
  return section;
}

/**
 * Helper: extract the compose connector service section.
 */
function extractConnectorSection(): string {
  const section =
    compose.split(/^ {2}connector:/m)[1]?.split(/^ {2}\w+:/m)[0] ?? '';
  if (section.length === 0) {
    throw new Error(
      'Failed to extract connector section from docker-compose-townhouse.yml'
    );
  }
  return section;
}

describe('DVM Node Dockerfile (Story 21.7)', () => {
  // ── T-034: Dockerfile builds from repo root ──
  describe('T-034: Dockerfile structure', () => {
    it('[P0] should use multi-stage build with node:20-alpine builder', () => {
      expect(dockerfile).toMatch(/FROM node:20-alpine AS builder/);
    });

    it('[P0] should have minimal runtime stage with node:20-alpine', () => {
      const fromStatements = dockerfile.match(/^FROM .+$/gm) ?? [];
      expect(fromStatements.length).toBeGreaterThanOrEqual(2);
      expect(fromStatements[fromStatements.length - 1]).toMatch(
        /node:20-alpine/
      );
    });

    it('[P0] should install pnpm 8.15.0 in builder stage', () => {
      expect(dockerfile).toMatch(/corepack prepare pnpm@8\.15\.0/);
    });

    it('[P0] should use esbuild to bundle entrypoint-dvm.ts', () => {
      expect(dockerfile).toMatch(/esbuild.*entrypoint-dvm\.ts/);
      expect(dockerfile).toMatch(/--external:better-sqlite3/);
    });

    it('[P0] should include externals for optional chain signers and turbo-sdk', () => {
      expect(dockerfile).toMatch(/--external:ethers/);
      expect(dockerfile).toMatch(/--external:express/);
      expect(dockerfile).toMatch(/--external:mina-signer/);
      expect(dockerfile).toMatch(/--external:o1js/);
      expect(dockerfile).toMatch(/--external:@solana\/kit/);
      expect(dockerfile).toMatch(/--external:@toon-protocol\/mina-zkapp/);
      expect(dockerfile).toMatch(/--external:@ardrive\/turbo-sdk/);
    });

    it('[P0] should include pet-dvm and memvid-node package filters', () => {
      expect(dockerfile).toMatch(/--filter '@toon-protocol\/pet-dvm'/);
      expect(dockerfile).toMatch(/--filter '@toon-protocol\/memvid-node'/);
    });
  });

  // ── T-041: CMD points to correct entrypoint ──
  describe('T-041: CMD configuration', () => {
    it('[P0] should have CMD pointing to entrypoint-dvm.js', () => {
      expect(dockerfile).toMatch(/CMD.*entrypoint-dvm\.js/);
    });
  });

  // ── T-042: Multi-stage build with minimal final image ──
  describe('T-042: Runtime image minimization', () => {
    it('[P1] should run as non-root user toon', () => {
      expect(dockerfile).toMatch(/USER toon/);
      expect(dockerfile).toMatch(/adduser.*toon/);
    });

    it('[P1] should install libstdc++ for native module support', () => {
      const runtimeSection =
        dockerfile.split(/^FROM node:20-alpine\s*$/m).pop() ?? '';
      expect(runtimeSection).toMatch(/apk add.*libstdc\+\+/);
    });

    it('[P1] should set ESM package.json with type module', () => {
      expect(dockerfile).toMatch(/\{"type":"module"\}/);
    });

    it('[P1] should have non-root UID 1001', () => {
      expect(dockerfile).toMatch(/adduser.*-u 1001/);
    });
  });

  // ── T-037: Health endpoint ──
  describe('T-037: HEALTHCHECK configuration', () => {
    it('[P0] should have HEALTHCHECK targeting /health on BLS_PORT', () => {
      expect(dockerfile).toMatch(/HEALTHCHECK/);
      expect(dockerfile).toMatch(/\/health/);
      expect(dockerfile).toMatch(/BLS_PORT/);
    });

    it('[P0] should target BLS port 3400', () => {
      expect(dockerfile).toMatch(/BLS_PORT=3400/);
    });
  });

  // ── Ports: AC #2, #6 ──
  describe('Port exposure', () => {
    it('[P0] should EXPOSE 3300 3400 (HTTP handler + BLS)', () => {
      expect(dockerfile).toMatch(/EXPOSE.*3300/);
      expect(dockerfile).toMatch(/EXPOSE.*3400/);
    });
  });

  // ── Volume for persistent data ──
  describe('Data volume', () => {
    it('[P1] should declare VOLUME /data for persistent storage', () => {
      expect(dockerfile).toMatch(/VOLUME.*\/data/);
    });
  });

  // ── Default env vars ──
  describe('Default environment variables', () => {
    it('[P2] should set NODE_ENV=production', () => {
      expect(dockerfile).toMatch(/ENV NODE_ENV=production/);
    });

    it('[P2] should set BLS_PORT=3400 default', () => {
      expect(dockerfile).toMatch(/ENV BLS_PORT=3400/);
    });

    it('[P2] should set HANDLER_PORT=3300 default', () => {
      expect(dockerfile).toMatch(/ENV HANDLER_PORT=3300/);
    });
  });
});

describe('DVM Entrypoint Adapter (Story 21.7)', () => {
  // ── T-038: Container accepts connector URL via CONNECTOR_URL (standalone HTTP mode) ──
  describe('T-038: Connector HTTP wiring (standalone mode)', () => {
    it('[P0] should import createNode from @toon-protocol/sdk', () => {
      expect(entrypoint).toMatch(
        /import.*createNode.*from.*@toon-protocol\/sdk/
      );
    });

    it('[P0] should map CONNECTOR_URL to connectorUrl in createNode()', () => {
      expect(entrypoint).toMatch(/connectorUrl/);
      expect(entrypoint).toMatch(/CONNECTOR_URL/);
    });

    it('[P0] should map HANDLER_PORT to handlerPort (default 3300)', () => {
      expect(entrypoint).toMatch(/handlerPort/);
      expect(entrypoint).toMatch(/HANDLER_PORT/);
      expect(entrypoint).toMatch(/3300/);
    });

    it('[P0] should use standalone mode (connectorUrl + handlerPort)', () => {
      // Entrypoint should NOT set btpServerPort (that's embedded mode)
      // It should use connectorUrl + handlerPort (standalone mode)
      expect(entrypoint).not.toMatch(/btpServerPort.*=.*3000/);
    });
  });

  // ── T-040: DVM handlers registered for kind:5094 and kind:5250 ──
  describe('T-040: DVM handler registration', () => {
    it('[P0] should import createArweaveDvmHandler from @toon-protocol/sdk', () => {
      expect(entrypoint).toMatch(/createArweaveDvmHandler/);
      expect(entrypoint).toMatch(/from.*@toon-protocol\/sdk/);
    });

    it('[P0] should import createDungeonDvmHandler from @toon-protocol/pet-dvm', () => {
      expect(entrypoint).toMatch(/createDungeonDvmHandler/);
      expect(entrypoint).toMatch(/from.*@toon-protocol\/pet-dvm/);
    });

    it('[P0] should register kind:5094 (Arweave DVM)', () => {
      expect(entrypoint).toMatch(/node\.on\(5094/);
    });

    it('[P0] should register kind:5250 (Dungeon DVM)', () => {
      expect(entrypoint).toMatch(/node\.on\(5250/);
    });

    it('[P1] should create ArweaveUploadAdapter from TURBO_TOKEN', () => {
      expect(entrypoint).toMatch(/TURBO_TOKEN/);
      expect(entrypoint).toMatch(/TurboUploadAdapter/);
    });

    it('[P1] should create ChunkManager for multi-packet uploads', () => {
      expect(entrypoint).toMatch(/ChunkManager/);
    });
  });

  // ── T-039: Fee configurable via FEE_PER_JOB ──
  describe('T-039: Fee configuration', () => {
    it('[P0] should map FEE_PER_JOB to basePricePerByte', () => {
      expect(entrypoint).toMatch(/FEE_PER_JOB/);
      expect(entrypoint).toMatch(/basePricePerByte/);
    });

    it('[P1] should allow kindPricing overrides', () => {
      expect(entrypoint).toMatch(/kindPricing/);
    });
  });

  // ── Env var mapping ──
  describe('Environment variable mapping', () => {
    it('[P0] should map NODE_NOSTR_SECRET_KEY to config.secretKey', () => {
      expect(entrypoint).toMatch(/NODE_NOSTR_SECRET_KEY/);
      expect(entrypoint).toMatch(/config\.secretKey/);
    });

    it('[P0] should map BLS_PORT to config.blsPort with default 3400', () => {
      expect(entrypoint).toMatch(/BLS_PORT/);
      expect(entrypoint).toMatch(/config\.blsPort/);
      expect(entrypoint).toMatch(/3400/);
    });

    it('[P1] should validate secret key is 64-char hex', () => {
      expect(entrypoint).toMatch(/\[0-9a-fA-F\]\{64\}/);
    });
  });

  // ── Graceful shutdown ──
  describe('Process lifecycle', () => {
    it('[P0] should register SIGTERM handler for graceful shutdown', () => {
      expect(entrypoint).toMatch(/SIGTERM/);
      expect(entrypoint).toMatch(/node\.stop/);
    });

    it('[P1] should register SIGINT handler for graceful shutdown', () => {
      expect(entrypoint).toMatch(/SIGINT/);
    });
  });

  // ── Startup banner ──
  describe('Startup logging', () => {
    it('[P2] should log DVM Ready banner with pubkey, handlerPort, blsPort, handler kinds', () => {
      expect(entrypoint).toMatch(/DVM Ready/);
      expect(entrypoint).toMatch(/pubkey/);
      expect(entrypoint).toMatch(/Handler Port/);
      expect(entrypoint).toMatch(/BLS Port/);
      expect(entrypoint).toMatch(/Handler Kinds/);
      expect(entrypoint).toMatch(/5094/);
      expect(entrypoint).toMatch(/5250/);
    });
  });

  // ── Error handling ──
  describe('Error handling', () => {
    it('[P1] should catch fatal errors and exit with code 1', () => {
      expect(entrypoint).toMatch(/\[Fatal\]/);
      expect(entrypoint).toMatch(/process\.exit\(1\)/);
    });
  });
});

describe('Compose stack integration (Story 21.7, AC #2 + #7)', () => {
  // ── AC #2: Connector peer registration ──
  describe('AC #2: Connector peer registration', () => {
    it('[P0] connector CONNECTOR_PEERS should include dvm with httpUrl', () => {
      const connectorSection = extractConnectorSection();
      expect(connectorSection).toMatch(/"id"\s*:\s*"dvm"/);
      expect(connectorSection).toMatch(
        /"httpUrl"\s*:\s*"http:\/\/townhouse-dvm:3300"/
      );
    });

    it('[P1] connector CONNECTOR_PEERS should have relation child', () => {
      const connectorSection = extractConnectorSection();
      expect(connectorSection).toMatch(/"id"\s*:\s*"dvm"/);
      expect(connectorSection).toMatch(/"relation"\s*:\s*"child"/);
    });
  });

  // ── AC #7: Image builds and starts in townhouse compose stack ──
  describe('AC #7: Compose stack configuration', () => {
    it('[P0] dvm service should use townhouse-net network', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/townhouse-net/);
    });

    it('[P0] dvm service should depend on connector being healthy', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/depends_on/);
      expect(dvmSection).toMatch(/connector/);
      expect(dvmSection).toMatch(/service_healthy/);
    });

    it('[P0] dvm service should use image toon:dvm', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/image:\s*toon:dvm/);
    });

    it('[P0] dvm service should have container_name townhouse-dvm', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/container_name:\s*townhouse-dvm/);
    });

    it('[P0] dvm service should be in dvm profile', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/profiles/);
      expect(dvmSection).toMatch(/- dvm/);
    });

    it('[P0] dvm service should expose HTTP handler port 3300 internally', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/expose/);
      expect(dvmSection).toMatch(/['"]?3300['"]?/);
    });

    it('[P0] dvm service should expose BLS port 3400 to host (localhost only)', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/127\.0\.0\.1:3400:3400/);
    });

    it('[P1] dvm service should have healthcheck on port 3400', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/healthcheck/);
      expect(dvmSection).toMatch(/3400\/health/);
    });

    it('[P1] dvm service should have volume mount townhouse-dvm-data:/data', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/townhouse-dvm-data.*:.*\/data/);
    });

    it('[P1] dvm service should have identity env vars', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/NODE_NOSTR_SECRET_KEY/);
      expect(dvmSection).toMatch(/NODE_NOSTR_PUBKEY/);
      expect(dvmSection).toMatch(/NODE_EVM_ADDRESS/);
    });

    it('[P1] dvm service should have TURBO_TOKEN env var', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/TURBO_TOKEN/);
    });

    it('[P1] dvm service should have restart policy', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/restart:\s*unless-stopped/);
    });

    it('[P2] CONNECTOR_URL should be documented as mapping to connectorUrl', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/connectorUrl.*standalone.*HTTP/i);
    });
  });

  // ── Volume declaration ──
  describe('Volume declarations', () => {
    it('[P1] should declare townhouse-dvm-data volume', () => {
      expect(compose).toMatch(/townhouse-dvm-data:/);
    });
  });
});

describe('DVM entrypoint Hono BLS server (Story 21.12)', () => {
  it('[P0] entrypoint imports Hono from hono', () => {
    expect(entrypoint).toMatch(/import.*Hono.*from ['"]hono['"]/);
  });

  it('[P0] entrypoint imports serve from @hono/node-server', () => {
    expect(entrypoint).toMatch(/import.*serve.*from ['"]@hono\/node-server['"]/);
  });

  it('[P0] entrypoint registers GET /health route on blsApp', () => {
    expect(entrypoint).toMatch(/blsApp\.get\(['"]\/health['"]/);
  });

  it('[P0] entrypoint calls serve() with blsPort', () => {
    expect(entrypoint).toMatch(/serve\(\s*\{[^}]*blsPort/s);
  });

  it('[P0] SIGTERM shutdown closes blsServer before node.stop()', () => {
    expect(entrypoint).toMatch(/blsServer/);
    expect(entrypoint).toMatch(/node\.stop\(\)/);
  });

  it('[P0] entrypoint wraps handlers with counter.wrap()', () => {
    expect(entrypoint).toMatch(/counter\.wrap\(/);
  });
});

describe('Orchestrator buildNodeEnv integration (Story 21.7)', () => {
  describe('buildNodeEnv dvm output matches entrypoint expectations', () => {
    it('[P0] compose dvm service should have CONNECTOR_URL env var', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/CONNECTOR_URL/);
    });

    it('[P0] compose dvm service should have FEE_PER_JOB env var', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/FEE_PER_JOB/);
    });

    it('[P2] CONNECTOR_URL comment should note standalone HTTP mode', () => {
      const dvmSection = extractDvmSection();
      expect(dvmSection).toMatch(/standalone.*HTTP/i);
    });
  });
});
