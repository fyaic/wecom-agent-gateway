# Loopback Transport

`@fyaic/transport-loopback` is a deterministic, in-memory reference
implementation of Channel Transport Contract v1. It has no WeCom SDK or Agent
Kernel dependency and exists to prove that the Gateway's Transport boundary can
be implemented without importing vendor types.

It supports every v1 capability so the Transport Conformance runner can cover
inbound direct/group messages, non-semantic events, media materialization,
mutable/final replies, proactive delivery, presentations, interaction updates,
and all media output declarations. A delivery receipt means only that the
Transport accepted the command; it never claims end-user visibility.
