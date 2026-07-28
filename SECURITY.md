# Security Policy

## Supported versions

Security fixes target the latest published Tokember release and the `master`
branch of the primary source repository.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems that could
expose user data, credentials, or remote code paths.

Preferred private channels (use the first available):

1. GitHub **Security Advisories** / private vulnerability reporting on the
   public Tokember repository.
2. Contact the repository owner privately if GitHub private reporting is
   unavailable. Do not include exploit details in a public issue.

Include:

- Affected component (server, collector, web, install scripts)
- Tokember version or commit
- Reproduction steps **without** real production secrets
- Impact assessment (data leak, auth bypass, RCE, etc.)

## Response expectations

- Acknowledgement target: **within 7 days**
- Status update target: **within 14 days** for confirmed issues
- Coordinated disclosure after a fix is available when practical

## Safe collector defaults

- Collectors must not send data without an explicit server URL and credential.
- Prefer revocable `TOKEMBER_DEVICE_TOKEN` over long-lived shared API keys.
- Do not log Authorization headers, device tokens, or prompt/response bodies.

## Secret hygiene

If you accidentally commit a secret:

1. Rotate the credential immediately.
2. Remove it from the default branch.
3. Assume git history may still contain it until history is rewritten or the
   public export uses a clean root commit.

## Dual-repository security fixes

The public repository is the disclosure and release surface. While product
source still originates in a private upstream, maintainers must land coordinated
security fixes there and regenerate the public manifest before release.

An urgent public-only fix freezes unrelated public merges and must return to the
private upstream within one working day. Release artifacts remain blocked until
the strict public-tree verification passes. See
[Repository governance](./docs/repository-governance.md).
