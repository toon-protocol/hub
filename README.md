# hub

TOON Protocol operator product — @toon-protocol/hub (apex orchestrator: connector + child relay/swap/store), townhouse-web dashboard, townhouse-mcp. NB: townhouse->hub package rename + deprecate-redirect is a follow-up.

> Extracted from the TOON monorepo with full git history preserved. npm publishing is done by CI (changesets + `pnpm`, authed by the org `NPM_TOKEN` secret). Docker image-publish workflows (where applicable) are a follow-up carved from the monorepo `publish-townhouse-images.yml`.

## Getting started with Devbox

This repo ships a [Devbox](https://www.jetify.com/devbox/) environment that pins Node.js 20 and pnpm 8.15.0 to match the versions used in CI.

**Prerequisites:** [Install Devbox](https://www.jetify.com/devbox/docs/installing_devbox/) (Nix is installed automatically by the Devbox installer).

```sh
devbox shell        # drops you into a shell with Node 20 + pnpm 8.15.0
pnpm install
pnpm -r build
```

CI uses the same toolchain via `jetify-com/devbox-install-action`. For full nixpkgs-revision pinning, run `devbox shell` locally once and commit the generated `devbox.lock` (follow-up).
