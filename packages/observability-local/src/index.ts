import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  AdapterLifecycleEvent,
  ApprovalLifecycleEvent,
  BackpressureEvent,
  DeliveryLifecycleEvent,
  GatewayLifecycleEvent,
  GatewayOperationalSnapshot,
  InfrastructureErrorEvent,
  InteractionLifecycleEvent,
} from "@fyaic/wecom-channel-core";

type Labels = Readonly<Record<string, string>>;

/** In-memory counters whose labels are restricted to bounded enum-like fields. */
export class GatewayMetrics {
  private readonly counters = new Map<string, number>();

  recordGatewayLifecycle(event: GatewayLifecycleEvent): void {
    this.increment("lifecycle_events_total", {
      phase: event.phase,
      conversation_type: event.conversationType,
    });
    this.incrementBy(
      "lifecycle_duration_ms_sum",
      { phase: event.phase },
      event.elapsedMs,
    );
    this.increment("lifecycle_duration_ms_count", { phase: event.phase });
  }

  recordAdapterLifecycle(event: AdapterLifecycleEvent): void {
    this.increment("adapter_lifecycle_events_total", { phase: event.phase });
  }

  recordDelivery(event: DeliveryLifecycleEvent): void {
    this.increment("delivery_events_total", {
      phase: event.phase,
      command_type: event.commandType,
    });
  }

  recordBackpressure(event: BackpressureEvent): void {
    this.increment("backpressure_rejections_total", {
      reason: event.reason,
      conversation_type: event.conversationType,
    });
  }

  recordApproval(event: ApprovalLifecycleEvent): void {
    this.increment("approval_events_total", {
      phase: event.phase,
      effect: event.effect,
    });
  }

  recordInteraction(event: InteractionLifecycleEvent): void {
    this.increment("interaction_events_total", {
      phase: event.phase,
      kind: event.kind,
      conversation_type: event.conversationType,
    });
    this.incrementBy(
      "interaction_duration_ms_sum",
      { phase: event.phase },
      event.elapsedMs,
    );
    this.increment("interaction_duration_ms_count", { phase: event.phase });
  }

  recordInfrastructureError(event: InfrastructureErrorEvent): void {
    this.increment("infrastructure_errors_total", {
      component: event.component,
      operation: event.operation,
    });
  }

  render(snapshot: GatewayOperationalSnapshot): string {
    const lines = [
      "# HELP wecom_gateway_ready Whether the Gateway can accept and process traffic.",
      "# TYPE wecom_gateway_ready gauge",
      `wecom_gateway_ready ${snapshot.ready ? 1 : 0}`,
      "# HELP wecom_gateway_transport_healthy Whether the WeCom transport is healthy.",
      "# TYPE wecom_gateway_transport_healthy gauge",
      `wecom_gateway_transport_healthy ${snapshot.transportHealthy ? 1 : 0}`,
      "# HELP wecom_gateway_store_healthy Whether the durable store is readable.",
      "# TYPE wecom_gateway_store_healthy gauge",
      `wecom_gateway_store_healthy ${snapshot.storeHealthy ? 1 : 0}`,
      "# HELP wecom_gateway_adapters Runtime Adapter health counts.",
      "# TYPE wecom_gateway_adapters gauge",
      `wecom_gateway_adapters{state="healthy"} ${snapshot.adapters.healthy}`,
      `wecom_gateway_adapters{state="total"} ${snapshot.adapters.total}`,
      "# HELP wecom_gateway_work Current aggregate work gauges.",
      "# TYPE wecom_gateway_work gauge",
      `wecom_gateway_work{state="pending_inbound"} ${snapshot.work.pendingInboundMessages}`,
      `wecom_gateway_work{state="active_runs"} ${snapshot.work.activeRuns}`,
      `wecom_gateway_work{state="pending_approvals"} ${snapshot.work.pendingApprovals}`,
      "# HELP wecom_gateway_outbox_entries Durable outbox entries by state.",
      "# TYPE wecom_gateway_outbox_entries gauge",
      ...Object.entries(snapshot.outbox).map(
        ([state, count]) =>
          `wecom_gateway_outbox_entries{state="${escapeLabel(state)}"} ${count}`,
      ),
    ];
    for (const [key, value] of [...this.counters.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`${key} ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  private increment(name: string, labels: Labels): void {
    this.incrementBy(name, labels, 1);
  }

  private incrementBy(name: string, labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const metric = `wecom_gateway_${name}${renderLabels(labels)}`;
    this.counters.set(metric, (this.counters.get(metric) ?? 0) + value);
  }
}

export interface LocalObservabilityServerOptions {
  host?: string;
  port?: number;
  snapshot(): Promise<GatewayOperationalSnapshot>;
  metrics: GatewayMetrics;
  isLive?: () => boolean;
  snapshotTimeoutMs?: number;
  onError?: (error: Error) => void;
}

/** Loopback-only HTTP endpoints for service managers and local scrapers. */
export class LocalObservabilityServer {
  readonly host: string;
  private readonly configuredPort: number;
  private readonly snapshot: () => Promise<GatewayOperationalSnapshot>;
  private readonly metrics: GatewayMetrics;
  private readonly isLive: () => boolean;
  private readonly snapshotTimeoutMs: number;
  private readonly onError?: (error: Error) => void;
  private server?: Server;

  constructor(options: LocalObservabilityServerOptions) {
    this.host = options.host ?? "127.0.0.1";
    if (!isLoopback(this.host)) {
      throw new Error("Observability server must bind to a loopback address");
    }
    this.configuredPort = port(options.port ?? 9_464);
    this.snapshot = options.snapshot;
    this.metrics = options.metrics;
    this.isLive = options.isLive ?? (() => true);
    this.snapshotTimeoutMs = positiveInteger(
      options.snapshotTimeoutMs,
      2_000,
      "snapshotTimeoutMs",
    );
    this.onError = options.onError;
  }

  get port(): number {
    const address = this.server?.address();
    return typeof address === "object" && address
      ? (address as AddressInfo).port
      : this.configuredPort;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((request, response) => {
      void this.handle(request.method ?? "GET", request.url ?? "/", response);
    });
    server.requestTimeout = 5_000;
    server.headersTimeout = 5_000;
    server.on("clientError", (_error, socket) => socket.destroy());
    await new Promise<void>((resolveStart, rejectStart) => {
      const onError = (error: Error) => rejectStart(error);
      server.once("error", onError);
      server.listen(this.configuredPort, this.host, () => {
        server.off("error", onError);
        resolveStart();
      });
    });
    server.on("error", (error) => this.onError?.(asError(error)));
    this.server = server;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }

  private async handle(
    method: string,
    rawUrl: string,
    response: ServerResponse,
  ): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (method !== "GET" && method !== "HEAD") {
      send(
        response,
        405,
        "text/plain; charset=utf-8",
        "method not allowed\n",
        method,
      );
      return;
    }
    const path = rawUrl.split("?", 1)[0];
    if (path === "/livez") {
      const live = this.isLive();
      send(
        response,
        live ? 200 : 503,
        "application/json; charset=utf-8",
        `${JSON.stringify({ live })}\n`,
        method,
      );
      return;
    }
    if (path !== "/readyz" && path !== "/metrics") {
      send(response, 404, "text/plain; charset=utf-8", "not found\n", method);
      return;
    }
    try {
      const snapshot = await withTimeout(
        this.snapshot(),
        this.snapshotTimeoutMs,
      );
      if (path === "/readyz") {
        send(
          response,
          snapshot.ready ? 200 : 503,
          "application/json; charset=utf-8",
          `${JSON.stringify({ ready: snapshot.ready, state: snapshot.state })}\n`,
          method,
        );
      } else {
        send(
          response,
          200,
          "text/plain; version=0.0.4; charset=utf-8",
          this.metrics.render(snapshot),
          method,
        );
      }
    } catch (error) {
      this.onError?.(asError(error));
      send(
        response,
        503,
        "application/json; charset=utf-8",
        '{"ready":false}\n',
        method,
      );
    }
  }
}

function renderLabels(labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "";
  return `{${entries
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",")}}`;
}

function escapeLabel(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\"');
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  method: string,
): void {
  response.statusCode = status;
  response.setHeader("Content-Type", contentType);
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.end(method === "HEAD" ? undefined : body);
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1";
}

function port(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error("Observability port must be an integer from 0 to 65535");
  }
  return value;
}

function positiveInteger(
  value: number | undefined,
  fallback: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return result;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Operational snapshot timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
