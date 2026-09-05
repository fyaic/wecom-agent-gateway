# Everyday uses: practical recipes, explicit prerequisites

[中文](use-cases.md) · [Set up your first conversation](getting-started.en.md)

These recipes use implemented building blocks. They are not a claim that every business scenario has been certified.
[Real cases](verified-kernel-cases.en.md) separately identify tested Agents, modalities, and evidence.
The Gateway does not supply models, business permissions, scheduling, or unrestricted tool access.

## Ask about your code away from your desk

Point a local Codex / Kimi / Pi Agent at a project during onboarding, or change its workspace configuration and restart.
Ask in your authorized direct chat:

> Where does this project decide the redirect after login? Give filenames and explain the logic. Do not modify files.

Then:

> What happens when no callback URL is configured?

The Agent needs read access. The Codex starter is read-only; verify other Agents' own permissions.
This is a Gateway-created session, **not a takeover of an existing desktop or terminal task**.
Do not grant untrusted group members access to a private local repository through the Agent.

## Troubleshoot a screenshot from your phone

Send an error screenshot, then:

> List the facts you can actually read, then suggest three checks. Say if anything is unclear.

Both the Adapter and selected model must support images. Existing bounded image cases include Pi with a vision model,
Codex, and Kimi; working text does not imply working vision. Native video callback certification is still pending,
and transporting video does not imply video understanding.

## Get a completion notification instead of polling

Keep the Gateway running with one authorized direct sender. From this repository, this executable example runs its
tests and notifies you:

```bash
if pnpm test; then
  pnpm proactive:send --target direct --text 'Gateway tests passed. Ready for review.'
else
  pnpm proactive:send --target direct --text 'Gateway tests failed. Check local output.'
fi
```

For another project, replace the task and run the send step from the Gateway directory, or explicitly select its
control socket. Do not interpolate sensitive logs into the message.

The starter enables the private local control socket. The `direct` alias requires exactly one authorized sender.
The CLI needs no Bot Secret. This is **explicit job integration**, not a built-in scheduler or automatic monitoring
of every terminal. Do not expose the socket directly to remote CI. Durable delivery does not prove a user read the message.

## Give a small project group a shared question entry point

Add the Bot to an eligible internal test group, configure group and sender allowlists using the
[runbook](real-wecom-runbook.md), then @mention it:

> Summarize how the workspace documentation says to start development. Do not execute commands.

Bot visibility, supported group types, mentions, and ACLs still apply; arbitrary external users/groups are not promised.
Group context may be shared. Start with members who have the same data access; this is not turnkey multi-tenant isolation.

## Answer a real Agent question from chat

A supported native ask-user request can become a choice/confirmation card. Your answer resumes the task.
Ordinary replies do not need a permanent “expand / summarize” card.

This requires Adapter interaction support and an actual Agent request.
See the [Pi interaction extension](../examples/pi-wecom-interaction.mjs) and [card guide](interaction-cards.md).
Loading an example extension and its configuration is an extra step, not something every model automatically does.
The Gateway transports the choice; the Agent decides what to do with it.

## Add office tools only when needed

An Agent with tool support can use official [wecom-cli](https://github.com/WecomTeam/wecom-cli), for example to query
your to-dos and create one on explicit instruction. CLI authorization, tool registration, and appropriate write approval
are separate prerequisites. Not every Adapter ships with every office tool configured.
The office-tool layer and Bot IM transport are different responsibilities and permission scopes.

## What not to promise yet

Existing desktop-task takeover, cross-kernel history migration, arbitrary video understanding, unrestricted external-group
access, hosted compute without setup, or multi-instance production guarantees.
See [status](status.md) and the [roadmap](../ROADMAP.md).
