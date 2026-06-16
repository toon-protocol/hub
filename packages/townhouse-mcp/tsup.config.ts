import { defineConfig } from 'tsup';

export default defineConfig({
  // Library surface (index) + the single stdio bin (mcp). The bin source carries
  // a `#!/usr/bin/env node` shebang which tsup preserves in the emitted file.
  // No second daemon: the apex (connector + Fastify API, started by
  // `townhouse up`) IS the long-lived layer — see docs/townhouse-mcp-design.md §0.
  entry: ['src/index.ts', 'src/mcp.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // We import ONLY types from @toon-protocol/hub (erased at build), so no
  // workspace runtime deps to inline. The single runtime dep
  // (@modelcontextprotocol/sdk) is declared and stays external.
});
