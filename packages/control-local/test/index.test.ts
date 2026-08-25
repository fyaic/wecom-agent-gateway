import { existsSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ProactiveMediaRequest,
  ProactiveTextRequest,
} from "@fyaic/wecom-channel-core";
import {
  LOCAL_CONTROL_PROTOCOL_VERSION,
  LocalGatewayControlClient,
  LocalGatewayControlServer,
  createScopedProactiveTargets,
  type ProactiveSender,
} from "../src/index.js";

const servers: LocalGatewayControlServer[] = [];
afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.stop()));
});

describe("LocalGatewayControlServer", () => {
  it("builds default and custom aliases only from scoped allowlists", () => {
    expect(
      createScopedProactiveTargets({
        accountId: "bot",
        allowedDirectSenders: ["direct-id"],
        allowedGroupConversations: ["group-id"],
      }),
    ).toEqual([
      {
        alias: "direct",
        accountId: "bot",
        conversationId: "direct-id",
        conversationType: "direct",
      },
      {
        alias: "group",
        accountId: "bot",
        conversationId: "group-id",
        conversationType: "group",
      },
    ]);

    expect(
      createScopedProactiveTargets({
        accountId: "bot",
        allowedDirectSenders: ["one", "two"],
        allowedGroupConversations: [],
        aliasesJson: JSON.stringify({
          owner: { conversationType: "direct", conversationId: "two" },
        }),
      }),
    ).toEqual([
      {
        alias: "owner",
        accountId: "bot",
        conversationId: "two",
        conversationType: "direct",
      },
    ]);

    expect(() =>
      createScopedProactiveTargets({
        accountId: "bot",
        allowedDirectSenders: ["allowed"],
        allowedGroupConversations: [],
        aliasesJson: JSON.stringify({
          leaked: { conversationType: "direct", conversationId: "other" },
        }),
      }),
    ).toThrow("outside the scoped allowlist");
  });

  it("sends text through a 0600 socket without returning target identities", async () => {
    const requests: ProactiveTextRequest[] = [];
    const { server, client, socketPath } = await fixture({
      async sendProactiveText(request) {
        requests.push(request);
        return "delivered";
      },
      async sendProactiveMedia() {
        return "delivered";
      },
    });

    const response = await client.request({
      version: LOCAL_CONTROL_PROTOCOL_VERSION,
      action: "send-text",
      target: "owner",
      text: "主动通知",
    });

    expect(response).toEqual({
      ok: true,
      action: "send-text",
      state: "delivered",
      targetType: "direct",
    });
    expect(requests).toEqual([
      {
        accountId: "private-account",
        conversationId: "private-conversation",
        text: "主动通知",
      },
    ]);
    expect(JSON.stringify(response)).not.toContain("private-");
    expect(statSync(socketPath).mode & 0o777).toBe(0o600);

    await server.stop();
    expect(existsSync(socketPath)).toBe(false);
  });

  it("validates aliases and media before invoking the Gateway", async () => {
    const mediaRequests: ProactiveMediaRequest[] = [];
    const errors: Error[] = [];
    const { client } = await fixture(
      {
        async sendProactiveText() {
          return "delivered";
        },
        async sendProactiveMedia(request) {
          mediaRequests.push(request);
          return "queued";
        },
      },
      errors,
    );

    expect(
      await client.request({
        version: LOCAL_CONTROL_PROTOCOL_VERSION,
        action: "send-text",
        target: "missing",
        text: "hello",
      }),
    ).toEqual({
      ok: false,
      error: { code: "unknown-target", message: "Unknown target alias" },
    });

    expect(
      await client.request({
        version: LOCAL_CONTROL_PROTOCOL_VERSION,
        action: "send-media",
        target: "owner",
        media: { type: "file", path: "/allowed/report.pdf" },
      }),
    ).toEqual({
      ok: true,
      action: "send-media",
      state: "queued",
      targetType: "direct",
    });
    expect(mediaRequests).toEqual([
      {
        accountId: "private-account",
        conversationId: "private-conversation",
        media: { type: "file", path: "/allowed/report.pdf" },
      },
    ]);
    expect(errors).toEqual([]);
  });

  it("supports a credential-free health probe", async () => {
    const { client } = await fixture({
      async sendProactiveText() {
        return "delivered";
      },
      async sendProactiveMedia() {
        return "delivered";
      },
    });
    await expect(
      client.request({
        version: LOCAL_CONTROL_PROTOCOL_VERSION,
        action: "health",
      }),
    ).resolves.toEqual({ ok: true, action: "health", ready: true });
  });

  it("never replaces or removes another active control socket", async () => {
    const sender: ProactiveSender = {
      async sendProactiveText() {
        return "delivered";
      },
      async sendProactiveMedia() {
        return "delivered";
      },
    };
    const { client, socketPath } = await fixture(sender);
    const competing = new LocalGatewayControlServer({
      socketPath,
      sender,
      targets: [
        {
          alias: "owner",
          accountId: "other-account",
          conversationId: "other-conversation",
          conversationType: "direct",
        },
      ],
    });
    servers.push(competing);

    await expect(competing.start()).rejects.toThrow("already listening");
    await competing.stop();
    await expect(
      client.request({
        version: LOCAL_CONTROL_PROTOCOL_VERSION,
        action: "health",
      }),
    ).resolves.toEqual({ ok: true, action: "health", ready: true });
  });
});

async function fixture(sender: ProactiveSender, errors: Error[] = []) {
  const root = await mkdtemp(join(tmpdir(), "wecom-control-test-"));
  const socketPath = join(root, "control.sock");
  const server = new LocalGatewayControlServer({
    socketPath,
    sender,
    targets: [
      {
        alias: "owner",
        accountId: "private-account",
        conversationId: "private-conversation",
        conversationType: "direct",
      },
    ],
    onError: (error) => errors.push(error),
  });
  servers.push(server);
  await server.start();
  return {
    server,
    client: new LocalGatewayControlClient({ socketPath }),
    socketPath,
  };
}
