/**
 * Wizard API Server Factory.
 *
 * Starts in wizard mode (only wizard routes), transitions to normal mode
 * after POST /wizard/init completes and containers are healthy.
 * SECURITY: Wizard mode hard-rejects non-loopback bind regardless of env var.
 */

import { WebSocket } from 'ws';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type Docker from 'dockerode';
import { buildFastifyApp, LOOPBACK_HOSTS } from './build-app.js';
import { registerWizardRoutes, PROGRESS_BUFFER_MAX } from './routes/wizard.js';
import { registerNodeRoutes } from './routes/nodes.js';
import { registerWalletRoutes } from './routes/wallet.js';
import { registerWalletBalancesRoutes } from './routes/wallet-balances.js';
import { registerWalletRevealRoutes } from './routes/wallet-reveal.js';
import { registerWalletWithdrawRoutes } from './routes/wallet-withdraw.js';
import { registerConfigPatchRoutes } from './routes/nodes-patch.js';
import {
  registerMetricsWsRoutes,
  getOpenWebSockets,
} from './routes/metrics-ws.js';
import { registerTransportRoutes } from './routes/transport.js';
import {
  ConnectorAdminClient,
  DEFAULT_ATOR_PROXY,
  TransportProbe,
} from '../connector/index.js';
import { DockerOrchestrator } from '../docker/index.js';
import type { WalletManager } from '../wallet/index.js';
import type { TownhouseConfig } from '../config/schema.js';
import type { NodeType } from '../docker/types.js';
import type { WizardProgressMessage } from './types.js';
import type { ApiServer } from './types.js';

export interface WizardInitialDeps {
  /** Directory where ~/.townhouse/ (or override) lives */
  configDir: string;
  /** Full path to config.yaml */
  configPath: string;
  /** Full path to wallet.enc */
  walletPath: string;
  /** Port to bind the API */
  port: number;
  /** Bind host — must be a loopback address; defaults to 127.0.0.1 */
  bindHost?: string;
  docker: Docker;
  logger?: FastifyBaseLogger | boolean;
}

const CLOSE_TIMEOUT_MS = 5000;

/**
 * Create the wizard API server. Starts in wizard-only mode.
 * After POST /wizard/init + orchestrator launch, transitions to normal mode.
 */
export async function createWizardApiServer(
  initialDeps: WizardInitialDeps
): Promise<ApiServer> {
  const bindHost = initialDeps.bindHost ?? '127.0.0.1';

  // SECURITY: Wizard mode hard-rejects non-loopback regardless of TOWNHOUSE_API_ALLOW_REMOTE.
  // This guard is stricter than buildFastifyApp's normal-mode check because the wizard
  // exposes unauthenticated mutating endpoints (POST /wizard/init).
  if (!LOOPBACK_HOSTS.includes(bindHost)) {
    throw new Error(
      'The wizard refuses remote bind for security. Edit ~/.townhouse/config.yaml after setup if you need remote API access.'
    );
  }

  const state: {
    mode: 'wizard' | 'normal';
    progressBuffer: WizardProgressMessage[];
    progressSockets: Set<WebSocket>;
    transitioned: boolean;
    initInFlight: boolean;
  } = {
    mode: 'wizard',
    progressBuffer: [],
    progressSockets: new Set<WebSocket>(),
    transitioned: false,
    initInFlight: false,
  };

  const app = await buildFastifyApp({
    logger: initialDeps.logger ?? true,
    bindHost,
    requireLoopback: true,
  });

  // Handler that fires after POST /wizard/init: creates orchestrator, transitions mode.
  // NOTE: state.transitioned is flipped only AFTER orchestrator.up() resolves so that
  // a launch failure leaves the wizard recoverable (the route handler clears initInFlight
  // on rejection and rolls back wallet+config files).
  async function onInit(
    config: TownhouseConfig,
    walletManager: WalletManager,
    profiles: NodeType[]
  ): Promise<void> {
    if (state.transitioned) return;

    const orchestrator = new DockerOrchestrator(
      initialDeps.docker,
      config,
      walletManager
    );

    // Forward orchestrator events to WS buffer + connected sockets
    orchestrator.on(
      'pullProgress',
      (event: { image: string; status: string; progress?: string }) => {
        const msg: WizardProgressMessage = {
          type: 'pull_progress',
          image: event.image,
          status: event.status,
          progress: event.progress,
          ts: Date.now(),
        };
        broadcastProgress(msg);
      }
    );

    orchestrator.on(
      'containerState',
      (event: {
        name: string;
        state: string;
        detail?: string;
        error?: string;
      }) => {
        const ts = Date.now();
        let msg: WizardProgressMessage;
        if (event.state === 'running' || event.state === 'starting') {
          msg = { type: 'container_starting', name: event.name, ts };
        } else if (event.state === 'error') {
          // Surface the underlying detail/error if the orchestrator provides one;
          // fall back to the generic 'error' state string.
          const reason = event.detail ?? event.error ?? event.state;
          msg = { type: 'container_failed', name: event.name, reason, ts };
        } else if (event.state === 'stopping' || event.state === 'stopped') {
          // During launch, an unexpected stop means a partial failure — surface it.
          msg = {
            type: 'container_failed',
            name: event.name,
            reason: `container ${event.state} during launch`,
            ts,
          };
        } else {
          return;
        }
        broadcastProgress(msg);
      }
    );

    // The orchestrator emits 'healthy' via the `healthCheck` event, not `containerState`.
    // Forward that to container_healthy so the wire contract in AC-7 is actually populated.
    orchestrator.on(
      'healthCheck',
      (event: { name: string; status: string }) => {
        if (event.status === 'healthy') {
          broadcastProgress({
            type: 'container_healthy',
            name: event.name,
            ts: Date.now(),
          });
        }
      }
    );

    // Start containers — if this rejects, the route's .catch will roll back files
    // and clear initInFlight so the operator can retry.
    await orchestrator.up(profiles);

    // Register all normal routes on the same Fastify instance
    const connectorAdmin = new ConnectorAdminClient(
      `http://127.0.0.1:${config.connector.adminPort}`
    );

    // Stop the wizard probe — the normal probe takes over.
    wizardProbe.stop();

    // Build probe for normal mode (after wizard completes)
    const normalProbe = new TransportProbe({
      proxyUrl:
        config.transport.mode === 'ator'
          ? (config.transport.socksProxy ?? DEFAULT_ATOR_PROXY)
          : '',
    });
    if (config.transport.mode === 'ator') {
      normalProbe.start();
    }
    // Swap the GET-route's view to the normal probe + real config. The GET
    // closure reads these per request, so subsequent calls reflect live state.
    wizardTransportDeps.config = config;
    wizardTransportDeps.transportProbe = normalProbe;
    activeProbe = normalProbe;

    const apiDeps = {
      configPath: initialDeps.configPath,
      config,
      orchestrator,
      wallet: walletManager,
      connectorAdmin,
      transportProbe: normalProbe,
    };

    registerNodeRoutes(app as FastifyInstance, apiDeps);
    registerWalletRoutes(app as FastifyInstance, apiDeps);
    registerWalletBalancesRoutes(app as FastifyInstance, apiDeps);
    registerWalletRevealRoutes(app as FastifyInstance, apiDeps);
    registerWalletWithdrawRoutes(app as FastifyInstance, apiDeps);
    registerConfigPatchRoutes(app as FastifyInstance, apiDeps);
    registerMetricsWsRoutes(app as FastifyInstance, apiDeps);
    // GET /api/transport is already registered (wizard mode). Add PATCH only to
    // avoid Fastify's FST_ERR_DUPLICATED_ROUTE on the wizard happy path.
    registerTransportRoutes(app as FastifyInstance, apiDeps, {
      mode: 'patch-only',
    });

    // Transition state — only after everything succeeded.
    state.transitioned = true;
    state.mode = 'normal';

    // Broadcast launch_complete
    broadcastProgress({ type: 'launch_complete', ts: Date.now() });
  }

  function broadcastProgress(msg: WizardProgressMessage): void {
    state.progressBuffer.push(msg);
    if (state.progressBuffer.length > PROGRESS_BUFFER_MAX) {
      state.progressBuffer.splice(
        0,
        state.progressBuffer.length - PROGRESS_BUFFER_MAX
      );
    }
    for (const socket of state.progressSockets) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      } catch {
        /* best-effort */
      }
    }
  }

  // Lazy ATOR probe for wizard step 3 preview.
  //
  // Privacy: do NOT start the probe at server boot — the wizard fires outbound
  // TCP+HTTPS only when the operator engages the ATOR radio (which calls
  // POST /api/transport/wizard-probe-start). Once started it runs until the
  // wizard transitions to normal mode (when the normal probe takes over) or
  // the server closes.
  const wizardProbe = new TransportProbe({ proxyUrl: DEFAULT_ATOR_PROXY });
  // `activeProbe` lets close() stop whichever probe is currently running.
  let activeProbe: TransportProbe = wizardProbe;

  // Wizard transport deps. The route closure reads `transportProbe` and `config`
  // per request, so swapping these on transition is observed by subsequent GETs.
  const wizardTransportConfig = {
    transport: { mode: 'ator' as const, socksProxy: DEFAULT_ATOR_PROXY },
  };
  const wizardTransportDeps = {
    config: wizardTransportConfig,
    transportProbe: wizardProbe,
  } as unknown as Parameters<typeof registerTransportRoutes>[1];
  registerTransportRoutes(app as FastifyInstance, wizardTransportDeps, {
    mode: 'wizard',
  });

  // Lazy probe-start endpoint (wizard-only). Idempotent.
  app.post('/api/transport/wizard-probe-start', async (_request, reply) => {
    if (state.mode !== 'wizard') {
      // After transition the normal probe runs based on saved config.
      return reply.status(409).send({ error: 'wizard_not_in_progress' });
    }
    wizardProbe.start();
    return reply.status(200).send({ started: true });
  });

  registerWizardRoutes(
    app as FastifyInstance,
    {
      configPath: initialDeps.configPath,
      walletPath: initialDeps.walletPath,
    },
    state,
    onInit
  );

  async function close(): Promise<void> {
    try {
      activeProbe.stop();
    } catch {
      /* best-effort */
    }
    // Defensive: stop wizardProbe in case activeProbe is the normal one.
    try {
      wizardProbe.stop();
    } catch {
      /* best-effort */
    }

    const openSockets = getOpenWebSockets();
    for (const socket of openSockets) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.close(1001, 'server_shutdown');
        }
      } catch {
        /* best-effort */
      }
    }
    openSockets.clear();
    for (const socket of state.progressSockets) {
      try {
        socket.close(1001, 'server_shutdown');
      } catch {
        /* best-effort */
      }
    }
    state.progressSockets.clear();

    await Promise.race([
      app.close(),
      new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
    ]);
  }

  return { app: app as FastifyInstance, close };
}
