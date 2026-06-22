/**
 * CORS configuration for Hub API.
 *
 * SECURITY: Only allows localhost origins (loopback only for v1).
 */

import type { FastifyCorsOptions } from '@fastify/cors';

/**
 * Allowed localhost origins for CORS.
 */
const ALLOWED_ORIGINS = ['localhost', '127.0.0.1', '[::1]', '::1'];

/**
 * Check if an origin host is allowed.
 */
function isOriginAllowed(origin: string | undefined): boolean {
  // No origin header = curl, native fetch from file:// page = allowed
  if (!origin) {
    return true;
  }

  try {
    const url = new URL(origin);
    return ALLOWED_ORIGINS.includes(url.hostname);
  } catch {
    // Invalid origin = reject
    return false;
  }
}

/**
 * Build CORS options for Fastify.
 */
export function buildCorsOptions(): FastifyCorsOptions {
  return {
    origin: (origin, callback) => {
      // origin is the value of the Origin header, or undefined if not present

      if (isOriginAllowed(origin)) {
        callback(null, true);
      } else {
        // Reject with 403; Fastify will handle the response
        callback(new Error('Origin not allowed'), false);
      }
    },
    methods: ['GET', 'PATCH', 'OPTIONS', 'HEAD'],
    credentials: false,
  };
}
