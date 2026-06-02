/**
 * Wizard API routes: GET /wizard/state, POST /wizard/mnemonic-preview,
 * POST /wizard/init, WS /wizard/progress.
 *
 * SECURITY: Mnemonic and password are never logged, never stored in module scope.
 */

import { existsSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { generateMnemonic, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import type { WizardInitRequest, WizardProgressMessage } from '../types.js';
import {
  WalletManager,
  encryptWallet,
  saveWallet,
} from '../../wallet/index.js';
import { saveConfig } from '../../config/loader.js';
import { getDefaultConfig } from '../../config/defaults.js';
import type { TownhouseConfig } from '../../config/schema.js';
import type { NodeType } from '../../docker/types.js';

export interface WizardDeps {
  configPath: string;
  walletPath: string;
}

export interface WizardTransitionState {
  mode: 'wizard' | 'normal';
  /** Buffered progress messages for late-connecting WS clients (wizard mode only) */
  progressBuffer?: WizardProgressMessage[];
  /** Active WS connections to forward events to (wizard mode only) */
  progressSockets?: Set<WebSocket>;
  /** Single in-flight init guard — prevents concurrent POST /wizard/init from racing past existsSync */
  initInFlight?: boolean;
}

export type OnInitCallback = (
  config: TownhouseConfig,
  wallet: WalletManager,
  profiles: NodeType[]
) => Promise<void>;

/** Cap progress buffer to bound memory during long Docker pulls */
export const PROGRESS_BUFFER_MAX = 200;

/** Allowed Origin hostnames for cross-origin WS upgrades on the wizard */
const ALLOWED_WS_ORIGIN_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
]);

function isAllowedWsOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // same-origin WS request has no Origin header in some clients; the OS-level loopback bind already restricts
  try {
    const url = new URL(origin);
    return ALLOWED_WS_ORIGIN_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Register wizard-scoped routes.
 * In 'wizard' mode: all wizard routes are active.
 * In 'normal' mode: only GET /wizard/state returns normal-mode payload; other routes refuse.
 */
export function registerWizardRoutes(
  app: FastifyInstance,
  deps: WizardDeps,
  state: WizardTransitionState,
  onInit?: OnInitCallback
): void {
  // GET /wizard/state — registered in BOTH wizard and normal mode
  app.get('/wizard/state', async (_request, reply) => {
    const configExists = existsSync(deps.configPath);
    const walletExists = existsSync(deps.walletPath);
    // `containers_running` reflects whether the wizard server has transitioned
    // to normal mode (i.e., orchestrator.up() resolved at least once). It does
    // NOT track live container health — a container that dies post-transition
    // will not flip this back to false. The SPA uses this to know it can navigate
    // off /wizard, not as a liveness indicator.
    const containersRunning = state.mode === 'normal';

    return reply.status(200).send({
      config_exists: configExists,
      wallet_exists: walletExists,
      containers_running: containersRunning,
      mode: state.mode,
      ts: Date.now(),
    });
  });

  // POST /wizard/mnemonic-preview — stateless preview; disabled after transition
  app.post('/wizard/mnemonic-preview', async (_request, reply) => {
    if (state.mode === 'normal') {
      return reply.status(503).send({ error: 'wizard_already_completed' });
    }
    // SECURITY: mnemonic generated fresh per request, never logged, never stored
    const mnemonic = generateMnemonic(wordlist, 128);
    return reply.status(200).send({ mnemonic });
  });

  // POST /wizard/init — validate, write wallet + config, fire async launch
  app.post('/wizard/init', async (request, reply) => {
    if (state.mode === 'normal') {
      return reply.status(409).send({
        code: 'wizard_already_completed',
        message: 'Setup is already complete.',
      });
    }

    // Concurrent-init guard: serialize against double-clicks and parallel POSTs.
    // The `wallet.enc` write below also uses O_EXCL ('wx') as a TOCTOU backstop.
    if (state.initInFlight) {
      return reply.status(409).send({
        code: 'init_in_flight',
        message: 'A setup is already in progress.',
      });
    }
    state.initInFlight = true;

    try {
      const body = request.body as Partial<WizardInitRequest> | null;
      if (!body || typeof body !== 'object') {
        return reply
          .status(400)
          .send({ code: 'invalid_request', message: 'Request body required.' });
      }

      // Validate password — boundary-trim trailing whitespace check; passwords with leading/trailing
      // whitespace are silently corrupted by browser autofill and cannot be decrypted later.
      const password = body.password;
      if (
        typeof password !== 'string' ||
        password.length === 0 ||
        password.length > 256
      ) {
        return reply.status(400).send({
          code: 'password_invalid',
          message: 'password must be 1–256 characters.',
        });
      }
      if (password !== password.trim()) {
        return reply.status(400).send({
          code: 'password_invalid',
          message: 'password cannot have leading or trailing whitespace.',
        });
      }
      if (password !== body.password_confirm) {
        return reply.status(400).send({
          code: 'password_mismatch',
          message: 'Passwords do not match.',
        });
      }

      // Validate mnemonic_mode
      const mnemonicMode = body.mnemonic_mode;
      if (mnemonicMode !== 'generate' && mnemonicMode !== 'import') {
        return reply.status(400).send({
          code: 'mnemonic_mode_invalid',
          message: 'mnemonic_mode must be "generate" or "import".',
        });
      }

      // Validate mnemonic (both modes require a valid phrase — server validates regardless of source)
      const mnemonic = body.mnemonic;
      if (
        !mnemonic ||
        typeof mnemonic !== 'string' ||
        mnemonic.trim().length === 0
      ) {
        return reply
          .status(400)
          .send({ code: 'mnemonic_invalid', message: 'mnemonic is required.' });
      }
      if (!validateMnemonic(mnemonic.trim(), wordlist)) {
        return reply.status(400).send({
          code: 'mnemonic_invalid',
          message: 'Invalid BIP-39 mnemonic.',
        });
      }
      const cleanMnemonic = mnemonic.trim();

      // backup_ack enforcement (Risk R-022) — applies to both generate and import modes
      if (body.backup_ack !== true) {
        return reply.status(400).send({
          code: 'backup_not_acknowledged',
          message:
            'You must confirm you have backed up your seed phrase before continuing.',
        });
      }

      // Validate nodes
      const nodes = body.nodes;
      if (!nodes || typeof nodes !== 'object') {
        return reply
          .status(400)
          .send({ code: 'no_nodes_selected', message: 'nodes is required.' });
      }
      const atLeastOne =
        nodes.town?.enabled || nodes.mill?.enabled || nodes.dvm?.enabled;
      if (!atLeastOne) {
        return reply.status(400).send({
          code: 'no_nodes_selected',
          message: 'At least one node must be enabled.',
        });
      }

      // Validate fee ranges
      if (nodes.town?.enabled && nodes.town.feePerEvent !== undefined) {
        if (
          !Number.isInteger(nodes.town.feePerEvent) ||
          nodes.town.feePerEvent < 0 ||
          nodes.town.feePerEvent > 1000
        ) {
          return reply.status(400).send({
            code: 'fee_out_of_range',
            message: 'nodes.town.feePerEvent must be 0–1000.',
          });
        }
      }
      if (nodes.mill?.enabled && nodes.mill.feeBasisPoints !== undefined) {
        if (
          !Number.isInteger(nodes.mill.feeBasisPoints) ||
          nodes.mill.feeBasisPoints < 0 ||
          nodes.mill.feeBasisPoints > 100
        ) {
          return reply.status(400).send({
            code: 'fee_out_of_range',
            message: 'nodes.mill.feeBasisPoints must be 0–100.',
          });
        }
      }
      if (nodes.dvm?.enabled && nodes.dvm.feePerJob !== undefined) {
        if (
          !Number.isInteger(nodes.dvm.feePerJob) ||
          nodes.dvm.feePerJob < 0 ||
          nodes.dvm.feePerJob > 100000
        ) {
          return reply.status(400).send({
            code: 'fee_out_of_range',
            message: 'nodes.dvm.feePerJob must be 0–100000.',
          });
        }
      }

      // Validate transport
      const transport = body.transport;
      if (
        !transport ||
        (transport.mode !== 'direct' && transport.mode !== 'ator')
      ) {
        return reply.status(400).send({
          code: 'transport_invalid',
          message: 'transport.mode must be "direct" or "ator".',
        });
      }

      // Conflict checks — TOCTOU-resilient: the wallet.enc write below uses O_EXCL ('wx').
      if (existsSync(deps.walletPath)) {
        return reply.status(409).send({
          code: 'wallet_already_exists',
          message: `A wallet already exists at ${deps.walletPath}. Delete it first.`,
        });
      }
      if (existsSync(deps.configPath)) {
        return reply.status(409).send({
          code: 'config_already_exists',
          message: `A config already exists at ${deps.configPath}. Delete it first.`,
        });
      }

      // Create + save wallet. saveWallet writes with mode 0o600 already.
      // Concurrent inits are serialized by `state.initInFlight` above; a stray
      // external process writing wallet.enc between existsSync and saveWallet
      // is an accepted edge case for v1 (single-machine localhost wizard).
      const walletManager = new WalletManager({
        encryptedPath: deps.walletPath,
      });
      await walletManager.fromMnemonic(cleanMnemonic);
      // SECURITY: encrypted immediately, plaintext mnemonic leaves scope after this call
      const encrypted = encryptWallet(cleanMnemonic, password);
      await saveWallet(deps.walletPath, encrypted);
      // Defensive chmod (saveWallet already sets 0o600 but a hostile umask on
      // exotic platforms could still produce a too-open file; cheap to assert).
      try {
        chmodSync(deps.walletPath, 0o600);
      } catch {
        /* best-effort */
      }

      // Build + save config — if this throws, roll back the wallet write.
      let config: TownhouseConfig;
      try {
        config = buildConfigFromRequest(
          body as WizardInitRequest,
          deps.configPath
        );
        saveConfig(deps.configPath, config);
      } catch (err) {
        try {
          unlinkSync(deps.walletPath);
        } catch {
          /* best-effort */
        }
        throw err;
      }

      // Return 202 before async launch — reply is sent first
      await reply.status(202).send({ status: 'launching' });

      // Fire-and-forget: transition to normal mode + start orchestrator.
      // On failure, roll back wallet+config so the operator can retry without
      // hitting 409 wallet_already_exists / config_already_exists.
      if (onInit) {
        const profiles: NodeType[] = [];
        if (nodes.town?.enabled) profiles.push('town');
        if (nodes.mill?.enabled) profiles.push('mill');
        if (nodes.dvm?.enabled) profiles.push('dvm');

        onInit(config, walletManager, profiles).catch((err: unknown) => {
          app.log.error({ err }, 'Wizard launch failed');
          try {
            unlinkSync(deps.walletPath);
          } catch {
            /* best-effort */
          }
          try {
            unlinkSync(deps.configPath);
          } catch {
            /* best-effort */
          }
          // Allow a fresh retry: clear the in-flight flag so the next POST passes the guard.
          state.initInFlight = false;
          const errMsg: WizardProgressMessage = {
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
            ts: Date.now(),
          };
          if (state.progressBuffer) {
            state.progressBuffer.push(errMsg);
            if (state.progressBuffer.length > PROGRESS_BUFFER_MAX) {
              state.progressBuffer.splice(
                0,
                state.progressBuffer.length - PROGRESS_BUFFER_MAX
              );
            }
          }
          if (state.progressSockets) {
            for (const socket of state.progressSockets) {
              try {
                if (socket.readyState === WebSocket.OPEN) {
                  socket.send(JSON.stringify(errMsg));
                }
              } catch {
                /* best-effort */
              }
            }
          }
        });
      }

      return reply;
    } finally {
      // The success path keeps initInFlight=true to block double-submits while
      // the orchestrator boots; only an error in onInit (above) clears it. If
      // we never reached the onInit branch (e.g., 4xx validation), clear here.
      // We detect this by checking whether reply was already sent with 202.
      // Simpler: the outer success path sets it; validation failures must reset.
      const sent = reply.statusCode;
      if (sent !== 202) {
        state.initInFlight = false;
      }
    }
  });

  // WS /wizard/progress — only active in wizard mode (progress sockets are wizard-only).
  // CSWSH defense: enforce Origin header allowlist on upgrade.
  app.get('/wizard/progress', { websocket: true }, (socket, req) => {
    const origin = (req.raw as IncomingMessage).headers?.origin;
    if (!isAllowedWsOrigin(origin)) {
      try {
        socket.close(1008, 'origin_not_allowed');
      } catch {
        /* best-effort */
      }
      return;
    }

    const sockets = state.progressSockets;
    if (!sockets) {
      // Normal mode: close immediately (wizard is complete)
      socket.close(1001, 'wizard_complete');
      return;
    }

    sockets.add(socket);

    // Replay buffered messages for late-connecting clients
    if (state.progressBuffer) {
      for (const msg of state.progressBuffer) {
        try {
          socket.send(JSON.stringify(msg));
        } catch {
          /* best-effort */
        }
      }
    }

    socket.on('close', () => {
      sockets.delete(socket);
    });

    socket.on('error', () => {
      sockets.delete(socket);
    });
  });
}

/**
 * Build a TownhouseConfig from a WizardInitRequest by merging with defaults.
 * Uses path.dirname/join for cross-platform path handling.
 */
export function buildConfigFromRequest(
  request: WizardInitRequest,
  configPath: string
): TownhouseConfig {
  const config = getDefaultConfig();

  // Point wallet path at the same directory as config — works on POSIX and Windows.
  const configDir = dirname(configPath);
  config.wallet.encrypted_path = join(configDir, 'wallet.enc');

  // Apply node selections and fees
  config.nodes.town.enabled = request.nodes.town.enabled;
  if (
    request.nodes.town.enabled &&
    request.nodes.town.feePerEvent !== undefined
  ) {
    config.nodes.town.feePerEvent = request.nodes.town.feePerEvent;
  }

  config.nodes.mill.enabled = request.nodes.mill.enabled;
  if (
    request.nodes.mill.enabled &&
    request.nodes.mill.feeBasisPoints !== undefined
  ) {
    config.nodes.mill.feeBasisPoints = request.nodes.mill.feeBasisPoints;
  }

  config.nodes.dvm.enabled = request.nodes.dvm.enabled;
  if (request.nodes.dvm.enabled && request.nodes.dvm.feePerJob !== undefined) {
    config.nodes.dvm.feePerJob = request.nodes.dvm.feePerJob;
  }

  // Apply transport
  config.transport.mode = request.transport.mode;

  // Apply optional settlement chains (deep-validated at save time).
  if (request.chainProviders && request.chainProviders.length > 0) {
    config.chainProviders = request.chainProviders;
  }

  return config;
}
