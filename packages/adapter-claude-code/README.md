# Claude Code Runtime Adapter (experimental)

This optional package translates the vendor-neutral Runtime Contract into the
official `@anthropic-ai/claude-agent-sdk` `query()` stream. It is a protocol
spike, is not registered by the default Gateway application, and must not yet
be presented as a production-supported Kernel.

The official SDK is an exact-version optional dependency. The repository test
install includes it; the default production image uses `--no-optional`, so it
does not ship the SDK or platform binary unless a Claude deployment explicitly
builds for that Adapter.

Current C0 scope:

- text and quoted-text input;
- init/session mapping and resume;
- partial `text_delta` streaming with authoritative `result` completion;
- `AbortController` cancellation;
- isolated settings, no Claude tools, and no permission bypass;
- a complete opt-in subprocess environment that rejects Gateway/WeCom secrets
  and Claude session/bearer tokens while allowing user-owned API/cloud keys;
- deterministic fake-backed tests that require no network or credentials.

Image input, tools, approvals, native user questions, real WeCom evidence, and
durable interaction recovery remain C1/C2 work. Each deployment must provide
and manage its own Anthropic credential under Anthropic's applicable terms.
The Adapter does not accept or persist Claude.ai session tokens.
