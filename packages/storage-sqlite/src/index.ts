import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  ApprovalStatus,
  DeliveryOutboxEntry,
  DeliveryOutboxStats,
  DeliveryOutboxStatus,
  DeliveryReceipt,
  DurableOutboundCommand,
  GatewayStore,
  InboundMessage,
  OutboundCommand,
  PendingApproval,
  PendingPresentationInteraction,
  ResolvedPresentationInteraction,
} from "@fyaic/wecom-runtime-contract";

export class SqliteGatewayStore implements GatewayStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS inbound_messages (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (account_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS runtime_sessions (
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (account_id, conversation_id, adapter_id)
      );
      CREATE TABLE IF NOT EXISTS delivery_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        command_json TEXT NOT NULL,
        receipt_json TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS delivery_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL,
        command_json TEXT NOT NULL,
        supersede_key TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'leased', 'delivered', 'dead', 'superseded')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_owner TEXT,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS delivery_outbox_due_idx
        ON delivery_outbox(status, next_attempt_at, lease_until, id);
      CREATE INDEX IF NOT EXISTS delivery_outbox_supersede_idx
        ON delivery_outbox(supersede_key, status);
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        adapter_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        effect TEXT NOT NULL CHECK(effect IN ('write', 'destructive')),
        summary TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'approved', 'denied', 'expired', 'interrupted')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS approvals_pending_idx
        ON approvals(status, expires_at);
      CREATE TABLE IF NOT EXISTS presentation_interactions (
        interaction_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('approval')),
        correlation_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'resolved', 'expired')),
        action_id TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE INDEX IF NOT EXISTS presentation_interactions_pending_idx
        ON presentation_interactions(status, expires_at);
    `);
  }

  async acceptInbound(message: InboundMessage): Promise<boolean> {
    const result = this.database
      .prepare(
        `
        INSERT OR IGNORE INTO inbound_messages
          (account_id, message_id, conversation_id, sender_id, received_at, payload_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `,
      )
      .run(
        message.accountId,
        message.id,
        message.conversationId,
        message.senderId,
        message.receivedAt,
        JSON.stringify(persistableInbound(message)),
      );
    return result.changes === 1;
  }

  async getSession(scope: {
    accountId: string;
    conversationId: string;
    adapterId: string;
  }): Promise<string | undefined> {
    const row = this.database
      .prepare(
        `
        SELECT session_id FROM runtime_sessions
        WHERE account_id = ? AND conversation_id = ? AND adapter_id = ?
      `,
      )
      .get(scope.accountId, scope.conversationId, scope.adapterId) as
      { session_id: string } | undefined;
    return row?.session_id;
  }

  async setSession(scope: {
    accountId: string;
    conversationId: string;
    adapterId: string;
    sessionId: string;
  }): Promise<void> {
    this.database
      .prepare(
        `
        INSERT INTO runtime_sessions
          (account_id, conversation_id, adapter_id, session_id, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_id, conversation_id, adapter_id) DO UPDATE SET
          session_id = excluded.session_id,
          updated_at = excluded.updated_at
      `,
      )
      .run(
        scope.accountId,
        scope.conversationId,
        scope.adapterId,
        scope.sessionId,
        new Date().toISOString(),
      );
  }

  async recordDelivery(record: {
    messageId: string;
    command: OutboundCommand;
    receipt?: DeliveryReceipt;
    error?: string;
  }): Promise<void> {
    this.database
      .prepare(
        `
        INSERT INTO delivery_journal
          (message_id, command_json, receipt_json, error, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.messageId,
        JSON.stringify(persistableOutbound(record.command)),
        record.receipt ? JSON.stringify(record.receipt) : null,
        record.error ?? null,
        new Date().toISOString(),
      );
  }

  async enqueueDelivery(record: {
    messageId: string;
    command: DurableOutboundCommand;
    supersedeKey?: string;
    now: string;
  }): Promise<string> {
    return this.transaction(() => {
      if (record.supersedeKey) {
        this.database
          .prepare(
            `
            UPDATE delivery_outbox
            SET status = 'superseded', updated_at = ?
            WHERE supersede_key = ? AND status = 'pending'
          `,
          )
          .run(record.now, record.supersedeKey);
      }
      const result = this.database
        .prepare(
          `
          INSERT INTO delivery_outbox
            (message_id, command_json, supersede_key, status, attempts,
             next_attempt_at, created_at, updated_at)
          VALUES (?, ?, ?, 'pending', 0, ?, ?, ?)
        `,
        )
        .run(
          record.messageId,
          JSON.stringify(record.command),
          record.supersedeKey ?? null,
          record.now,
          record.now,
          record.now,
        );
      return String(result.lastInsertRowid);
    });
  }

  async claimDelivery(options: {
    deliveryId: string;
    owner: string;
    now: string;
    leaseUntil: string;
  }): Promise<DeliveryOutboxEntry | undefined> {
    return this.transaction(() => {
      const result = this.database
        .prepare(
          `
          UPDATE delivery_outbox
          SET status = 'leased', lease_owner = ?, lease_until = ?,
              attempts = attempts + 1, updated_at = ?
          WHERE id = ? AND (
            (status = 'pending' AND next_attempt_at <= ?)
            OR (status = 'leased' AND lease_until <= ?)
          )
        `,
        )
        .run(
          options.owner,
          options.leaseUntil,
          options.now,
          options.deliveryId,
          options.now,
          options.now,
        );
      if (result.changes !== 1) return undefined;
      return this.getOutboxEntry(options.deliveryId);
    });
  }

  async claimDueDeliveries(options: {
    owner: string;
    now: string;
    leaseUntil: string;
    limit: number;
  }): Promise<DeliveryOutboxEntry[]> {
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          `
          SELECT id FROM delivery_outbox
          WHERE (status = 'pending' AND next_attempt_at <= ?)
             OR (status = 'leased' AND lease_until <= ?)
          ORDER BY id
          LIMIT ?
        `,
        )
        .all(options.now, options.now, options.limit) as Array<{ id: number }>;
      const entries: DeliveryOutboxEntry[] = [];
      for (const row of rows) {
        const updated = this.database
          .prepare(
            `
            UPDATE delivery_outbox
            SET status = 'leased', lease_owner = ?, lease_until = ?,
                attempts = attempts + 1, updated_at = ?
            WHERE id = ? AND (
              (status = 'pending' AND next_attempt_at <= ?)
              OR (status = 'leased' AND lease_until <= ?)
            )
          `,
          )
          .run(
            options.owner,
            options.leaseUntil,
            options.now,
            row.id,
            options.now,
            options.now,
          );
        if (updated.changes === 1) {
          const entry = this.getOutboxEntry(String(row.id));
          if (entry) entries.push(entry);
        }
      }
      return entries;
    });
  }

  async completeDelivery(record: {
    deliveryId: string;
    owner: string;
    receipt: DeliveryReceipt;
    now: string;
  }): Promise<void> {
    this.transaction(() => {
      const row = this.getLeasedOutboxRow(record.deliveryId, record.owner);
      const result = this.database
        .prepare(
          `
          UPDATE delivery_outbox
          SET status = 'delivered', lease_owner = NULL, lease_until = NULL,
              updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
        `,
        )
        .run(record.now, record.deliveryId, record.owner);
      if (result.changes !== 1) throw new Error("Outbox lease was lost");
      this.insertDeliveryJournal({
        messageId: row.message_id,
        commandJson: row.command_json,
        receiptJson: JSON.stringify(record.receipt),
        createdAt: record.now,
      });
    });
  }

  async retryDelivery(record: {
    deliveryId: string;
    owner: string;
    error: string;
    nextAttemptAt: string;
    now: string;
  }): Promise<void> {
    const result = this.database
      .prepare(
        `
        UPDATE delivery_outbox
        SET status = 'pending', next_attempt_at = ?, lease_owner = NULL,
            lease_until = NULL, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'leased' AND lease_owner = ?
      `,
      )
      .run(
        record.nextAttemptAt,
        record.error,
        record.now,
        record.deliveryId,
        record.owner,
      );
    if (result.changes !== 1) throw new Error("Outbox lease was lost");
  }

  async deadLetterDelivery(record: {
    deliveryId: string;
    owner: string;
    error: string;
    now: string;
  }): Promise<void> {
    this.transaction(() => {
      const row = this.getLeasedOutboxRow(record.deliveryId, record.owner);
      const result = this.database
        .prepare(
          `
          UPDATE delivery_outbox
          SET status = 'dead', lease_owner = NULL, lease_until = NULL,
              last_error = ?, updated_at = ?
          WHERE id = ? AND status = 'leased' AND lease_owner = ?
        `,
        )
        .run(record.error, record.now, record.deliveryId, record.owner);
      if (result.changes !== 1) throw new Error("Outbox lease was lost");
      this.insertDeliveryJournal({
        messageId: row.message_id,
        commandJson: row.command_json,
        error: record.error,
        createdAt: record.now,
      });
    });
  }

  async listReferencedMediaArtifactIds(): Promise<string[]> {
    const rows = this.database
      .prepare(
        `
        SELECT command_json FROM delivery_outbox
        WHERE status IN ('pending', 'leased')
      `,
      )
      .all() as Array<{ command_json: string }>;
    const ids: string[] = [];
    for (const row of rows) {
      const command = JSON.parse(row.command_json) as DurableOutboundCommand;
      if (command.type === "proactive-media") {
        ids.push(command.media.artifactId);
      }
    }
    return ids;
  }

  async getDeliveryOutboxStats(): Promise<DeliveryOutboxStats> {
    const stats = emptyOutboxStats();
    const rows = this.database
      .prepare(
        `
        SELECT status, count(*) AS count
        FROM delivery_outbox
        GROUP BY status
      `,
      )
      .all() as Array<{ status: DeliveryOutboxStatus; count: number }>;
    for (const row of rows) stats[row.status] = row.count;
    return stats;
  }

  async requeueDeadTextDeliveries(options: {
    limit: number;
    now: string;
  }): Promise<number> {
    if (options.limit < 1) return 0;
    return this.transaction(() => {
      const rows = this.database
        .prepare(
          `
          SELECT id FROM delivery_outbox
          WHERE status = 'dead' AND (
            json_extract(command_json, '$.type') = 'proactive'
            OR (
              json_extract(command_json, '$.type') = 'reply'
              AND json_extract(command_json, '$.final') = 1
            )
          )
          ORDER BY id
          LIMIT ?
        `,
        )
        .all(options.limit) as Array<{ id: number }>;
      if (rows.length === 0) return 0;
      const update = this.database.prepare(
        `
        UPDATE delivery_outbox
        SET status = 'pending', attempts = 0, next_attempt_at = ?,
            lease_owner = NULL, lease_until = NULL, last_error = NULL,
            updated_at = ?
        WHERE id = ? AND status = 'dead'
      `,
      );
      let requeued = 0;
      for (const row of rows) {
        requeued += Number(
          update.run(options.now, options.now, row.id).changes,
        );
      }
      return requeued;
    });
  }

  async createApproval(approval: PendingApproval): Promise<boolean> {
    const result = this.database
      .prepare(
        `
        INSERT OR IGNORE INTO approvals
          (approval_id, account_id, conversation_id, sender_id, adapter_id,
           tool_name, effect, summary, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `,
      )
      .run(
        approval.approvalId,
        approval.accountId,
        approval.conversationId,
        approval.senderId,
        approval.adapterId,
        approval.toolName,
        approval.effect,
        approval.summary,
        approval.createdAt,
        approval.expiresAt,
      );
    return result.changes === 1;
  }

  async resolveApproval(options: {
    approvalId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    decision: Exclude<ApprovalStatus, "pending">;
    now: string;
  }): Promise<boolean> {
    return this.transaction(() => {
      const result = this.database
        .prepare(
          `
          UPDATE approvals
          SET status = ?, resolved_at = ?
          WHERE approval_id = ?
            AND account_id = ?
            AND conversation_id = ?
            AND sender_id = ?
            AND status = 'pending'
            AND (? = 'expired' OR expires_at > ?)
        `,
        )
        .run(
          options.decision,
          options.now,
          options.approvalId,
          options.accountId,
          options.conversationId,
          options.senderId,
          options.decision,
          options.now,
        );
      return result.changes === 1;
    });
  }

  async interruptPendingApprovals(now: string): Promise<number> {
    const result = this.database
      .prepare(
        `
        UPDATE approvals
        SET status = 'interrupted', resolved_at = ?
        WHERE status = 'pending'
      `,
      )
      .run(now);
    return Number(result.changes);
  }

  async createPresentationInteraction(
    interaction: PendingPresentationInteraction,
  ): Promise<boolean> {
    const result = this.database
      .prepare(
        `
        INSERT OR IGNORE INTO presentation_interactions
          (interaction_id, account_id, conversation_id, sender_id, kind,
           correlation_id, status, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `,
      )
      .run(
        interaction.interactionId,
        interaction.accountId,
        interaction.conversationId,
        interaction.senderId,
        interaction.kind,
        interaction.correlationId,
        interaction.createdAt,
        interaction.expiresAt,
      );
    return result.changes === 1;
  }

  async resolvePresentationInteraction(options: {
    interactionId: string;
    accountId: string;
    conversationId: string;
    senderId: string;
    actionId: string;
    now: string;
  }): Promise<ResolvedPresentationInteraction | undefined> {
    return this.transaction(() => {
      this.database
        .prepare(
          `
          UPDATE presentation_interactions
          SET status = 'expired', resolved_at = ?
          WHERE interaction_id = ? AND status = 'pending' AND expires_at <= ?
        `,
        )
        .run(options.now, options.interactionId, options.now);
      const row = this.database
        .prepare(
          `
          SELECT kind, correlation_id
          FROM presentation_interactions
          WHERE interaction_id = ?
            AND account_id = ?
            AND conversation_id = ?
            AND sender_id = ?
            AND status = 'pending'
            AND expires_at > ?
        `,
        )
        .get(
          options.interactionId,
          options.accountId,
          options.conversationId,
          options.senderId,
          options.now,
        ) as
        | {
            kind: ResolvedPresentationInteraction["kind"];
            correlation_id: string;
          }
        | undefined;
      if (!row) return undefined;
      const result = this.database
        .prepare(
          `
          UPDATE presentation_interactions
          SET status = 'resolved', action_id = ?, resolved_at = ?
          WHERE interaction_id = ? AND status = 'pending'
        `,
        )
        .run(options.actionId, options.now, options.interactionId);
      if (result.changes !== 1) return undefined;
      return {
        interactionId: options.interactionId,
        kind: row.kind,
        correlationId: row.correlation_id,
        actionId: options.actionId,
      };
    });
  }

  close(): void {
    this.database.close();
  }

  private getOutboxEntry(id: string): DeliveryOutboxEntry | undefined {
    const row = this.database
      .prepare(
        `
        SELECT id, message_id, command_json, attempts
        FROM delivery_outbox WHERE id = ?
      `,
      )
      .get(id) as OutboxRow | undefined;
    return row ? outboxEntry(row) : undefined;
  }

  private getLeasedOutboxRow(id: string, owner: string): OutboxRow {
    const row = this.database
      .prepare(
        `
        SELECT id, message_id, command_json, attempts
        FROM delivery_outbox
        WHERE id = ? AND status = 'leased' AND lease_owner = ?
      `,
      )
      .get(id, owner) as OutboxRow | undefined;
    if (!row) throw new Error("Outbox delivery is not leased by owner");
    return row;
  }

  private insertDeliveryJournal(record: {
    messageId: string;
    commandJson: string;
    receiptJson?: string;
    error?: string;
    createdAt: string;
  }): void {
    this.database
      .prepare(
        `
        INSERT INTO delivery_journal
          (message_id, command_json, receipt_json, error, created_at)
        VALUES (?, ?, ?, ?, ?)
      `,
      )
      .run(
        record.messageId,
        record.commandJson,
        record.receiptJson ?? null,
        record.error ?? null,
        record.createdAt,
      );
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      // SQLite may automatically end a transaction after faults such as
      // SQLITE_FULL. A secondary ROLLBACK error must never hide the original
      // write/commit failure that operators need for diagnosis.
      if (this.database.isTransaction) {
        try {
          this.database.exec("ROLLBACK");
        } catch {
          // Preserve the causal error. The caller will fail closed and may
          // reopen the database after the underlying storage fault is cleared.
        }
      }
      throw error;
    }
  }
}

interface OutboxRow {
  id: number;
  message_id: string;
  command_json: string;
  attempts: number;
}

function emptyOutboxStats(): DeliveryOutboxStats {
  return {
    pending: 0,
    leased: 0,
    delivered: 0,
    dead: 0,
    superseded: 0,
  };
}

function outboxEntry(row: OutboxRow): DeliveryOutboxEntry {
  return {
    id: String(row.id),
    messageId: row.message_id,
    command: JSON.parse(row.command_json) as DurableOutboundCommand,
    attempts: row.attempts,
  };
}

function persistableInbound(message: InboundMessage): InboundMessage {
  return {
    ...message,
    parts: message.parts.map((part) => {
      if (part.type === "text") return part;
      return {
        type: part.type,
        name: part.name,
        mimeType: part.mimeType,
        sizeBytes: part.sizeBytes,
      };
    }),
  };
}

function persistableOutbound(command: OutboundCommand): unknown {
  if (command.type !== "proactive-media") return command;
  return {
    ...command,
    media: {
      type: command.media.type,
      name: command.media.name,
      mimeType: command.media.mimeType,
      title: command.media.title,
      description: command.media.description,
    },
  };
}
