# Changelog

All notable changes will be documented in this file. The project follows
[Semantic Versioning](https://semver.org/) once the first public version is
tagged.

## [Unreleased]

### Added

- A privacy-safe real-WeCom ingress verifier for quoted text/media and native
  video callbacks. It correlates normalized inbound records, Adapter session,
  durable final delivery, message-level errors, persisted media redaction, and
  spool cleanup without printing message or identity data, and deliberately
  rejects MIME-promoted `file` uploads as native-video evidence.
- Marker-scoped plain-text evidence in the real-WeCom ingress verifier, enabling
  authorized direct and real rich-mention group desktop smokes to close
  autonomously across client visibility, Adapter session, durable delivery, and
  spool state.
- A public evidence-claim policy, prominent bilingual capability boundaries,
  PR review checklist, and CI guard that prevents critical pending real-client
  work from disappearing from release-facing documentation.
- An opt-in, credential-safe Claude Code C1 smoke command for real two-turn
  session continuity and cancellation through the official Agent SDK.
- A versioned Channel Transport Contract, startup compatibility guard,
  vendor-free loopback reference, and privacy-safe 22-check Transport
  conformance report with explicit acceptance-versus-visibility semantics.
- An isolated experimental Claude Code C0 Adapter using the pinned official
  Agent SDK, with deterministic streaming/session/cancellation fixtures,
  fail-closed media handling, isolated settings, and exact license review.
- A 26-second bilingual-README product walkthrough built from a real,
  privacy-cropped WeCom/Pi conversation, covering mutable status/final replies,
  native confirmation and same-task resume, plus proactive text/media delivery.

- A bilingual 15-minute integration guide from a clean clone to the first
  authorized WeCom direct conversation.

- Structured quoted-message context, including protected quoted-media
  materialization and explicit support across every reference Adapter.
- Channel-native reply feedback events that never create a semantic Agent turn,
  plus an optional bounded static `enter_chat` welcome.
- A privacy-reviewed real WeCom case page covering Codex, Kimi/ACP, OpenClaw,
  and Pi, with one cropped client screenshot, representative layered latency,
  evidence boundaries, and reproducible smoke commands.
- Channel-neutral notice, article, action, choice, and form presentations,
  rendered through the official WeCom SDK's five template-card types.
- Durable, sender- and conversation-scoped card interactions with an approval
  button-card flow, in-place callback updates, and exact-command fallback.
- A durable Agent interaction broker with callback fast lane, TTL, scoped
  results, leased resume delivery, and dead-letter handling.
- Pi native select, confirm, input, and editor bridging with same-call live
  resume, scoped plain-text input, and a side-effect-free example extension.
- Final-answer actions with official proactive template cards, durable callback
  continuation, and same-session support across
  Codex SDK/App Server, ACP/Kimi, OpenClaw, Pi, and the external Adapter template.
- Native Codex App Server `item/tool/requestUserInput` bridging for choices,
  forms, free text, and multi-step live continuation, with secret input rejected.
- Sender-scoped long-run control cards that appear only for cancellable
  adapters, atomically accept one stop request, and call the Kernel's native
  cancel path without creating another semantic turn.
- Mutable status text that projects only explicit Adapter events without
  creating extra messages, plus real-client coverage of combined-stream cards.

### Fixed

- Classify Claude Code signed-out results as a stable authentication diagnostic
  without forwarding the SDK's login text or accepting session credentials.
- Classify protected generic-file uploads by detected MIME at the Transport
  boundary, so desktop MP4 uploads reach Kernel capability checks as semantic
  video while retaining the original WeCom `msgtype` in metadata.
- Strip provider-private `<think>` sentinels and the duplicated visible prefix
  from Pi output before it crosses the Runtime Contract.
- Reframe the bilingual README around the user problem, observable message
  flow, shortest setup path, real-client proof, Agent support, and clear
  comparison with the official OpenClaw plugin and `wecom-cli` tool layer.

- Strip ephemeral URLs, decryption keys, and local paths from both current and
  quoted media before SQLite persistence.
- Apply the same scoped ACL to feedback and `enter_chat` events as semantic
  messages, without creating an Agent turn.
- Keep official SDK reconnect attempts unbounded for transient outages while
  retaining a bounded authentication-failure limit; validate private endpoints
  as credential-free `wss://` URLs.
- Version the SQLite schema and prune old terminal records in bounded batches
  without deleting pending, leased, or dead work.
- Launch Codex with a least-environment child process and make raw official SDK
  messages and Adapter stderr opt-in diagnostics instead of default logs.

### Security

- Redact configured Adapter credentials plus common API key, password, and
  credential fields from enabled diagnostics.
- Re-run the complete repository CI and public-history audit for each release,
  require the tag commit to be on `main`, and select release notes by tag.

- Use the official non-blocking plain-stream helper so stale partial frames do
  not queue behind an unacknowledged update while final frames remain durable.
- Keep late presentations outside an already-started plain stream instead of
  switching the official vendor message type mid-stream.
- Reframe cards as an optional channel-native projection so repository
  positioning, architecture, and roadmap keep IM fidelity and the stable
  Kernel Adapter boundary ahead of additional card UX.
- Respect the official one-template-card-per-stream contract and real desktop
  rendering: status stays in mutable text; cancellable long runs use one
  sender-scoped proactive control card instead of an invisible first-frame card.
- Preserve complete choice labels, render peer selections vertically without
  first-option color bias, and render updates as an inert checked result state
  instead of an invalid no-link notice.
- Deliver late-bound final-answer actions as a separate proactive template card;
  real clients silently drop cards first introduced on a final stream frame.
- Silently absorb duplicate, expired, and superseded runtime-card callbacks
  instead of emitting repeated completion cards.
- Keep operator-configured default reply actions one-shot instead of inheriting
  them into callback continuations and generating an unbounded card chain.

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
