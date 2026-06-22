/**
 * Port-collision preflight for `hub hs up` (Epic 49 Followup B).
 *
 * Detects host-port conflicts BEFORE handing off to Docker, so operators get
 * an actionable error message instead of a cryptic mid-boot EADDRINUSE.
 *
 * Detection strategy (defense in depth):
 *   1. Bind a transient TCP socket to 127.0.0.1:<port> and immediately close.
 *      If bind throws EADDRINUSE, the port is occupied. Pure Node, no deps,
 *      works on Linux/Mac/WSL — this is the source of truth.
 *   2. If (1) flags a collision, ask Docker for the offending container's
 *      name + compose project so the message can name a culprit. Best-effort
 *      enrichment — Docker may be unreachable, in which case we still report
 *      the port and suggest `lsof` for non-Docker processes.
 */

import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type Docker from 'dockerode';
import type { ContainerInfo } from 'dockerode';

/**
 * Canonical HS-mode host ports — sourced from the compose template at
 * `packages/hub/compose/hub-hs.yml`. If that template is edited
 * to bind a new port (or unbind an existing one), update this list.
 *
 * HS-mode is single-tenant by design (per packages/hub/README.md), so
 * these ports cannot be remapped — collisions MUST be cleared before boot.
 *
 *   9401  : connector admin
 *   28090 : hub-api Fastify
 *   7100  : town relay WebSocket (profile: town, lazy-provisioned)
 *   3100  : town BLS health      (profile: town, lazy-provisioned)
 *   3200  : mill BLS health      (profile: mill, lazy-provisioned)
 *   3400  : dvm BLS health       (profile: dvm, lazy-provisioned)
 *
 * Profile-gated peer ports are checked too: even though `hub hs up`
 * boots only connector + hub-api at apex install, the SAME compose
 * file is re-parsed when `hub node add <type>` lazy-provisions a peer.
 * Catching all six up-front means `hs up` succeeds AND the operator's
 * subsequent `node add town` won't fail with the same EADDRINUSE error.
 */
export const HS_CANONICAL_PORTS: readonly number[] = [
  9401, 28090, 7100, 3100, 3200, 3400,
];

/**
 * Canonical direct-mode host ports — sourced from the compose template at
 * `packages/hub/compose/hub-direct.yml`. Identical to the HS set
 * PLUS the connector BTP port 3000, which direct-mode EXPOSES to the host for
 * external `ws://host:3000/btp` clients (the KEY difference from HS, where the
 * BTP port is reached over a hidden service instead of a host bind).
 *
 *   3000  : connector BTP (external direct client dial) — direct-only
 *   9401  : connector admin
 *   28090 : hub-api Fastify
 *   7100  : town relay WebSocket (profile: town, lazy-provisioned)
 *   3100  : town BLS health      (profile: town, lazy-provisioned)
 *   3200  : mill BLS health      (profile: mill, lazy-provisioned)
 *   3400  : dvm BLS health       (profile: dvm, lazy-provisioned)
 */
export const DIRECT_CANONICAL_PORTS: readonly number[] = [
  3000, 9401, 28090, 7100, 3100, 3200, 3400,
];

export interface PortCollision {
  /** The host port that is already bound. */
  port: number;
  /** Name of the Docker container holding the port (when known). */
  containerName?: string;
  /** Compose project the container belongs to (when known). */
  composeProject?: string;
  /** Container status string e.g. "Up 5 hours" (when known). */
  status?: string;
}

/**
 * Probe one port: bind a transient TCP server to 127.0.0.1:<port> and close
 * it immediately. Returns true if the bind fails with EADDRINUSE, false if
 * the port is free, throws for other errors (kernel issues, permissions).
 */
export async function isPortInUse(port: number): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const server = createServer();
    let settled = false;

    const finalize = (result: boolean | Error): void => {
      if (settled) return;
      settled = true;
      // Drop listeners so `close` doesn't re-trigger them.
      server.removeAllListeners('error');
      server.removeAllListeners('listening');
      try {
        server.close();
      } catch {
        /* best-effort */
      }
      if (result instanceof Error) reject(result);
      else resolve(result);
    };

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        finalize(true);
      } else {
        finalize(err);
      }
    });

    server.once('listening', () => {
      // Capture the actual port to confirm the bind succeeded; then close.
      const addr = server.address() as AddressInfo | null;
      void addr; // touched for clarity; not used further
      finalize(false);
    });

    try {
      // exclusive:true ensures we don't share a socket with another listener.
      server.listen({ port, host: '127.0.0.1', exclusive: true });
    } catch (err) {
      finalize(err as Error);
    }
  });
}

/**
 * Walk a dockerode `ContainerInfo.Ports[]` for an entry that maps host port
 * `port` on 127.0.0.1 or 0.0.0.0. Returns the container's display name and
 * compose project label if found, undefined otherwise.
 */
function findDockerCulprit(
  containers: readonly ContainerInfo[],
  port: number
):
  | Pick<PortCollision, 'containerName' | 'composeProject' | 'status'>
  | undefined {
  for (const c of containers) {
    const ports = c.Ports ?? [];
    for (const p of ports) {
      // PublicPort is the host-side port; IP "" or "0.0.0.0" or "127.0.0.1" all bind to loopback's view.
      if (p.PublicPort === port) {
        // Names come back as ["/foo"] — strip the leading slash.
        const rawName = c.Names?.[0] ?? '';
        const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
        const project = c.Labels?.['com.docker.compose.project'];
        return {
          containerName: name || undefined,
          composeProject: project,
          status: c.Status,
        };
      }
    }
  }
  return undefined;
}

/**
 * Preflight check for `hub hs up`. Probes each canonical HS port for
 * a collision and (if Docker is reachable) enriches each collision with the
 * offending container's name + compose project.
 *
 * Pure logic: never throws on Docker failures, never calls process.exit, never
 * writes to stdout/stderr. Returns `[]` when all ports are free.
 *
 * @param docker - Dockerode instance for enrichment. If undefined or
 *   unreachable, collisions are still reported (port-only).
 * @param ports - List of ports to probe. Defaults to HS_CANONICAL_PORTS.
 */
export async function checkHsPortCollisions(
  docker?: Pick<Docker, 'listContainers'>,
  ports: readonly number[] = HS_CANONICAL_PORTS
): Promise<PortCollision[]> {
  // 1) Socket-bind probe in parallel. Fast — sub-millisecond per port.
  const probes = await Promise.all(
    ports.map(async (port) => {
      try {
        const inUse = await isPortInUse(port);
        return { port, inUse, probeError: undefined as Error | undefined };
      } catch (err) {
        // Unexpected bind error (EACCES on privileged port, EMFILE, etc.).
        // Treat as "unknown" — surface as a collision so the operator
        // investigates rather than as a silent pass.
        return {
          port,
          inUse: true,
          probeError: err instanceof Error ? err : new Error(String(err)),
        };
      }
    })
  );

  const taken = probes.filter((p) => p.inUse);
  if (taken.length === 0) return [];

  // 2) Enrich with Docker info (best effort).
  let containers: readonly ContainerInfo[] = [];
  if (docker) {
    try {
      containers = await docker.listContainers({ all: false });
    } catch {
      // Docker unreachable or daemon down — fall through with empty list.
      containers = [];
    }
  }

  return taken.map((t) => {
    const culprit = findDockerCulprit(containers, t.port);
    return {
      port: t.port,
      ...(culprit ?? {}),
    };
  });
}

/**
 * Preflight check for the direct-apex bring-up path. Identical logic to
 * {@link checkHsPortCollisions} but probes {@link DIRECT_CANONICAL_PORTS}
 * (which adds the host-exposed BTP port 3000).
 */
export async function checkDirectPortCollisions(
  docker?: Pick<Docker, 'listContainers'>,
  ports: readonly number[] = DIRECT_CANONICAL_PORTS
): Promise<PortCollision[]> {
  return checkHsPortCollisions(docker, ports);
}

/**
 * Format port collisions into a multi-line operator-facing error message.
 * Designed to be written to stderr; ends with a trailing newline.
 *
 * Shape (matches the spec):
 *
 *   hub hs up: cannot start — host ports already in use:
 *
 *     127.0.0.1:9401  in use by container 'hub-hs-connector'
 *                     (compose project 'compose', Up 5 hours)
 *     127.0.0.1:3100  port in use (no Docker container found — try `sudo lsof -iTCP:3100 -sTCP:LISTEN`)
 *
 *   The HS template needs canonical ports — it cannot remap.
 *   Stop the conflicting project to free them:
 *
 *     docker compose -p <project> down
 *
 *   Or, if the conflicting process is NOT a hub stack, identify it with:
 *
 *     sudo lsof -iTCP:<port> -sTCP:LISTEN
 *
 *   Re-run with --skip-preflight to bypass this check.
 */
export function formatCollisionMessage(
  collisions: readonly PortCollision[]
): string {
  if (collisions.length === 0) return '';

  const lines: string[] = [];
  lines.push('hub hs up: cannot start — host ports already in use:');
  lines.push('');

  for (const c of collisions) {
    const portLabel = `127.0.0.1:${c.port}`.padEnd(18);
    if (c.containerName) {
      lines.push(`  ${portLabel}in use by container '${c.containerName}'`);
      const project = c.composeProject ?? '<no compose project>';
      const status = c.status ? `, ${c.status}` : '';
      lines.push(`  ${' '.repeat(18)}(compose project '${project}'${status})`);
    } else {
      lines.push(
        `  ${portLabel}port in use (no Docker container found — try \`sudo lsof -iTCP:${c.port} -sTCP:LISTEN\`)`
      );
    }
  }

  lines.push('');
  lines.push('The HS template needs canonical ports — it cannot remap.');

  // Suggest a `docker compose -p <project> down` for the most-common project
  // (typically `compose` or `hub-hs`). Dedupe to avoid spamming.
  const projects = new Set<string>();
  for (const c of collisions) {
    if (c.composeProject) projects.add(c.composeProject);
  }
  if (projects.size > 0) {
    lines.push('Stop the conflicting project to free them:');
    lines.push('');
    for (const project of projects) {
      lines.push(`  docker compose -p ${project} down`);
    }
    lines.push('');
    lines.push(
      'Or, if the conflicting process is NOT a hub stack, identify it with:'
    );
  } else {
    lines.push('Identify the conflicting processes with:');
  }

  lines.push('');
  // Pick the first collision's port for the example lsof command — keeps the
  // message concrete rather than dropping `<port>` placeholder text.
  const examplePort = collisions[0]?.port ?? 9401;
  lines.push(`  sudo lsof -iTCP:${examplePort} -sTCP:LISTEN`);
  lines.push('');
  lines.push('Re-run with --skip-preflight to bypass this check.');

  return lines.join('\n') + '\n';
}
