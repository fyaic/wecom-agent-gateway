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

## Next

- Exercise host-level physical network loss, native WeCom video callbacks, and
  a real Linux/systemd soak. Cross-process SQLite lease recovery after
  `SIGKILL`, isolated Linux network detach/reconnect, bounded disk exhaustion,
  read-only recovery, and macOS managed-process restart are already covered.
- Define multi-instance ownership, shared backpressure, and ordering semantics.

## Later

- Compatibility certification for additional Agent kernels.
- Optional distributed outbox and media storage implementations.
- A documented extension model for additional IM transports without weakening
  the Runtime Contract boundary.
