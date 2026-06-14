/**
 * MCP resources (design §5/§9). The cheap, frequently-read operator views are
 * also exposed as MCP *resources* so clients that prefer resource reads (over
 * an explicit tool call) can fetch them by URI:
 *
 *   • `townhouse://status`   — apex / connector / node / transport snapshot
 *   • `townhouse://earnings` — apex + per-peer earnings with deltas
 *
 * Each resource is a thin alias over the equivalent telemetry tool, so the
 * degradation contract (apex booting → retry hint, CLI fallback) is identical
 * and there is exactly one code path per view.
 */
import { dispatchTool, type ToolCtx } from './mcp-tools.js';

/** An MCP resource descriptor (subset of the SDK's `Resource`). */
export interface ResourceDefinition {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

/** Contents returned for a resource read (subset of the SDK's result). */
export interface ResourceContents {
  contents: { uri: string; mimeType: string; text: string }[];
}

/** Each resource URI maps to the tool whose JSON payload it mirrors. */
const URI_TO_TOOL: Record<string, string> = {
  'townhouse://status': 'townhouse_status',
  'townhouse://earnings': 'townhouse_earnings',
};

export const RESOURCE_DEFINITIONS: ResourceDefinition[] = [
  {
    uri: 'townhouse://status',
    name: 'Townhouse status',
    description:
      'Apex / connector / node / transport snapshot (mirrors townhouse_status).',
    mimeType: 'application/json',
  },
  {
    uri: 'townhouse://earnings',
    name: 'Townhouse earnings',
    description:
      'Apex + per-peer earnings with today/month/year deltas (mirrors ' +
      'townhouse_earnings).',
    mimeType: 'application/json',
  },
];

/** True if `uri` is a townhouse resource this server serves. */
export function isKnownResource(uri: string): boolean {
  return uri in URI_TO_TOOL;
}

/**
 * Read a townhouse resource by URI. Delegates to the mirroring tool so error
 * handling / fallback behave exactly as the tool does; the tool's JSON text is
 * returned verbatim as the resource body.
 */
export async function readResource(
  ctx: ToolCtx,
  uri: string
): Promise<ResourceContents> {
  const tool = URI_TO_TOOL[uri];
  if (!tool) throw new Error(`Unknown resource: ${uri}`);
  const res = await dispatchTool(ctx, tool, {});
  const text = res.content.map((c) => c.text).join('\n');
  return { contents: [{ uri, mimeType: 'application/json', text }] };
}
