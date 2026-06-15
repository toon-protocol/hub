/**
 * Boot rebinder tests — auto-rebind of provisioned child containers on `hs up`.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type Mock,
} from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import { rebindChildContainers, type RebindWallet } from './rebind.js';
import { getDefaultConfig } from './config/index.js';
import type { TownhouseConfig } from './config/schema.js';
import { writeNodesYaml, type NodesYamlEntry } from './state/nodes-yaml.js';
import type { NodeType } from './api/types.js';

const FAKE_KEYS = {
  nostrPubkey: 'a'.repeat(64),
  nostrSecretKey: new Uint8Array(32).fill(0x11),
  evmAddress: '0x' + 'a'.repeat(40),
  evmPrivateKey: new Uint8Array(32).fill(0x22),
  nostrDerivationPath: "m/44'/1237'/0'/0/0",
  evmDerivationPath: "m/44'/60'/0'/0/0",
};

const FAKE_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

function makeWallet(over: Partial<RebindWallet> = {}): {
  wallet: RebindWallet;
  deriveNodeKey: Mock;
  getMnemonic: Mock;
} {
  const deriveNodeKey = vi
    .fn()
    .mockImplementation((_t: NodeType, _i: number) =>
      Promise.resolve({ ...FAKE_KEYS })
    );
  const getMnemonic = vi.fn().mockReturnValue(FAKE_MNEMONIC);
  const wallet: RebindWallet = {
    deriveNodeKey: deriveNodeKey as RebindWallet['deriveNodeKey'],
    getMnemonic: getMnemonic as RebindWallet['getMnemonic'],
    getNodeKeys: vi
      .fn()
      .mockReturnValue(FAKE_KEYS) as RebindWallet['getNodeKeys'],
    ...over,
  };
  return { wallet, deriveNodeKey, getMnemonic };
}

function entry(type: NodeType, derivationIndex: number): NodesYamlEntry {
  return {
    id: type,
    type,
    peerId: type,
    ilpAddress: `g.townhouse.${type}`,
    derivationIndex,
    enabledAt: new Date().toISOString(),
    lastSeenAt: null,
  };
}

let homeDir: string;
let nodesYamlPath: string;
let startNodeViaCompose: Mock;

beforeEach(async () => {
  homeDir = await fs.mkdtemp(join(tmpdir(), 'townhouse-rebind-test-'));
  nodesYamlPath = join(homeDir, 'nodes.yaml');
  startNodeViaCompose = vi.fn().mockResolvedValue(undefined);
});

afterEach(async () => {
  await fs.rm(homeDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

/** config with mill relays set, so mill is rebindable by default. */
function configWithRelays(relays = ['wss://relay.example']): TownhouseConfig {
  const base = getDefaultConfig();
  return {
    ...base,
    nodes: {
      ...base.nodes,
      mill: { ...base.nodes.mill, relays },
    },
  };
}

describe('rebindChildContainers', () => {
  it('no-op when nodes.yaml does not exist — wallet never touched', async () => {
    const { wallet, deriveNodeKey } = makeWallet();
    const summary = await rebindChildContainers({
      nodesYamlPath,
      wallet,
      orchestrator: { startNodeViaCompose },
      config: getDefaultConfig(),
    });

    expect(summary).toEqual({ started: [], skipped: [], failed: [] });
    expect(deriveNodeKey).not.toHaveBeenCalled();
    expect(startNodeViaCompose).not.toHaveBeenCalled();
  });

  it('rebinds town + mill + dvm with reconstructed env', async () => {
    vi.stubEnv('TURBO_TOKEN', '');
    await writeNodesYaml(nodesYamlPath, {
      entries: [entry('town', 0), entry('mill', 1), entry('dvm', 2)],
    });
    const { wallet } = makeWallet();

    const summary = await rebindChildContainers({
      nodesYamlPath,
      wallet,
      orchestrator: { startNodeViaCompose },
      config: configWithRelays(['wss://relay.a', 'wss://relay.b']),
    });

    expect(summary.started.sort()).toEqual(['dvm', 'mill', 'town']);
    expect(summary.skipped).toEqual([]);
    expect(summary.failed).toEqual([]);

    // town gets identity + settlement key
    expect(startNodeViaCompose).toHaveBeenCalledWith(
      'town',
      expect.objectContaining({
        TOWN_SECRET_KEY: expect.any(String),
        TOWN_SETTLEMENT_PRIVATE_KEY: expect.stringMatching(/^0x/),
      })
    );
    // mill gets relays joined from config
    expect(startNodeViaCompose).toHaveBeenCalledWith(
      'mill',
      expect.objectContaining({ MILL_RELAYS: 'wss://relay.a,wss://relay.b' })
    );
  });

  it('derives each node with its own derivationIndex from nodes.yaml', async () => {
    await writeNodesYaml(nodesYamlPath, {
      entries: [entry('town', 0), entry('mill', 1)],
    });
    const { wallet, deriveNodeKey } = makeWallet();

    await rebindChildContainers({
      nodesYamlPath,
      wallet,
      orchestrator: { startNodeViaCompose },
      config: configWithRelays(),
    });

    expect(deriveNodeKey).toHaveBeenCalledWith('town', 0);
    expect(deriveNodeKey).toHaveBeenCalledWith('mill', 1);
  });

  it('skips mill when no relays resolve (config empty + MILL_RELAYS unset)', async () => {
    vi.stubEnv('MILL_RELAYS', '');
    await writeNodesYaml(nodesYamlPath, {
      entries: [entry('town', 0), entry('mill', 1)],
    });
    const { wallet } = makeWallet();

    const summary = await rebindChildContainers({
      nodesYamlPath,
      wallet,
      orchestrator: { startNodeViaCompose },
      config: getDefaultConfig(), // no mill.relays
    });

    expect(summary.started).toEqual(['town']);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0].id).toBe('mill');
    expect(summary.skipped[0].reason).toMatch(/relays/);
    expect(startNodeViaCompose).not.toHaveBeenCalledWith(
      'mill',
      expect.anything()
    );
  });

  it('skips ALL nodes when the wallet is locked (getMnemonic null)', async () => {
    await writeNodesYaml(nodesYamlPath, {
      entries: [entry('town', 0), entry('mill', 1)],
    });
    const { wallet, deriveNodeKey } = makeWallet({
      getMnemonic: vi.fn().mockReturnValue(null) as RebindWallet['getMnemonic'],
    });

    const summary = await rebindChildContainers({
      nodesYamlPath,
      wallet,
      orchestrator: { startNodeViaCompose },
      config: configWithRelays(),
    });

    expect(summary.started).toEqual([]);
    expect(summary.skipped.map((s) => s.id).sort()).toEqual(['mill', 'town']);
    expect(summary.skipped.every((s) => /locked/.test(s.reason))).toBe(true);
    // No key derivation or container start attempted on a locked wallet.
    expect(deriveNodeKey).not.toHaveBeenCalled();
    expect(startNodeViaCompose).not.toHaveBeenCalled();
  });

  it('records a per-node failure without aborting the rest', async () => {
    await writeNodesYaml(nodesYamlPath, {
      entries: [entry('town', 0), entry('dvm', 2)],
    });
    const { wallet } = makeWallet();
    startNodeViaCompose.mockImplementation((type: NodeType) =>
      type === 'town'
        ? Promise.reject(new Error('compose boom'))
        : Promise.resolve(undefined)
    );

    const summary = await rebindChildContainers({
      nodesYamlPath,
      wallet,
      orchestrator: { startNodeViaCompose },
      config: configWithRelays(),
    });

    expect(summary.started).toEqual(['dvm']);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({ id: 'town' });
    expect(summary.failed[0].err).toMatch(/compose boom/);
  });

  it('injects dvm TURBO_TOKEN from config when present', async () => {
    vi.stubEnv('TURBO_TOKEN', '');
    await writeNodesYaml(nodesYamlPath, { entries: [entry('dvm', 2)] });
    const { wallet } = makeWallet();
    const base = getDefaultConfig();
    const config: TownhouseConfig = {
      ...base,
      nodes: {
        ...base.nodes,
        dvm: { ...base.nodes.dvm, turboToken: '{"kty":"RSA"}' },
      },
    };

    await rebindChildContainers({
      nodesYamlPath,
      wallet,
      orchestrator: { startNodeViaCompose },
      config,
    });

    expect(startNodeViaCompose).toHaveBeenCalledWith(
      'dvm',
      expect.objectContaining({ TURBO_TOKEN: '{"kty":"RSA"}' })
    );
  });
});
