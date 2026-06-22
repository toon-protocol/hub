#!/usr/bin/env node
/**
 * `hub-mcp` — a thin MCP stdio server exposing the Hub OPERATOR
 * surface to a Claude agent (Desktop or Code). It holds NO chain keys: every
 * tool maps to either the `hub` CLI (lifecycle / config / $) or the apex
 * Fastify API :9400 (live telemetry). Unlike client-mcp there is NO second
 * daemon — the apex (connector + API, started by `hub up`) IS the
 * long-lived layer (see docs/hub-mcp-design.md §0).
 *
 * Works on both surfaces:
 *   • Claude Desktop — `claude_desktop_config.json` mcpServers entry.
 *   • Claude Code   — `claude mcp add hub -- hub-mcp`.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  type CallToolResult,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import { ApiClient } from './api-client.js';
import { CliDriver } from './cli-driver.js';
import { dispatchTool, TOOL_DEFINITIONS } from './mcp-tools.js';
import { RESOURCE_DEFINITIONS, readResource } from './resources.js';
import { resolveConfig } from './config.js';
import { autoUpIfEnabled } from './apex-lifecycle.js';

/** stdout carries the MCP protocol — all logging must go to stderr. */
function log(msg: string): void {
  console.error(`[hub-mcp] ${msg}`);
}

async function main(): Promise<void> {
  const cfg = resolveConfig();
  const api = new ApiClient({ baseUrl: cfg.apiUrl });
  const cli = new CliDriver(cfg);

  // Kick off apex bring-up; don't block server init on it (image pulls / HS
  // bootstrap are slow). Tools report "booting — retry" until the API answers.
  void autoUpIfEnabled(api, cfg);

  const server = new Server(
    { name: 'hub-operator', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } }
  );

  const ctx = { api, cli, cfg };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    // Our ToolResult is a structural subset of CallToolResult (content + isError).
    return (await dispatchTool(ctx, name, args)) as CallToolResult;
  });

  // Resources: read-only aliases over the cheap telemetry views (design §5).
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCE_DEFINITIONS,
  }));

  server.setRequestHandler(
    ReadResourceRequestSchema,
    async (request) =>
      // ResourceContents is a structural subset of ReadResourceResult.
      (await readResource(ctx, request.params.uri)) as ReadResourceResult
  );

  await server.connect(new StdioServerTransport());
  log(`ready; api=${cfg.apiUrl} bin=${cfg.hubBin}`);
}

main().catch((err) => {
  log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
