# Transport Conformance

`@fyaic/transport-conformance` executes Channel Transport Contract v1 against a
Transport plus a test-only driver. The driver supplies deterministic inbound
events and observes accepted outbound commands; it is deliberately outside the
production SPI.

The report contains only stable Transport metadata, capability names, check
IDs, and bounded error codes. It never serializes message text, media paths,
conversation identifiers, delivery IDs, upstream responses, or credentials.

The checks distinguish three layers:

1. Core durably records outbound intent.
2. `transport.deliver()` returns an acceptance receipt.
3. End-user visibility is vendor-specific and must be separately certified.

An acceptance receipt must never be described as proof that a message was seen
or durably stored by the IM provider.
