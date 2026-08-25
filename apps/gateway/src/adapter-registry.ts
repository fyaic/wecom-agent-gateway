import { AcpRuntimeAdapter } from "@fyaic/acp-runtime-adapter";
import { resolve } from "node:path";
import {
  CodexAppServerRuntimeAdapter,
  CodexRuntimeAdapter,
  type RuntimeToolLifecycleEvent,
} from "@fyaic/codex-runtime-adapter";
import { OpenClawRuntimeAdapter } from "@fyaic/openclaw-runtime-adapter";
import { PooledPiRuntimeAdapter } from "@fyaic/pi-runtime-adapter";
import {
  loadRuntimeAdapter,
  parseRuntimeAdapterConfig,
} from "@fyaic/wecom-adapter-sdk";
import type {
  AgentRuntimeAdapter,
  RuntimeTool,
} from "@fyaic/wecom-runtime-contract";

export interface AdapterRegistryOptions {
  env: NodeJS.ProcessEnv;
  tools: RuntimeTool[];
  onToolError?: (error: Error) => void;
  onToolLifecycle?: (event: RuntimeToolLifecycleEvent) => void;
  onStderr?: (adapterId: string, message: string) => void;
}

type AdapterKind = "codex" | "kimi" | "acp" | "openclaw" | "pi" | "external";

/** Selects one Kernel implementation without leaking vendor types into Core. */
export async function createConfiguredAdapter(
  options: AdapterRegistryOptions,
): Promise<AgentRuntimeAdapter> {
  const kind = adapterKind(options.env.GATEWAY_ADAPTER);
  const factories: Record<
    AdapterKind,
    () => AgentRuntimeAdapter | Promise<AgentRuntimeAdapter>
  > = {
    codex: () => createCodexAdapter(options),
    kimi: () => {
      assertNoRuntimeTools(options.tools, "kimi");
      return new AcpRuntimeAdapter({
        id: "kimi",
        executable: options.env.KIMI_EXECUTABLE || "kimi",
        args: ["acp"],
        cwd:
          options.env.KIMI_WORKING_DIRECTORY ||
          options.env.AGENT_WORKING_DIRECTORY ||
          process.cwd(),
        env: safeAgentEnvironment(options.env),
        requestTimeoutMs: positiveInteger(
          options.env.KIMI_REQUEST_TIMEOUT_MS,
          5 * 60_000,
        ),
        onStderr: (message) => options.onStderr?.("kimi", message),
      });
    },
    acp: () => {
      assertNoRuntimeTools(options.tools, "acp");
      return new AcpRuntimeAdapter({
        id: required(options.env, "ACP_ADAPTER_ID"),
        executable: required(options.env, "ACP_EXECUTABLE"),
        args: stringArray(options.env.ACP_ARGS_JSON, "ACP_ARGS_JSON"),
        cwd:
          options.env.ACP_WORKING_DIRECTORY ||
          options.env.AGENT_WORKING_DIRECTORY ||
          process.cwd(),
        env: safeAgentEnvironment(options.env),
        requestTimeoutMs: positiveInteger(
          options.env.ACP_REQUEST_TIMEOUT_MS,
          5 * 60_000,
        ),
        onStderr: (message) =>
          options.onStderr?.(required(options.env, "ACP_ADAPTER_ID"), message),
      });
    },
    openclaw: () => {
      assertNoRuntimeTools(options.tools, "openclaw");
      return new OpenClawRuntimeAdapter({
        url: options.env.OPENCLAW_GATEWAY_URL,
        token: options.env.OPENCLAW_GATEWAY_TOKEN,
        password: options.env.OPENCLAW_GATEWAY_PASSWORD,
        agentId: options.env.OPENCLAW_AGENT_ID || undefined,
        requestTimeoutMs: positiveInteger(
          options.env.OPENCLAW_REQUEST_TIMEOUT_MS,
          30_000,
        ),
        runTimeoutMs: positiveInteger(
          options.env.OPENCLAW_RUN_TIMEOUT_MS,
          5 * 60_000,
        ),
        connectTimeoutMs: positiveInteger(
          options.env.OPENCLAW_CONNECT_TIMEOUT_MS,
          15_000,
        ),
      });
    },
    pi: () => {
      assertNoRuntimeTools(options.tools, "pi");
      return new PooledPiRuntimeAdapter({
        executable: options.env.PI_EXECUTABLE || "pi",
        args: stringArray(options.env.PI_ARGS_JSON, "PI_ARGS_JSON"),
        cwd:
          options.env.PI_WORKING_DIRECTORY ||
          options.env.AGENT_WORKING_DIRECTORY ||
          process.cwd(),
        env: safePiEnvironment(options.env),
        requestTimeoutMs: positiveInteger(
          options.env.PI_REQUEST_TIMEOUT_MS,
          30_000,
        ),
        runTimeoutMs: positiveInteger(
          options.env.PI_RUN_TIMEOUT_MS,
          5 * 60_000,
        ),
        maxWorkers: positiveInteger(options.env.PI_MAX_WORKERS, 2),
        sessionRoots: list(options.env.PI_SESSION_ROOTS),
        onStderr: (message) => options.onStderr?.("pi", message),
      });
    },
    external: () => {
      const moduleSpecifier = required(
        options.env,
        "GATEWAY_EXTERNAL_ADAPTER_MODULE",
      );
      return loadRuntimeAdapter({
        moduleSpecifier,
        baseDirectory:
          options.env.GATEWAY_EXTERNAL_ADAPTER_BASE_DIRECTORY || process.cwd(),
        packageBaseDirectory: resolve(import.meta.dirname, ".."),
        config: parseRuntimeAdapterConfig(
          options.env.GATEWAY_EXTERNAL_ADAPTER_CONFIG_JSON,
        ),
        tools: options.tools,
        onDiagnostic: (_level, message) =>
          options.onStderr?.("external", message),
      });
    },
  };
  return await factories[kind]();
}

/**
 * ACP child processes receive an explicit environment. Bot credentials and
 * unrelated Gateway configuration are excluded even when present upstream.
 */
export function safeAgentEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const names = new Set([
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    ...list(source.ACP_AGENT_ENV_ALLOWLIST),
  ]);
  for (const name of Object.keys(source)) {
    if (name.startsWith("KIMI_") || name.startsWith("MOONSHOT_"))
      names.add(name);
  }
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/** Pi receives only process basics and explicitly named provider credentials. */
export function safePiEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const names = new Set([
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    ...list(source.PI_AGENT_ENV_ALLOWLIST),
  ]);
  const result: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function createCodexAdapter(
  options: AdapterRegistryOptions,
): AgentRuntimeAdapter {
  const env = options.env;
  const kind = env.CODEX_ADAPTER || "app-server";
  if (kind === "sdk") {
    if (options.tools.length > 0) {
      throw new Error(
        "Runtime tools currently require CODEX_ADAPTER=app-server",
      );
    }
    return new CodexRuntimeAdapter({
      workingDirectory:
        env.CODEX_WORKING_DIRECTORY || env.AGENT_WORKING_DIRECTORY,
      model: env.CODEX_MODEL || undefined,
      modelReasoningEffort: reasoningEffort(env.CODEX_REASONING_EFFORT),
    });
  }
  if (kind !== "app-server") throw new Error(`Invalid CODEX_ADAPTER: ${kind}`);
  return new CodexAppServerRuntimeAdapter({
    cwd: env.CODEX_WORKING_DIRECTORY || env.AGENT_WORKING_DIRECTORY,
    executable: env.CODEX_EXECUTABLE || undefined,
    codexHome: env.CODEX_RUNTIME_HOME || undefined,
    model: env.CODEX_MODEL || undefined,
    serviceTier: env.CODEX_SERVICE_TIER || undefined,
    effort: reasoningEffort(env.CODEX_REASONING_EFFORT),
    sandbox: sandboxMode(env.CODEX_SANDBOX),
    approvalPolicy: approvalPolicy(env.CODEX_APPROVAL_POLICY),
    requestTimeoutMs: positiveInteger(env.CODEX_REQUEST_TIMEOUT_MS, 30_000),
    responsesWebsocket: booleanValue(env.CODEX_RESPONSES_WEBSOCKET, false),
    tools: options.tools,
    toolTimeoutMs: positiveInteger(env.RUNTIME_TOOL_TIMEOUT_MS, 60_000),
    approvalWaitTimeoutMs: positiveInteger(
      env.CODEX_APPROVAL_WAIT_TIMEOUT_MS,
      90_000,
    ),
    maxToolOutputBytes: positiveInteger(
      env.RUNTIME_TOOL_MAX_OUTPUT_BYTES,
      256 * 1024,
    ),
    onToolError: options.onToolError,
    onToolLifecycle: options.onToolLifecycle,
    onStderr: (message) => options.onStderr?.("codex", message),
  });
}

function adapterKind(value: string | undefined): AdapterKind {
  const kind = value || "codex";
  if (
    kind === "codex" ||
    kind === "kimi" ||
    kind === "acp" ||
    kind === "openclaw" ||
    kind === "pi" ||
    kind === "external"
  )
    return kind;
  throw new Error(`Invalid GATEWAY_ADAPTER: ${kind}`);
}

function assertNoRuntimeTools(tools: RuntimeTool[], adapter: string): void {
  if (tools.length > 0) {
    throw new Error(
      `Runtime tool catalog is not supported by the ${adapter} adapter; disable WECOM_CLI_TOOLS_ENABLED`,
    );
  }
}

function stringArray(value: string | undefined, name: string): string[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${name} must be a JSON string array`);
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return parsed;
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function reasoningEffort(
  value: string | undefined,
): "minimal" | "low" | "medium" | "high" | "xhigh" | undefined {
  if (!value) return undefined;
  if (["minimal", "low", "medium", "high", "xhigh"].includes(value)) {
    return value as "minimal" | "low" | "medium" | "high" | "xhigh";
  }
  throw new Error(`Invalid CODEX_REASONING_EFFORT: ${value}`);
}

function sandboxMode(
  value: string | undefined,
): "read-only" | "workspace-write" | "danger-full-access" {
  if (!value) return "read-only";
  if (
    value === "read-only" ||
    value === "workspace-write" ||
    value === "danger-full-access"
  ) {
    return value;
  }
  throw new Error(`Invalid CODEX_SANDBOX: ${value}`);
}

function approvalPolicy(
  value: string | undefined,
): "untrusted" | "on-request" | "never" {
  if (!value) return "never";
  if (value === "untrusted" || value === "on-request" || value === "never") {
    return value;
  }
  throw new Error(`Invalid CODEX_APPROVAL_POLICY: ${value}`);
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
