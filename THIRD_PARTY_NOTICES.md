# Third-party notices

This repository contains original gateway and adapter code and depends on
third-party packages. It does not vendor the source code of the projects listed
below. Each dependency remains subject to its own license.

## Direct runtime dependencies

| Project                                                                                       | Use                                       | License                                                                           |
| --------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)                        | Official WeCom Bot WebSocket transport    | MIT, as declared by the package manifest                                          |
| [`@openclaw/gateway-client`](https://github.com/openclaw/openclaw)                            | OpenClaw Gateway protocol client          | MIT                                                                               |
| [`@openai/codex-sdk`](https://github.com/openai/codex)                                        | Codex reference adapter                   | Apache-2.0                                                                        |
| [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk)           | Generic ACP v1 adapter                    | Apache-2.0                                                                        |
| [`@anthropic-ai/claude-agent-sdk`](https://github.com/anthropics/claude-agent-sdk-typescript) | Optional experimental Claude Code adapter | Anthropic Commercial Terms; package `0.3.258` declares `SEE LICENSE IN README.md` |

The optional `wecom-cli` integration invokes the official
[`WecomTeam/wecom-cli`](https://github.com/WecomTeam/wecom-cli) executable as a
separate process. That project is licensed under MIT.

The Claude Agent SDK package and its platform-specific, unmodified Claude Code
binary remain governed by Anthropic's applicable terms. They are not
relicensed under this repository's MIT license. The optional Adapter requires
each operator to provide and manage an eligible credential directly; this
project does not collect, store, proxy, or redistribute Claude.ai session
tokens or shared subscription access.

## Architectural references

The official
[`WecomTeam/wecom-openclaw-plugin`](https://github.com/WecomTeam/wecom-openclaw-plugin)
was studied as a behavioral and architectural reference. Its package manifest
declares MIT. No source from that repository is vendored here. Any future
incorporation or adaptation of third-party source must preserve the applicable
copyright and license notices and be recorded in this file.

Transitive dependency licenses can be reviewed with:

```bash
pnpm licenses list
```

The lockfile is the authoritative inventory of installed versions.
