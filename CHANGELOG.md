# Changelog

All notable changes will be documented in this file. The project follows
[Semantic Versioning](https://semver.org/) once the first public version is
tagged.

## [Unreleased]

### Added

- Channel-neutral notice, article, action, choice, and form presentations,
  rendered through the official WeCom SDK's five template-card types.
- Durable, sender- and conversation-scoped card interactions with an approval
  button-card flow, in-place callback updates, and exact-command fallback.
- A durable Agent interaction broker with callback fast lane, TTL, scoped
  results, leased resume delivery, and dead-letter handling.
- Pi native select, confirm, input, and editor bridging with same-call live
  resume, scoped plain-text input, and a side-effect-free example extension.

## [0.1.0] - 2026-08-25

### Added

- Runtime-neutral WeCom Bot Gateway and Runtime Contract v1.
- Official WeCom SDK transport with streaming, media, proactive messaging, and
  reconnect handling.
- Codex, ACP/Kimi, OpenClaw, and Pi Agent adapters.
- Durable SQLite outbox, protected media spool, scoped ACLs, and approval
  control plane.
- Exact modality negotiation and bounded Pi worker pool.
- Credential-free local proactive text/media control with scoped aliases.
- External Runtime Adapter SDK, validated loader, and contract-tested template.
- Loopback liveness/readiness, privacy-safe Prometheus metrics, and structured
  identifier-free lifecycle tracing.
- Linux/systemd and non-root, read-only container deployment references.
- A cross-process `SIGKILL` recovery test for leased SQLite outbox deliveries.
- A full-ref public-history audit command with operator-supplied private terms.
- Immutable commit pinning for all external GitHub Actions.

### Security

- Fail-closed access control and adapter capability checks.
- Redacted logs, protected local storage, ephemeral inbound media, and bounded
  outbound media roots.

### Fixed

- Preserve the causal SQLite write/commit error when a storage fault also
  makes transaction rollback fail.

[Unreleased]: https://github.com/fyaic/wecom-agent-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/fyaic/wecom-agent-gateway/releases/tag/v0.1.0
