# `@fyaic/wecom-adapter-sdk`

Public Preview authoring boundary for trusted, in-process Kernel Adapters used by
`wecom-agent-gateway`.

Use `defineRuntimeAdapter()` for the module factory and implement the exported
Runtime Contract types. The Gateway loader validates contract version, stable
identity, required methods, capabilities, configuration size, and optional tool
support before WeCom ingress starts.

See [`../../examples/adapter-template`](../../examples/adapter-template) and the
[Adapter authoring guide](../../docs/adapter-authoring.md).

This module boundary is not a sandbox. Use ACP or another isolated Adapter Host
for untrusted Kernel code. The package is not published to npm during Public
Preview; release provenance and package publication remain separate milestones.
