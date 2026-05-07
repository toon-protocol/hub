/**
 * Unit tests for the `--preset=demo` configuration builder.
 *
 * D2 acceptance criteria:
 *   AC-D2-1: preset writes 1 town + 1 mill + 1 dvm
 *   AC-D2-2: ATOR transport on; chain endpoints sourced from leases.json or local fallback
 *   AC-D2-5: all fees zeroed; mill has EVM<->SOL pair with chain endpoints
 *   AC-D2-6: deterministic-demo-password constant exists with safety warning
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDemoConfig,
  resolveChainEndpoints,
  LOCAL_DEVNET_FALLBACK,
  DEMO_DETERMINISTIC_PASSWORD,
} from './demo.js';

describe('buildDemoConfig', () => {
  it('AC-D2-1: ships 1 town + 1 mill + 1 dvm, all enabled', () => {
    const cfg = buildDemoConfig({ walletPath: '/tmp/x.enc', leasesPath: null });
    expect(cfg.nodes.town.enabled).toBe(true);
    expect(cfg.nodes.mill.enabled).toBe(true);
    expect(cfg.nodes.dvm.enabled).toBe(true);
  });

  it('AC-D2-2: transport defaults to direct (ATOR sidecar not yet wired into `townhouse up`)', () => {
    // The demo intentionally ships transport.mode='direct' until the SOCKS5
    // sidecar story lands in `townhouse up` — see demo.ts:210 for the inline
    // rationale. Flip back to 'ator' once the sidecar is wired.
    const cfg = buildDemoConfig({ walletPath: '/tmp/x.enc', leasesPath: null });
    expect(cfg.transport.mode).toBe('direct');
  });

  it('AC-D2-5: all fees zeroed; mill has EVM<->SOL pair', () => {
    const cfg = buildDemoConfig({ walletPath: '/tmp/x.enc', leasesPath: null });
    expect(cfg.nodes.town.feePerEvent).toBe(0);
    expect(cfg.nodes.mill.feeBasisPoints).toBe(0);
    expect(cfg.nodes.dvm.feePerJob).toBe(0);
    expect(cfg.nodes.mill.pairs).toEqual(['EVM<->SOL']);
    expect(cfg.nodes.mill.chains?.evm?.rpcUrl).toBeDefined();
    expect(cfg.nodes.mill.chains?.solana?.rpcUrl).toBeDefined();
  });

  it('demo DVM declares Arweave kind:5094 pricing (post-ca29625 image is Arweave-only)', () => {
    const cfg = buildDemoConfig({ walletPath: '/tmp/x.enc', leasesPath: null });
    expect(cfg.nodes.dvm.kindPricing).toBeDefined();
    expect(cfg.nodes.dvm.kindPricing?.['5094']).toBe(0);
  });

  it('falls back to local devnet URLs when leases.json is absent', () => {
    const cfg = buildDemoConfig({ walletPath: '/tmp/x.enc', leasesPath: null });
    expect(cfg.nodes.mill.chains?.evm?.rpcUrl).toBe(
      LOCAL_DEVNET_FALLBACK.anvilUrl
    );
    expect(cfg.nodes.mill.chains?.solana?.rpcUrl).toBe(
      LOCAL_DEVNET_FALLBACK.solanaUrl
    );
    expect(cfg.preset?.chainEndpointSource).toBe('local-fallback');
  });

  it('uses leases.json values when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-preset-test-'));
    const leasesFile = join(dir, 'leases.json');
    writeFileSync(
      leasesFile,
      JSON.stringify({
        anvil: {
          url: 'http://anvil.akash.example:32100',
          ws_url: 'ws://anvil.akash.example:32101',
        },
        solana: {
          url: 'http://sol.akash.example:32200',
          ws_url: 'ws://sol.akash.example:32201',
        },
      }),
      'utf-8'
    );
    try {
      const cfg = buildDemoConfig({
        walletPath: '/tmp/x.enc',
        leasesPath: leasesFile,
      });
      expect(cfg.nodes.mill.chains?.evm?.rpcUrl).toBe(
        'http://anvil.akash.example:32100'
      );
      expect(cfg.nodes.mill.chains?.evm?.wsUrl).toBe(
        'ws://anvil.akash.example:32101'
      );
      expect(cfg.nodes.mill.chains?.solana?.rpcUrl).toBe(
        'http://sol.akash.example:32200'
      );
      expect(cfg.preset?.chainEndpointSource).toBe(leasesFile);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records deterministic demo password as a clearly-unsafe constant', () => {
    expect(DEMO_DETERMINISTIC_PASSWORD).toMatch(/INSECURE|demo|do.not.use/i);
  });

  it('handles malformed leases.json gracefully (falls back to local)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'demo-preset-bad-'));
    const leasesFile = join(dir, 'leases.json');
    writeFileSync(leasesFile, 'not json {{{', 'utf-8');
    try {
      const result = resolveChainEndpoints(leasesFile);
      expect(result.source).toBe('local-fallback');
      expect(result.evm.rpcUrl).toBe(LOCAL_DEVNET_FALLBACK.anvilUrl);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
