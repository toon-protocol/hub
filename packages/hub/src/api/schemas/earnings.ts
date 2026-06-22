/**
 * Response schema for GET /api/earnings (Story 47.4).
 *
 * Locks the wire-level contract for the TUI / SPA / future Tauri client.
 * Schema library: raw `FastifySchema` JSON Schema — matches the established
 * pattern in `api/routes/transport.ts:42-52`. See Story 47.4 Open Question 1
 * for the decision trail (TypeBox language in the epic AC was superseded by
 * codebase consistency).
 *
 * AC #1 enforcement: amount fields use `pattern: '^-?\\d+$'` (decimal-string
 * bigint, no number coercion); timestamps use `format: 'date-time'` (ISO-8601).
 * Validation requires `ajv-formats` in tests (schema.test.ts registers it).
 *
 * Pass-through subobjects (`recentClaim`, `perAsset`) intentionally OMIT
 * `additionalProperties: false` so future connector-shipped fields (e.g. a
 * `RecentClaim.txHash` added in a connector minor release) survive serialization.
 * `peerSchema` and the top-level remain closed — Hub owns those shapes.
 *
 * NOTE: Fastify response schemas run a SERIALIZER (fast-json-stringify), not a
 * validator — unknown fields in the handler return value are silently dropped.
 * To validate against this schema, use Ajv directly (see earnings.test.ts).
 */

import type { FastifySchema } from 'fastify';

const DECIMAL_STRING_PATTERN = '^-?\\d+$';

const perAssetSchema = {
  type: 'object',
  properties: {
    lifetime: { type: 'string', pattern: DECIMAL_STRING_PATTERN },
    today: { type: 'string', pattern: DECIMAL_STRING_PATTERN },
    month: { type: 'string', pattern: DECIMAL_STRING_PATTERN },
    year: { type: 'string', pattern: DECIMAL_STRING_PATTERN },
  },
  required: ['lifetime', 'today', 'month', 'year'] as const,
  // Open to future connector-derived fields per D2 decision (2026-05-13).
} as const;

const routingFeesSchema = {
  type: 'object',
  additionalProperties: perAssetSchema,
} as const;

const peerSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    type: {
      type: 'string',
      enum: ['town', 'mill', 'dvm', 'external'] as const,
    },
    byAsset: routingFeesSchema,
    lastClaimAt: {
      oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
    },
  },
  required: ['id', 'type', 'byAsset', 'lastClaimAt'] as const,
  additionalProperties: false, // Hub owns the peer shape.
} as const;

const recentClaimSchema = {
  type: 'object',
  properties: {
    peerId: { type: 'string' },
    assetCode: { type: 'string' },
    assetScale: { type: 'integer', minimum: 0 },
    amount: { type: 'string', pattern: DECIMAL_STRING_PATTERN },
    direction: { type: 'string', enum: ['inbound', 'outbound'] as const },
    at: { type: 'string', format: 'date-time' },
  },
  required: [
    'peerId',
    'assetCode',
    'assetScale',
    'amount',
    'direction',
    'at',
  ] as const,
  // Open to future connector-shipped fields per D2 decision (2026-05-13).
} as const;

export const earningsResponseSchema: FastifySchema = {
  response: {
    200: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok', 'connector_unavailable'] },
        apex: {
          type: 'object',
          properties: {
            routingFees: routingFeesSchema,
          },
          required: ['routingFees'],
          additionalProperties: false,
        },
        peers: {
          type: 'array',
          items: peerSchema,
        },
        recentClaims: {
          type: 'array',
          items: recentClaimSchema,
        },
        eventsRelayed: { type: 'integer', minimum: 0 },
        uptimeSeconds: { type: 'integer', minimum: 0 },
      },
      required: [
        'status',
        'apex',
        'peers',
        'recentClaims',
        'eventsRelayed',
        'uptimeSeconds',
      ],
      additionalProperties: false,
    },
  },
};
