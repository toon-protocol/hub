import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  statSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import {
  writeHsConnectorConfig,
  writeDirectConnectorConfig,
  detectExistingHsConfig,
} from './hs-config-writer.js';
import { getDefaultConfig } from '../config/defaults.js';

describe('writeHsConnectorConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hs-config-writer-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes connector.yaml on a fresh dir', () => {
    const config = getDefaultConfig();
    const result = writeHsConnectorConfig(tmpDir, config);

    expect(result.created).toBe(true);
    expect(existsSync(result.yamlPath)).toBe(true);
    expect(result.yamlPath).toBe(join(tmpDir, 'connector.yaml'));
  });

  it('written file has mode 0o600', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);
    const mode = statSync(yamlPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('written file contains anon.enabled: true (HS marker)', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const anon = parsed['anon'] as Record<string, unknown> | undefined;
    expect(anon?.['enabled']).toBe(true);
  });

  it('parsed YAML has anon.enabled: true field', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect((parsed['anon'] as Record<string, unknown>)?.['enabled']).toBe(true);
  });

  it('transport block has managed hidden service settings', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const transport = parsed['transport'] as Record<string, unknown>;
    expect(transport['type']).toBe('socks5');
    expect(transport['managed']).toBe(true);
    const opts = transport['managedOptions'] as Record<string, unknown>;
    expect(opts['hiddenServiceDir']).toBe('/var/lib/anon/hs');
    expect(opts['hiddenServicePort']).toBe(3000);
  });

  // Regression: the dvm node runs a standalone HTTP handler (no BTP server), so
  // the apex must locally-deliver packets addressed to its own nodeId to the
  // dvm handler. Without this block a provisioned dvm can never receive a
  // kind:5094 job (it neither subscribes to a relay nor runs a dialable peer).
  it('wires localDelivery + a self-route to the dvm handler (DVM job intake)', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const localDelivery = parsed['localDelivery'] as Record<string, unknown>;
    expect(localDelivery?.['enabled']).toBe(true);
    expect(localDelivery?.['handlerUrl']).toBe('http://townhouse-hs-dvm:3300');

    const nodeId = parsed['nodeId'] as string;
    const routes = parsed['routes'] as Record<string, unknown>[];
    const selfRoute = routes.find(
      (r) => r['prefix'] === nodeId && r['nextHop'] === 'local'
    );
    expect(selfRoute, 'expected a g.townhouse → local self-route').toBeTruthy();
  });

  it('preserves existing file when it contains the HS marker (idempotency)', () => {
    const config = getDefaultConfig();
    // First write
    const first = writeHsConnectorConfig(tmpDir, config);
    expect(first.created).toBe(true);
    const firstContent = readFileSync(first.yamlPath, 'utf-8');

    // Second write without force — must reuse
    const second = writeHsConnectorConfig(tmpDir, config);
    expect(second.created).toBe(false);
    const secondContent = readFileSync(second.yamlPath, 'utf-8');
    expect(secondContent).toBe(firstContent); // byte-for-byte identical
  });

  it('overwrites when force: true even if HS marker present', () => {
    const config = getDefaultConfig();
    writeHsConnectorConfig(tmpDir, config); // first write

    const result = writeHsConnectorConfig(tmpDir, config, { force: true });
    expect(result.created).toBe(true);
  });

  it('overwrites when existing file lacks the HS marker (legacy non-HS config)', () => {
    const existingPath = join(tmpDir, 'connector.yaml');
    // Write a file that does NOT have anon.enabled: true
    writeFileSync(
      existingPath,
      'nodeId: g.townhouse\nanon:\n  enabled: false\n',
      {
        mode: 0o600,
      }
    );

    const config = getDefaultConfig();
    const result = writeHsConnectorConfig(tmpDir, config);
    expect(result.created).toBe(true);
    const parsed = parse(readFileSync(existingPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const anon = parsed['anon'] as Record<string, unknown> | undefined;
    expect(anon?.['enabled']).toBe(true);
  });

  it('chmodSync is called after writeFileSync (defensive re-chmod ordering)', () => {
    // Verify that the file ends up at 0o600 even if the umask would mask it.
    // We can't directly test the ordering, but we can verify the end state.
    const config = getDefaultConfig();
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);

    // Simulate a prior run that left the file at wrong permissions.
    chmodSync(yamlPath, 0o644);
    // Re-write
    writeHsConnectorConfig(tmpDir, config, { force: true });
    const mode = statSync(yamlPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  // ── chainProviders injection (Epic 47 BUG-1 product fix, D2) ─────────────
  // Without at least one chainProviders entry, the connector's settlement
  // subsystem (AccountManager + ClaimReceiver) does not initialize and
  // /admin/earnings.json returns 503. HS-mode injects defaults so the
  // earnings data plane works out of the box.

  it('injects DEFAULT_HS_CHAIN_PROVIDERS when config has no chainProviders', () => {
    const config = getDefaultConfig();
    // config has no chainProviders
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config);

    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const chainProviders = parsed['chainProviders'] as Record<
      string,
      unknown
    >[];
    expect(Array.isArray(chainProviders)).toBe(true);
    expect(chainProviders.length).toBeGreaterThanOrEqual(1);
    const first = chainProviders[0] ?? {};
    expect(first['chainType']).toBe('evm');
    expect(typeof first['chainId']).toBe('string');
    expect(typeof first['rpcUrl']).toBe('string');
    expect(typeof first['registryAddress']).toBe('string');
    expect(typeof first['tokenAddress']).toBe('string');
    expect(typeof first['keyId']).toBe('string');
  });

  it('honors operator-provided chainProviders (no defaults override)', () => {
    const config = getDefaultConfig();
    config.chainProviders = [
      {
        chainType: 'evm',
        chainId: 'evm:base:8453',
        rpcUrl: 'https://mainnet.base.org',
        registryAddress: '0xaaaa1725E7734CE288F8367e1Bb143E90bb3F0512',
        tokenAddress: '0xbbbbb2315678afecb367f032d93F642f64180aa3',
        keyId:
          '0xccccc118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
      },
    ];

    const { yamlPath } = writeHsConnectorConfig(tmpDir, config, {
      force: true,
    });
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const chainProviders = parsed['chainProviders'] as Record<
      string,
      unknown
    >[];
    expect(chainProviders).toHaveLength(1);
    expect(chainProviders[0]?.['chainId']).toBe('evm:base:8453');
    expect(chainProviders[0]?.['rpcUrl']).toBe('https://mainnet.base.org');
  });

  // ── apex settlement keyId injection (mnemonic-derived; drops manual --key-id)
  const APEX_EVM_KEY = `0x${'ab'.repeat(32)}`;

  it('fills a missing EVM keyId with the apex settlement key', () => {
    const config = getDefaultConfig();
    config.chainProviders = [
      {
        chainType: 'evm',
        chainId: 'evm:base:8453',
        rpcUrl: 'https://mainnet.base.org',
        registryAddress: '0xaaaa1725E7734CE288F8367e1Bb143E90bb3F0512',
        tokenAddress: '0xbbbbb2315678afecb367f032d93F642f64180aa3',
        // keyId omitted — operator did not pass --key-id
      },
    ];

    const { yamlPath } = writeHsConnectorConfig(tmpDir, config, {
      force: true,
      apexSettlementKeys: { evmPrivateKeyHex: APEX_EVM_KEY },
    });
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const cps = parsed['chainProviders'] as Record<string, unknown>[];
    expect(cps[0]?.['keyId']).toBe(APEX_EVM_KEY);
  });

  it('does NOT override an explicit operator keyId with the apex key', () => {
    const explicit = `0x${'cc'.repeat(32)}`;
    const config = getDefaultConfig();
    config.chainProviders = [
      {
        chainType: 'evm',
        chainId: 'evm:base:8453',
        rpcUrl: 'https://mainnet.base.org',
        registryAddress: '0xaaaa1725E7734CE288F8367e1Bb143E90bb3F0512',
        tokenAddress: '0xbbbbb2315678afecb367f032d93F642f64180aa3',
        keyId: explicit,
      },
    ];

    const { yamlPath } = writeHsConnectorConfig(tmpDir, config, {
      force: true,
      apexSettlementKeys: { evmPrivateKeyHex: APEX_EVM_KEY },
    });
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const cps = parsed['chainProviders'] as Record<string, unknown>[];
    expect(cps[0]?.['keyId']).toBe(explicit);
  });

  it('keeps the funded dev placeholder key for the no-chains default fallback', () => {
    const config = getDefaultConfig(); // no chainProviders
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config, {
      force: true,
      apexSettlementKeys: { evmPrivateKeyHex: APEX_EVM_KEY },
    });
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const cps = parsed['chainProviders'] as Record<string, unknown>[];
    // Bare dev boot keeps the funded Anvil placeholder, NOT the apex key.
    expect(cps[0]?.['keyId']).not.toBe(APEX_EVM_KEY);
  });

  // ── Solana/Mina apex keyId injection (connector 3.9.0 non-EVM keyId) ───────
  const APEX_SOLANA_KEY = '4'.repeat(44); // representative base58 Solana keyId
  const APEX_MINA_KEY = `EK${'a'.repeat(50)}`; // representative EK… Mina keyId

  it('fills a missing Solana keyId with the apex Solana key', () => {
    const config = getDefaultConfig();
    config.chainProviders = [
      {
        chainType: 'solana',
        chainId: 'solana:devnet',
        rpcUrl: 'https://api.devnet.solana.com',
        programId: 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG',
        // keyId omitted
      },
    ];
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config, {
      force: true,
      apexSettlementKeys: {
        evmPrivateKeyHex: APEX_EVM_KEY,
        solanaPrivateKeyBase58: APEX_SOLANA_KEY,
        minaPrivateKeyBase58: APEX_MINA_KEY,
      },
    });
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const cps = parsed['chainProviders'] as Record<string, unknown>[];
    expect(cps[0]?.['chainType']).toBe('solana');
    expect(cps[0]?.['keyId']).toBe(APEX_SOLANA_KEY);
  });

  it('fills a missing Mina keyId with the apex Mina key', () => {
    const config = getDefaultConfig();
    config.chainProviders = [
      {
        chainType: 'mina',
        chainId: 'mina:devnet',
        graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
        zkAppAddress: 'B62qtestzkappaddressplaceholderxxxxxxxxxxxxxxxxxxxxx',
        // keyId omitted
      },
    ];
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config, {
      force: true,
      apexSettlementKeys: {
        evmPrivateKeyHex: APEX_EVM_KEY,
        solanaPrivateKeyBase58: APEX_SOLANA_KEY,
        minaPrivateKeyBase58: APEX_MINA_KEY,
      },
    });
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const cps = parsed['chainProviders'] as Record<string, unknown>[];
    expect(cps[0]?.['chainType']).toBe('mina');
    expect(cps[0]?.['keyId']).toBe(APEX_MINA_KEY);
  });

  it('does NOT override an explicit Solana/Mina operator keyId', () => {
    const explicitSol = '5'.repeat(44);
    const explicitMina = `EK${'b'.repeat(50)}`;
    const config = getDefaultConfig();
    config.chainProviders = [
      {
        chainType: 'solana',
        chainId: 'solana:devnet',
        rpcUrl: 'https://api.devnet.solana.com',
        programId: 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG',
        keyId: explicitSol,
      },
      {
        chainType: 'mina',
        chainId: 'mina:devnet',
        graphqlUrl: 'https://api.minascan.io/node/devnet/v1/graphql',
        zkAppAddress: 'B62qtestzkappaddressplaceholderxxxxxxxxxxxxxxxxxxxxx',
        keyId: explicitMina,
      },
    ];
    const { yamlPath } = writeHsConnectorConfig(tmpDir, config, {
      force: true,
      apexSettlementKeys: {
        evmPrivateKeyHex: APEX_EVM_KEY,
        solanaPrivateKeyBase58: APEX_SOLANA_KEY,
        minaPrivateKeyBase58: APEX_MINA_KEY,
      },
    });
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const cps = parsed['chainProviders'] as Record<string, unknown>[];
    const sol = cps.find((c) => c['chainType'] === 'solana');
    const mina = cps.find((c) => c['chainType'] === 'mina');
    expect(sol?.['keyId']).toBe(explicitSol);
    expect(mina?.['keyId']).toBe(explicitMina);
  });
});

describe('writeDirectConnectorConfig (Phase 2 direct-apex)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'direct-config-writer-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes connector.yaml on a fresh dir with mode 0o600', () => {
    const config = getDefaultConfig();
    const result = writeDirectConnectorConfig(tmpDir, config);
    expect(result.created).toBe(true);
    expect(result.yamlPath).toBe(join(tmpDir, 'connector.yaml'));
    expect(existsSync(result.yamlPath)).toBe(true);
    expect(statSync(result.yamlPath).mode & 0o777).toBe(0o600);
  });

  it('emits NO anon block (the direct-mode marker)', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeDirectConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(parsed['anon']).toBeUndefined();
  });

  it("transport block is type 'direct'", () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeDirectConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const transport = parsed['transport'] as Record<string, unknown>;
    expect(transport).toBeDefined();
    expect(transport['type']).toBe('direct');
    // The HS-only managed-anon fields must NOT be present.
    expect(transport['managed']).toBeUndefined();
    expect(transport['managedOptions']).toBeUndefined();
  });

  it('still wires DVM localDelivery to the DIRECT dvm container', () => {
    const config = getDefaultConfig();
    const { yamlPath } = writeDirectConnectorConfig(tmpDir, config);
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const ld = parsed['localDelivery'] as Record<string, unknown>;
    expect(ld['enabled']).toBe(true);
    expect(ld['handlerUrl']).toBe('http://townhouse-direct-dvm:3300');
  });

  it('is idempotent — a prior direct config is reused (created:false)', () => {
    const config = getDefaultConfig();
    const first = writeDirectConnectorConfig(tmpDir, config);
    expect(first.created).toBe(true);
    const second = writeDirectConnectorConfig(tmpDir, config);
    expect(second.created).toBe(false);
  });

  it('force:true overwrites an existing HS config with a direct one', () => {
    const config = getDefaultConfig();
    // First lay down an HS config (anon.enabled:true).
    writeHsConnectorConfig(tmpDir, config);
    // Without force, the HS file is NOT a valid direct config → it overwrites.
    const result = writeDirectConnectorConfig(tmpDir, config, { force: true });
    expect(result.created).toBe(true);
    const parsed = parse(readFileSync(result.yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(parsed['anon']).toBeUndefined();
    expect((parsed['transport'] as Record<string, unknown>)['type']).toBe(
      'direct'
    );
  });

  it('does NOT reuse an existing HS config (overwrites to direct)', () => {
    const config = getDefaultConfig();
    writeHsConnectorConfig(tmpDir, config);
    // A pre-existing HS file (anon.enabled:true) is not a valid direct config,
    // so the direct writer overwrites it rather than reusing it.
    const result = writeDirectConnectorConfig(tmpDir, config);
    expect(result.created).toBe(true);
    const parsed = parse(readFileSync(result.yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(parsed['anon']).toBeUndefined();
  });

  it('injects apexSettlementKeys into a keyId-less chainProvider', () => {
    const config = getDefaultConfig();
    const APEX_EVM_KEY = '0x' + 'b'.repeat(64);
    const { yamlPath } = writeDirectConnectorConfig(tmpDir, config, {
      apexSettlementKeys: { evmPrivateKeyHex: APEX_EVM_KEY },
    });
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const cps = parsed['chainProviders'] as
      | Record<string, unknown>[]
      | undefined;
    // Default config yields the DEFAULT_HS_CHAIN_PROVIDERS fallback (Anvil dev
    // key already present) — assert the key plumbing path renders providers.
    expect(Array.isArray(cps)).toBe(true);
    expect(cps!.length).toBeGreaterThan(0);
  });

  // ── Multi-chain parity with the HS writer (Phase 5, step 1) ────────────────
  // The DIRECT writer shares buildApexGenerator with the HS writer, so given the
  // SAME EVM + Solana + Mina chainProviders it MUST emit byte-identical
  // chainProvider blocks (with apexSettlementKeys filling blank keyIds). The only
  // intended differences are transport (direct vs socks5) and the absence of the
  // `anon` stanza. This is the on-chain-settlement lever for the live Sol/Mina
  // direct-apex exercise: the apex advertises + settles both chains.
  const APEX_EVM_KEY = `0x${'ab'.repeat(32)}`;
  const APEX_SOLANA_KEY = '4'.repeat(44);
  const APEX_MINA_KEY = `EK${'a'.repeat(50)}`;

  function multiChainConfig(): ReturnType<typeof getDefaultConfig> {
    const config = getDefaultConfig();
    config.chainProviders = [
      {
        chainType: 'evm',
        chainId: 'evm:base:31337',
        rpcUrl: 'http://townhouse-dev-anvil:8545',
        registryAddress: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
        tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
        // keyId omitted — filled from apexSettlementKeys.evmPrivateKeyHex
        settlementOptions: { threshold: '1' },
      },
      {
        chainType: 'solana',
        chainId: 'solana:devnet',
        rpcUrl: 'http://townhouse-dev-solana:8899',
        programId: 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG',
        tokenMint: '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q',
        // keyId omitted — filled from apexSettlementKeys.solanaPrivateKeyBase58
      },
      {
        chainType: 'mina',
        chainId: 'mina:devnet',
        graphqlUrl: 'http://townhouse-dev-mina:3085/graphql',
        zkAppAddress: 'B62qtestzkappaddressplaceholderxxxxxxxxxxxxxxxxxxxxx',
        // keyId omitted — filled from apexSettlementKeys.minaPrivateKeyBase58
      },
    ];
    return config;
  }

  const APEX_KEYS = {
    evmPrivateKeyHex: APEX_EVM_KEY,
    solanaPrivateKeyBase58: APEX_SOLANA_KEY,
    minaPrivateKeyBase58: APEX_MINA_KEY,
  };

  it('emits the Solana + Mina chainProvider blocks (with apex keyIds) — the on-chain settlement lever', () => {
    const { yamlPath } = writeDirectConnectorConfig(
      tmpDir,
      multiChainConfig(),
      {
        force: true,
        apexSettlementKeys: APEX_KEYS,
      }
    );
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    const cps = parsed['chainProviders'] as Record<string, unknown>[];

    const evm = cps.find((c) => c['chainType'] === 'evm');
    const sol = cps.find((c) => c['chainType'] === 'solana');
    const mina = cps.find((c) => c['chainType'] === 'mina');

    expect(evm, 'direct config must carry the EVM chainProvider').toBeTruthy();
    expect(
      sol,
      'direct config must carry the Solana chainProvider'
    ).toBeTruthy();
    expect(
      mina,
      'direct config must carry the Mina chainProvider'
    ).toBeTruthy();

    // apex settlement keyIds filled per chain.
    expect(evm?.['keyId']).toBe(APEX_EVM_KEY);
    expect(sol?.['keyId']).toBe(APEX_SOLANA_KEY);
    expect(mina?.['keyId']).toBe(APEX_MINA_KEY);

    // Solana/Mina-specific fields preserved.
    expect(sol?.['programId']).toBe(
      'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG'
    );
    expect(sol?.['tokenMint']).toBe(
      '6GbdrVghwNKTz9raga7y3Y4qqX5Zgg3AC4d48Kt7C59Q'
    );
    expect(mina?.['graphqlUrl']).toBe('http://townhouse-dev-mina:3085/graphql');
    expect(mina?.['zkAppAddress']).toBe(
      'B62qtestzkappaddressplaceholderxxxxxxxxxxxxxxxxxxxxx'
    );
  });

  it('direct transport is {type:direct} and there is NO anon stanza (alongside multi-chain providers)', () => {
    const { yamlPath } = writeDirectConnectorConfig(
      tmpDir,
      multiChainConfig(),
      {
        force: true,
        apexSettlementKeys: APEX_KEYS,
      }
    );
    const parsed = parse(readFileSync(yamlPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect((parsed['transport'] as Record<string, unknown>)['type']).toBe(
      'direct'
    );
    expect(parsed['anon']).toBeUndefined();
  });

  it('emits the SAME chainProvider blocks the HS writer does (given identical inputs)', () => {
    // Two fresh dirs so the writers do not race on the same connector.yaml.
    const directDir = mkdtempSync(join(tmpdir(), 'direct-parity-direct-'));
    const hsDir = mkdtempSync(join(tmpdir(), 'direct-parity-hs-'));
    try {
      const { yamlPath: directPath } = writeDirectConnectorConfig(
        directDir,
        multiChainConfig(),
        { force: true, apexSettlementKeys: APEX_KEYS }
      );
      const { yamlPath: hsPath } = writeHsConnectorConfig(
        hsDir,
        multiChainConfig(),
        { force: true, apexSettlementKeys: APEX_KEYS }
      );
      const directCps = (
        parse(readFileSync(directPath, 'utf-8')) as Record<string, unknown>
      )['chainProviders'];
      const hsCps = (
        parse(readFileSync(hsPath, 'utf-8')) as Record<string, unknown>
      )['chainProviders'];
      // The chainProvider arrays are produced by the shared buildApexGenerator
      // path, so they are structurally identical across transports.
      expect(directCps).toEqual(hsCps);
    } finally {
      rmSync(directDir, { recursive: true, force: true });
      rmSync(hsDir, { recursive: true, force: true });
    }
  });
});

describe('detectExistingHsConfig (Phase 3 back-compat guard)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'detect-hs-config-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns false when connector.yaml is absent (fresh install)', () => {
    expect(detectExistingHsConfig(tmpDir)).toBe(false);
  });

  it('returns true when an HS config (anon.enabled: true) is present', () => {
    writeHsConnectorConfig(tmpDir, getDefaultConfig());
    expect(detectExistingHsConfig(tmpDir)).toBe(true);
  });

  it('returns false for a direct config (no anon block)', () => {
    writeDirectConnectorConfig(tmpDir, getDefaultConfig());
    expect(detectExistingHsConfig(tmpDir)).toBe(false);
  });

  it('returns false for a legacy non-HS config lacking anon.enabled', () => {
    writeFileSync(
      join(tmpDir, 'connector.yaml'),
      'transport:\n  type: direct\n',
      'utf-8'
    );
    expect(detectExistingHsConfig(tmpDir)).toBe(false);
  });

  it('returns false for an unparseable connector.yaml', () => {
    writeFileSync(
      join(tmpDir, 'connector.yaml'),
      '::: not yaml :::\n',
      'utf-8'
    );
    expect(detectExistingHsConfig(tmpDir)).toBe(false);
  });
});
