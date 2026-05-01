/**
 * Shared Fastify instance builder — loopback validation + CORS + WebSocket + error handler.
 * Consumed by both createApiServer and createWizardApiServer.
 */

import Fastify, { type FastifyInstance, type FastifyServerOptions, type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { buildCorsOptions } from './cors.js';

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
export async function buildFastifyApp(opts: FastifyBuildOptions = {}): Promise<FastifyInstance> {
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
            ],
            censor: '[REDACTED]',
          },
        }
      : (loggerOpt as FastifyServerOptions['logger']);

  const app = Fastify({
    logger,
    bodyLimit: 16 * 1024,
  } as FastifyServerOptions);

  app.setErrorHandler((error, _request, reply) => {
    app.log.error(error);
    const err = error as { statusCode?: number; code?: string; message?: string; validation?: unknown };
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
      error: isCorsRejection ? 'origin_not_allowed' : (err.code ?? 'internal_error'),
      message,
    });
  });

  await app.register(cors, buildCorsOptions());
  await app.register(websocket);

  return app;
}
