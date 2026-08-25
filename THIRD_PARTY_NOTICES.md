# Third-party notices

This repository contains original gateway and adapter code and depends on
third-party packages. It does not vendor the source code of the projects listed
below. Each dependency remains subject to its own license.

## Direct runtime dependencies

| Project                                                                             | Use                                    | License                                  |
| ----------------------------------------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| [`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk)              | Official WeCom Bot WebSocket transport | MIT, as declared by the package manifest |
| [`@openclaw/gateway-client`](https://github.com/openclaw/openclaw)                  | OpenClaw Gateway protocol client       | MIT                                      |
| [`@openai/codex-sdk`](https://github.com/openai/codex)                              | Codex reference adapter                | Apache-2.0                               |
| [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk) | Generic ACP v1 adapter                 | Apache-2.0                               |

The optional `wecom-cli` integration invokes the official
[`WecomTeam/wecom-cli`](https://github.com/WecomTeam/wecom-cli) executable as a
separate process. That project is licensed under MIT.

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
