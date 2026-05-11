/**
 * Unit tests for `nodes.yaml` schema + read/write helpers (Story 46.1).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readNodesYaml,
  writeNodesYaml,
  type NodesYaml,
} from '../nodes-yaml.js';

describe('nodes-yaml schema + read/write helpers', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'nodes-yaml-test-'));
    path = join(dir, 'nodes.yaml');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('readNodesYaml', () => {
    it('returns empty entries when file does not exist (first-run graceful)', async () => {
      const result = await readNodesYaml(path);
      expect(result).toEqual({ entries: [] });
    });

    it('returns empty entries when file is empty', async () => {
      await fsp.writeFile(path, '', 'utf-8');
      const result = await readNodesYaml(path);
      expect(result).toEqual({ entries: [] });
    });

    it('round-trips a valid payload', async () => {
      const data: NodesYaml = {
        entries: [
          {
            id: 'town-01',
            type: 'town',
            peerId: 'peer-town-01',
            ilpAddress: 'g.toon.peer.town01',
            derivationIndex: 0,
            enabledAt: '2026-05-10T12:00:00Z',
            lastSeenAt: null,
          },
        ],
      };
      await writeNodesYaml(path, data);
      const result = await readNodesYaml(path);
      expect(result).toEqual(data);
    });

    it('rejects invalid type enum', async () => {
      await fsp.writeFile(
        path,
        `entries:
  - id: bogus-01
    type: gateway
    peerId: peer-bogus-01
    ilpAddress: g.toon.bogus
    derivationIndex: 0
    enabledAt: "2026-05-10T12:00:00Z"
    lastSeenAt: null
`,
        'utf-8'
      );
      await expect(readNodesYaml(path)).rejects.toThrow();
    });

    it('rejects entry missing peerId', async () => {
      await fsp.writeFile(
        path,
        `entries:
  - id: town-01
    type: town
    ilpAddress: g.toon.town01
    derivationIndex: 0
    enabledAt: "2026-05-10T12:00:00Z"
    lastSeenAt: null
`,
        'utf-8'
      );
      await expect(readNodesYaml(path)).rejects.toThrow();
    });

    it('rejects negative derivationIndex', async () => {
      await fsp.writeFile(
        path,
        `entries:
  - id: town-01
    type: town
    peerId: peer-01
    ilpAddress: g.toon.town01
    derivationIndex: -1
    enabledAt: "2026-05-10T12:00:00Z"
    lastSeenAt: null
`,
        'utf-8'
      );
      await expect(readNodesYaml(path)).rejects.toThrow();
    });

    it('accepts non-null lastSeenAt as a string', async () => {
      const data: NodesYaml = {
        entries: [
          {
            id: 'mill-01',
            type: 'mill',
            peerId: 'peer-mill-01',
            ilpAddress: 'g.toon.peer.mill01',
            derivationIndex: 1,
            enabledAt: '2026-05-10T12:00:00Z',
            lastSeenAt: '2026-05-10T12:30:00Z',
          },
        ],
      };
      await writeNodesYaml(path, data);
      const result = await readNodesYaml(path);
      expect(result.entries[0]?.lastSeenAt).toBe('2026-05-10T12:30:00Z');
    });
  });

  describe('writeNodesYaml', () => {
    it('writes the file with mode 0o600', async () => {
      await writeNodesYaml(path, { entries: [] });
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('writes atomically via tmp + rename (no .tmp left behind on success)', async () => {
      await writeNodesYaml(path, { entries: [] });
      const tmpExists = await fsp
        .stat(`${path}.tmp`)
        .then(() => true)
        .catch(() => false);
      expect(tmpExists).toBe(false);
    });

    it('overwrites existing file and corrects mode', async () => {
      // Pre-create the file with a permissive mode to verify chmod-after-rename
      await fsp.writeFile(path, 'entries: []\n', {
        encoding: 'utf-8',
        mode: 0o644,
      });
      await writeNodesYaml(path, { entries: [] });
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('serializes entries as readable yaml', async () => {
      const data: NodesYaml = {
        entries: [
          {
            id: 'dvm-01',
            type: 'dvm',
            peerId: 'peer-dvm-01',
            ilpAddress: 'g.toon.peer.dvm01',
            derivationIndex: 2,
            enabledAt: '2026-05-10T12:00:00Z',
            lastSeenAt: null,
          },
        ],
      };
      await writeNodesYaml(path, data);
      const raw = readFileSync(path, 'utf-8');
      expect(raw).toContain('id: dvm-01');
      expect(raw).toContain('type: dvm');
      expect(raw).toContain('peerId: peer-dvm-01');
    });

    it('rejects invalid data without writing', async () => {
      const bad = {
        entries: [
          {
            id: 'town-01',
            type: 'invalid-type',
            peerId: 'peer-01',
            ilpAddress: 'g.toon.town01',
            derivationIndex: 0,
            enabledAt: '2026-05-10T12:00:00Z',
            lastSeenAt: null,
          },
        ],
      } as unknown as NodesYaml;
      await expect(writeNodesYaml(path, bad)).rejects.toThrow();
      const fileExists = await fsp
        .stat(path)
        .then(() => true)
        .catch(() => false);
      expect(fileExists).toBe(false);
    });
  });
});
