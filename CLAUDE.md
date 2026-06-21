# hub

The TOON Protocol **operator product** (the deployment operators run): `@toon-protocol/hub` (the apex orchestrator — connector with nodeId `g.townhouse` + child relay/swap/store containers, Docker orchestration, wallet manager, Fastify control API), `@toon-protocol/hub-web` (dashboard), and `@toon-protocol/hub-mcp` (agent control). Ships the `hub-plugin/`.

> **Renamed from `townhouse`.** The npm packages were `@toon-protocol/{townhouse,townhouse-mcp,townhouse-web}` → now `@toon-protocol/{hub,hub-mcp,hub-web}`; CLIs keep deprecated `townhouse`/`townhouse-mcp` bin aliases alongside `hub`/`hub-mcp`. Follow-up at publish time: `npm deprecate @toon-protocol/townhouse "renamed to @toon-protocol/hub"`. **The `g.townhouse` on-wire nodeId and `TOWNHOUSE_*` env vars are deliberately UNCHANGED** — the rename touched only the `@toon-protocol/*` package identifiers and the repo directory structure, never the wire protocol or operator config.

Part of the **TOON Protocol** — pay-to-write Nostr over Interledger (ILP), split into per-team repos. The hub is the apex: clients pay it over BTP; it validates the claim, takes a fee, and free-forwards to its child nodes.

## Build & test
```
pnpm install
pnpm -r build
pnpm -r test
```

## Shared skills, docs & project context → toon-protocol/toon-meta
Cross-cutting agent skills, docs, and the canonical project context live in **[toon-protocol/toon-meta](https://github.com/toon-protocol/toon-meta)**. Load the shared skills:
```
/plugin marketplace add toon-protocol/toon-meta
/plugin install toon-skills@toon-meta
```
The product-specific **`hub-operator` skill ships in this repo's `hub-plugin/`** (not in toon-meta). Canonical rules: `toon-meta` → `_bmad-output/project-context.md`.

## Cross-repo dependencies
- Consumes `@toon-protocol/{core,sdk,client,relay,mill}` from **npm** (pinned semver) **and** pins the child node **Docker image digests** (`relay`/`swap`/`store`) — exactly as it already pins the connector image in `src/constants.ts`.
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo. **All payment-claim validation lives ONLY in the connector — never re-implement it here.**

> **Wire-id caveat:** `g.townhouse` is an on-wire ILP nodeId baked into the connector + every child's parent tag. The `hub → hub` *concept/package* rename must NOT change `g.townhouse`, or paid parent→child forwarding breaks (T00/F06).

## Publishing
CI publishes via **changesets + `pnpm`** using the org `NPM_TOKEN` secret. **Never run `npm publish`** (it ships unresolved `workspace:*`).
