# Building and publishing releases

This document describes **public** distribution. Production host deploy stays in
the private monorepo workflow (`.github/workflows/deploy.yml`) and is out of
scope here.

## Local collector pack

Prerequisites: Node 22.x (`>=22 <23`), repository root, collector already built.
Node 24 is not currently certified.

```bash
npm ci
npm run build -w collector

node scripts/package-collector-release.mjs \
  --workspace . \
  --output tokember-collector-pack \
  --archives tokember-release-archives \
  --commit "$(git rev-parse HEAD)" \
  --built-at "$(git show -s --format=%cI HEAD)"
```

Outputs:

- Staged tree: `tokember-collector-pack/` (installers + `dist` + `package-meta.json` + `SHA256SUMS`)
- Archives (when `tar` / zip tools exist): `tokember-release-archives/tokember-collector-<version>-node22.{tar.gz,zip}` and archive-level `SHA256SUMS`

Forbidden in packs: `collector.env`, logs, machine-local runners.

## Image manifest

After multi-arch build (or with known tags):

```bash
node scripts/package-image-manifest.mjs \
  --output image-manifest.json \
  --version 0.2.0 \
  --commit "$(git rev-parse HEAD)" \
  --image linux/amd64=ghcr.io/example/tokember:0.2.0 \
  --image linux/arm64=ghcr.io/example/tokember:0.2.0@sha256:...
```

## GitHub Release workflow

`.github/workflows/release.yml` runs on:

- a weekly schedule (verification only)
- push of tags `v*`
- `workflow_dispatch` (manual)

Jobs:

1. **Platform release gate** — on the exact public repository, run Node 22
   `npm ci` + `npm run verify` on Windows, macOS, and Linux; Windows also runs
   the unchanged default-worker Chromium E2E command
2. **Package collector** — after the matrix, build dist, archive, upload artifacts
3. **Server images** — after the matrix, buildx `linux/amd64` + `linux/arm64`; push to GHCR when
   token allows, otherwise local build + manifest only  
4. **Publish** — assemble assets + `SHA256SUMS`, create GitHub Release

Scheduled runs stop after verification. Collector/image packaging and Release
publication are restricted to tag or manual events, so a timer never produces
distribution artifacts. Pull requests continue to use the faster Ubuntu CI
gate and its existing four required contexts.

It never SSHs to production hosts.

## Verify a download

```bash
sha256sum -c SHA256SUMS
# extract collector archive, then:
node install.mjs doctor
```

See also [COMPATIBILITY.md](./COMPATIBILITY.md).
