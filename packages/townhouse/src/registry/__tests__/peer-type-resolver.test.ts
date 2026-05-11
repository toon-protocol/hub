/**
 * Unit tests for PeerTypeResolver (Story 46.1).
 */

import { describe, it, expect } from 'vitest';
import { PeerTypeResolver } from '../peer-type-resolver.js';
import type { NodesYaml } from '../../state/nodes-yaml.js';

const ENABLED_AT = '2026-05-10T12:00:00Z';

describe('PeerTypeResolver', () => {
  it('resolves a known peerId to its declared type', () => {
    const yaml: NodesYaml = {
      entries: [
        {
          id: 'town-01',
          type: 'town',
          peerId: 'peer-town-01',
          ilpAddress: 'g.toon.peer.town01',
          derivationIndex: 0,
          enabledAt: ENABLED_AT,
          lastSeenAt: null,
        },
      ],
    };
    const resolver = new PeerTypeResolver(yaml);
    expect(resolver.resolvePeerType('peer-town-01')).toBe('town');
  });

  it('returns "external" for an unknown peerId', () => {
    const yaml: NodesYaml = {
      entries: [
        {
          id: 'town-01',
          type: 'town',
          peerId: 'peer-town-01',
          ilpAddress: 'g.toon.peer.town01',
          derivationIndex: 0,
          enabledAt: ENABLED_AT,
          lastSeenAt: null,
        },
      ],
    };
    const resolver = new PeerTypeResolver(yaml);
    expect(resolver.resolvePeerType('peer-unknown-99')).toBe('external');
  });

  it('returns "external" for any input when yaml is empty', () => {
    const resolver = new PeerTypeResolver({ entries: [] });
    expect(resolver.resolvePeerType('peer-anything')).toBe('external');
    expect(resolver.resolvePeerType('')).toBe('external');
  });

  it('resolves multiple entries with different types independently', () => {
    const yaml: NodesYaml = {
      entries: [
        {
          id: 'town-01',
          type: 'town',
          peerId: 'peer-town-01',
          ilpAddress: 'g.toon.peer.town01',
          derivationIndex: 0,
          enabledAt: ENABLED_AT,
          lastSeenAt: null,
        },
        {
          id: 'mill-01',
          type: 'mill',
          peerId: 'peer-mill-01',
          ilpAddress: 'g.toon.peer.mill01',
          derivationIndex: 1,
          enabledAt: ENABLED_AT,
          lastSeenAt: null,
        },
        {
          id: 'dvm-01',
          type: 'dvm',
          peerId: 'peer-dvm-01',
          ilpAddress: 'g.toon.peer.dvm01',
          derivationIndex: 2,
          enabledAt: ENABLED_AT,
          lastSeenAt: null,
        },
      ],
    };
    const resolver = new PeerTypeResolver(yaml);
    expect(resolver.resolvePeerType('peer-town-01')).toBe('town');
    expect(resolver.resolvePeerType('peer-mill-01')).toBe('mill');
    expect(resolver.resolvePeerType('peer-dvm-01')).toBe('dvm');
    expect(resolver.resolvePeerType('peer-other')).toBe('external');
  });
});
