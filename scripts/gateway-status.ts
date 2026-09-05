import { pathToFileURL } from "node:url";

export interface GatewayStatusReport {
  schemaVersion: 1;
  event: "gateway_status";
  status:
    | "healthy"
    | "busy"
    | "degraded"
    | "disabled"
    | "unavailable"
    | "invalid-configuration"
    | "invalid-response";
  findings: string[];
  snapshot?: {
    ready: boolean;
    transportHealthy: boolean;
    storeHealthy: boolean;
    adapters: { healthy: number; total: number };
    work: {
      pendingInbound: number;
      activeRuns: number;
      pendingApprovals: number;
    };
    outbox: {
      pending: number;
      leased: number;
      delivered: number;
      dead: number;
      superseded: number;
    };
  };
}

const fields = {
  ready: "wecom_gateway_ready",
  transportHealthy: "wecom_gateway_transport_healthy",
  storeHealthy: "wecom_gateway_store_healthy",
  healthy: 'wecom_gateway_adapters{state="healthy"}',
  total: 'wecom_gateway_adapters{state="total"}',
  pendingInbound: 'wecom_gateway_work{state="pending_inbound"}',
  activeRuns: 'wecom_gateway_work{state="active_runs"}',
  pendingApprovals: 'wecom_gateway_work{state="pending_approvals"}',
  pending: 'wecom_gateway_outbox_entries{state="pending"}',
  leased: 'wecom_gateway_outbox_entries{state="leased"}',
  delivered: 'wecom_gateway_outbox_entries{state="delivered"}',
  dead: 'wecom_gateway_outbox_entries{state="dead"}',
  superseded: 'wecom_gateway_outbox_entries{state="superseded"}',
} as const;

function report(
  status: GatewayStatusReport["status"],
  findings: string[],
): GatewayStatusReport {
  return { schemaVersion: 1, event: "gateway_status", status, findings };
}

/** Only exact, aggregate fields are allowed into a support report. Never copy labels or text. */
export function parseGatewayMetrics(body: string): GatewayStatusReport {
  const invalid = () => report("invalid-response", ["metrics-invalid"]);
  const samples = new Map<string, number>();
  const allowed = new Set<string>(Object.values(fields));
  for (const line of body.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const [key, value, ...extra] = line.trim().split(/\s+/);
    if (!allowed.has(key)) continue;
    const number = Number(value);
    if (
      extra.length ||
      value === undefined ||
      !Number.isSafeInteger(number) ||
      number < 0 ||
      samples.has(key)
    )
      return invalid();
    samples.set(key, number);
  }
  if (samples.size !== allowed.size) return invalid();
  const read = (field: keyof typeof fields) => samples.get(fields[field])!;
  if (
    ["ready", "transportHealthy", "storeHealthy"].some(
      (key) => read(key as keyof typeof fields) > 1,
    )
  )
    return invalid();
  if (read("healthy") > read("total")) return invalid();
  const componentsReady =
    read("transportHealthy") === 1 &&
    read("storeHealthy") === 1 &&
    read("total") > 0 &&
    read("healthy") === read("total");
  if (read("ready") && !componentsReady) return invalid();
  const findings: string[] = [];
  if (!read("ready")) findings.push("gateway-not-ready");
  if (!read("transportHealthy")) findings.push("transport-unhealthy");
  if (!read("storeHealthy")) findings.push("store-unhealthy");
  if (!read("total") || read("healthy") < read("total"))
    findings.push("adapter-unhealthy");
  if (read("dead")) findings.push("outbox-dead");
  const degraded = findings.length > 0;
  if (read("pending") || read("leased")) findings.push("deliveries-pending");
  if (read("pendingInbound") || read("activeRuns"))
    findings.push("work-active");
  if (read("pendingApprovals")) findings.push("approval-pending");
  return {
    ...report(
      degraded ? "degraded" : findings.length ? "busy" : "healthy",
      findings,
    ),
    snapshot: {
      ready: Boolean(read("ready")),
      transportHealthy: Boolean(read("transportHealthy")),
      storeHealthy: Boolean(read("storeHealthy")),
      adapters: { healthy: read("healthy"), total: read("total") },
      work: {
        pendingInbound: read("pendingInbound"),
        activeRuns: read("activeRuns"),
        pendingApprovals: read("pendingApprovals"),
      },
      outbox: {
        pending: read("pending"),
        leased: read("leased"),
        delivered: read("delivered"),
        dead: read("dead"),
        superseded: read("superseded"),
      },
    },
  };
}

export async function inspectGatewayStatus(
  env: NodeJS.ProcessEnv,
  timeoutMs = 3_000,
): Promise<GatewayStatusReport> {
  const enabled = env.GATEWAY_OBSERVABILITY_ENABLED;
  if (!enabled || enabled === "false")
    return report("disabled", ["observability-disabled"]);
  const host = env.GATEWAY_OBSERVABILITY_HOST || "127.0.0.1";
  const port = Number(env.GATEWAY_OBSERVABILITY_PORT || "9464");
  if (
    enabled !== "true" ||
    !["127.0.0.1", "::1"].includes(host) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  ) {
    return report("invalid-configuration", ["observability-config-invalid"]);
  }
  try {
    const response = await fetch(
      `http://${host === "::1" ? "[::1]" : host}:${port}/metrics`,
      {
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return report("unavailable", ["metrics-unavailable"]);
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 65_536) {
        await reader.cancel();
        return report("invalid-response", ["metrics-too-large"]);
      }
      chunks.push(chunk.value);
    }
    return parseGatewayMetrics(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return report("unavailable", ["metrics-unavailable"]);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = await inspectGatewayStatus(process.env);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = ["healthy", "busy"].includes(result.status) ? 0 : 1;
}
