/**
 * `@toon-protocol/hub-mcp` — library surface.
 *
 * The package ships one bin (`hub-mcp`, the stdio server); this entry
 * exposes the reusable pieces for embedding / testing: config resolution, the
 * apex API client, the CLI driver, apex bring-up, and the MCP tool definitions.
 */
export { resolveConfig, type ResolvedConfig } from './config.js';
export {
  ApiClient,
  ApiError,
  ApexUnreachableError,
  type ApiClientOptions,
} from './api-client.js';
export {
  CliDriver,
  CliError,
  type ExecResult,
  type SpawnExec,
} from './cli-driver.js';
export {
  isApexReachable,
  spawnUpDetached,
  readUpStatus,
  autoUpIfEnabled,
  upLogPath,
  type UpStatus,
} from './apex-lifecycle.js';
export {
  dispatchTool,
  TOOL_DEFINITIONS,
  type ToolDefinition,
  type ToolResult,
  type ToolCtx,
} from './mcp-tools.js';
export {
  StreamsUnavailableError,
  tailLogsViaSse,
  metricsSnapshotViaWs,
  type LogEvent,
  type TailLogsOptions,
  type MetricsSnapshotOptions,
  type WsLike,
  type WsFactory,
} from './streams.js';
export {
  RESOURCE_DEFINITIONS,
  isKnownResource,
  readResource,
  type ResourceDefinition,
  type ResourceContents,
} from './resources.js';
export {
  readSelfPackage,
  computeVersionInfo,
  lowerBound,
  compareSemver,
  satisfiesLowerBound,
  type SelfPackage,
  type VersionInfo,
} from './version.js';
