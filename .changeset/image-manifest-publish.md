---
"@toon-protocol/hub": patch
---

fix: ship `dist/image-manifest.json` so `townhouse up --transport direct` works from npm

0.34.3 published without the digest-pinned image manifest the build only ever
*read* — direct mode hard-failed with "image-manifest.json not found". The build
(`tsup` onSuccess) now generates it from live GHCR digests for connector/town/
mill/dvm/townhouse-api, so the published tarball includes it.
