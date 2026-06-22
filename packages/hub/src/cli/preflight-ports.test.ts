/**
 * Unit tests for the HS-mode port-collision preflight (Epic 49 Followup B).
 *
 * Strategy:
 *   - `isPortInUse` is exercised by binding a real loopback socket (cheap,
 *     deterministic) and then probing the bound port.
 *   - `checkHsPortCollisions` is exercised against a fake dockerode stub
 *     that returns canned `listContainers` data so we don't touch the
 *     local Docker daemon.
 *   - `formatCollisionMessage` is asserted line-by-line for shape.
 */

import { describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:net';
import {
  isPortInUse,
  checkHsPortCollisions,
  checkDirectPortCollisions,
  formatCollisionMessage,
  HS_CANONICAL_PORTS,
  DIRECT_CANONICAL_PORTS,
  type PortCollision,
} from './preflight-ports.js';

/** Allocate a free ephemeral port on 127.0.0.1 (kernel-assigned). */
async function allocateFreePort(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1' }, () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('failed to allocate ephemeral port');
  }
  return {
    port: addr.port,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/** Hold a port open on 127.0.0.1 so isPortInUse sees it as bound. */
async function holdPort(port: number): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () =>
      resolve()
    );
  });
  return server;
}

describe('isPortInUse', () => {
  it('returns false for a port that nothing is listening on', async () => {
    // Allocate then immediately release — the just-freed port is almost
    // certainly still free on the very next bind attempt.
    const { port, close } = await allocateFreePort();
    await close();
    const inUse = await isPortInUse(port);
    expect(inUse).toBe(false);
  });

  it('returns true when something is already listening on the port', async () => {
    const { port, close } = await allocateFreePort();
    await close();
    const blocker = await holdPort(port);
    try {
      const inUse = await isPortInUse(port);
      expect(inUse).toBe(true);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

describe('checkHsPortCollisions', () => {
  it('returns [] when all probed ports are free', async () => {
    // Use a tiny range of high ports that are extremely unlikely to be bound.
    const { port: p1, close: c1 } = await allocateFreePort();
    const { port: p2, close: c2 } = await allocateFreePort();
    await c1();
    await c2();
    const collisions = await checkHsPortCollisions(undefined, [p1, p2]);
    expect(collisions).toEqual([]);
  });

  it('reports collisions for ports that are bound', async () => {
    const { port, close } = await allocateFreePort();
    await close();
    const blocker = await holdPort(port);
    try {
      const collisions = await checkHsPortCollisions(undefined, [port]);
      expect(collisions).toHaveLength(1);
      expect(collisions[0]?.port).toBe(port);
      // No Docker → no container name.
      expect(collisions[0]?.containerName).toBeUndefined();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('enriches collisions with Docker container name + compose project', async () => {
    const { port, close } = await allocateFreePort();
    await close();
    const blocker = await holdPort(port);
    try {
      // Fake docker.listContainers returning a container that "binds" the port.
      const fakeDocker = {
        listContainers: async () => [
          {
            Id: 'abc',
            Names: ['/hub-hs-connector'],
            Image: 'ghcr.io/toon-protocol/connector',
            Ports: [
              {
                IP: '127.0.0.1',
                PrivatePort: 9401,
                PublicPort: port,
                Type: 'tcp',
              },
            ],
            Status: 'Up 5 hours',
            Labels: { 'com.docker.compose.project': 'compose' },
          },
        ],
      } as unknown as Parameters<typeof checkHsPortCollisions>[0];
      const collisions = await checkHsPortCollisions(fakeDocker, [port]);
      expect(collisions).toHaveLength(1);
      expect(collisions[0]).toMatchObject({
        port,
        containerName: 'hub-hs-connector',
        composeProject: 'compose',
        status: 'Up 5 hours',
      });
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('gracefully degrades when Docker enrichment fails (unreachable daemon)', async () => {
    const { port, close } = await allocateFreePort();
    await close();
    const blocker = await holdPort(port);
    try {
      const fakeDocker = {
        listContainers: async () => {
          throw new Error('Cannot connect to the Docker daemon');
        },
      } as unknown as Parameters<typeof checkHsPortCollisions>[0];
      const collisions = await checkHsPortCollisions(fakeDocker, [port]);
      expect(collisions).toHaveLength(1);
      expect(collisions[0]?.port).toBe(port);
      expect(collisions[0]?.containerName).toBeUndefined();
      expect(collisions[0]?.composeProject).toBeUndefined();
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('only reports ports that are actually bound (others stay clean)', async () => {
    const { port: bound, close: cBound } = await allocateFreePort();
    const { port: free, close: cFree } = await allocateFreePort();
    await cBound();
    await cFree();
    const blocker = await holdPort(bound);
    try {
      const collisions = await checkHsPortCollisions(undefined, [bound, free]);
      expect(collisions).toHaveLength(1);
      expect(collisions[0]?.port).toBe(bound);
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });

  it('HS_CANONICAL_PORTS covers all six template ports', () => {
    expect(new Set(HS_CANONICAL_PORTS)).toEqual(
      new Set([9401, 28090, 7100, 3100, 3200, 3400])
    );
  });
});

describe('direct-mode port set (Phase 2 direct-apex)', () => {
  it('DIRECT_CANONICAL_PORTS = HS set PLUS the host-exposed BTP port 3000', () => {
    expect(new Set(DIRECT_CANONICAL_PORTS)).toEqual(
      new Set([3000, 9401, 28090, 7100, 3100, 3200, 3400])
    );
    // Specifically: every HS port is present, plus 3000.
    for (const p of HS_CANONICAL_PORTS) {
      expect(DIRECT_CANONICAL_PORTS).toContain(p);
    }
    expect(DIRECT_CANONICAL_PORTS).toContain(3000);
  });

  it('checkDirectPortCollisions reports a bound port (parametrized set)', async () => {
    // allocateFreePort keeps a server bound on the returned port, so probing it
    // is a guaranteed collision regardless of the host's canonical-port state.
    const { port, close } = await allocateFreePort();
    try {
      const collisions = await checkDirectPortCollisions(undefined, [port]);
      expect(collisions.map((c) => c.port)).toContain(port);
    } finally {
      await close();
    }
  });
});

describe('formatCollisionMessage', () => {
  it('returns empty string for an empty collision list', () => {
    expect(formatCollisionMessage([])).toBe('');
  });

  it('renders the headline + per-port lines + cleanup suggestion when Docker named a culprit', () => {
    const collisions: PortCollision[] = [
      {
        port: 9401,
        containerName: 'hub-hs-connector',
        composeProject: 'compose',
        status: 'Up 5 hours',
      },
    ];
    const msg = formatCollisionMessage(collisions);
    expect(msg).toContain(
      'hub hs up: cannot start — host ports already in use:'
    );
    expect(msg).toContain("in use by container 'hub-hs-connector'");
    expect(msg).toContain("(compose project 'compose', Up 5 hours)");
    expect(msg).toContain('docker compose -p compose down');
    expect(msg).toContain('Re-run with --skip-preflight to bypass this check.');
  });

  it('suggests lsof when no Docker culprit was identified', () => {
    const collisions: PortCollision[] = [{ port: 9401 }];
    const msg = formatCollisionMessage(collisions);
    expect(msg).toContain('no Docker container found');
    expect(msg).toContain('sudo lsof -iTCP:9401 -sTCP:LISTEN');
    // No docker-compose-down suggestion since project is unknown.
    expect(msg).not.toContain('docker compose -p');
  });

  it('dedupes compose-down suggestions across multiple collisions in the same project', () => {
    const collisions: PortCollision[] = [
      {
        port: 9401,
        containerName: 'a',
        composeProject: 'compose',
        status: 'Up',
      },
      {
        port: 3100,
        containerName: 'b',
        composeProject: 'compose',
        status: 'Up',
      },
    ];
    const msg = formatCollisionMessage(collisions);
    // Only ONE `docker compose -p compose down` line, not two.
    const matches = msg.match(/docker compose -p compose down/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('lists each unique project when collisions span multiple compose projects', () => {
    const collisions: PortCollision[] = [
      {
        port: 9401,
        containerName: 'a',
        composeProject: 'compose',
        status: 'Up',
      },
      {
        port: 3100,
        containerName: 'b',
        composeProject: 'hub-dev',
        status: 'Up',
      },
    ];
    const msg = formatCollisionMessage(collisions);
    expect(msg).toContain('docker compose -p compose down');
    expect(msg).toContain('docker compose -p hub-dev down');
  });

  it('ends with a trailing newline (terminal-friendly)', () => {
    const msg = formatCollisionMessage([{ port: 9401 }]);
    expect(msg.endsWith('\n')).toBe(true);
  });
});
