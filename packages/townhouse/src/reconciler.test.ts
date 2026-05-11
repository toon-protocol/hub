/**
 * Unit tests for BootReconciler (Story 46.1).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BootReconciler } from './reconciler.js';
import { writeNodesYaml, type NodesYamlEntry } from './state/nodes-yaml.js';
import type { PeerStatus } from './connector/types.js';

const ENABLED_AT = '2026-05-10T12:00:00Z';

function entry(overrides: Partial<NodesYamlEntry> = {}): NodesYamlEntry {
  return {
    id: 'town-01',
    type: 'town',
    peerId: 'peer-town-01',
    ilpAddress: 'g.toon.peer.town01',
    derivationIndex: 0,
    enabledAt: ENABLED_AT,
    lastSeenAt: null,
    ...overrides,
  };
}

function peer(overrides: Partial<PeerStatus> = {}): PeerStatus {
  return {
    id: 'peer-town-01',
    connected: true,
    ilpAddresses: ['g.toon.peer.town01'],
    routeCount: 1,
    ...overrides,
  };
}

interface StubAdminClient {
  getPeers: ReturnType<typeof vi.fn>;
  registerPeer: ReturnType<typeof vi.fn>;
}

function makeStubClient(
  opts: {
    peers?: PeerStatus[];
    getPeersError?: Error;
    registerPeerError?: Error;
  } = {}
): StubAdminClient {
  return {
    getPeers: vi.fn(async () => {
      if (opts.getPeersError) throw opts.getPeersError;
      return opts.peers ?? [];
    }),
    registerPeer: vi.fn(async () => {
      if (opts.registerPeerError) throw opts.registerPeerError;
    }),
  };
}

describe('BootReconciler', () => {
  let dir: string;
  let yamlPath: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reconciler-test-'));
    yamlPath = join(dir, 'nodes.yaml');
    logPath = join(dir, 'reconciler.log');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no-ops when both yaml and connector peers are empty', async () => {
    const client = makeStubClient({ peers: [] });
    const r = new BootReconciler(client, yamlPath, logPath);
    await r.reconcile();

    expect(client.registerPeer).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);
  });

  it('re-registers a yaml entry missing from the connector peer list', async () => {
    await writeNodesYaml(yamlPath, { entries: [entry()] });
    const client = makeStubClient({ peers: [] });
    const r = new BootReconciler(client, yamlPath, logPath);
    await r.reconcile();

    expect(client.registerPeer).toHaveBeenCalledTimes(1);
    expect(client.registerPeer).toHaveBeenCalledWith({
      id: 'peer-town-01',
      url: 'ws://townhouse-town:3000',
      authToken: '',
      routes: [{ prefix: 'g.toon.peer.town01', priority: 0 }],
    });

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('"action":"reregistered"');
    expect(log).toContain('"peerId":"peer-town-01"');
  });

  it('logs a connector peer with no yaml entry as external (no deregistration)', async () => {
    // yaml has nothing; connector has one peer
    const client = makeStubClient({
      peers: [peer({ id: 'peer-rogue-99' })],
    });
    const r = new BootReconciler(client, yamlPath, logPath);
    await r.reconcile();

    expect(client.registerPeer).not.toHaveBeenCalled();

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('"action":"external"');
    expect(log).toContain('"peerId":"peer-rogue-99"');
  });

  it('does nothing when yaml and connector peers match', async () => {
    await writeNodesYaml(yamlPath, { entries: [entry()] });
    const client = makeStubClient({ peers: [peer()] });
    const r = new BootReconciler(client, yamlPath, logPath);
    await r.reconcile();

    expect(client.registerPeer).not.toHaveBeenCalled();
    expect(existsSync(logPath)).toBe(false);
  });

  it('handles mixed divergences in a single pass (re-register + external)', async () => {
    await writeNodesYaml(yamlPath, {
      entries: [
        entry(),
        entry({
          id: 'mill-01',
          type: 'mill',
          peerId: 'peer-mill-01',
          ilpAddress: 'g.toon.peer.mill01',
          derivationIndex: 1,
        }),
      ],
    });
    const client = makeStubClient({
      peers: [peer({ id: 'peer-mill-01' }), peer({ id: 'peer-rogue-99' })],
    });
    const r = new BootReconciler(client, yamlPath, logPath);
    await r.reconcile();

    // Only peer-town-01 missing from connector → re-registered.
    expect(client.registerPeer).toHaveBeenCalledTimes(1);
    expect(client.registerPeer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'peer-town-01' })
    );

    const log = readFileSync(logPath, 'utf-8');
    const lines = log
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    const actions = lines.map((l) => `${l.peerId}:${l.action}`).sort();
    expect(actions).toEqual([
      'peer-rogue-99:external',
      'peer-town-01:reregistered',
    ]);
  });

  it('records reregister-failed when registerPeer rejects', async () => {
    await writeNodesYaml(yamlPath, { entries: [entry()] });
    const client = makeStubClient({
      peers: [],
      registerPeerError: new Error('Connector admin API error: 500'),
    });
    const r = new BootReconciler(client, yamlPath, logPath);
    // Re-registration failure is logged but does not throw — reconciler
    // divergence is non-fatal at the wire point in cli.ts.
    await r.reconcile();

    const log = readFileSync(logPath, 'utf-8');
    expect(log).toContain('"action":"reregister-failed"');
    expect(log).toContain('500');
  });

  it('surfaces (does not swallow) getPeers() failures', async () => {
    await writeNodesYaml(yamlPath, { entries: [entry()] });
    const client = makeStubClient({
      getPeersError: new Error(
        'Connector admin API connection refused: ECONNREFUSED'
      ),
    });
    const r = new BootReconciler(client, yamlPath, logPath);
    await expect(r.reconcile()).rejects.toThrow('ECONNREFUSED');
  });

  it('writes ISO-8601 timestamps to each log line', async () => {
    await writeNodesYaml(yamlPath, { entries: [entry()] });
    const client = makeStubClient({ peers: [] });
    const r = new BootReconciler(client, yamlPath, logPath);
    await r.reconcile();

    const log = readFileSync(logPath, 'utf-8');
    const parsed = JSON.parse(log.trim().split('\n')[0] ?? '{}') as {
      timestamp: string;
    };
    // ISO-8601: YYYY-MM-DDTHH:MM:SS.sssZ
    expect(parsed.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    // Round-trip parse → same wall-clock string.
    expect(new Date(parsed.timestamp).toISOString()).toBe(parsed.timestamp);
  });

  it('appends to (does not truncate) an existing log file', async () => {
    await writeNodesYaml(yamlPath, { entries: [entry()] });
    const client = makeStubClient({ peers: [] });
    const r = new BootReconciler(client, yamlPath, logPath);
    await r.reconcile();
    await r.reconcile();

    const log = readFileSync(logPath, 'utf-8');
    const lines = log.trim().split('\n');
    expect(lines).toHaveLength(2);
  });
});
