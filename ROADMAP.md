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
      conversations; deterministic transport and Adapter coverage is complete.
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
- [ ] Complete the remaining real WeCom approval-card rejection, expiry, and
      process-interruption acceptance checks.

- [ ] Turn current upstream community signals into a deterministic compatibility
      matrix: late/duplicate acknowledgements, queue saturation, unknown frame
      fields, rapid text-plus-media ingress, final/media deduplication, and proxy
      isolation.
- [ ] Certify native WeCom video callbacks as a transport/media lifecycle; model
      understanding is explicitly outside this acceptance.

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
- Fail fast when two local processes attempt to own the same Bot account, then
  document connection ownership, conversation fencing, shared admission, and
  failover semantics before implementing active-active operation.

### M3.2: ecosystem conformance

- Extract the existing Adapter contract tests into an independently runnable
  conformance kit and certify one clean-room external Adapter.
- Add Claude Code as the next reference Kernel through the official Claude
  Agent SDK, with streaming, resume, cancellation, image, approval, and native
  ask-user semantics. Keep it planned until deterministic and real WeCom
  acceptance pass; users must bring and manage their own Anthropic credential.
- Track ACP capability negotiation and document an AG-UI event mapping without
  making either protocol a Core dependency.
- Specify a channel-neutral Transport SPI and validate it with a loopback
  Transport before selecting a second production IM.

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
