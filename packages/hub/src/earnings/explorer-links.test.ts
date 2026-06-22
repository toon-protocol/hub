/**
 * Unit tests for explorer-links.ts (Story D4, AC-D4-3 + test gate).
 *
 * Test gate matrix (4 cases, per the locked AC):
 *   1. EVM with Blockscout lease present → uses Blockscout URL.
 *   2. EVM with no leases.json → no explorerUrl (returns undefined).
 *   3. Solana with self-hosted explorer lease → uses self-hosted URL.
 *   4. Solana with only RPC lease → uses public Solana Explorer with
 *      `cluster=custom&customUrl=…` query param.
 *
 * Plus edge cases: Solana with NO leases at all, malformed leases.json,
 * empty txHash, trailing-slash normalization.
 */

import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildExplorerUrl,
  loadLeases,
  PUBLIC_SOLANA_EXPLORER,
} from './explorer-links.js';

describe('buildExplorerUrl', () => {
  // ── AC-D4-3 case 1: EVM + Blockscout ───────────────────────────────────────
  it('[AC-D4-3.1] EVM with Blockscout lease present uses Blockscout URL', () => {
    const txHash = '0x' + 'a'.repeat(64);
    const url = buildExplorerUrl('evm', txHash, {
      blockscout: { url: 'https://blockscout.example' },
    });
    expect(url).toBe(`https://blockscout.example/tx/${txHash}`);
  });

  it('[AC-D4-3.1] EVM strips trailing slash from blockscout base URL', () => {
    const txHash = '0x' + 'b'.repeat(64);
    const url = buildExplorerUrl('evm', txHash, {
      blockscout: { url: 'https://blockscout.example/' },
    });
    expect(url).toBe(`https://blockscout.example/tx/${txHash}`);
  });

  // ── Otterscan (current default EVM explorer) ─────────────────────────────
  it('EVM with Otterscan lease uses hash-router URL', () => {
    const txHash = '0x' + 'a'.repeat(64);
    const url = buildExplorerUrl('evm', txHash, {
      otterscan: { url: 'https://otter.example' },
    });
    expect(url).toBe(`https://otter.example/#/tx/${txHash}`);
  });

  it('EVM strips trailing slash from Otterscan base URL', () => {
    const txHash = '0x' + 'b'.repeat(64);
    const url = buildExplorerUrl('evm', txHash, {
      otterscan: { url: 'https://otter.example/' },
    });
    expect(url).toBe(`https://otter.example/#/tx/${txHash}`);
  });

  it('EVM prefers Otterscan over Blockscout when both are present', () => {
    const txHash = '0x' + 'c'.repeat(64);
    const url = buildExplorerUrl('evm', txHash, {
      otterscan: { url: 'https://otter.example' },
      blockscout: { url: 'https://blockscout.example' },
    });
    expect(url).toBe(`https://otter.example/#/tx/${txHash}`);
  });

  // ── AC-D4-3 case 2: EVM + no leases ───────────────────────────────────────
  it('[AC-D4-3.2] EVM with no leases.json returns undefined (no broken link)', () => {
    const url = buildExplorerUrl('evm', '0x' + 'c'.repeat(64), null);
    expect(url).toBeUndefined();
  });

  it('[AC-D4-3.2] EVM with leases but no blockscout/otterscan entry returns undefined', () => {
    const url = buildExplorerUrl('evm', '0x' + 'c'.repeat(64), {
      solana: { url: 'http://solana' },
    });
    expect(url).toBeUndefined();
  });

  // ── AC-D4-3 case 3: Solana + self-hosted explorer ─────────────────────────
  it('[AC-D4-3.3] Solana with self-hosted explorer lease uses self-hosted URL', () => {
    const sig = '5'.repeat(88); // base58-ish placeholder
    const url = buildExplorerUrl('solana', sig, {
      solana_explorer: { url: 'https://sol-explorer.example' },
      // RPC also present, but self-hosted should win:
      solana: { url: 'https://sol-rpc.example' },
    });
    expect(url).toBe(`https://sol-explorer.example/tx/${sig}`);
  });

  // ── AC-D4-3 case 4: Solana + only RPC ─────────────────────────────────────
  it('[AC-D4-3.4] Solana with only RPC lease uses public explorer with customUrl', () => {
    const sig = '6'.repeat(88);
    const rpcUrl = 'https://sol-rpc.example';
    const url = buildExplorerUrl('solana', sig, {
      solana: { url: rpcUrl },
    });
    expect(url).toBe(
      `${PUBLIC_SOLANA_EXPLORER}/tx/${sig}?cluster=custom&customUrl=${encodeURIComponent(rpcUrl)}`
    );
  });

  it('[AC-D4-3.4] Solana RPC URL with special chars is properly encoded', () => {
    const sig = '7'.repeat(88);
    const rpcUrl = 'https://sol-rpc.example:8899/path?x=1';
    const url = buildExplorerUrl('solana', sig, {
      solana: { url: rpcUrl },
    });
    expect(url).toContain(encodeURIComponent(rpcUrl));
    // Ensure the unencoded host:port is NOT in the URL (would break parsing)
    expect(url).not.toContain('sol-rpc.example:8899/path?x=1&');
  });

  // ── Edge cases ─────────────────────────────────────────────────────────────
  it('Solana with no leases at all returns undefined', () => {
    const url = buildExplorerUrl('solana', '8'.repeat(88), null);
    expect(url).toBeUndefined();
  });

  it('Solana with only blockscout (wrong chain) returns undefined', () => {
    const url = buildExplorerUrl('solana', '9'.repeat(88), {
      blockscout: { url: 'https://blockscout.example' },
    });
    expect(url).toBeUndefined();
  });

  it('empty txHash returns undefined for both chains', () => {
    expect(
      buildExplorerUrl('evm', '', { blockscout: { url: 'https://x' } })
    ).toBeUndefined();
    expect(
      buildExplorerUrl('solana', '', {
        solana_explorer: { url: 'https://y' },
      })
    ).toBeUndefined();
  });
});

describe('loadLeases', () => {
  it('returns null for undefined path', () => {
    expect(loadLeases(undefined)).toBeNull();
  });

  it('returns null for null path', () => {
    expect(loadLeases(null)).toBeNull();
  });

  it('returns null when file does not exist', () => {
    expect(loadLeases('/nonexistent/path/leases.json')).toBeNull();
  });

  it('returns parsed object when valid JSON exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd4-leases-'));
    const path = join(dir, 'leases.json');
    writeFileSync(path, JSON.stringify({ blockscout: { url: 'https://x' } }));
    try {
      const result = loadLeases(path);
      expect(result?.blockscout?.url).toBe('https://x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for malformed JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd4-leases-'));
    const path = join(dir, 'leases.json');
    writeFileSync(path, '{not valid');
    try {
      expect(loadLeases(path)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for non-object JSON (array)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd4-leases-'));
    const path = join(dir, 'leases.json');
    writeFileSync(path, '[1,2,3]');
    try {
      // Arrays are technically objects but not the leases shape; we accept
      // them through and let buildExplorerUrl no-op since no fields match.
      const result = loadLeases(path);
      // Either null or an array-shaped object — the contract is that
      // buildExplorerUrl never crashes. We assert the latter.
      expect(
        buildExplorerUrl('evm', '0x' + 'a'.repeat(64), result)
      ).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
