# From a clean clone to your first WeCom reply

[中文](getting-started.md) · [Everyday uses](use-cases.en.md)

Separate three questions: does the Gateway work, can your Agent answer independently, and can your real Bot exchange messages?

## 1. Credential-free demo

Requires Node.js 22.13+ and pnpm 11.8.0. The source-based path targets macOS / Linux; there is no published npm installer.

```bash
git clone https://github.com/fyaic/wecom-agent-gateway.git
cd wecom-agent-gateway
pnpm install --frozen-lockfile
pnpm demo
```

Expect six passing checks: replies, deduplication, access control, session recovery after rebuilding the Gateway,
proactive delivery, and a drained outbox. This uses the real Core, SQLite, and external Adapter loader,
but local Loopback transport and deterministic Echo. **No WeCom connection or model call.**
Running all developer CI tests is not a first-use prerequisite.

## 2. Choose an existing Agent

Choose an Agent that already answers successfully on your machine.

```bash
pnpm onboard --adapter pi
```

Profiles: `codex | kimi | pi | openclaw | echo`. Creates a minimal `0600` `.env`, refusing to overwrite an
existing file or symlink. The default workspace is an ignored `agent-workspace/` directory.
To let a CLI Agent access an existing project, specify this during initial setup:

```bash
pnpm onboard --adapter codex --workspace /path/to/project
```

If `.env` exists, edit its Adapter selection/settings instead. [.env.example](../.env.example) is the full reference, not a required copy step.

| Agent                        | Prerequisite                                 | Configuration / boundary                                                                               |
| ---------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Codex                        | Installed, authenticated `codex` CLI         | Starter selects App Server, read-only sandbox, never approvals; separate from your desktop task        |
| Kimi Code                    | Authenticated `kimi acp`                     | `KIMI_EXECUTABLE=kimi`; Kimi owns model and credentials                                                |
| Pi                           | Installed `pi` with a working provider/model | Reuses local settings; optional explicit arguments below                                               |
| OpenClaw                     | Running local Gateway with a working Agent   | Local Gateway token or password is required, not auto-discovered                                       |
| Echo                         | No Agent or model                            | Real Bot connectivity only; not AI                                                                     |
| Generic ACP / custom harness | Known protocol and executable                | Follow [Adapter configuration/authoring](adapter-authoring.md); the generator does not guess protocols |

Optional Pi configuration; replace with your actual available provider/model:

```dotenv
PI_ARGS_JSON='["--provider","your-provider","--model","your-model"]'
```

For environment-based provider credentials, set the variable locally and list its **name** in
`PI_AGENT_ENV_ALLOWLIST`. The Gateway does not forward the whole host environment. Never commit credentials.

OpenClaw:

```dotenv
OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789
OPENCLAW_GATEWAY_TOKEN=
# Alternatively OPENCLAW_GATEWAY_PASSWORD; use the existing Gateway value.
OPENCLAW_AGENT_ID=
```

OpenClaw owns its Agent workspace; `AGENT_WORKING_DIRECTORY` does not change it.
Claude Code remains an experimental package, not a registered `GATEWAY_ADAPTER=claude` starter.

### Optional: verify the real Agent first

```bash
pnpm agent:check
```

Runs two real model turns, asking the second turn to recall a code only supplied in the first.
Uses the configured Agent account/quota. No Bot connection or production session database is involved;
the Agent may retain its own test transcript. Reports continuity, streaming observation, and timing without
printing response content or internal IDs. Echo deliberately fails this semantic AI test.
The check has a two-minute deadline followed by bounded Adapter shutdown; failures use sanitized diagnostic codes.

## 3. Configure the Bot and authorize a direct chat

Create or select a WeCom **API-mode, long-connection** intelligent Bot and fill `.env`:

```dotenv
WECOM_BOT_ID=
WECOM_BOT_SECRET=
```

See the [official SDK](https://github.com/WecomTeam/aibot-node-sdk).
This is not a classic group Webhook Bot or human account. The Bot must be visible to the testing member.
Do not share secrets, internal member IDs, or raw chat logs in an Issue.

```bash
pnpm enroll:direct
```

Keep other Gateway/plugin instances using this Bot stopped. Send the exact displayed one-time code in your direct chat with it.
The command appends the sender to the allowlist without removing existing members.
The two-minute window can be retried. The local owner lock rejects an already-owned Bot before opening another connection.

## 4. Have a real conversation

```bash
pnpm start:checked
```

After Doctor passes, the service stays in the foreground. Send:

> Remember the project name Bamboo. Reply briefly.

Then:

> What project name did I just tell you?

Expect a reception status, then an in-place answer, and “Bamboo” recalled on turn two.
An Agent that does not emit text increments cannot provide token-by-token streaming.
The starter disables automatic final-answer actions and long-run control cards: **ordinary replies should not always append a card.**

The Gateway manages separate Agent sessions. It does not attach to existing terminal/desktop tasks,
and changing kernels does not migrate their history. Keep the host and service online.
Agent cold starts, queueing, and model generation affect answer latency independently of transport latency.

## 5. Get a second useful result

With the Gateway running, open another terminal in this repository:

```bash
pnpm proactive:send --target direct --text 'Your local task is complete.'
```

The starter enables a private local control socket; the CLI needs no Bot Secret.
The `direct` alias requires exactly one authorized sender. For more members, configure explicit aliases using the
[real integration runbook](real-wecom-runbook.md). Delivery does not mean the user has read the message.

| Next goal                                                            | Entry point                                                                                                            |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Repository questions, screenshot diagnosis, completion notifications | [Everyday recipes](use-cases.en.md)                                                                                    |
| Group @Bot                                                           | [Runbook](real-wecom-runbook.md): group scope and sender ACL; group context may be shared                              |
| Images, files, video, cards                                          | [Real cases](verified-kernel-cases.en.md), [interaction cards](interaction-cards.md): check Adapter/model capabilities |
| Persistent service and health checks                                 | [Deployment](deployment.md): single Bot, single instance                                                               |
| Your own harness                                                     | [Adapter SDK](adapter-authoring.md), [examples](../examples/README.md)                                                 |

## Troubleshooting by layer

| Symptom                             | First check                                                                                             |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Demo fails                          | Node/pnpm versions and dependency installation; accounts are irrelevant                                 |
| Agent check fails                   | Local Agent login, provider/model and Adapter settings; no Bot was opened                               |
| Enrollment times out                | Bot visibility, correct Bot, exact one-time code                                                        |
| Bot already owned                   | Stop the old instance; do not connect the official plugin and this Gateway to the same Bot concurrently |
| No response                         | `pnpm doctor`, running service, direct/group allowlists                                                 |
| Status is quick but answer is slow  | Queue, Agent first event, first text, and final timing separately                                       |
| Image arrives but is not understood | Vision support in the selected Agent/model                                                              |
| Config changes do not apply         | Stop and restart safely; do not launch a second competing instance                                      |

Use the [onboarding feedback form](https://github.com/fyaic/wecom-agent-gateway/issues/new?template=onboarding.yml)
with the command stage, versions and sanitized error, never credentials or raw chat logs.
