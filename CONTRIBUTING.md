# Contributing

Thanks for helping improve wecom-agent-gateway. The project welcomes focused
bug reports, documentation fixes, transport reliability work, and new Agent
Kernel adapters.

## Before opening an issue

- Search existing issues and the [documentation](docs/README.md).
- Use GitHub Security Advisories for vulnerabilities; do not disclose secrets
  or exploitable details in a public issue.
- Remove Bot credentials, internal IDs, employee names, conversation names,
  message bodies, media URLs, local paths, and model credentials from reports.

## Development setup

Requirements: Node.js 22 or newer and pnpm 11.8.0.

```bash
pnpm install --frozen-lockfile
pnpm run ci
```

Real WeCom and model credentials are never required for the default test suite.
Use deterministic fakes for every behavior change. Real acceptance tests are
operator-triggered and must remain outside CI.

## Design rules

- Prefer the official WeCom SDK over reimplementing authentication, heartbeat,
  reconnect, media cryptography, or push protocols.
- Keep `packages/runtime-contract` independent of WeCom and Agent vendors.
- Preserve the single Bot identity invariant.
- Keep Agent reasoning, model selection, and business routing outside Gateway
  Core.
- Declare exact input and output modalities and fail closed when unsupported.
- Do not convert media into semantic placeholder prompts.
- Persist outbound commands before delivery and keep sensitive media material
  ephemeral or in the protected spool.

Substantial contract or architecture changes should include an ADR under
`docs/adr/`.

## Pull requests

1. Keep a pull request scoped to one coherent change.
2. Add or update deterministic tests.
3. Update public documentation and compatibility tables when behavior changes.
4. Run `pnpm run ci` locally.
5. Complete the pull request checklist and call out untested real-world paths.

Commits should use a clear imperative or Conventional Commits-style subject,
for example `fix: recover a leased media delivery`.

By contributing, you agree that your contributions are licensed under the
repository's [MIT License](LICENSE).
