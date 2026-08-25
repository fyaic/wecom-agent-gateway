# Security policy

## Supported versions

The project is currently in Public Preview. Security fixes are applied to the
latest commit on `main`; older commits and unreleased snapshots are not
maintained as separate support lines.

## Reporting a vulnerability

Use the repository's **Security** tab to submit a private GitHub Security
Advisory. Do not open a public issue for a suspected vulnerability.

Include a minimal reproduction, affected component, impact, and suggested
mitigation if known. Remove all real Bot credentials, model credentials,
employee or conversation identifiers, message contents, media URLs, and local
filesystem paths.

Maintainers will acknowledge a valid report as soon as practical, coordinate a
fix and disclosure timeline, and credit reporters who wish to be credited.

## Deployment responsibility

Operators are responsible for:

- keeping Bot, Kernel, and provider credentials outside the repository;
- using scoped direct and group allowlists;
- restricting `.env`, SQLite, media temp, and spool permissions;
- restricting `WECOM_MEDIA_OUTPUT_ROOTS` to dedicated output directories;
- running exactly one Gateway Kernel for a Bot identity;
- reviewing write-tool approvals and rotating credentials after suspected
  exposure.

The project does not provide a security warranty. See [LICENSE](LICENSE).
