/**
 * Preset barrel — single entrypoint for all `townhouse init --preset=<name>`
 * preset definitions.
 */

export {
  buildDemoConfig,
  resolveChainEndpoints,
  defaultLeasesPath,
  defaultDemoConfigDir,
  DEMO_DETERMINISTIC_PASSWORD,
  LOCAL_DEVNET_FALLBACK,
  type PresetName,
  type AkashLeases,
  type ResolvedChainEndpoints,
  type BuildDemoConfigOptions,
} from './demo.js';
