/**
 * Shared Fastify instance builder — loopback validation + CORS + WebSocket + error handler.
 * Consumed by both createApiServer and createWizardApiServer.
 */

import Fastify, {
  type FastifyInstance,
  type FastifyServerOptions,
  type FastifyBaseLogger,
} from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
// Local alias so the bundled output doesn't collide with the tsup banner's own
// `import { createRequire } from 'module'` (Node ESM rejects duplicate identifier
// imports from the same module). Retroactively authorized 2026-05-18 code review of
// Story 49.1 — see Hard Rule #2 exception (d) in the story file. Smaller-radius fix
// than dropping the tsup banner entirely.
import { createRequire as nodeCreateRequire } from 'node:module';
import { buildCorsOptions } from './cors.js';

const STARTED_AT = new Date().toISOString();
// Resolve `package.json` defensively. At runtime `import.meta.url` points at the
// bundled output (e.g. `dist/cli.js`), where `../package.json` resolves to
// `packages/townhouse/package.json`. If tsup ever chunks this module deeper
// (e.g. `dist/api/build-app.js`), `../../package.json` is needed. Try the
// expected path first, then the deeper-chunk fallback. Pass 2 code review
// 2026-05-18 hardening per P37 — keeps the file working across bundle layouts
// instead of silently MODULE_NOT_FOUND-ing at boot under a future tsup config change.
const _localRequire = nodeCreateRequire(import.meta.url);
function _loadPackageJson(): { version: string } {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      return _localRequire(rel) as { version: string };
    } catch {
      // try next candidate
    }
  }
  throw new Error(
    "build-app.ts: could not resolve package.json from '../package.json' or '../../package.json'. " +
      'Bundle layout may have changed — update the resolution ladder.'
  );
}
const _pkgVersion: string = _loadPackageJson()['version'];

/** Allowed loopback hosts */
export const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'];

export interface FastifyBuildOptions {
  logger?: FastifyBaseLogger | boolean;
  /** Validated bind host — must be a loopback address in wizard mode */
  bindHost?: string;
  /** When true, throws if bindHost is non-loopback regardless of env var */
  requireLoopback?: boolean;
}

/**
 * Build a Fastify instance with shared middleware: CORS, WebSocket, and error handler.
 * Does NOT register any routes.
 *
 * SECURITY: Pino logger is configured with `redact` paths covering wizard-mode
 * secrets (mnemonic, password, password_confirm) so request-shape logging cannot
 * leak credentials even if the log level is bumped.
 */
export async function buildFastifyApp(
  opts: FastifyBuildOptions = {}
): Promise<FastifyInstance> {
  const bindHost = opts.bindHost ?? '127.0.0.1';

  if (!LOOPBACK_HOSTS.includes(bindHost)) {
    if (opts.requireLoopback) {
      throw new Error(
        'The wizard refuses remote bind for security. Edit ~/.townhouse/config.yaml after setup if you need remote API access.'
      );
    }
    if (process.env['TOWNHOUSE_API_ALLOW_REMOTE'] !== '1') {
      throw new Error(
        'Townhouse API refuses to bind to non-loopback host without TOWNHOUSE_API_ALLOW_REMOTE=1'
      );
    }
  }

  // Build logger options. When the caller passes a boolean (the common path) we
  // attach Pino redact paths. A custom FastifyBaseLogger instance is opaque so
  // we trust the caller has already configured redaction.
  const loggerOpt = opts.logger ?? true;
  const logger: FastifyServerOptions['logger'] =
    typeof loggerOpt === 'boolean' && loggerOpt
      ? {
          redact: {
            paths: [
              'req.body.mnemonic',
              'req.body.password',
              'req.body.password_confirm',
              'res.body.mnemonic',
              'mnemonic',
              'password',
              'password_confirm',
              // Story 46.2: secret-bearing fields introduced by node lifecycle
              // routes. These never appear in request/response bodies (they go
              // to subprocess env), but defense-in-depth covers them at every
              // path Pino might log a stray object (error objects, debug dumps).
              'nostrSecretKey',
              'evmPrivateKey',
              'TOWN_SECRET_KEY',
              'MILL_SECRET_KEY',
              'DVM_SECRET_KEY',
              'TOWN_SETTLEMENT_PRIVATE_KEY',
              'MILL_SETTLEMENT_PRIVATE_KEY',
              'DVM_SETTLEMENT_PRIVATE_KEY',
              'MILL_MNEMONIC',
              'TOWNHOUSE_WALLET_PASSWORD',
            ],
            censor: '[REDACTED]',
          },
        }
      : (loggerOpt as FastifyServerOptions['logger']);

  const app = Fastify({
    logger,
    bodyLimit: 16 * 1024,
    // SECURITY/CONTRACT: schemas with `additionalProperties: false` must REJECT
    // unknown keys with a 400, not silently strip them. Operators shipping a typo
    // should see a loud failure, not a no-op success.
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
  } as FastifyServerOptions);

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const err = error as {
      statusCode?: number;
      code?: string;
      message?: string;
      validation?: unknown;
    };
    const isCorsRejection = err.message === 'Origin not allowed';
    const statusCode = isCorsRejection ? 403 : (err.statusCode ?? 500);

    // SECURITY: 5xx responses always sanitized — err.message can carry payload
    // bits (validation context, file paths, partial inputs) and must not reach
    // the client. Only known-safe error classes (CORS rejection, Fastify
    // validation 4xx) get the original message.
    let message: string;
    if (isCorsRejection) {
      message = err.message ?? 'Origin not allowed';
    } else if (statusCode >= 400 && statusCode < 500 && err.validation) {
      message = err.message ?? 'Bad request';
    } else if (statusCode >= 400 && statusCode < 500) {
      message = err.message ?? 'Bad request';
    } else {
      message = 'Internal server error';
    }

    reply.status(statusCode).send({
      error: isCorsRejection
        ? 'origin_not_allowed'
        : (err.code ?? 'internal_error'),
      message,
    });
  });

  await app.register(cors, buildCorsOptions());
  await app.register(websocket);

  app.get('/health', async () => ({
    status: 'healthy' as const,
    uptime: Math.floor(process.uptime()),
    startedAt: STARTED_AT,
    version: _pkgVersion,
  }));

  return app;
}
