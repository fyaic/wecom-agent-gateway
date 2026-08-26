# Roadmap

The roadmap describes direction, not a delivery commitment. Priorities may
change based on production feedback and upstream WeCom or Agent protocol
changes.

## Public Preview readiness

- [x] Runtime Contract v1 and adapter compatibility checks
- [x] Official WeCom SDK transport and mutable streaming replies
- [x] Text and media outbox recovery
- [x] Scoped ACLs, bounded admission, and approval control plane
- [x] Codex, ACP/Kimi, OpenClaw, and Pi reference adapters
- [x] Credential-free local control plane for durable proactive text and media
- [x] Stable external Adapter SDK, runtime loader, and contract-tested template
- [x] Linux/systemd and hardened container deployment references
- [x] Loopback health/readiness and privacy-safe Prometheus metrics
- [x] Deterministic test suite and real acceptance evidence
- [x] Sanitize all Git refs before changing repository visibility
- [x] Publish the first signed or provenance-backed release
- [x] Channel-neutral five-kind card contract and durable approval-card control
      loop

## Next

- [x] M2.1: durable Interaction Broker, five-second callback fast lane, and
      runtime resume queue with deterministic end-to-end tests.
- [x] M2.2: connect Pi native ask-user hooks to the neutral interaction contract,
      including live same-call resume and scoped text fallback.
- [x] Complete the real WeCom ask-user acceptance matrix across private select,
      private scoped input, group select, in-place updates, and duplicate safety.
- [ ] M2.3: `replyStreamWithCard` final-answer actions and proactive fallback
      (implementation complete; final real callback click is in progress).
- [ ] Complete the remaining real WeCom approval-card rejection, expiry, and
      process-interruption acceptance checks.

- Exercise host-level physical network loss, native WeCom video callbacks, and
  a real Linux/systemd soak. Cross-process SQLite lease recovery after
  `SIGKILL`, isolated Linux network detach/reconnect, bounded disk exhaustion,
  read-only recovery, and macOS managed-process restart are already covered.
- Define multi-instance ownership, shared backpressure, and ordering semantics.

## Later

- [x] M2.4 reply-action continuation adapters for Codex, OpenClaw, ACP, Pi, and
      the external SDK, with one shared deterministic contract. Native live
      ask-user hooks remain protocol-dependent follow-up work.
- M2.5 multi-field forms, welcome/task cards, and a separate group-poll model.
- Compatibility certification for additional Agent kernels.
- Optional distributed outbox and media storage implementations.
- A documented extension model for additional IM transports without weakening
  the Runtime Contract boundary.
