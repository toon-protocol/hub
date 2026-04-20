/**
 * @toon-protocol/townhouse — public API.
 */

export type {
  TownhouseConfig,
  TownNodeConfig,
  MillNodeConfig,
  DvmNodeConfig,
  NodesConfig,
  WalletConfig,
  ConnectorConfig,
  TransportConfig,
  ApiConfig,
  LoggingConfig,
} from './config/index.js';

export {
  getDefaultConfig,
  loadConfig,
  validateConfig,
  ConfigValidationError,
} from './config/index.js';
