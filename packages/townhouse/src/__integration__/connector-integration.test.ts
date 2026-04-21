/**
 * Integration Tests: Connector + Node communication (Story 21.3)
 *
 * Test IDs map to test-design-epic-21.md scenarios T-017, T-018, T-020, T-022.
 *
 * These tests REQUIRE real Docker daemon running.
 * Skip in CI by default: only run when RUN_DOCKER_INTEGRATION=1 is set.
 *
 * These tests verify:
 * - AC #2: Connector started first, health-checked before nodes
 * - AC #3: Node add/remove triggers connector restart with updated peers
 * - AC #4: Connector admin API responds with peer list
 * - AC #6: Integration test — connector + one node communicating over Docker network
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { DockerOrchestrator } from '../docker/orchestrator.js';
import { ConnectorAdminClient } from '../connector/admin-client.js';
import { getDefaultConfig } from '../config/defaults.js';
import type { TownhouseConfig } from '../config/schema.js';

// Skip entire suite unless RUN_DOCKER_INTEGRATION is set
const shouldRun = process.env['RUN_DOCKER_INTEGRATION'] === '1';

describe.skipIf(!shouldRun)(
  'Connector Integration (requires Docker)',
  () => {
    let orchestrator: DockerOrchestrator;
    let adminClient: ConnectorAdminClient;
    let config: TownhouseConfig;

    beforeAll(async () => {
      config = getDefaultConfig();
      config.nodes.town.enabled = true;
      config.connector.adminPort = 9401;
      config.transport.mode = 'direct';

      const Docker = (await import('dockerode')).default;
      const docker = new Docker();
      orchestrator = new DockerOrchestrator(docker, config);
      adminClient = new ConnectorAdminClient('http://localhost:9401');

      await orchestrator.up(['town']);
    }, 120000);

    afterAll(async () => {
      await orchestrator.down();
    }, 60000);

    // ── T-017: Connector started first and health-checked before nodes ──

    describe('startup sequence (T-017)', () => {
      it('starts connector + Town node and both are running', async () => {
        const statuses = await orchestrator.status();

        const connectorStatus = statuses.find((s) => s.name === 'connector');
        const townStatus = statuses.find((s) => s.name === 'town');

        expect(connectorStatus?.state).toBe('running');
        expect(connectorStatus?.health).toBe('healthy');
        expect(townStatus?.state).toBe('running');
      }, 60000);

      it('connector and Town are on same Docker network', async () => {
        const Docker = (await import('dockerode')).default;
        const docker = new Docker();
        const networks = await docker.listNetworks();
        const townhouseNet = networks.find(
          (n: { Name: string }) => n.Name === 'townhouse-net'
        );
        expect(townhouseNet).toBeDefined();

        const netInfo = await docker
          .getNetwork(townhouseNet!.Id)
          .inspect();
        const containerNames = Object.values(
          netInfo.Containers || {}
        ).map((c: any) => c.Name);
        expect(containerNames).toContain('townhouse-connector');
        expect(containerNames).toContain('townhouse-town');
      }, 30000);
    });

    // ── T-020: Connector admin API returns valid JSON ──

    describe('admin API (T-020)', () => {
      it('connector admin API responds to health check', async () => {
        const health = await adminClient.getHealth();
        expect(health.status).toBe('healthy');
        expect(health.uptime).toBeGreaterThan(0);
      }, 10000);

      it('connector admin API returns peer list including Town', async () => {
        const peers = await adminClient.getPeers();
        expect(peers.length).toBeGreaterThanOrEqual(1);
        const townPeer = peers.find((p) => p.id === 'town');
        expect(townPeer).toBeDefined();
        expect(townPeer?.connected).toBe(true);
      }, 10000);

      it('connector admin API returns metrics', async () => {
        const metrics = await adminClient.getMetrics();
        expect(metrics.packetsForwarded).toBeGreaterThanOrEqual(0);
        expect(metrics.packetsRejected).toBeGreaterThanOrEqual(0);
        expect(metrics.bytesSent).toBeGreaterThanOrEqual(0);
      }, 10000);
    });

    // ── T-018: Node add/remove triggers connector restart with updated peers ──

    describe('node addition (T-018)', () => {
      it('addNode(mill) updates connector peer list to include both Town and Mill', async () => {
        await orchestrator.addNode('mill');

        // Give connector a moment to stabilize
        const peers = await adminClient.getPeers();
        const peerIds = peers.map((p) => p.id);
        expect(peerIds).toContain('town');
        expect(peerIds).toContain('mill');
      }, 30000);
    });

    describe('node removal (T-018)', () => {
      it('removeNode(mill) updates connector peer list to only include Town', async () => {
        await orchestrator.removeNode('mill');

        const peers = await adminClient.getPeers();
        const peerIds = peers.map((p) => p.id);
        expect(peerIds).toContain('town');
        expect(peerIds).not.toContain('mill');
      }, 30000);
    });

    // ── T-022: Connector restart completes within 5s ──

    describe('restart performance (T-022)', () => {
      it('connector restart completes within 5 seconds', async () => {
        const start = Date.now();
        await orchestrator.regenerateConnectorConfig(['town']);
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(5000);
      }, 10000);
    });
  }
);
