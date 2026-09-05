# External Adapter template

This is a deliberately small **Echo**, not another AI Agent. It demonstrates the
public factory export, v1 runtime contract, streaming events, session references,
and capability declarations expected by the Gateway.

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm demo
```

For real Bot connectivity without a model, generate a starter with
`pnpm onboard --adapter echo`, then follow the
[setup guide](../../docs/getting-started.en.md) / [中文](../../docs/getting-started.md).
Existing configuration is never overwritten.

To implement your own harness, start with [src/index.ts](src/index.ts), replace
the Echo run implementation with your kernel protocol, declare only supported
capabilities, and follow the [Adapter authoring guide](../../docs/adapter-authoring.md).
The [SDK-only example](../clean-room-adapter/README.md) shows a stricter independent
consumer. Passing a fixture is not proof of a real Agent or WeCom integration.
