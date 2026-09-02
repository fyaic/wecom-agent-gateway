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

Mainline priorities take precedence over additional card themes or business UI:

The evidence, ordering, and exit criteria for the following work are maintained
in [`docs/ecosystem-watch-and-mainline-plan.md`](docs/ecosystem-watch-and-mainline-plan.md).

### M3.0: upstream compatibility and real-client closure

- [x] Preserve quoted/replied-message context in the neutral inbound contract,
      including protected quoted-media persistence boundaries.
- [ ] Certify quoted/replied-message callbacks in real direct and group
      conversations; deterministic direct/group Transport, Core and Adapter
      coverage is complete and available through `pnpm test:m3-quote-approval`.
- [x] Adopt the official non-blocking stream path with bounded coalescing and
      backpressure, while keeping the final answer on the durable outbox path.
- [x] Normalize reply-feedback events as channel feedback without creating a
      new semantic Agent turn.
- [x] Add a static, Kernel-free `enter_chat` welcome as an optional Transport
      capability.
- [x] Evaluate a separate Bot Webhook Transport: keep it as a future independent
      package sharing Core and the Runtime Contract; WebSocket remains the
      Public Preview reference Transport.

- [x] M2.1: durable Interaction Broker, five-second callback fast lane, and
      runtime resume queue with deterministic end-to-end tests.
- [x] M2.2: connect Pi native ask-user hooks to the neutral interaction contract,
      including live same-call resume and scoped text fallback.
- [x] Complete the real WeCom ask-user acceptance matrix across private select,
      private scoped input, group select, in-place updates, and duplicate safety.
- [x] M2.3: final-answer actions through a durable proactive card, including a
      real callback click, same-session continuation, and one-shot termination.
- [x] Complete the real WeCom approval-card rejection, expiry, and
      process-interruption acceptance checks. All three card outcomes, including
      inert stale clicks after expiry or startup interruption, are deterministic
      regression gates through `pnpm test:m3-quote-approval`; the expired-card
      fallback also retains a visible `expired` semantic instead of saying that
      the operation completed.

- [x] Turn current upstream community signals into a deterministic compatibility
      matrix: late acknowledgements, queue saturation, unknown frame fields,
      rapid text-plus-media ingress, and final/media recovery. Duplicate ACK
      correlation remains owned by the pinned official SDK; Kernel subprocesses
      cannot pollute Transport globals. Real HTTP proxy download/decrypt remains
      an explicitly tracked deployment check.
- [ ] Certify native WeCom video callbacks as a transport/media lifecycle; model
      understanding is explicitly outside this acceptance. The exact official
      frame, protected materialization, Adapter capability rejection, cleanup,
      and following-message recovery are deterministic gates; a real native
      `msgtype=video` callback is still required to close this item.

### M3.1: production ownership

- [x] v0.2 security/reliability convergence: versioned SQLite schema, bounded
      retention, least-environment Adapter processes, privacy-safe diagnostic
      defaults, ACL-gated channel events, long-outage reconnect, and release
      revalidation from `main`.

- Exercise host-level physical network loss and a real Linux/systemd soak.
  Native WeCom video callback certification is tracked in M3.0. Cross-process
  SQLite lease recovery after `SIGKILL`, isolated Linux network
  detach/reconnect, bounded disk exhaustion, read-only recovery, and macOS
  managed-process restart are already covered.
- Define multi-instance ownership, shared backpressure, and ordering semantics.
- [x] Fail fast when two local processes attempt to own the same Bot account.
      Connection ownership, conversation fencing, shared admission, and failover
      semantics are documented as mandatory prerequisites to active-active.

### M3.2: ecosystem conformance

- [x] Extract the Adapter checks into an independently runnable conformance kit
      with a deterministic JSON report, and certify one SDK-only clean-room Adapter.
- [x] Add an isolated Claude Code C0 Adapter package through official Claude
      Agent SDK `0.3.258`, with deterministic init/delta/result/error/resume/abort
      fixtures, safe default permissions, and exact non-SPDX license review.
- Complete Claude Code C1 real local text/session/cancel/auth smoke with a
  user-owned credential, then C2 image/approval/AskUserQuestion before it enters
  the supported or real-WeCom matrix. Keep the package optional and its
  commercial terms separate from the repository's MIT code.
- Track ACP capability negotiation and document an AG-UI event mapping without
  making either protocol a Core dependency.
- [x] Specify Channel Transport Contract v1, enforce startup capability
      consistency, and certify a vendor-free loopback Transport with a fixed
      22-check report before selecting a second production IM.
- Evaluate the next production Transport only after its vendor-specific
  authentication, callback, visibility, media, and failure matrix is available.

## Later

- [x] M2.4 reply-action continuation adapters for Codex, OpenClaw, ACP, Pi, and
      the external SDK, with one shared deterministic contract. Codex App
      Server and Pi expose native live ask-user; current ACP v1 and OpenClaw
      Gateway v4 do not expose an equivalent client response method.
- [x] M2.5 first slice: durable, sender-scoped long-run cancel cards backed by
      each Adapter's native cancel capability.
- [x] M2.5 second slice: mutable status text driven only by explicit Adapter
      events, plus real-client certification of the official combined-stream
      boundary; run controls use the proven proactive-card path.
- M2.5 follow-up: optional proactive task cards and a separate group-poll
  aggregation model, after the IM-fidelity priorities above.
- Compatibility certification for additional Agent kernels through the public
  Adapter SDK and conformance kit.
- Optional distributed outbox and media storage implementations.
- Implement additional IM transports only after the Transport SPI and delivery
  semantics are documented without weakening the Runtime Contract boundary.
