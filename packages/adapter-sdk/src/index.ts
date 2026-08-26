import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  RUNTIME_CONTRACT_VERSION,
  assertRuntimeAdapterCompatible,
  type AgentRuntimeAdapter,
  type RuntimeJsonValue,
  type RuntimeTool,
} from "@fyaic/wecom-runtime-contract";

export {
  RUNTIME_CONTRACT_VERSION,
  type AgentInteractionResumeRequest,
  type AgentMediaOutput,
  type AgentRunEvent,
  type AgentRunRequest,
  type AgentRuntimeAdapter,
  type InboundMessage,
  type MediaType,
  type RuntimeCapability,
  type RuntimeJsonValue,
  type RuntimeTool,
} from "@fyaic/wecom-runtime-contract";

export interface RuntimeAdapterFactoryContext {
  readonly contractVersion: typeof RUNTIME_CONTRACT_VERSION;
  /** Adapter-owned JSON. The Gateway never interprets vendor configuration. */
  readonly config: Readonly<Record<string, RuntimeJsonValue>>;
  /** Optional host tools. An Adapter must declare `tools` before accepting these. */
  readonly tools: readonly RuntimeTool[];
  /** Bounded diagnostics are redacted and emitted by the Gateway host. */
  reportDiagnostic(level: "info" | "warn" | "error", message: string): void;
}

export type RuntimeAdapterFactory = (
  context: RuntimeAdapterFactoryContext,
) => AgentRuntimeAdapter | Promise<AgentRuntimeAdapter>;

/** Type-preserving helper for an external module's default export. */
export function defineRuntimeAdapter(
  factory: RuntimeAdapterFactory,
): RuntimeAdapterFactory {
  return factory;
}

export interface LoadRuntimeAdapterOptions {
  moduleSpecifier: string;
  baseDirectory?: string;
  packageBaseDirectory?: string;
  config?: Readonly<Record<string, RuntimeJsonValue>>;
  tools?: readonly RuntimeTool[];
  onDiagnostic?: (level: "info" | "warn" | "error", message: string) => void;
}

/** Loads an explicitly configured, trusted in-process Adapter module. */
export async function loadRuntimeAdapter(
  options: LoadRuntimeAdapterOptions,
): Promise<AgentRuntimeAdapter> {
  const moduleSpecifier = resolveRuntimeAdapterSpecifier(
    options.moduleSpecifier,
    options.baseDirectory,
    options.packageBaseDirectory,
  );
  const loaded: unknown = await import(moduleSpecifier);
  if (!isObject(loaded)) {
    throw new Error("External Adapter module must export a factory");
  }
  const factory = loaded.default ?? loaded.createAdapter;
  if (typeof factory !== "function") {
    throw new Error(
      "External Adapter module must export default or createAdapter factory",
    );
  }
  const tools = Object.freeze([...(options.tools ?? [])]);
  const adapter = await (factory as RuntimeAdapterFactory)({
    contractVersion: RUNTIME_CONTRACT_VERSION,
    config: Object.freeze({ ...(options.config ?? {}) }),
    tools,
    reportDiagnostic: (level, message) => {
      if (typeof message !== "string" || Buffer.byteLength(message) > 16_384) {
        throw new Error("External Adapter diagnostic must be bounded text");
      }
      options.onDiagnostic?.(level, message);
    },
  });
  assertAdapterShape(adapter);
  assertRuntimeAdapterCompatible(adapter);
  if (tools.length > 0 && !adapter.capabilities.has("tools")) {
    throw new Error(
      `Adapter ${adapter.id} does not accept the configured RuntimeTool catalog`,
    );
  }
  return adapter;
}

export function parseRuntimeAdapterConfig(
  value: string | undefined,
): Readonly<Record<string, RuntimeJsonValue>> {
  if (!value?.trim()) return Object.freeze({});
  if (Buffer.byteLength(value) > 64 * 1024) {
    throw new Error("External Adapter configuration exceeds byte limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GATEWAY_EXTERNAL_ADAPTER_CONFIG_JSON must be valid JSON");
  }
  if (!isObject(parsed) || !isRuntimeJsonValue(parsed, 0)) {
    throw new Error(
      "GATEWAY_EXTERNAL_ADAPTER_CONFIG_JSON must be a JSON object",
    );
  }
  return Object.freeze(parsed);
}

export function resolveRuntimeAdapterSpecifier(
  value: string,
  baseDirectory = process.cwd(),
  packageBaseDirectory = baseDirectory,
): string {
  const specifier = value.trim();
  if (!specifier || specifier.length > 2_048 || /[\r\n\0]/.test(specifier)) {
    throw new Error("Invalid external Adapter module specifier");
  }
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    return pathToFileURL(resolve(baseDirectory, specifier)).href;
  }
  if (
    !/^(?:@[a-z0-9._~-]+\/[a-z0-9._~-]+|[a-z0-9._~-]+)(?:\/[a-z0-9._~-]+)*$/i.test(
      specifier,
    )
  ) {
    throw new Error(
      "External Adapter module must be a package name or local file path",
    );
  }
  const requireFromBase = createRequire(
    pathToFileURL(resolve(packageBaseDirectory, "package.json")),
  );
  return pathToFileURL(requireFromBase.resolve(specifier)).href;
}

function assertAdapterShape(
  value: unknown,
): asserts value is AgentRuntimeAdapter {
  if (!isObject(value))
    throw new Error("External Adapter factory returned no Adapter");
  if (typeof value.id !== "string") {
    throw new Error("External Adapter must provide a stable id");
  }
  const capabilities = value.capabilities;
  if (
    !capabilities ||
    typeof (capabilities as ReadonlySet<unknown>).has !== "function" ||
    typeof (capabilities as ReadonlySet<unknown>)[Symbol.iterator] !==
      "function"
  ) {
    throw new Error("External Adapter capabilities must be a ReadonlySet");
  }
  const knownCapabilities = new Set([
    "streaming",
    "resume",
    "cancel",
    "approval",
    "tools",
    "status-events",
    "multimodal-input",
    "multimodal-output",
    "interaction-resume",
    "interaction-live-resume",
    "reply-actions",
  ]);
  for (const capability of capabilities as ReadonlySet<unknown>) {
    if (typeof capability !== "string" || !knownCapabilities.has(capability)) {
      throw new Error("External Adapter declares an unknown capability");
    }
  }
  if (typeof value.run !== "function" || typeof value.health !== "function") {
    throw new Error("External Adapter must implement run() and health()");
  }
  for (const method of [
    "start",
    "stop",
    "cancel",
    "respondToApproval",
    "resumeInteraction",
  ] as const) {
    if (value[method] !== undefined && typeof value[method] !== "function") {
      throw new Error(`External Adapter ${method} must be a function`);
    }
  }
  const declared = capabilities as ReadonlySet<string>;
  if (
    declared.has("interaction-resume") &&
    typeof value.resumeInteraction !== "function"
  ) {
    throw new Error(
      "External Adapter declares interaction-resume without resumeInteraction()",
    );
  }
  if (
    (declared.has("interaction-live-resume") ||
      declared.has("reply-actions")) &&
    !declared.has("interaction-resume")
  ) {
    throw new Error(
      "External Adapter interaction-live-resume and reply-actions require interaction-resume",
    );
  }
  validateModalitySet(value.inputModalities, "inputModalities");
  validateModalitySet(value.outputModalities, "outputModalities");
  if (
    value.sessionCompatibilityId !== undefined &&
    (typeof value.sessionCompatibilityId !== "string" ||
      !value.sessionCompatibilityId ||
      value.sessionCompatibilityId.length > 256 ||
      /[\r\n\0]/.test(value.sessionCompatibilityId))
  ) {
    throw new Error("External Adapter sessionCompatibilityId is invalid");
  }
}

function validateModalitySet(value: unknown, label: string): void {
  if (value === undefined) return;
  if (
    !value ||
    typeof (value as ReadonlySet<unknown>)[Symbol.iterator] !== "function"
  ) {
    throw new Error(`External Adapter ${label} must be a ReadonlySet`);
  }
  const known = new Set(["image", "audio", "video", "file"]);
  for (const modality of value as ReadonlySet<unknown>) {
    if (typeof modality !== "string" || !known.has(modality)) {
      throw new Error(`External Adapter ${label} contains an unknown modality`);
    }
  }
}

function isRuntimeJsonValue(
  value: unknown,
  depth: number,
): value is RuntimeJsonValue {
  if (depth > 32) return false;
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isRuntimeJsonValue(item, depth + 1));
  }
  if (isObject(value)) {
    return Object.values(value).every((item) =>
      isRuntimeJsonValue(item, depth + 1),
    );
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
