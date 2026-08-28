# 15-minute integration guide

Goal: connect one independently working Agent to an authorized WeCom Bot direct
conversation with inbound messages, mutable streaming replies, and session
resume. This is the shortest mainline path; group chat, media, cards, proactive
messages, and fault acceptance come later.

## The result

```text
WeCom direct chat → Bot → WeCom Agent Gateway → selected Agent
WeCom direct chat ← one mutable streamed reply ←───────────┘
```

The Gateway does not provide a model or hosted Agent. Verify that the selected
Agent already answers through its own CLI or local service.

## 1. Install and validate

Use Node.js 22 and pnpm 11.8.0:

```bash
git clone https://github.com/fyaic/wecom-agent-gateway.git
cd wecom-agent-gateway
pnpm install --frozen-lockfile
pnpm run ci
```

This contacts no Bot and spends no model quota. Pass it before adding real
credentials so transport and environment failures stay easy to distinguish.

## 2. Prepare a WeCom Bot

Create or select a dedicated intelligent Bot in WeCom, enable
long-connection/API mode, and obtain its Bot ID and Secret. Exactly one Gateway
instance may own one Bot at a time. See the official
[`@wecom/aibot-node-sdk`](https://github.com/WecomTeam/aibot-node-sdk) for the
connection capability and setup context.

```bash
cp .env.example .env
chmod 600 .env
```

Fill in:

```dotenv
WECOM_BOT_ID=
WECOM_BOT_SECRET=
```

Never commit `.env`, Bot secrets, internal member/conversation IDs, or raw chat
logs.

## 3. Select one Agent Adapter

Each Gateway process selects exactly one:

| Agent       | Minimum selection          | Prerequisite                                            |
| ----------- | -------------------------- | ------------------------------------------------------- |
| OpenClaw    | `GATEWAY_ADAPTER=openclaw` | A local OpenClaw Gateway is running                     |
| Pi Agent    | `GATEWAY_ADAPTER=pi`       | `pi --mode rpc` works and provider/model are configured |
| Kimi Code   | `GATEWAY_ADAPTER=kimi`     | `kimi acp` works and is logged in                       |
| Codex       | `GATEWAY_ADAPTER=codex`    | `codex app-server` works with the required login        |
| Generic ACP | `GATEWAY_ADAPTER=acp`      | An ACP v1 executable and arguments are known            |

For example, OpenClaw:

```dotenv
GATEWAY_ADAPTER=openclaw
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
```

Verify the Agent through its own command first. After ACL enrollment, optionally
run `pnpm doctor:live` for the complete upstream probe. If the Agent itself is
unavailable, fix the Agent, provider, model, or login rather than hiding that
failure inside the Gateway.

## 4. Enroll the first authorized direct conversation

```bash
pnpm enroll:direct --name 'Authorized test member'
```

The command connects to the Bot and prints a one-time token. Send it unchanged
in that member's direct Bot conversation. The Gateway stores only the required
sender scope and does not print the internal ID.

## 5. Start and send the first message

```bash
pnpm doctor
# Optional: probe the selected real Agent upstream
pnpm doctor:live
pnpm start:checked
```

Send ordinary text in the enrolled conversation. Expect:

1. a neutral acknowledgement quickly;
2. Agent text deltas appearing in the same Bot message;
3. the final answer completing in place;
4. a second message resuming the same Agent session.

Ordinary replies do not attach cards by default. A separate card appears only
when the Agent explicitly requests interaction or the deployment explicitly
enables reply actions or long-run control.

## 6. Next steps

| Goal                    | Guide or command                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| Add an authorized group | Authenticate `wecom-cli`, then resolve the unique group name through the [real runbook](real-wecom-runbook.md) |
| Send proactively        | Set `GATEWAY_CONTROL_ENABLED=true`, then run `pnpm proactive:health`                                           |
| Add image/file/video    | Configure media roots and validate each path through the [real runbook](real-wecom-runbook.md)                 |
| Add another Agent       | Read the [Adapter authoring guide](adapter-authoring.md)                                                       |
| Deploy in production    | Read the [systemd and container baseline](deployment.md)                                                       |
| See real results        | Read the [Codex, Kimi, OpenClaw, and Pi cases](verified-kernel-cases.en.md)                                    |

## Common questions

- **No reply at all:** run `pnpm doctor`, confirm no second Gateway owns the Bot,
  then inspect direct/group ACL scope.
- **The reply is slow:** separate Channel acknowledgement, queue, Agent first
  event, first text, and completion. Model time is not WeCom transport time.
- **Every answer has a card:** inspect `GATEWAY_REPLY_ACTIONS_JSON` and long-run
  control settings. Default ordinary replies have no card.
- **Media arrives but the Agent cannot understand it:** successful transport
  does not imply that the current model or Agent tools support the modality.
- **Office APIs are needed:** use official `wecom-cli` as an Agent tool layer;
  it is not the Bot IM identity or session transport.

The [real WeCom runbook](real-wecom-runbook.md) and [status](status.md) contain
the full acceptance, recovery, Adapter-version, and evidence record.
