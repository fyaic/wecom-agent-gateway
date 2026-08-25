# Repository guidance

- Prefer official WeCom SDK capabilities over reimplementing WebSocket authentication, heartbeat,
  reconnect, media cryptography, or push protocols.
- Keep `packages/runtime-contract` free of WeCom, Codex, OpenClaw, and other vendor types.
- Preserve the single Bot identity invariant. Do not add human-account or identity-fallback paths.
- Keep secrets out of source, logs, fixtures, snapshots, and git history.
- Every transport or runtime behavior change requires a deterministic fake-backed test.
- Run `pnpm run ci` before committing.
