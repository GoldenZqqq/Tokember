# Security Policy

## Supported versions

Security fixes target the latest published Tokember release and the `master`
branch of the primary source repository.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems that could
expose user data, credentials, or remote code paths.

Preferred private channels (use the first available):

1. GitHub **Security Advisories** / private vulnerability reporting on the
   public Tokember repository (once published).
2. Contact the maintainer via the private repository owner account for this
   project while the public repo is being prepared.

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
