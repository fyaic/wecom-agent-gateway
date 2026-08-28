# Real-client demo assets

The public GIF, MP4, and cover in this directory are generated from a real
macOS WeCom Bot conversation. They are product evidence, not a UI mock.

The walkthrough demonstrates five independent Gateway behaviors:

1. a scoped inbound message receives an immediate mutable status;
2. Pi Agent text replaces that status in the same Bot reply;
3. an explicit Agent confirmation becomes a native WeCom card;
4. one callback resumes the original task and settles idempotently;
5. scoped proactive text and image delivery reuse the Bot, ACL, and outbox.

## Privacy gate

Only the conversation pane may appear in public output. Before publishing,
confirm that the result excludes the chat sidebar, account and Bot names,
contacts, internal sender/conversation IDs, credentials, local paths, and
unrelated conversations. Raw captures stay under the ignored `captures/`
directory and must never be committed.

## Rebuild on macOS

The checked-in builder requires `ffmpeg` plus macOS Quick Look. Place the
privacy-reviewed raw screenshots in `captures/` using the filenames declared in
`scripts/build-demo-assets.mjs`, then run:

```bash
pnpm demo:build
```

Set `DEMO_CAPTURE_DIR=/absolute/path` to read captures from another ignored
location. Inspect every rendered slide and the final animation before commit.
