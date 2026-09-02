# `@fyaic/wecom-adapter-conformance`

Vendor-neutral conformance runner for Runtime Contract v1 Adapters. It imports an Adapter through the public
`@fyaic/wecom-adapter-sdk`, exercises only declared capabilities, and emits deterministic JSON without upstream error
messages, prompts, responses, session IDs, file paths, or credentials.

From this repository:

```bash
pnpm --silent conformance:adapter \
  --module ./examples/clean-room-adapter/src/index.ts \
  --base-directory . \
  --image ./path/to/a/local-test-image.png \
  --exercise-cancel \
  --pretty
```

The default suite checks compatibility, health, a successful text turn, declared streaming, session resume, quoted
context acceptance, supplied media fixtures, reply-action idempotency, and opt-in cancellation. A missing fixture or
Adapter-specific probe is reported as `skipped`, never `passed`. Model-backed Adapters should run the suite against a
deterministic fake backend in CI and keep real Kernel/WeCom smoke evidence separate.

See [`docs/adapter-conformance.md`](../../docs/adapter-conformance.md) for the report contract and certification limits.
