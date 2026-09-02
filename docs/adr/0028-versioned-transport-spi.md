# ADR 0028: Versioned Channel Transport SPI and delivery semantics

Status: Accepted, 2026-09-02.

## Context

WeCom is the first fully validated Transport, but the product boundary is an IM
gateway rather than a WeCom-specific Agent plugin. The existing
`ChannelTransport` interface was vendor-neutral at compile time, yet it had no
runtime version guard or independently executable evidence. A second IM could
therefore drift into Core through private types, overclaim provider delivery,
or silently weaken media, streaming, interaction, and lifecycle semantics.

## Decision

Channel Transport Contract v1 is now an explicit, runtime-checked SPI:

- every Transport declares a stable `id`, `contractVersion`, capabilities, and
  exact input/output media modality sets;
- Gateway validates the declaration before Adapter startup or inbound access;
- inconsistent media and presentation capabilities fail before any side
  effect;
- inbound messages, quotes, conversation type, feedback, and enter-chat events
  use only Runtime Contract envelopes;
- Transport owns vendor authentication, callbacks, media materialization,
  mutable reply handles, proactive delivery, and native presentation mapping;
- Core owns ACL, ordering, backpressure, session routing, durable intent,
  interaction state, and outbox retries;
- a `DeliveryReceipt` proves only that the Transport accepted a command. It is
  not proof of provider durability, client visibility, reading, or user
  acknowledgement.

The test-only `TransportConformanceDriver` is deliberately separate from the
production SPI. It may inject normalized events and observe accepted commands,
but a production Transport never exposes those methods to Core.

## Reference evidence

`@fyaic/transport-loopback` implements all v1 capabilities without importing a
WeCom SDK or any Agent Kernel. `@fyaic/transport-conformance` exercises 22
checks across lifecycle, health, direct/group ingress, quoted text, feedback,
enter-chat, all media modalities, mutable/final reply, proactive delivery,
presentations, interaction updates, receipt shape, and idempotent media release.

The fixed report is
[`transport-conformance-loopback.json`](../evidence/transport-conformance-loopback.json).
It contains only stable capability/check metadata and never records message
content, media paths, identities, delivery IDs, upstream bodies, or credentials.

## Delivery layers

```text
Core durable intent        SQLite/outbox accepted the work
        ↓
Transport accepted         deliver() returned a bounded receipt
        ↓
Provider/client visibility vendor-specific evidence, never inferred from HTTP 200
```

WeCom may provide callback/reply acknowledgements, but those remain
Transport-specific observations. The common contract intentionally does not
invent a universal “delivered” or “read” state.

## Consequences

- A new IM must pass the SPI/conformance layer before being connected to Core.
- Unsupported streaming, media, proactive messaging, quotes, or interaction
  features must be declared absent and follow a deterministic Core fallback or
  fail-closed path; the contract does not collapse to a lowest common
  denominator.
- Existing WeCom behavior remains the production reference and still requires
  its separate real-client matrix.
- Contract-breaking Transport semantics require a major version change rather
  than vendor-specific optional fields in Core.
