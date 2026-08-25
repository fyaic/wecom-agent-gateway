import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { RuntimeTool } from "@fyaic/wecom-runtime-contract";
import {
  createWeComContactSearchTool,
  createWeComTodoCreateTool,
  WeComCliTool,
} from "@fyaic/wecom-cli-tool";
import { WeComBotTransport } from "@fyaic/wecom-bot-transport";
import { LocalMediaSpool } from "@fyaic/wecom-media-spool-local";
import {
  AllowlistPolicy,
  StaticRuntimeRouter,
  WeComAgentGateway,
} from "@fyaic/wecom-channel-core";
import { SqliteGatewayStore } from "@fyaic/wecom-storage-sqlite";
import {
  GatewayMetrics,
  LocalObservabilityServer,
} from "@fyaic/wecom-observability-local";
import {
  createScopedProactiveTargets,
  LocalGatewayControlServer,
} from "@fyaic/wecom-local-control";
import { createConfiguredAdapter } from "./adapter-registry.js";
import { redactSecrets } from "./redaction.js";

const botId = required("WECOM_BOT_ID");
const secret = required("WECOM_BOT_SECRET");
const allowedSenders = list("WECOM_ALLOWED_SENDERS");
const allowedConversations = list("WECOM_ALLOWED_CONVERSATIONS");
const allowedDirectSenders = list("WECOM_ALLOWED_DIRECT_SENDERS");
const allowedGroupConversations = list("WECOM_ALLOWED_GROUP_CONVERSATIONS");
if (
  allowedSenders.length === 0 &&
  allowedConversations.length === 0 &&
  allowedDirectSenders.length === 0 &&
  allowedGroupConversations.length === 0
) {
  throw new Error(
    "Configure at least one global or scoped WECOM allowlist; the gateway fails closed",
  );
}
const databasePath = resolve(
  process.env.GATEWAY_DATABASE_PATH ?? "data/gateway.db",
);
mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
const store = new SqliteGatewayStore(databasePath);
const operationalMetrics = new GatewayMetrics();
const adapter = await createConfiguredAdapter({
  env: process.env,
  tools: createRuntimeTools(),
  onToolError: (error) =>
    console.error(
      JSON.stringify({
        event: "runtime_tool_error",
        message: redactSecrets(error.message, [botId, secret]),
      }),
    ),
  onToolLifecycle: (event) =>
    console.log(JSON.stringify({ event: "runtime_tool_lifecycle", ...event })),
  onStderr: (adapterId, message) =>
    console.error(
      JSON.stringify({
        event: "adapter_stderr",
        adapterId,
        message: redactSecrets(message, [botId, secret]),
      }),
    ),
});
const mediaMaxBytes = positiveInteger(
  process.env.WECOM_MEDIA_MAX_BYTES,
  50 * 1024 * 1024,
);
const mediaSpool = new LocalMediaSpool({
  root: resolve(process.env.GATEWAY_MEDIA_SPOOL_ROOT ?? "data/media-spool"),
  sourceRoots: list("WECOM_MEDIA_OUTPUT_ROOTS"),
  maxArtifactBytes: mediaMaxBytes,
  maxTotalBytes: positiveInteger(
    process.env.GATEWAY_MEDIA_SPOOL_MAX_TOTAL_BYTES,
    500 * 1024 * 1024,
  ),
});
const transport = new WeComBotTransport({
  accountId: botId,
  botId,
  secret,
  onError: (error) =>
    console.error("wecom transport error", {
      message: redactSecrets(error.message, [botId, secret]),
    }),
  onStateChange: (state) =>
    console.log(JSON.stringify({ event: "wecom_transport_state", state })),
  onSdkLog: (level, message) => {
    if (level === "debug") return;
    const output = JSON.stringify({
      event: "wecom_sdk",
      level,
      message: redactSecrets(message, [botId, secret]),
    });
    if (level === "error" || level === "warn") console.error(output);
    else console.log(output);
  },
  mediaTempRoot: process.env.WECOM_MEDIA_TEMP_ROOT || undefined,
  mediaMaxBytes,
  mediaRetentionMs: positiveInteger(
    process.env.WECOM_MEDIA_RETENTION_MS,
    24 * 60 * 60 * 1_000,
  ),
  mediaOutputRoots: [mediaSpool.rootPath],
});
const gateway = new WeComAgentGateway({
  transport,
  adapters: [adapter],
  router: new StaticRuntimeRouter(adapter.id),
  store,
  mediaSpool,
  policy: new AllowlistPolicy({
    allowedSenders,
    allowedConversations,
    allowedDirectSenders,
    allowedGroupConversations,
  }),
  onAccessDecision: (event) =>
    console.log(JSON.stringify({ event: "access_decision", ...event })),
  onRuntimeError: (error) =>
    console.error(
      JSON.stringify({
        event: "runtime_error",
        message: redactSecrets(error.message, [botId, secret]),
      }),
    ),
  onLifecycleEvent: (event) => {
    operationalMetrics.recordGatewayLifecycle(event);
    console.log(JSON.stringify({ event: "gateway_lifecycle", ...event }));
  },
  onAdapterLifecycleEvent: (event) => {
    operationalMetrics.recordAdapterLifecycle(event);
    console.log(JSON.stringify({ event: "adapter_lifecycle", ...event }));
  },
  onDeliveryLifecycleEvent: (event) => {
    operationalMetrics.recordDelivery(event);
    console.log(JSON.stringify({ event: "delivery_lifecycle", ...event }));
  },
  onBackpressureEvent: (event) => {
    operationalMetrics.recordBackpressure(event);
    console.warn(JSON.stringify({ event: "gateway_backpressure", ...event }));
  },
  onApprovalLifecycleEvent: (event) => {
    operationalMetrics.recordApproval(event);
    console.log(JSON.stringify({ event: "approval_lifecycle", ...event }));
  },
  onInfrastructureError: (event) => {
    operationalMetrics.recordInfrastructureError(event);
    console.error(
      JSON.stringify({
        event: "infrastructure_error",
        component: event.component,
        componentId: event.componentId,
        operation: event.operation,
        message: redactSecrets(event.error.message, [botId, secret]),
      }),
    );
  },
  outboxPollIntervalMs: positiveInteger(
    process.env.GATEWAY_OUTBOX_POLL_INTERVAL_MS,
    1_000,
  ),
  outboxLeaseMs: positiveInteger(process.env.GATEWAY_OUTBOX_LEASE_MS, 30_000),
  outboxMaxAttempts: positiveInteger(
    process.env.GATEWAY_OUTBOX_MAX_ATTEMPTS,
    5,
  ),
  outboxRetryBaseMs: positiveInteger(
    process.env.GATEWAY_OUTBOX_RETRY_BASE_MS,
    1_000,
  ),
  outboxRetryMaxMs: positiveInteger(
    process.env.GATEWAY_OUTBOX_RETRY_MAX_MS,
    30_000,
  ),
  outboxBatchSize: positiveInteger(process.env.GATEWAY_OUTBOX_BATCH_SIZE, 10),
  maxPendingInboundMessages: positiveInteger(
    process.env.GATEWAY_MAX_PENDING_INBOUND_MESSAGES,
    100,
  ),
  maxPendingInboundPerConversation: positiveInteger(
    process.env.GATEWAY_MAX_PENDING_INBOUND_PER_CONVERSATION,
    10,
  ),
  maxConcurrentRuns: positiveInteger(
    process.env.GATEWAY_MAX_CONCURRENT_RUNS,
    8,
  ),
  approvalTimeoutMs: positiveInteger(
    process.env.GATEWAY_APPROVAL_TIMEOUT_MS,
    5 * 60_000,
  ),
  maxProactiveTextBytes: positiveInteger(
    process.env.GATEWAY_PROACTIVE_MAX_TEXT_BYTES,
    20_000,
  ),
});

const controlEnabled = booleanValue(process.env.GATEWAY_CONTROL_ENABLED, false);
const proactiveTargets = controlEnabled
  ? createScopedProactiveTargets({
      accountId: botId,
      allowedDirectSenders,
      allowedGroupConversations,
      aliasesJson: process.env.GATEWAY_PROACTIVE_TARGETS_JSON,
    })
  : [];
const controlServer = controlEnabled
  ? new LocalGatewayControlServer({
      socketPath: resolve(
        process.env.GATEWAY_CONTROL_SOCKET ?? "data/gateway-control.sock",
      ),
      sender: gateway,
      targets: proactiveTargets,
      maxRequestBytes: positiveInteger(
        process.env.GATEWAY_CONTROL_MAX_REQUEST_BYTES,
        64 * 1024,
      ),
      requestTimeoutMs: positiveInteger(
        process.env.GATEWAY_CONTROL_REQUEST_TIMEOUT_MS,
        5_000,
      ),
      onError: (error) =>
        console.error(
          JSON.stringify({
            event: "gateway_control_error",
            message: redactSecrets(error.message, [botId, secret]),
          }),
        ),
    })
  : undefined;

let shuttingDown = false;
const observabilityEnabled = booleanValue(
  process.env.GATEWAY_OBSERVABILITY_ENABLED,
  false,
);
const observabilityServer = observabilityEnabled
  ? new LocalObservabilityServer({
      host: process.env.GATEWAY_OBSERVABILITY_HOST || "127.0.0.1",
      port: positiveInteger(process.env.GATEWAY_OBSERVABILITY_PORT, 9_464),
      snapshotTimeoutMs: positiveInteger(
        process.env.GATEWAY_OBSERVABILITY_SNAPSHOT_TIMEOUT_MS,
        2_000,
      ),
      snapshot: () => gateway.operationalSnapshot(),
      metrics: operationalMetrics,
      isLive: () => !shuttingDown,
      onError: (error) =>
        console.error(
          JSON.stringify({
            event: "gateway_observability_error",
            message: redactSecrets(error.message, [botId, secret]),
          }),
        ),
    })
  : undefined;

const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  await controlServer?.stop();
  await gateway.stop();
  await observabilityServer?.stop();
  store.close();
  process.exit(0);
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
let gatewayStarted = false;
try {
  await observabilityServer?.start();
  await gateway.start();
  gatewayStarted = true;
  await controlServer?.start();
} catch (error) {
  await controlServer?.stop();
  if (gatewayStarted) await gateway.stop();
  await observabilityServer?.stop();
  store.close();
  throw error;
}
console.log(
  JSON.stringify({
    event: "gateway_started",
    adapterId: adapter.id,
    localControl: controlEnabled,
    proactiveTargetCount: proactiveTargets.length,
    observability: observabilityEnabled,
    observabilityPort: observabilityServer?.port,
  }),
);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function createRuntimeTools(): RuntimeTool[] {
  if (!booleanValue(process.env.WECOM_CLI_TOOLS_ENABLED, false)) return [];
  const cli = new WeComCliTool({
    executable: process.env.WECOM_CLI_EXECUTABLE || undefined,
    configDirectory: required("WECOM_CLI_CONFIG_DIR"),
    timeoutMs: positiveInteger(process.env.WECOM_CLI_TIMEOUT_MS, 60_000),
    maxOutputBytes: positiveInteger(
      process.env.WECOM_CLI_MAX_OUTPUT_BYTES,
      256 * 1024,
    ),
  });
  return [
    createWeComContactSearchTool(cli),
    ...(booleanValue(process.env.WECOM_CLI_WRITE_TOOLS_ENABLED, false)
      ? [createWeComTodoCreateTool(cli)]
      : []),
  ];
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

function booleanValue(value: string | undefined, fallback: boolean): boolean {
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`Expected true or false, received: ${value}`);
}
