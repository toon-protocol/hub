# hub

TOON Protocol operator product — @toon-protocol/hub (apex orchestrator: connector + child relay/swap/store), townhouse-web dashboard, townhouse-mcp. NB: townhouse->hub package rename + deprecate-redirect is a follow-up.

> Extracted from the TOON monorepo with full git history preserved. npm publishing is done by CI (changesets + `pnpm`, authed by the org `NPM_TOKEN` secret). Docker image-publish workflows (where applicable) are a follow-up carved from the monorepo `publish-townhouse-images.yml`.

## Getting started with Devbox

[Devbox](https://github.com/jetify-com/devbox) pins the local toolchain to the exact
versions CI uses — Node `22` and pnpm `8.15.9` — so `pnpm build`, `pnpm test`, and
`pnpm lint` run in a reproducible shell without touching your system packages.

**Prerequisites:** [Install devbox](https://www.jetify.com/devbox/docs/installing_devbox/) (one-liner).

```bash
# Enter the pinned shell (downloads packages on first run via Nix)
devbox shell

# Inside the devbox shell, all tools are on PATH:
node --version    # v22.x
pnpm --version    # 8.15.x

# Run the standard targets (defined as devbox scripts)
devbox run build  # pnpm install --frozen-lockfile && pnpm build
devbox run lint
devbox run test
```

`.devbox/` (the Nix symlink/cache dir) is gitignored; `devbox.json` and `devbox.lock`
are committed.
