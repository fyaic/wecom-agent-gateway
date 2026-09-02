# Clean-room echo Adapter

This example demonstrates a repository-external dependency boundary: its runtime package depends only on
`@fyaic/wecom-adapter-sdk`. It does not import Gateway Core, the WeCom SDK, a Transport, storage, or an in-repository
Kernel implementation.

The deterministic echo implementation is intentionally not an Agent. It exists to prove that an Adapter can expose
streaming, session resume, quoted context, image input, reply actions, and cancellation through the public contract.
Replace its `run()` and `cancel()` internals with a Kernel SDK/RPC while keeping the same boundary.

Run its machine-readable certification from the repository root:

```bash
pnpm --silent conformance:adapter \
  --module ./examples/clean-room-adapter/src/index.ts \
  --base-directory . \
  --image docs/assets/verified-kernel-cases/pi-wecom-private.png \
  --exercise-cancel \
  --pretty
```
