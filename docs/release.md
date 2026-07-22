# Building and publishing releases

This document describes **public** distribution. Production host deploy stays in
the private monorepo workflow (`.github/workflows/deploy.yml`) and is out of
scope here.

## Local collector pack

Prerequisites: Node 22+, repository root, collector already built.

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
  --version 0.1.0 \
  --commit "$(git rev-parse HEAD)" \
  --image linux/amd64=ghcr.io/example/tokember:0.1.0 \
  --image linux/arm64=ghcr.io/example/tokember:0.1.0@sha256:...
```

## GitHub Release workflow

`.github/workflows/release.yml` runs on:

- push of tags `v*`
- `workflow_dispatch` (manual)

Jobs:

1. **Package collector** — build dist, archive, upload artifacts  
2. **Server images** — buildx `linux/amd64` + `linux/arm64`; push to GHCR when
   token allows, otherwise local build + manifest only  
3. **Publish** — assemble assets + `SHA256SUMS`, create GitHub Release

It never SSHs to production hosts.

## Verify a download

```bash
sha256sum -c SHA256SUMS
# extract collector archive, then:
node install.mjs doctor
```

See also [COMPATIBILITY.md](./COMPATIBILITY.md).
