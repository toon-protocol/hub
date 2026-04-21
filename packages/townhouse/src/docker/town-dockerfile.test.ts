/**
 * Unit Tests: Town Node Dockerfile & Entrypoint (Story 21.5)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-032 through T-042.
 * TDD Red Phase — all tests use it() because implementation does not exist yet.
 *
 * These tests verify:
 * - AC #1: Dockerfile builds successfully (multi-stage, correct CMD, EXPOSE, HEALTHCHECK)
 * - AC #2: Container accepts CONNECTOR_URL via environment variable
 * - AC #4: Health endpoint at /health (HEALTHCHECK in Dockerfile)
 * - AC #5: Exposes relay WebSocket port 7100
 * - AC #6: Write-fee configuration via FEE_PER_EVENT
 * - AC #7: Compose stack integration (env var mapping from orchestrator)
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Paths relative to repo root (tests run from packages/townhouse/)
const REPO_ROOT = resolve(import.meta.dirname, '../../../../');
const DOCKERFILE_PATH = resolve(REPO_ROOT, 'docker/Dockerfile.town');
const ENTRYPOINT_PATH = resolve(REPO_ROOT, 'docker/src/entrypoint-town.ts');
const COMPOSE_PATH = resolve(REPO_ROOT, 'docker-compose-townhouse.yml');

// Cache file contents to avoid redundant synchronous reads across tests
const dockerfile = readFileSync(DOCKERFILE_PATH, 'utf-8');
const entrypoint = readFileSync(ENTRYPOINT_PATH, 'utf-8');
const compose = readFileSync(COMPOSE_PATH, 'utf-8');

/**
 * Helper: extract the compose town service section.
 * Asserts the section is non-empty to prevent silent false passes
 * if the compose file structure changes.
 */
function extractTownSection(): string {
  const section = compose.split(/^ {2}town:/m)[1]?.split(/^ {2}\w+:/m)[0] ?? '';
  // Guard: fail loudly if parsing produced empty section
  if (section.length === 0) {
    throw new Error(
      'Failed to extract town section from docker-compose-townhouse.yml — file structure may have changed'
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

describe('Town Node Dockerfile (Story 21.5)', () => {
  // ── T-032: Dockerfile builds from repo root ──
  describe('T-032: Dockerfile structure', () => {
    it('[P0] should use multi-stage build with node:20-alpine builder', () => {
      expect(dockerfile).toMatch(/FROM node:20-alpine AS builder/);
    });

    it('[P0] should have minimal runtime stage with node:20-alpine', () => {
      // Second FROM (runtime stage) must also be node:20-alpine
      const fromStatements = dockerfile.match(/^FROM .+$/gm) ?? [];
      expect(fromStatements.length).toBeGreaterThanOrEqual(2);
      expect(fromStatements[fromStatements.length - 1]).toMatch(/node:20-alpine/);
    });

    it('[P0] should install pnpm 8.15.0 in builder stage', () => {
      expect(dockerfile).toMatch(/corepack prepare pnpm@8\.15\.0/);
    });

    it('[P0] should use esbuild to bundle entrypoint-town.ts', () => {
      expect(dockerfile).toMatch(/esbuild.*entrypoint-town\.ts/);
      expect(dockerfile).toMatch(/--external:better-sqlite3/);
    });
  });

  // ── T-041: CMD points to correct entrypoint ──
  describe('T-041: CMD configuration', () => {
    it('[P0] should have CMD pointing to entrypoint-town.js', () => {
      expect(dockerfile).toMatch(/CMD.*entrypoint-town\.js/);
    });
  });

  // ── T-042: Multi-stage build with minimal final image ──
  describe('T-042: Runtime image minimization', () => {
    it('[P1] should run as non-root user toon', () => {
      expect(dockerfile).toMatch(/USER toon/);
      expect(dockerfile).toMatch(/adduser.*toon/);
    });

    it('[P1] should install libstdc++ for native module support', () => {
      // Runtime stage should have libstdc++
      const runtimeSection = dockerfile.split(/^FROM node:20-alpine\s*$/m).pop() ?? '';
      expect(runtimeSection).toMatch(/apk add.*libstdc\+\+/);
    });

    it('[P1] should set ESM package.json with type module', () => {
      expect(dockerfile).toMatch(/\{"type":"module"\}/);
    });
  });

  // ── T-035: Health endpoint ──
  describe('T-035: HEALTHCHECK configuration', () => {
    it('[P0] should have HEALTHCHECK targeting /health on BLS port', () => {
      expect(dockerfile).toMatch(/HEALTHCHECK/);
      expect(dockerfile).toMatch(/\/health/);
    });
  });

  // ── Ports: AC #4, #5 ──
  describe('Port exposure', () => {
    it('[P0] should EXPOSE 3000 3100 7100 (BTP + BLS + Relay WS)', () => {
      expect(dockerfile).toMatch(/EXPOSE.*3000/);
      expect(dockerfile).toMatch(/EXPOSE.*3100/);
      expect(dockerfile).toMatch(/EXPOSE.*7100/);
    });
  });

  // ── Volume for persistent data ──
  describe('Data volume', () => {
    it('[P1] should declare VOLUME /data for persistent storage', () => {
      expect(dockerfile).toMatch(/VOLUME.*\/data/);
    });
  });
});

describe('Town Entrypoint Adapter (Story 21.5)', () => {
  // ── T-038: Container accepts CONNECTOR_URL env var ──
  describe('T-038: Env var mapping', () => {
    it('[P0] should map CONNECTOR_URL to TOON_CONNECTOR_URL', () => {
      expect(entrypoint).toMatch(/CONNECTOR_URL/);
      expect(entrypoint).toMatch(/TOON_CONNECTOR_URL/);
    });

    it('[P0] should map NODE_NOSTR_SECRET_KEY to TOON_SECRET_KEY', () => {
      expect(entrypoint).toMatch(/NODE_NOSTR_SECRET_KEY/);
      expect(entrypoint).toMatch(/TOON_SECRET_KEY/);
    });

    it('[P1] should map BLS_PORT to TOON_BLS_PORT with default 3100', () => {
      expect(entrypoint).toMatch(/BLS_PORT/);
      expect(entrypoint).toMatch(/TOON_BLS_PORT/);
      expect(entrypoint).toMatch(/3100/);
    });

    it('[P1] should map WS_PORT to TOON_RELAY_PORT with default 7100', () => {
      expect(entrypoint).toMatch(/WS_PORT/);
      expect(entrypoint).toMatch(/TOON_RELAY_PORT/);
      expect(entrypoint).toMatch(/7100/);
    });

    it('[P1] should set TOON_DATA_DIR to /data', () => {
      expect(entrypoint).toMatch(/TOON_DATA_DIR/);
      expect(entrypoint).toMatch(/\/data/);
    });

    it('[P1] should map DEV_MODE=true to TOON_DEV_MODE=true', () => {
      expect(entrypoint).toMatch(/DEV_MODE/);
      expect(entrypoint).toMatch(/TOON_DEV_MODE/);
    });
  });

  // ── T-039: FEE_PER_EVENT env var ──
  describe('T-039: Fee configuration', () => {
    it('[P0] should map FEE_PER_EVENT to TOON_FEE_PER_EVENT', () => {
      expect(entrypoint).toMatch(/FEE_PER_EVENT/);
      expect(entrypoint).toMatch(/TOON_FEE_PER_EVENT/);
    });
  });

  // ── Graceful shutdown ──
  describe('Process lifecycle', () => {
    it('[P1] should handle SIGTERM for graceful shutdown', () => {
      expect(entrypoint).toMatch(/SIGTERM/);
    });
  });
});

describe('Orchestrator buildNodeEnv integration (Story 21.5)', () => {
  // ── T-038/T-039: buildNodeEnv('town') produces expected env vars ──
  describe('buildNodeEnv town output matches entrypoint expectations', () => {
    it('[P0] should produce CONNECTOR_URL env var', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/CONNECTOR_URL/);
    });

    it('[P0] should produce FEE_PER_EVENT env var', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/FEE_PER_EVENT/);
    });

    it('[P1] should have healthcheck in compose town service', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/healthcheck/);
    });

    it('[P1] should have volume mount for persistent data', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/town.*data.*:.*\/data/i);
    });

    it('[P1] should expose relay WS port 7100 to host', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/7100:7100/);
    });

    it('[P1] should expose BLS port 3100 to host', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/3100:3100/);
    });

    it('[P2] should include identity env var placeholders (NODE_NOSTR_SECRET_KEY)', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/NODE_NOSTR_SECRET_KEY/);
    });
  });
});

describe('Compose stack integration (Story 21.5, AC #3 + #7)', () => {
  // ── AC #3: Registers as peer with standalone connector on startup ──
  describe('AC #3: Connector peer registration', () => {
    it('[P0] connector CONNECTOR_PEERS should include town with btp+ws://townhouse-town:3000', () => {
      const connectorSection = extractConnectorSection();
      expect(connectorSection).toMatch(/townhouse-town:3000/);
    });

    it('[P1] connector CONNECTOR_PEERS town entry should have relation child', () => {
      const connectorSection = extractConnectorSection();
      // The CONNECTOR_PEERS JSON should include town with relation=child
      expect(connectorSection).toMatch(/"id"\s*:\s*"town"/);
      expect(connectorSection).toMatch(/"relation"\s*:\s*"child"/);
    });
  });

  // ── AC #7: Image builds and starts in townhouse compose stack ──
  describe('AC #7: Compose stack configuration', () => {
    it('[P0] town service should use townhouse-net network', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/townhouse-net/);
    });

    it('[P0] town service should depend on connector being healthy', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/depends_on/);
      expect(townSection).toMatch(/connector/);
      expect(townSection).toMatch(/service_healthy/);
    });

    it('[P1] town service should use image toon:town', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/image:\s*toon:town/);
    });

    it('[P1] town service should have container_name townhouse-town', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/container_name:\s*townhouse-town/);
    });

    it('[P1] town service should be in town profile', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/profiles/);
      expect(townSection).toMatch(/- town/);
    });

    it('[P1] town service should expose BTP port 3000 internally for connector', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/expose/);
      expect(townSection).toMatch(/['"]?3000['"]?/);
    });

    it('[P1] town service should have restart policy', () => {
      const townSection = extractTownSection();
      expect(townSection).toMatch(/restart:\s*unless-stopped/);
    });
  });
});
