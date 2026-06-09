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

describe('PeerTypeResolver.fromConnectorPeers', () => {
  it('infers the type from a bare node-type peer id (compose-render path)', () => {
    // The `townhouse hs up` / local-HS harness registers child peers with a
    // bare node-type id via POST /admin/peers (e.g. {id:'town'}) — #144.
    const resolver = PeerTypeResolver.fromConnectorPeers([
      { id: 'town', ilpAddresses: ['g.townhouse.town'] },
    ]);
    expect(resolver.resolvePeerType('town')).toBe('town');
  });

  it('infers the type from a g.townhouse.<type> ILP route prefix', () => {
    const resolver = PeerTypeResolver.fromConnectorPeers([
      // id doesn't match a node-type, but the route prefix does.
      { id: 'peer-abc123', ilpAddresses: ['g.townhouse.mill.sub'] },
    ]);
    expect(resolver.resolvePeerType('peer-abc123')).toBe('mill');
  });

  it('infers the type from a <type>-NN / <type>_NN id (node add naming)', () => {
    const resolver = PeerTypeResolver.fromConnectorPeers([
      { id: 'town-01' },
      { id: 'mill_02' },
      { id: 'dvm-99', ilpAddresses: [] },
    ]);
    expect(resolver.resolvePeerType('town-01')).toBe('town');
    expect(resolver.resolvePeerType('mill_02')).toBe('mill');
    expect(resolver.resolvePeerType('dvm-99')).toBe('dvm');
  });

  it('treats peers with no inferable type as external', () => {
    const resolver = PeerTypeResolver.fromConnectorPeers([
      { id: '0xabc', ilpAddresses: ['g.external.client'] },
      { id: 'town', ilpAddresses: ['g.townhouse.town'] },
    ]);
    // Known child resolves; unrecognised peer (and any other id) → external.
    expect(resolver.resolvePeerType('town')).toBe('town');
    expect(resolver.resolvePeerType('0xabc')).toBe('external');
    expect(resolver.resolvePeerType('anything-else')).toBe('external');
  });

  it('resolves a full local-HS-style roster distinctly (town child + external client)', () => {
    const resolver = PeerTypeResolver.fromConnectorPeers([
      { id: 'town', ilpAddresses: ['g.townhouse.town'] },
      { id: '0x90f79bf6eb2c4f870365e785982e1f101e93b906', ilpAddresses: [] },
    ]);
    expect(resolver.resolvePeerType('town')).toBe('town');
    expect(
      resolver.resolvePeerType('0x90f79bf6eb2c4f870365e785982e1f101e93b906')
    ).toBe('external');
  });

  it('returns an all-external resolver for an empty roster', () => {
    const resolver = PeerTypeResolver.fromConnectorPeers([]);
    expect(resolver.resolvePeerType('town')).toBe('external');
    expect(resolver.resolvePeerType('')).toBe('external');
  });
});
