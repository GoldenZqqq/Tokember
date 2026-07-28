# Repository Governance

Tokember currently uses two repositories so public product development remains
separate from private production operations. This document defines the source
of truth, synchronization, contribution, emergency, release, and migration
rules. It does not grant access to private infrastructure.

## Current ownership

| Surface | Source of truth | Flow |
| --- | --- | --- |
| Product source, tests, public documentation and public workflows | Private source repository | Verified source commit to public sync pull request |
| Production workflow, environment policy, inventory and credentials | Private operations only | Never exported |
| Issues and contribution proposals | Public repository | Public review, then attributed maintainer replay |
| Release assets and GHCR images | Public tagged commit | Public Release to users and, later, production |
| Research, task history and source media | Private operations only | Never exported |

`scripts/public-export.mjs` is the only product export path. It classifies every
tracked source path, rejects sensitive or unsupported entries, and writes a
schema-versioned `PUBLIC_EXPORT.json` containing the private source commit and a
sorted SHA-256 list. Unknown paths fail closed.

## Integrity checks

The verifier has two modes:

```bash
# Public checkout or freshly staged export: manifest plus exact tree and hashes
npm run public:verify -- --public-root /path/to/Tokember

# Private source checkout: also recreate the manifest from its declared commit
npm run public:verify -- \
  --public-root /path/to/Tokember \
  --source-root /path/to/private-source
```

Self mode proves that the inspected public tree matches its manifest. Source
mode additionally proves that the manifest matches the declared private Git
tree and the current export classification. Neither mode fetches, pushes,
changes remotes, or follows symbolic links.

Public pull requests validate manifest structure but do not require contributors
to regenerate private-source hashes. Strict tree verification runs after a
public `master` push and during manual CI. The existing required pull-request
contexts remain the product quality gate.

## Normal synchronization

1. Select one committed, fully verified private source SHA.
2. Stage a fresh export with `npm run public:export`; never reuse a previous
   staging directory or copy private Git history.
3. Run private hygiene, strict self verification, source verification, tests,
   and secret scanning against the staged tree.
4. Create a public sync branch and pull request. Do not push directly through
   protected `master`.
5. Merge only after the four current public required contexts pass.
6. Verify public `master` again and record the public commit, private source
   commit, manifest hash, version, and Release tag when applicable.

Release-ready private changes should be synchronized within one working day.
Security fixes follow their coordinated disclosure plan when that is stricter.

## External contributions

Contributors open ordinary public pull requests and do not edit
`PUBLIC_EXPORT.json`. Before merge, a maintainer:

1. reviews public ownership and privacy boundaries;
2. replays the accepted diff into a private source branch;
3. preserves author credit with `Co-authored-by`;
4. runs the complete private verification gate;
5. exports that private commit into a public sync pull request; and
6. links the original pull request to the attributed commit and sync result.

The original pull request is then closed as superseded. This temporary process
prevents a later export from overwriting a public-only fix. It ends when the
public repository becomes the product source of truth.

## Emergency public fixes

A maintainer may merge a public-only fix when delaying it would expose users to
material security or release harm. The maintainer must immediately:

1. freeze unrelated public merges;
2. record the divergent public commit;
3. replay the patch into the private source with attribution;
4. regenerate and verify the public manifest within one working day; and
5. resume merges only after public `master` is reconciled.

If reconciliation cannot complete, do not publish a tag or artifact from the
divergent tree. Revert the public-only fix only when that is safer than retaining
it; never hide or rewrite an already published security release.

## Releases and rollback

Public tags are immutable distribution identities. Collector archives, checksum
manifests, attestations, and OCI images must come from the tagged public commit.
Production remains on the private build path until the migration gates below
pass. A repository synchronization failure never restores or rewrites the live
SQLite database.

Rollback means selecting the last verified code or artifact identity and using
the existing atomic publisher. Do not move a published tag, overwrite an
artifact, mirror private history, or silently omit a drift finding.

## Public-first migration

1. **Harden export**: operate the manifest verifier and contribution ingress.
2. **Shadow public authority**: make product changes publicly while retaining a
   read-only private product copy for one release cycle.
3. **Consume artifacts**: publish a checksummed server bundle or immutable OCI
   digest; private deployment verifies repository identity, checksum or
   attestation, architecture, and release metadata before publication.
4. **Retire duplication**: remove private product source only after two
   consecutive public releases and one production rollback drill pass.

The final private repository keeps deployment policy, environment wiring,
inventory, recovery evidence, and private tooling. It consumes immutable public
artifacts rather than a mutable branch or Git submodule.
