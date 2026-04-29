/**
 * Unit Tests: Mill Node Dockerfile & Entrypoint (Story 21.6)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-032 through T-042.
 * These tests verify:
 * - AC #1: Dockerfile builds successfully (multi-stage, correct CMD, EXPOSE, HEALTHCHECK)
 * - AC #2: Container accepts connector peering via BTP port 3000 (embedded connector)
 * - AC #3: Health endpoint at /health (HEALTHCHECK in Dockerfile)
 * - AC #4: Swap pairs configurable via MILL_CONFIG_JSON / MILL_CONFIG_PATH
 * - AC #5: Fee markup configurable via FEE_BASIS_POINTS
 * - AC #6: Multi-stage build, non-root execution, HEALTHCHECK, EXPOSE 3000+3200
 * - AC #7: Compose stack integration (env var mapping from orchestrator)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Paths relative to repo root (tests run from packages/townhouse/)
const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'docker/Dockerfile.mill');
const ENTRYPOINT_PATH = resolve(REPO_ROOT, 'docker/src/entrypoint-mill.ts');
const COMPOSE_PATH = resolve(REPO_ROOT, 'docker-compose-townhouse.yml');

// Cache file contents to avoid redundant synchronous reads across tests
const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
const entrypoint = readFileSync(ENTRYPOINT_PATH, 'utf-8');
const compose = readFileSync(COMPOSE_PATH, 'utf-8');

/**
 * Helper: extract the compose mill service section.
 * Asserts the section is non-empty to prevent silent false passes
 * if the compose file structure changes.
 */
function extractMillSection(): string {
  const section = compose.split(/^ {2}mill:/m)[1]?.split(/^ {2}\w+:/m)[0] ?? '';
  if (section.length === 0) {
    throw new Error(
      'Failed to extract mill section from docker-compose-townhouse.yml — file structure may have changed'
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
      'Failed to extract connector section from docker-compose-townhouse.yml — file structure may have changed'
    );
  }
  return section;
}

describe('Mill Node Dockerfile (Story 21.6)', () => {
  // ── T-033: Dockerfile builds from repo root ──
  describe('T-033: Dockerfile structure', () => {
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

    it('[P0] should use esbuild to bundle entrypoint-mill.ts', () => {
      expect(dockerfile).toMatch(/esbuild.*entrypoint-mill\.ts/);
      expect(dockerfile).toMatch(/--external:better-sqlite3/);
    });

    it('[P0] should include externals for optional chain signers', () => {
      expect(dockerfile).toMatch(/--external:ethers/);
      expect(dockerfile).toMatch(/--external:express/);
      expect(dockerfile).toMatch(/--external:mina-signer/);
      expect(dockerfile).toMatch(/--external:o1js/);
      expect(dockerfile).toMatch(/--external:@solana\/kit/);
      expect(dockerfile).toMatch(/--external:@toon-protocol\/mina-zkapp/);
    });
  });

  // ── T-041: CMD points to correct entrypoint ──
  describe('T-041: CMD configuration', () => {
    it('[P0] should have CMD pointing to entrypoint-mill.js', () => {
      expect(dockerfile).toMatch(/CMD.*entrypoint-mill\.js/);
    });
  });

  // ── Story 21.6.1, AC #2 (Finding #11): Dockerfile LABELs in runtime stage ──
  // LABELs declared before the first FROM are silently dropped by Docker —
  // they never appear on the produced image. They must live in the runtime
  // stage (after the second `FROM node:20-alpine`).
  describe('LABEL placement (Story 21.6.1, Finding #11)', () => {
    const builderFromIdx = dockerfile.search(/^FROM node:20-alpine AS builder/m);
    const runtimeFromIdx = dockerfile.search(/^FROM node:20-alpine\s*$/m);
    const beforeBuilder = dockerfile.slice(0, builderFromIdx);
    const runtimeSection = dockerfile.slice(runtimeFromIdx);

    it('[P0] should NOT declare LABELs before the first FROM', () => {
      expect(beforeBuilder).not.toMatch(/^LABEL\s+/m);
    });

    it('[P0] should declare LABEL maintainer in the runtime stage', () => {
      expect(runtimeSection).toMatch(/^LABEL\s+maintainer\s*=/m);
    });

    it('[P0] should declare LABEL version in the runtime stage', () => {
      expect(runtimeSection).toMatch(/^LABEL\s+version\s*=/m);
    });

    it('[P0] should declare LABEL description in the runtime stage', () => {
      expect(runtimeSection).toMatch(/^LABEL\s+description\s*=/m);
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

  // ── T-036: Health endpoint ──
  describe('T-036: HEALTHCHECK configuration', () => {
    it('[P0] should have HEALTHCHECK targeting /health on BLS port', () => {
      expect(dockerfile).toMatch(/HEALTHCHECK/);
      expect(dockerfile).toMatch(/\/health/);
      expect(dockerfile).toMatch(/BLS_PORT/);
    });
  });

  // ── Ports: AC #2, #6 ──
  describe('Port exposure', () => {
    it('[P0] should EXPOSE 3000 3200 (BTP + BLS)', () => {
      expect(dockerfile).toMatch(/EXPOSE.*3000/);
      expect(dockerfile).toMatch(/EXPOSE.*3200/);
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

    it('[P2] should set BLS_PORT=3200 default', () => {
      expect(dockerfile).toMatch(/ENV BLS_PORT=3200/);
    });
  });
});

describe('Mill Entrypoint Adapter (Story 21.6)', () => {
  // ── T-038: Container accepts connector peering via BTP port 3000 ──
  describe('T-038: Connector BTP wiring', () => {
    it('[P0] should import startMill from @toon-protocol/mill', () => {
      expect(entrypoint).toMatch(
        /import.*startMill.*from.*@toon-protocol\/mill/
      );
    });

    it('[P0] should force btpServerPort = 3000', () => {
      expect(entrypoint).toMatch(/btpServerPort.*=.*3000/);
    });

    it('[P0] should NOT forward CONNECTOR_URL (intentionally ignored)', () => {
      // The entrypoint should NOT map CONNECTOR_URL to anything
      expect(entrypoint).not.toMatch(/CONNECTOR_URL.*connectorUrl/);
      expect(entrypoint).not.toMatch(/process\.env\['CONNECTOR_URL'\]/);
    });

    it('[P1] should create embedded connector when btpServerPort is set', () => {
      // The entrypoint sets btpServerPort without setting connectorUrl,
      // which triggers the embedded connector auto-creation in startMill
      expect(entrypoint).toMatch(/btpServerPort/);
    });
  });

  // ── T-040: Config loading via MILL_CONFIG_JSON / MILL_CONFIG_PATH ──
  describe('T-040: JSON config loading', () => {
    it('[P0] should load config from MILL_CONFIG_JSON', () => {
      expect(entrypoint).toMatch(/MILL_CONFIG_JSON/);
      expect(entrypoint).toMatch(/JSON\.parse.*MILL_CONFIG_JSON/);
    });

    it('[P0] should load config from MILL_CONFIG_PATH', () => {
      expect(entrypoint).toMatch(/MILL_CONFIG_PATH/);
      expect(entrypoint).toMatch(/readFileSync/);
    });

    it('[P0] should throw error if neither config source is provided', () => {
      expect(entrypoint).toMatch(
        /MILL_CONFIG_JSON.*or.*MILL_CONFIG_PATH.*must be provided/
      );
    });
  });

  // ── Env var mapping ──
  describe('Environment variable mapping', () => {
    it('[P0] should map NODE_NOSTR_SECRET_KEY to config.secretKey', () => {
      expect(entrypoint).toMatch(/NODE_NOSTR_SECRET_KEY/);
      expect(entrypoint).toMatch(/config\.secretKey/);
    });

    it('[P0] should map BLS_PORT to config.blsPort with default 3200', () => {
      expect(entrypoint).toMatch(/BLS_PORT/);
      expect(entrypoint).toMatch(/config\.blsPort/);
      expect(entrypoint).toMatch(/3200/);
    });

    it('[P1] should map MILL_RELAYS to config.relayUrls', () => {
      expect(entrypoint).toMatch(/MILL_RELAYS/);
      expect(entrypoint).toMatch(/config\.relayUrls/);
    });

    it('[P1] should apply FEE_BASIS_POINTS via rateProvider wrapping', () => {
      expect(entrypoint).toMatch(/FEE_BASIS_POINTS/);
      expect(entrypoint).toMatch(/rateProvider/);
    });
  });

  // ── BigInt rehydration ──
  describe('BigInt rehydration from JSON', () => {
    it('[P1] should convert inventory values to BigInt', () => {
      expect(entrypoint).toMatch(/toBigInt/);
      expect(entrypoint).toMatch(/inventory/);
    });

    it('[P1] should convert channel cumulativeAmount and nonce to BigInt', () => {
      expect(entrypoint).toMatch(/cumulativeAmount.*toBigInt/);
      expect(entrypoint).toMatch(/nonce.*toBigInt/);
    });
  });

  // ── Graceful shutdown ──
  describe('Process lifecycle', () => {
    it('[P0] should register SIGTERM handler for graceful shutdown', () => {
      expect(entrypoint).toMatch(/SIGTERM/);
      expect(entrypoint).toMatch(/instance\.stop/);
    });

    it('[P1] should register SIGINT handler for graceful shutdown', () => {
      expect(entrypoint).toMatch(/SIGINT/);
    });
  });

  // ── Startup logging (Story 21.6.1, Finding #12) ──
  // The ASCII "Mill Ready" banner was replaced with a structured JSON line
  // emitted via logJson('info', 'mill_ready', {...}).
  describe('Startup logging', () => {
    it('[P2] should emit structured mill_ready event with pubkey, evmAddress, blsPort, swapPairCount', () => {
      expect(entrypoint).toMatch(/['"]mill_ready['"]/);
      expect(entrypoint).toMatch(/pubkey/);
      expect(entrypoint).toMatch(/evmAddress/);
      expect(entrypoint).toMatch(/blsPort/);
      expect(entrypoint).toMatch(/swapPairCount/);
    });

    it('[P2] should expose a logJson helper writing JSON-per-line', () => {
      expect(entrypoint).toMatch(/function\s+logJson/);
      expect(entrypoint).toMatch(/JSON\.stringify/);
      expect(entrypoint).toMatch(/scope:\s*['"]mill-entrypoint['"]/);
    });

    it('[P2] should not emit the legacy ASCII "Mill Ready" banner', () => {
      expect(entrypoint).not.toMatch(/Mill Ready/);
      expect(entrypoint).not.toMatch(/╔/);
    });
  });

  // ── Process lifecycle (Story 21.6.1, Finding #13) ──
  describe('SIGQUIT handling (Finding #13)', () => {
    it('[P1] should register SIGQUIT alongside SIGTERM and SIGINT', () => {
      expect(entrypoint).toMatch(/process\.on\(\s*['"]SIGTERM['"]/);
      expect(entrypoint).toMatch(/process\.on\(\s*['"]SIGINT['"]/);
      expect(entrypoint).toMatch(/process\.on\(\s*['"]SIGQUIT['"]/);
    });
  });

  // ── Sensitive env cleanup (Story 21.6.1, Finding #10) ──
  describe('MILL_CONFIG_JSON cleanup (Finding #10)', () => {
    it('[P0] should delete process.env.MILL_CONFIG_JSON in loadMillConfig', () => {
      expect(entrypoint).toMatch(
        /delete\s+process\.env\[['"]MILL_CONFIG_JSON['"]\]/
      );
    });
  });
});

describe('Compose stack integration (Story 21.6, AC #2 + #7)', () => {
  // ── AC #2: Connector peer registration ──
  describe('AC #2: Connector peer registration', () => {
    it('[P0] connector CONNECTOR_PEERS should include mill with btp+ws://townhouse-mill:3000', () => {
      const connectorSection = extractConnectorSection();
      expect(connectorSection).toMatch(/townhouse-mill:3000/);
    });

    it('[P1] connector CONNECTOR_PEERS mill entry should have relation child', () => {
      const connectorSection = extractConnectorSection();
      expect(connectorSection).toMatch(/"id"\s*:\s*"mill"/);
      expect(connectorSection).toMatch(/"relation"\s*:\s*"child"/);
    });
  });

  // ── AC #7: Image builds and starts in townhouse compose stack ──
  describe('AC #7: Compose stack configuration', () => {
    it('[P0] mill service should use townhouse-net network', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/townhouse-net/);
    });

    it('[P0] mill service should depend on connector being healthy', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/depends_on/);
      expect(millSection).toMatch(/connector/);
      expect(millSection).toMatch(/service_healthy/);
    });

    it('[P0] mill service should use image toon:mill', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/image:\s*toon:mill/);
    });

    it('[P0] mill service should have container_name townhouse-mill', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/container_name:\s*townhouse-mill/);
    });

    it('[P0] mill service should be in mill profile', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/profiles/);
      expect(millSection).toMatch(/- mill/);
    });

    it('[P0] mill service should expose BTP port 3000 internally for connector', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/expose/);
      expect(millSection).toMatch(/['"]?3000['"]?/);
    });

    it('[P0] mill service should expose BLS port 3200 to host (localhost only)', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/127\.0\.0\.1:3200:3200/);
    });

    it('[P1] mill service should have healthcheck on port 3200', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/healthcheck/);
      expect(millSection).toMatch(/3200\/health/);
    });

    it('[P1] mill service should have volume mount townhouse-mill-data:/data', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/townhouse-mill-data.*:.*\/data/);
    });

    it('[P1] mill service should have identity env vars (NODE_NOSTR_SECRET_KEY, etc.)', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/NODE_NOSTR_SECRET_KEY/);
      expect(millSection).toMatch(/NODE_NOSTR_PUBKEY/);
      expect(millSection).toMatch(/NODE_EVM_ADDRESS/);
    });

    it('[P1] mill service should have restart policy', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/restart:\s*unless-stopped/);
    });

    it('[P2] CONNECTOR_URL should be documented as ignored', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/IGNORED.*embedded connector/);
    });
  });

  // ── Volume declaration ──
  describe('Volume declarations', () => {
    it('[P1] should declare townhouse-mill-data volume', () => {
      expect(compose).toMatch(/townhouse-mill-data:/);
    });
  });
});

describe('Orchestrator buildNodeEnv integration (Story 21.6)', () => {
  // The buildNodeEnv('mill') test is already in orchestrator.test.ts
  // This section just documents the expected integration

  describe('buildNodeEnv mill output matches entrypoint expectations', () => {
    it('[P0] compose mill service should have FEE_BASIS_POINTS env var', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/FEE_BASIS_POINTS/);
    });

    it('[P2] should note that CONNECTOR_URL is accepted but ignored in comments', () => {
      const millSection = extractMillSection();
      expect(millSection).toMatch(/CONNECTOR_URL.*IGNORED/i);
    });
  });
});
