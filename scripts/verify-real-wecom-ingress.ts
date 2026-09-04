import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  InboundMessage,
  OutboundCommand,
} from "@fyaic/wecom-runtime-contract";

export type RealIngressKind = "quote-text" | "quote-media" | "native-video";

export interface RealIngressCandidate {
  message: InboundMessage;
  deliveries: Array<{
    status: string;
    command: OutboundCommand;
  }>;
  acceptedReceipts: number;
  deliveryErrors: number;
  adapterSessionPresent: boolean;
}

export interface RealIngressEvidence {
  schemaVersion: 1;
  kind: RealIngressKind;
  conversationType: "direct" | "group";
  passed: boolean;
  matchedMessages: number;
  checks: {
    exactlyOneInbound: boolean;
    expectedWireShape: boolean;
    expectedQuoteShape: boolean;
    sensitiveMediaFieldsAbsentAtRest: boolean;
    adapterBoundarySatisfied: boolean;
    finalDeliveryAccepted: boolean;
    noMessageDeliveryBacklog: boolean;
    noMessageDeliveryError: boolean;
    mediaSpoolEmpty: boolean;
  };
}

export function evaluateRealIngress(options: {
  kind: RealIngressKind;
  conversationType: "direct" | "group";
  candidates: RealIngressCandidate[];
  expectedQuoteText?: string;
  expectedQuoteMedia?: "image" | "audio" | "video" | "file";
  mediaSpoolEmpty: boolean;
}): RealIngressEvidence {
  const exactlyOneInbound = options.candidates.length === 1;
  const candidate = exactlyOneInbound ? options.candidates[0] : undefined;
  const message = candidate?.message;
  const quoteParts = message?.quote?.parts ?? [];
  const expectedWireShape =
    message?.conversationType === options.conversationType &&
    (options.kind !== "native-video" ||
      (message.metadata?.msgtype === "video" &&
        message.parts.some((part) => part.type === "video")));
  const expectedQuoteShape =
    options.kind === "native-video"
      ? message?.quote === undefined
      : options.kind === "quote-text"
        ? quoteParts.some(
            (part) =>
              part.type === "text" &&
              (options.expectedQuoteText === undefined ||
                part.text.includes(options.expectedQuoteText)),
          )
        : quoteParts.some((part) => part.type === options.expectedQuoteMedia);
  const sensitiveMediaFieldsAbsentAtRest = [
    ...(message?.parts ?? []),
    ...quoteParts,
  ]
    .filter((part) => part.type !== "text")
    .every(
      (part) => !("url" in part) && !("aesKey" in part) && !("path" in part),
    );
  const finalDeliveryAccepted =
    candidate?.deliveries.some(
      ({ status, command }) =>
        status === "delivered" && command.type === "reply" && command.final,
    ) === true && (candidate?.acceptedReceipts ?? 0) > 0;
  const noMessageDeliveryBacklog =
    candidate?.deliveries.every(({ status }) =>
      ["delivered", "superseded"].includes(status),
    ) === true;
  const noMessageDeliveryError = (candidate?.deliveryErrors ?? 0) === 0;
  const finalTexts =
    candidate?.deliveries.flatMap(({ command }) =>
      command.type === "reply" && command.final ? [command.text] : [],
    ) ?? [];
  const adapterBoundarySatisfied =
    options.kind === "native-video"
      ? finalTexts.some((text) => text.includes("当前 Agent 不支持视频输入"))
      : candidate?.adapterSessionPresent === true &&
        finalTexts.length === 1 &&
        !finalTexts[0]?.includes("Agent 处理失败，请稍后重试");

  const checks = {
    exactlyOneInbound,
    expectedWireShape: expectedWireShape === true,
    expectedQuoteShape: expectedQuoteShape === true,
    sensitiveMediaFieldsAbsentAtRest,
    adapterBoundarySatisfied,
    finalDeliveryAccepted,
    noMessageDeliveryBacklog,
    noMessageDeliveryError,
    mediaSpoolEmpty: options.mediaSpoolEmpty,
  };
  return {
    schemaVersion: 1,
    kind: options.kind,
    conversationType: options.conversationType,
    passed: Object.values(checks).every(Boolean),
    matchedMessages: options.candidates.length,
    checks,
  };
}

function run(): void {
  const args = parseArgs(process.argv.slice(2));
  const databasePath = resolve(
    args.database ?? process.env.GATEWAY_DATABASE_PATH ?? "data/gateway.db",
  );
  if (!existsSync(databasePath)) {
    throw new Error("Gateway database does not exist; refusing to create it");
  }
  const after = args.after;
  if (!after || !Number.isFinite(Date.parse(after))) {
    throw new Error("--after=<ISO timestamp> is required");
  }
  if (args.kind !== "native-video" && !args.marker) {
    throw new Error("--marker=<unique current-message text> is required");
  }
  if (args.kind === "quote-text" && !args.expectedQuoteText) {
    throw new Error("--expected-quote-text=<text> is required");
  }
  if (args.kind === "quote-media" && !args.expectedQuoteMedia) {
    throw new Error(
      "--expected-quote-media=image|audio|video|file is required",
    );
  }
  const adapter = args.adapter ?? process.env.GATEWAY_ADAPTER;
  if (!adapter) throw new Error("--adapter=<id> is required");

  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT message_id, payload_json
         FROM inbound_messages
         WHERE received_at >= ?
         ORDER BY received_at ASC
         LIMIT 1000`,
      )
      .all(after) as Array<{ message_id: string; payload_json: string }>;
    const candidates = rows
      .map((row) => ({
        messageId: row.message_id,
        message: JSON.parse(row.payload_json) as InboundMessage,
      }))
      .filter(({ message }) =>
        matchesInbound(message, {
          kind: args.kind,
          conversationType: args.conversationType,
          marker: args.marker,
        }),
      )
      .map(({ messageId, message }) => {
        const deliveries = database
          .prepare(
            `SELECT status, command_json
             FROM delivery_outbox
             WHERE message_id = ?`,
          )
          .all(messageId) as Array<{ status: string; command_json: string }>;
        const journal = database
          .prepare(
            `SELECT receipt_json, error
             FROM delivery_journal
             WHERE message_id = ?`,
          )
          .all(messageId) as Array<{
          receipt_json: string | null;
          error: string | null;
        }>;
        const session = database
          .prepare(
            `SELECT 1 AS present
             FROM runtime_sessions
             WHERE account_id = ? AND conversation_id = ? AND adapter_id = ?`,
          )
          .get(message.accountId, message.conversationId, adapter) as
          { present: number } | undefined;
        return {
          message,
          deliveries: deliveries.map((delivery) => ({
            status: delivery.status,
            command: JSON.parse(delivery.command_json) as OutboundCommand,
          })),
          acceptedReceipts: journal.filter(
            (entry) => entry.receipt_json !== null && entry.error === null,
          ).length,
          deliveryErrors: journal.filter((entry) => entry.error !== null)
            .length,
          adapterSessionPresent: session?.present === 1,
        } satisfies RealIngressCandidate;
      });
    const spoolRoot = resolve(
      args.mediaSpool ??
        process.env.GATEWAY_MEDIA_SPOOL_ROOT ??
        "data/media-spool",
    );
    const evidence = evaluateRealIngress({
      kind: args.kind,
      conversationType: args.conversationType,
      candidates,
      expectedQuoteText: args.expectedQuoteText,
      expectedQuoteMedia: args.expectedQuoteMedia,
      mediaSpoolEmpty: isDirectoryEmpty(spoolRoot),
    });
    console.log(
      JSON.stringify({ event: "real_wecom_ingress_evidence", ...evidence }),
    );
    if (!evidence.passed) process.exitCode = 1;
  } finally {
    database.close();
  }
}

function isDirectoryEmpty(path: string): boolean {
  if (!existsSync(path)) return true;
  return !readdirSync(path, { recursive: true, withFileTypes: true }).some(
    (entry) => !entry.isDirectory(),
  );
}

function matchesInbound(
  message: InboundMessage,
  options: {
    kind: RealIngressKind;
    conversationType: "direct" | "group";
    marker?: string;
  },
): boolean {
  if (message.conversationType !== options.conversationType) return false;
  if (options.kind === "native-video") {
    return (
      message.metadata?.msgtype === "video" &&
      message.parts.some((part) => part.type === "video")
    );
  }
  return message.parts.some(
    (part) =>
      part.type === "text" &&
      options.marker !== undefined &&
      part.text.includes(options.marker),
  );
}

function parseArgs(argv: string[]): {
  kind: RealIngressKind;
  conversationType: "direct" | "group";
  after?: string;
  marker?: string;
  expectedQuoteText?: string;
  expectedQuoteMedia?: "image" | "audio" | "video" | "file";
  adapter?: string;
  database?: string;
  mediaSpool?: string;
} {
  const values = Object.fromEntries(
    argv.map((argument) => {
      const separator = argument.indexOf("=");
      if (!argument.startsWith("--") || separator < 3) {
        throw new Error("Arguments must use --name=value form");
      }
      return [argument.slice(2, separator), argument.slice(separator + 1)];
    }),
  );
  if (
    !["quote-text", "quote-media", "native-video"].includes(values.kind ?? "")
  ) {
    throw new Error("--kind=quote-text|quote-media|native-video is required");
  }
  if (!["direct", "group"].includes(values.conversation ?? "")) {
    throw new Error("--conversation=direct|group is required");
  }
  if (
    values["expected-quote-media"] &&
    !["image", "audio", "video", "file"].includes(
      values["expected-quote-media"],
    )
  ) {
    throw new Error("Invalid --expected-quote-media value");
  }
  return {
    kind: values.kind as RealIngressKind,
    conversationType: values.conversation as "direct" | "group",
    after: values.after,
    marker: values.marker,
    expectedQuoteText: values["expected-quote-text"],
    expectedQuoteMedia: values["expected-quote-media"] as
      "image" | "audio" | "video" | "file" | undefined,
    adapter: values.adapter,
    database: values.database,
    mediaSpool: values["media-spool"],
  };
}

if (process.argv[1]?.endsWith("verify-real-wecom-ingress.ts")) run();
