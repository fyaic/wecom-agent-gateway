import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InboundMessage } from "@fyaic/wecom-runtime-contract";
import { WeComBotTransport } from "../src/index.js";

class FakeClient {
  readonly listeners = new Map<string, (...args: any[]) => void>();
  readonly replies: any[][] = [];
  readonly pushes: any[][] = [];
  readonly mediaPushes: any[][] = [];
  readonly uploads: any[][] = [];
  replyError?: unknown;
  downloadResult = { buffer: Buffer.from("media"), filename: "asset.bin" };
  readonly downloads: any[][] = [];
  on(event: string, listener: (...args: any[]) => void): void {
    this.listeners.set(event, listener);
  }
  async connect(): Promise<void> {
    this.listeners.get("authenticated")?.();
  }
  disconnect(): void {}
  async replyStream(...args: any[]): Promise<void> {
    this.replies.push(args);
    if (this.replyError) throw this.replyError;
  }
  async sendMessage(...args: any[]): Promise<void> {
    this.pushes.push(args);
  }
  async sendMediaMessage(...args: any[]): Promise<void> {
    this.mediaPushes.push(args);
  }
  async downloadFile(...args: any[]): Promise<{
    buffer: Buffer;
    filename: string;
  }> {
    this.downloads.push(args);
    return this.downloadResult;
  }
  async uploadMedia(...args: any[]): Promise<{
    media_id: string;
    type: "image";
    created_at: string;
  }> {
    this.uploads.push(args);
    return { media_id: "media-1", type: "image", created_at: "now" };
  }
}

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("WeComBotTransport", () => {
  it("declares exact inbound and outbound media modalities", () => {
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => new FakeClient(),
    });
    expect(transport.inputModalities).toEqual(
      new Set(["image", "video", "file"]),
    );
    expect(transport.outputModalities).toEqual(
      new Set(["image", "audio", "video", "file"]),
    );
  });

  it("routes SDK logs through the injected logger", () => {
    const client = new FakeClient();
    const logs: string[] = [];
    new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: ({ logger }) => {
        logger.debug("raw frame");
        logger.info("connected");
        return client;
      },
      onSdkLog: (level, message) => logs.push(`${level}:${message}`),
    });
    expect(logs).toEqual(["debug:raw frame", "info:connected"]);
  });

  it("normalizes official SDK frames and sends stream/proactive messages", async () => {
    const client = new FakeClient();
    const received: InboundMessage[] = [];
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => client,
    });
    await transport.start(async (message) => {
      received.push(message);
    });
    client.listeners.get("message")?.({
      headers: { req_id: "req-1" },
      body: {
        msgid: "msg-1",
        msgtype: "text",
        chatid: "chat-1",
        chattype: "group",
        from: { userid: "user-1" },
        text: { content: "你好" },
      },
    });
    await Promise.resolve();
    expect(received[0]).toMatchObject({
      id: "msg-1",
      conversationId: "chat-1",
      conversationType: "group",
      senderId: "user-1",
      parts: [{ type: "text", text: "你好" }],
    });
    await transport.deliver({
      type: "reply",
      accountId: "bot-a",
      conversationId: "chat-1",
      replyReference: { requestId: "req-1" },
      streamId: "stream-1",
      text: "完成",
      final: true,
    });
    await transport.deliver({
      type: "proactive",
      accountId: "bot-a",
      conversationId: "chat-1",
      text: "提醒",
    });
    expect(client.replies[0]).toEqual([
      { headers: { req_id: "req-1" } },
      "stream-1",
      "完成",
      true,
    ]);
    expect(client.pushes[0]).toEqual([
      "chat-1",
      { msgtype: "markdown", markdown: { content: "提醒" } },
    ]);
  });

  it("reports authenticated and disconnected SDK states", async () => {
    const client = new FakeClient();
    const states: string[] = [];
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => client,
      onStateChange: (state) => states.push(state),
    });
    await transport.start(async () => undefined);
    client.listeners.get("disconnected")?.();
    expect(states).toEqual(["authenticated", "disconnected"]);
    expect(await transport.health()).toEqual({
      ok: false,
      detail: "WebSocket is not authenticated",
    });
    client.listeners.get("authenticated")?.();
    expect(states).toEqual(["authenticated", "disconnected", "authenticated"]);
    expect(await transport.health()).toEqual({ ok: true });
    await transport.deliver({
      type: "proactive",
      accountId: "bot-a",
      conversationId: "chat-1",
      text: "重连后投递",
    });
    expect(client.pushes).toHaveLength(1);
  });

  it("normalizes voice transcripts and mixed text/image messages", async () => {
    const client = new FakeClient();
    const received: InboundMessage[] = [];
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => client,
    });
    await transport.start(async (message) => {
      received.push(message);
    });

    client.listeners.get("message")?.({
      headers: { req_id: "req-voice" },
      body: {
        msgid: "voice-1",
        msgtype: "voice",
        chattype: "single",
        from: { userid: "user-1" },
        voice: { content: "语音转写" },
      },
    });
    client.listeners.get("message")?.({
      headers: { req_id: "req-mixed" },
      body: {
        msgid: "mixed-1",
        msgtype: "mixed",
        chatid: "chat-1",
        chattype: "group",
        from: { userid: "user-1" },
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "看图" } },
            {
              msgtype: "image",
              image: { url: "https://example.invalid/image", aeskey: "key" },
            },
          ],
        },
      },
    });
    client.listeners.get("message")?.({
      headers: { req_id: "req-video" },
      body: {
        msgid: "video-1",
        msgtype: "video",
        chattype: "single",
        from: { userid: "user-1" },
        video: {
          url: "https://example.invalid/video",
          aeskey: "video-key",
          filename: "demo.mp4",
        },
      },
    });
    client.listeners.get("message")?.({
      headers: { req_id: "req-file" },
      body: {
        msgid: "file-1",
        msgtype: "file",
        chattype: "single",
        from: { userid: "user-1" },
        file: {
          url: "https://example.invalid/file",
          aeskey: "file-key",
          filename: "report.pdf",
        },
      },
    });
    await Promise.resolve();

    expect(received[0]?.parts).toEqual([{ type: "text", text: "语音转写" }]);
    expect(received[1]?.parts).toEqual([
      { type: "text", text: "看图" },
      {
        type: "image",
        url: "https://example.invalid/image",
        name: undefined,
        aesKey: "key",
      },
    ]);
    expect(received[2]?.parts).toEqual([
      {
        type: "video",
        url: "https://example.invalid/video",
        name: "demo.mp4",
        aesKey: "video-key",
      },
    ]);
    expect(received[3]?.parts).toEqual([
      {
        type: "file",
        url: "https://example.invalid/file",
        name: "report.pdf",
        aesKey: "file-key",
      },
    ]);
  });

  it("downloads and decrypts inbound media into protected ephemeral files", async () => {
    const root = mkdtempSync(join(tmpdir(), "wecom-media-test-"));
    directories.push(root);
    const client = new FakeClient();
    client.downloadResult = {
      buffer: Buffer.from("89504e470d0a1a0a", "hex"),
      filename: "../unsafe.png",
    };
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => client,
      mediaTempRoot: root,
    });
    const inbound: InboundMessage = {
      id: "media-1",
      accountId: "bot-a",
      conversationId: "chat-1",
      conversationType: "direct",
      senderId: "user-1",
      receivedAt: "2026-08-20T00:00:00.000Z",
      parts: [
        { type: "text", text: "看图" },
        {
          type: "image",
          url: "https://example.invalid/encrypted",
          aesKey: "one-time-key",
        },
      ],
    };

    const materialized = await transport.materializeInbound(inbound);
    const image = materialized.message.parts[1];
    expect(client.downloads).toEqual([
      ["https://example.invalid/encrypted", "one-time-key"],
    ]);
    expect(image).toMatchObject({
      type: "image",
      name: "01-unsafe.png",
      mimeType: "image/png",
      sizeBytes: 8,
    });
    expect(image).not.toHaveProperty("url");
    expect(image).not.toHaveProperty("aesKey");
    if (image?.type === "text" || !image?.path) {
      throw new Error("expected a materialized image path");
    }
    expect(readFileSync(image.path)).toEqual(client.downloadResult.buffer);
    expect(statSync(image.path).mode & 0o777).toBe(0o600);

    await materialized.release();
    await materialized.release();
    expect(existsSync(image.path)).toBe(false);
  });

  it.each([
    {
      type: "file" as const,
      buffer: Buffer.from("%PDF-1.7\n"),
      filename: "report.pdf",
      mimeType: "application/pdf",
    },
    {
      type: "video" as const,
      buffer: Buffer.concat([
        Buffer.alloc(4),
        Buffer.from("ftyp"),
        Buffer.from("isom"),
      ]),
      filename: "clip.mp4",
      mimeType: "video/mp4",
    },
  ])(
    "materializes inbound $type without persisting SDK secrets",
    async (testCase) => {
      const root = mkdtempSync(join(tmpdir(), "wecom-media-type-test-"));
      directories.push(root);
      const client = new FakeClient();
      client.downloadResult = {
        buffer: testCase.buffer,
        filename: testCase.filename,
      };
      const transport = new WeComBotTransport({
        accountId: "bot-a",
        botId: "id",
        secret: "secret",
        clientFactory: () => client,
        mediaTempRoot: root,
      });

      const materialized = await transport.materializeInbound({
        id: `media-${testCase.type}`,
        accountId: "bot-a",
        conversationId: "chat-1",
        conversationType: "direct",
        senderId: "user-1",
        receivedAt: "2026-08-24T00:00:00.000Z",
        parts: [
          {
            type: testCase.type,
            url: "https://example.invalid/encrypted",
            aesKey: "one-time-key",
            name: testCase.filename,
          },
        ],
      });
      const media = materialized.message.parts[0];
      expect(media).toMatchObject({
        type: testCase.type,
        mimeType: testCase.mimeType,
        sizeBytes: testCase.buffer.byteLength,
      });
      expect(media).not.toHaveProperty("url");
      expect(media).not.toHaveProperty("aesKey");
      if (media?.type === "text" || !media?.path) {
        throw new Error("expected materialized media path");
      }
      expect(statSync(media.path).mode & 0o777).toBe(0o600);
      await materialized.release();
      expect(existsSync(media.path)).toBe(false);
    },
  );

  it("rejects oversized inbound media and removes partial files", async () => {
    const root = mkdtempSync(join(tmpdir(), "wecom-media-limit-test-"));
    directories.push(root);
    const client = new FakeClient();
    client.downloadResult = {
      buffer: Buffer.alloc(5),
      filename: "large.bin",
    };
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => client,
      mediaTempRoot: root,
      mediaMaxBytes: 4,
    });

    await expect(
      transport.materializeInbound({
        id: "large",
        accountId: "bot-a",
        conversationId: "chat-1",
        conversationType: "direct",
        senderId: "user-1",
        receivedAt: "2026-08-20T00:00:00.000Z",
        parts: [
          {
            type: "file",
            url: "https://example.invalid/large",
            aesKey: "key",
          },
        ],
      }),
    ).rejects.toThrow("exceeds configured media limit");
    expect(
      readdirSync(root).filter((name) =>
        name.startsWith("wecom-agent-gateway-media-"),
      ),
    ).toEqual([]);
  });

  it("uploads and proactively sends Agent media only from allowed roots", async () => {
    const root = mkdtempSync(join(tmpdir(), "wecom-media-output-test-"));
    const outside = mkdtempSync(
      join(tmpdir(), "wecom-media-output-outside-test-"),
    );
    directories.push(root, outside);
    const imagePath = join(root, "result.png");
    const outsidePath = join(outside, "private.txt");
    writeFileSync(imagePath, Buffer.from("image"), { mode: 0o600 });
    writeFileSync(outsidePath, "private", { mode: 0o600 });
    const client = new FakeClient();
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => client,
      mediaOutputRoots: [root],
    });

    await transport.deliver({
      type: "proactive-media",
      accountId: "bot-a",
      conversationId: "chat-1",
      media: {
        type: "image",
        path: imagePath,
        name: "../shared.png",
      },
    });
    expect(client.uploads).toEqual([
      [Buffer.from("image"), { type: "image", filename: "shared.png" }],
    ]);
    expect(client.mediaPushes).toEqual([
      ["chat-1", "image", "media-1", undefined],
    ]);

    writeFileSync(imagePath, "tampered", { mode: 0o600 });
    await expect(
      transport.deliver({
        type: "proactive-media",
        accountId: "bot-a",
        conversationId: "chat-1",
        media: {
          type: "image",
          path: imagePath,
          sizeBytes: 5,
          sha256: createHash("sha256").update("image").digest("hex"),
        },
      }),
    ).rejects.toThrow("size changed after spooling");

    await expect(
      transport.deliver({
        type: "proactive-media",
        accountId: "bot-a",
        conversationId: "chat-1",
        media: { type: "file", path: outsidePath },
      }),
    ).rejects.toThrow("outside allowed roots");
    expect(client.uploads).toHaveLength(1);
  });

  it("maps every supported outbound media type to the official SDK", async () => {
    const root = mkdtempSync(join(tmpdir(), "wecom-media-output-types-"));
    directories.push(root);
    const filePath = join(root, "report.pdf");
    const audioPath = join(root, "answer.mp3");
    const videoPath = join(root, "demo.mp4");
    writeFileSync(filePath, "%PDF-test", { mode: 0o600 });
    writeFileSync(audioPath, "audio", { mode: 0o600 });
    writeFileSync(videoPath, "video", { mode: 0o600 });
    const client = new FakeClient();
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => client,
      mediaOutputRoots: [root],
    });

    await transport.deliver({
      type: "proactive-media",
      accountId: "bot-a",
      conversationId: "chat-1",
      media: { type: "file", path: filePath },
    });
    await transport.deliver({
      type: "proactive-media",
      accountId: "bot-a",
      conversationId: "chat-1",
      media: { type: "audio", path: audioPath },
    });
    await transport.deliver({
      type: "proactive-media",
      accountId: "bot-a",
      conversationId: "chat-1",
      media: {
        type: "video",
        path: videoPath,
        title: "演示",
        description: "视频说明",
      },
    });

    expect(client.uploads.map((entry) => entry[1].type)).toEqual([
      "file",
      "voice",
      "video",
    ]);
    expect(client.mediaPushes).toEqual([
      ["chat-1", "file", "media-1", undefined],
      ["chat-1", "voice", "media-1", undefined],
      [
        "chat-1",
        "video",
        "media-1",
        { title: "演示", description: "视频说明" },
      ],
    ]);
  });

  it("fails closed when no outbound media root is configured", async () => {
    const root = mkdtempSync(join(tmpdir(), "wecom-media-disabled-test-"));
    directories.push(root);
    const filePath = join(root, "report.pdf");
    writeFileSync(filePath, "report", { mode: 0o600 });
    const client = new FakeClient();
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => client,
    });

    await expect(
      transport.deliver({
        type: "proactive-media",
        accountId: "bot-a",
        conversationId: "chat-1",
        media: { type: "file", path: filePath },
      }),
    ).rejects.toThrow("no allowed output roots");
  });

  it("falls back to an official proactive send when the stream window expires", async () => {
    const client = new FakeClient();
    client.replyError = Object.assign(new Error("stream expired 846608"), {
      errcode: 846608,
    });
    const transport = new WeComBotTransport({
      accountId: "bot-a",
      botId: "id",
      secret: "secret",
      clientFactory: () => client,
    });
    await transport.start(async () => undefined);

    await transport.deliver({
      type: "reply",
      accountId: "bot-a",
      conversationId: "chat-1",
      replyReference: { requestId: "req-expired" },
      streamId: "stream-expired",
      text: "最终结果",
      final: true,
    });

    expect(client.pushes).toContainEqual([
      "chat-1",
      { msgtype: "markdown", markdown: { content: "最终结果" } },
    ]);
  });
});
