# hub

The TOON Protocol **operator product** (the deployment operators run): `@toon-protocol/townhouse` (the apex orchestrator — connector with nodeId `g.townhouse` + child relay/swap/store containers, Docker orchestration, wallet manager, Fastify control API), `townhouse-web` (dashboard), and `townhouse-mcp` (agent control). Ships the `townhouse-plugin/`. The repo is named `hub`; the npm packages keep the `townhouse` names pending the rename (which needs a deprecate-and-redirect since `@toon-protocol/townhouse` is published).

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
The product-specific **`townhouse-operator` skill ships in this repo's `townhouse-plugin/`** (not in toon-meta). Canonical rules: `toon-meta` → `_bmad-output/project-context.md`.

## Cross-repo dependencies
- Consumes `@toon-protocol/{core,sdk,client,relay,mill}` from **npm** (pinned semver) **and** pins the child node **Docker image digests** (`relay`/`swap`/`store`) — exactly as it already pins the connector image in `src/constants.ts`.
- The ILP payment engine is the separate **[toon-protocol/connector](https://github.com/toon-protocol/connector)** repo. **All payment-claim validation lives ONLY in the connector — never re-implement it here.**

> **Wire-id caveat:** `g.townhouse` is an on-wire ILP nodeId baked into the connector + every child's parent tag. The `townhouse → hub` *concept/package* rename must NOT change `g.townhouse`, or paid parent→child forwarding breaks (T00/F06).

## Publishing
CI publishes via **changesets + `pnpm`** using the org `NPM_TOKEN` secret. **Never run `npm publish`** (it ships unresolved `workspace:*`).
