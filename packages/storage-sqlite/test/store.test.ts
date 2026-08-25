import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  DurableOutboundCommand,
  InboundMessage,
} from "@fyaic/wecom-runtime-contract";
import { SqliteGatewayStore } from "../src/index.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("SqliteGatewayStore", () => {
  it("does not mask a transaction failure when rollback also fails", async () => {
    const store = new SqliteGatewayStore(":memory:");
    const database = (
      store as unknown as {
        database: { exec: (sql: string) => void };
      }
    ).database;
    const originalExec = database.exec.bind(database);
    database.exec = (sql: string) => {
      if (sql === "ROLLBACK") throw new Error("secondary rollback failure");
      originalExec(sql);
    };
    const command = {
      type: "proactive",
      accountId: "bot",
      conversationId: "chat",
      get text(): string {
        throw new Error("original transaction failure");
      },
    } as DurableOutboundCommand;

    try {
      await expect(
        store.enqueueDelivery({
          messageId: "failed-transaction",
          command,
          now: "2026-08-25T00:00:00.000Z",
        }),
      ).rejects.toThrow("original transaction failure");
    } finally {
      database.exec = originalExec;
      originalExec("ROLLBACK");
      store.close();
    }
  });

  it("persists deduplication, runtime sessions, and delivery records across reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-agent-gateway-"));
    directories.push(directory);
    const path = join(directory, "gateway.db");
    const message: InboundMessage = {
      id: "m1",
      accountId: "bot",
      conversationId: "chat",
      conversationType: "direct",
      senderId: "user",
      receivedAt: "2026-08-20T00:00:00.000Z",
      parts: [{ type: "text", text: "hello" }],
      replyReference: { requestId: "req-1" },
    };
    const first = new SqliteGatewayStore(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await first.acceptInbound(message)).toBe(true);
    await first.setSession({
      accountId: "bot",
      conversationId: "chat",
      adapterId: "codex",
      sessionId: "thread-1",
    });
    await first.recordDelivery({
      messageId: "m1",
      command: {
        type: "proactive",
        accountId: "bot",
        conversationId: "chat",
        text: "done",
      },
      receipt: { id: "delivery-1", acceptedAt: "2026-08-20T00:00:01.000Z" },
    });
    first.close();

    const second = new SqliteGatewayStore(path);
    expect(await second.acceptInbound(message)).toBe(false);
    expect(
      await second.getSession({
        accountId: "bot",
        conversationId: "chat",
        adapterId: "codex",
      }),
    ).toBe("thread-1");
    second.close();
  });

  it("never persists ephemeral media URLs, keys, or local paths", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-agent-media-store-"));
    directories.push(directory);
    const path = join(directory, "gateway.db");
    const store = new SqliteGatewayStore(path);
    await store.acceptInbound({
      id: "media",
      accountId: "bot",
      conversationId: "chat",
      conversationType: "direct",
      senderId: "user",
      receivedAt: "2026-08-20T00:00:00.000Z",
      parts: [
        {
          type: "image",
          url: "https://example.invalid/secret-media-url",
          path: "/tmp/secret-media-path",
          aesKey: "secret-aes-key",
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 8,
        },
      ],
    });
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const row = database
      .prepare("SELECT payload_json FROM inbound_messages WHERE message_id = ?")
      .get("media") as { payload_json: string };
    database.close();
    expect(JSON.parse(row.payload_json).parts).toEqual([
      {
        type: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 8,
      },
    ]);
    expect(row.payload_json).not.toContain("secret-media");
    expect(row.payload_json).not.toContain("secret-aes-key");
  });

  it("does not persist an Agent local path in the delivery journal", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-agent-media-outbox-"));
    directories.push(directory);
    const path = join(directory, "gateway.db");
    const store = new SqliteGatewayStore(path);
    await store.recordDelivery({
      messageId: "media-output",
      command: {
        type: "proactive-media",
        accountId: "bot",
        conversationId: "chat",
        media: {
          type: "file",
          path: "/private/workspace/secret-report.pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
        },
      },
      receipt: { id: "delivery", acceptedAt: "2026-08-20T00:00:00.000Z" },
    });
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const row = database
      .prepare("SELECT command_json FROM delivery_journal WHERE message_id = ?")
      .get("media-output") as { command_json: string };
    database.close();
    expect(JSON.parse(row.command_json).media).toEqual({
      type: "file",
      name: "report.pdf",
      mimeType: "application/pdf",
    });
    expect(row.command_json).not.toContain("secret-report");
    expect(row.command_json).not.toContain("private/workspace");
  });

  it("recovers a pending delivery after the database is reopened", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-agent-outbox-"));
    directories.push(directory);
    const path = join(directory, "gateway.db");
    const first = new SqliteGatewayStore(path);
    const deliveryId = await first.enqueueDelivery({
      messageId: "restart-message",
      command: replyCommand("final answer", true),
      now: "2026-08-20T00:00:00.000Z",
    });
    first.close();

    const second = new SqliteGatewayStore(path);
    const entries = await second.claimDueDeliveries({
      owner: "new-process",
      now: "2026-08-20T00:00:01.000Z",
      leaseUntil: "2026-08-20T00:00:31.000Z",
      limit: 10,
    });
    expect(entries).toEqual([
      {
        id: deliveryId,
        messageId: "restart-message",
        command: replyCommand("final answer", true),
        attempts: 1,
      },
    ]);
    await second.completeDelivery({
      deliveryId,
      owner: "new-process",
      receipt: {
        id: "remote-delivery",
        acceptedAt: "2026-08-20T00:00:02.000Z",
      },
      now: "2026-08-20T00:00:02.000Z",
    });
    second.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const outbox = database
      .prepare("SELECT status, attempts FROM delivery_outbox WHERE id = ?")
      .get(deliveryId) as { status: string; attempts: number };
    const journal = database
      .prepare(
        "SELECT command_json, receipt_json FROM delivery_journal WHERE message_id = ?",
      )
      .get("restart-message") as {
      command_json: string;
      receipt_json: string;
    };
    database.close();
    expect(outbox).toEqual({ status: "delivered", attempts: 1 });
    expect(JSON.parse(journal.command_json)).toEqual(
      replyCommand("final answer", true),
    );
    expect(JSON.parse(journal.receipt_json).id).toBe("remote-delivery");
  });

  it("reclaims an expired lease but not an active lease", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-agent-lease-"));
    directories.push(directory);
    const store = new SqliteGatewayStore(join(directory, "gateway.db"));
    const deliveryId = await store.enqueueDelivery({
      messageId: "leased-message",
      command: replyCommand("leased", true),
      now: "2026-08-20T00:00:00.000Z",
    });
    expect(
      await store.claimDelivery({
        deliveryId,
        owner: "crashed-process",
        now: "2026-08-20T00:00:01.000Z",
        leaseUntil: "2026-08-20T00:00:10.000Z",
      }),
    ).toMatchObject({ attempts: 1 });
    expect(
      await store.claimDueDeliveries({
        owner: "replacement-process",
        now: "2026-08-20T00:00:09.000Z",
        leaseUntil: "2026-08-20T00:00:39.000Z",
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      await store.claimDueDeliveries({
        owner: "replacement-process",
        now: "2026-08-20T00:00:11.000Z",
        leaseUntil: "2026-08-20T00:00:41.000Z",
        limit: 10,
      }),
    ).toEqual([expect.objectContaining({ id: deliveryId, attempts: 2 })]);
    store.close();
  });

  it("supersedes stale stream updates and supports retry then dead-letter", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-agent-retry-"));
    directories.push(directory);
    const path = join(directory, "gateway.db");
    const store = new SqliteGatewayStore(path);
    const staleId = await store.enqueueDelivery({
      messageId: "stream-message",
      command: replyCommand("partial", false),
      supersedeKey: "one-stream",
      now: "2026-08-20T00:00:00.000Z",
    });
    const finalId = await store.enqueueDelivery({
      messageId: "stream-message",
      command: replyCommand("complete", true),
      supersedeKey: "one-stream",
      now: "2026-08-20T00:00:01.000Z",
    });
    expect(
      await store.claimDelivery({
        deliveryId: staleId,
        owner: "worker",
        now: "2026-08-20T00:00:01.000Z",
        leaseUntil: "2026-08-20T00:00:31.000Z",
      }),
    ).toBeUndefined();
    const firstAttempt = await store.claimDelivery({
      deliveryId: finalId,
      owner: "worker",
      now: "2026-08-20T00:00:01.000Z",
      leaseUntil: "2026-08-20T00:00:31.000Z",
    });
    expect(firstAttempt).toMatchObject({ attempts: 1 });
    await store.retryDelivery({
      deliveryId: finalId,
      owner: "worker",
      error: "temporary failure",
      nextAttemptAt: "2026-08-20T00:00:10.000Z",
      now: "2026-08-20T00:00:02.000Z",
    });
    expect(
      await store.claimDueDeliveries({
        owner: "worker",
        now: "2026-08-20T00:00:09.000Z",
        leaseUntil: "2026-08-20T00:00:39.000Z",
        limit: 10,
      }),
    ).toEqual([]);
    const secondAttempt = await store.claimDueDeliveries({
      owner: "worker",
      now: "2026-08-20T00:00:10.000Z",
      leaseUntil: "2026-08-20T00:00:40.000Z",
      limit: 10,
    });
    expect(secondAttempt).toEqual([
      expect.objectContaining({ id: finalId, attempts: 2 }),
    ]);
    await store.deadLetterDelivery({
      deliveryId: finalId,
      owner: "worker",
      error: "permanent failure",
      now: "2026-08-20T00:00:11.000Z",
    });
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const rows = database
      .prepare("SELECT id, status FROM delivery_outbox ORDER BY id")
      .all() as Array<{ id: number; status: string }>;
    const journal = database
      .prepare("SELECT error FROM delivery_journal WHERE message_id = ?")
      .get("stream-message") as { error: string };
    database.close();
    expect(rows).toEqual([
      { id: Number(staleId), status: "superseded" },
      { id: Number(finalId), status: "dead" },
    ]);
    expect(journal.error).toBe("permanent failure");
  });

  it("persists only durable media references and lists live spool artifacts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-agent-media-spool-"));
    directories.push(directory);
    const path = join(directory, "gateway.db");
    const store = new SqliteGatewayStore(path);
    const deliveryId = await store.enqueueDelivery({
      messageId: "durable-media",
      command: {
        type: "proactive-media",
        accountId: "bot",
        conversationId: "chat",
        media: {
          artifactId: "00000000-0000-4000-8000-000000000000",
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 123,
          sha256: "a".repeat(64),
        },
      },
      now: "2026-08-20T00:00:00.000Z",
    });
    expect(await store.listReferencedMediaArtifactIds()).toEqual([
      "00000000-0000-4000-8000-000000000000",
    ]);
    await store.claimDelivery({
      deliveryId,
      owner: "worker",
      now: "2026-08-20T00:00:01.000Z",
      leaseUntil: "2026-08-20T00:00:31.000Z",
    });
    expect(await store.listReferencedMediaArtifactIds()).toHaveLength(1);
    await store.deadLetterDelivery({
      deliveryId,
      owner: "worker",
      error: "upload failed",
      now: "2026-08-20T00:00:02.000Z",
    });
    expect(await store.listReferencedMediaArtifactIds()).toEqual([]);
    store.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const row = database
      .prepare("SELECT command_json FROM delivery_outbox WHERE id = ?")
      .get(deliveryId) as { command_json: string };
    database.close();
    expect(row.command_json).not.toContain("/private/agent-workspace");
    expect(JSON.parse(row.command_json).media).toEqual({
      artifactId: "00000000-0000-4000-8000-000000000000",
      type: "file",
      name: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 123,
      sha256: "a".repeat(64),
    });
  });

  it("reports aggregate outbox state and requeues only safe terminal text", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-agent-dead-admin-"));
    directories.push(directory);
    const store = new SqliteGatewayStore(join(directory, "gateway.db"));
    const commands: DurableOutboundCommand[] = [
      replyCommand("stale partial", false),
      replyCommand("safe final", true),
      {
        type: "proactive",
        accountId: "bot",
        conversationId: "chat",
        text: "safe proactive",
      },
      {
        type: "proactive-media",
        accountId: "bot",
        conversationId: "chat",
        media: {
          artifactId: "00000000-0000-4000-8000-000000000000",
          type: "file",
          sizeBytes: 1,
          sha256: "b".repeat(64),
        },
      },
    ];
    for (const [index, command] of commands.entries()) {
      const deliveryId = await store.enqueueDelivery({
        messageId: `dead-${index}`,
        command,
        now: "2026-08-20T00:00:00.000Z",
      });
      await store.claimDelivery({
        deliveryId,
        owner: "worker",
        now: "2026-08-20T00:00:01.000Z",
        leaseUntil: "2026-08-20T00:00:31.000Z",
      });
      await store.deadLetterDelivery({
        deliveryId,
        owner: "worker",
        error: "failed",
        now: "2026-08-20T00:00:02.000Z",
      });
    }
    expect(await store.getDeliveryOutboxStats()).toEqual({
      pending: 0,
      leased: 0,
      delivered: 0,
      dead: 4,
      superseded: 0,
    });

    expect(
      await store.requeueDeadTextDeliveries({
        limit: 10,
        now: "2026-08-20T00:00:10.000Z",
      }),
    ).toBe(2);
    expect(await store.getDeliveryOutboxStats()).toEqual({
      pending: 2,
      leased: 0,
      delivered: 0,
      dead: 2,
      superseded: 0,
    });
    const replay = await store.claimDueDeliveries({
      owner: "worker",
      now: "2026-08-20T00:00:10.000Z",
      leaseUntil: "2026-08-20T00:00:40.000Z",
      limit: 10,
    });
    expect(replay.map((entry) => entry.command.type)).toEqual([
      "reply",
      "proactive",
    ]);
    expect(replay.every((entry) => entry.attempts === 1)).toBe(true);
    store.close();
  });

  it("persists approvals with scoped, expiring, and idempotent decisions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wecom-agent-approval-"));
    directories.push(directory);
    const path = join(directory, "gateway.db");
    const first = new SqliteGatewayStore(path);
    expect(
      await first.createApproval({
        approvalId: "A1B2C3D4",
        accountId: "bot",
        conversationId: "chat",
        senderId: "user",
        adapterId: "codex",
        toolName: "test_write",
        effect: "write",
        summary: "执行测试写入",
        createdAt: "2026-08-20T00:00:00.000Z",
        expiresAt: "2026-08-20T00:05:00.000Z",
      }),
    ).toBe(true);
    expect(
      await first.resolveApproval({
        approvalId: "A1B2C3D4",
        accountId: "bot",
        conversationId: "chat",
        senderId: "other-user",
        decision: "approved",
        now: "2026-08-20T00:01:00.000Z",
      }),
    ).toBe(false);
    expect(
      await first.resolveApproval({
        approvalId: "A1B2C3D4",
        accountId: "bot",
        conversationId: "chat",
        senderId: "user",
        decision: "approved",
        now: "2026-08-20T00:01:00.000Z",
      }),
    ).toBe(true);
    expect(
      await first.resolveApproval({
        approvalId: "A1B2C3D4",
        accountId: "bot",
        conversationId: "chat",
        senderId: "user",
        decision: "denied",
        now: "2026-08-20T00:02:00.000Z",
      }),
    ).toBe(false);

    await first.createApproval({
      approvalId: "DEAD0001",
      accountId: "bot",
      conversationId: "chat",
      senderId: "user",
      adapterId: "codex",
      toolName: "test_delete",
      effect: "destructive",
      summary: "执行测试删除",
      createdAt: "2026-08-20T00:00:00.000Z",
      expiresAt: "2026-08-20T00:01:00.000Z",
    });
    expect(
      await first.resolveApproval({
        approvalId: "DEAD0001",
        accountId: "bot",
        conversationId: "chat",
        senderId: "user",
        decision: "approved",
        now: "2026-08-20T00:02:00.000Z",
      }),
    ).toBe(false);
    expect(
      await first.resolveApproval({
        approvalId: "DEAD0001",
        accountId: "bot",
        conversationId: "chat",
        senderId: "user",
        decision: "expired",
        now: "2026-08-20T00:02:00.000Z",
      }),
    ).toBe(true);
    await first.createApproval({
      approvalId: "WAIT0001",
      accountId: "bot",
      conversationId: "chat",
      senderId: "user",
      adapterId: "codex",
      toolName: "test_write",
      effect: "write",
      summary: "执行另一次测试写入",
      createdAt: "2026-08-20T00:02:00.000Z",
      expiresAt: "2026-08-20T00:07:00.000Z",
    });
    first.close();

    const second = new SqliteGatewayStore(path);
    expect(
      await second.interruptPendingApprovals("2026-08-20T00:03:00.000Z"),
    ).toBe(1);
    second.close();

    const database = new DatabaseSync(path, { readOnly: true });
    const rows = database
      .prepare("SELECT approval_id, status FROM approvals ORDER BY approval_id")
      .all() as Array<{ approval_id: string; status: string }>;
    database.close();
    expect(rows).toEqual([
      { approval_id: "A1B2C3D4", status: "approved" },
      { approval_id: "DEAD0001", status: "expired" },
      { approval_id: "WAIT0001", status: "interrupted" },
    ]);
  });
});

function replyCommand(text: string, final: boolean): DurableOutboundCommand {
  return {
    type: "reply",
    accountId: "bot",
    conversationId: "chat",
    replyReference: { requestId: "request" },
    streamId: "stream",
    text,
    final,
  };
}
