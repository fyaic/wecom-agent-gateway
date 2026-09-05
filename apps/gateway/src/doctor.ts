import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, resolve } from "node:path";
import { createScopedProactiveTargets } from "@fyaic/wecom-local-control";
import {
  parseRuntimeAdapterConfig,
  resolveRuntimeAdapterSpecifier,
} from "@fyaic/wecom-adapter-sdk";
import { createConfiguredAdapter } from "./adapter-registry.js";

export type DoctorCheckStatus = "ok" | "warning" | "error";

export interface DoctorCheck {
  name: string;
  status: DoctorCheckStatus;
  detail: string;
}

export async function diagnoseGatewayEnvironment(
  env: NodeJS.ProcessEnv,
  options: { live?: boolean; cwd?: string } = {},
): Promise<DoctorCheck[]> {
  const cwd = options.cwd ?? process.cwd();
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push(
    check(
      "node-version",
      nodeMajor >= 22 ? "ok" : "error",
      nodeMajor >= 22
        ? "Node.js runtime is supported"
        : "Node.js 22+ is required",
    ),
  );
  checks.push(
    presence("wecom-bot-credentials", env.WECOM_BOT_ID && env.WECOM_BOT_SECRET),
  );
  checks.push(
    check(
      "wecom-allowlist",
      hasAllowlist(env) ? "ok" : "error",
      hasAllowlist(env)
        ? "At least one inbound allowlist is configured"
        : "Configure at least one inbound allowlist",
    ),
  );

  const envMode = await fileMode(resolve(cwd, ".env"));
  if (envMode !== undefined) {
    checks.push(
      check(
        "env-file-permissions",
        (envMode & 0o077) === 0 ? "ok" : "error",
        (envMode & 0o077) === 0
          ? ".env is private to its owner"
          : ".env must not be accessible by group or other users",
      ),
    );
  }

  for (const [name, path] of [
    [
      "database-parent",
      dirname(resolve(cwd, env.GATEWAY_DATABASE_PATH ?? "data/gateway.db")),
    ],
    [
      "media-spool-parent",
      dirname(resolve(cwd, env.GATEWAY_MEDIA_SPOOL_ROOT ?? "data/media-spool")),
    ],
  ] as const) {
    checks.push(await writableAncestorCheck(name, path));
  }

  const adapter = env.GATEWAY_ADAPTER || "codex";
  checks.push(
    check(
      "adapter-selection",
      ["codex", "kimi", "acp", "openclaw", "pi", "external"].includes(adapter)
        ? "ok"
        : "error",
      ["codex", "kimi", "acp", "openclaw", "pi", "external"].includes(adapter)
        ? `Kernel adapter selected: ${adapter}`
        : "GATEWAY_ADAPTER is invalid",
    ),
  );
  checks.push(...(await adapterChecks(adapter, env)));

  if (env.GATEWAY_OBSERVABILITY_ENABLED === "true") {
    const host = env.GATEWAY_OBSERVABILITY_HOST || "127.0.0.1";
    const configuredPort = Number(env.GATEWAY_OBSERVABILITY_PORT || "9464");
    checks.push(
      check(
        "observability-loopback",
        host === "127.0.0.1" || host === "::1" ? "ok" : "error",
        host === "127.0.0.1" || host === "::1"
          ? "Operational endpoints are restricted to loopback"
          : "Operational endpoints must bind to 127.0.0.1 or ::1",
      ),
      check(
        "observability-port",
        Number.isInteger(configuredPort) &&
          configuredPort > 0 &&
          configuredPort <= 65_535
          ? "ok"
          : "error",
        Number.isInteger(configuredPort) &&
          configuredPort > 0 &&
          configuredPort <= 65_535
          ? "Operational endpoint port is valid"
          : "GATEWAY_OBSERVABILITY_PORT must be from 1 to 65535",
      ),
    );
  } else if (
    env.GATEWAY_OBSERVABILITY_ENABLED &&
    env.GATEWAY_OBSERVABILITY_ENABLED !== "false"
  ) {
    checks.push(
      check(
        "observability-enabled",
        "error",
        "GATEWAY_OBSERVABILITY_ENABLED must be true or false",
      ),
    );
  }

  if (env.GATEWAY_CONTROL_ENABLED === "true") {
    checks.push(
      await writableAncestorCheck(
        "local-control-parent",
        dirname(
          resolve(
            cwd,
            env.GATEWAY_CONTROL_SOCKET ?? "data/gateway-control.sock",
          ),
        ),
      ),
    );
    try {
      const targets = createScopedProactiveTargets({
        accountId: env.WECOM_BOT_ID ?? "",
        allowedDirectSenders: list(env.WECOM_ALLOWED_DIRECT_SENDERS),
        allowedGroupConversations: list(env.WECOM_ALLOWED_GROUP_CONVERSATIONS),
        aliasesJson: env.GATEWAY_PROACTIVE_TARGETS_JSON,
      });
      checks.push(
        check(
          "local-control-targets",
          targets.length > 0 ? "ok" : "error",
          targets.length > 0
            ? `${targets.length} scoped proactive target aliases are configured`
            : "Local control requires a scoped proactive target alias",
        ),
      );
    } catch {
      checks.push(
        check(
          "local-control-targets",
          "error",
          "Local control target aliases are invalid or outside scoped allowlists",
        ),
      );
    }
  } else if (
    env.GATEWAY_CONTROL_ENABLED &&
    env.GATEWAY_CONTROL_ENABLED !== "false"
  ) {
    checks.push(
      check(
        "local-control-enabled",
        "error",
        "GATEWAY_CONTROL_ENABLED must be true or false",
      ),
    );
  }

  if (
    env.WECOM_CLI_TOOLS_ENABLED === "true" &&
    adapter !== "codex" &&
    adapter !== "external"
  ) {
    checks.push(
      check(
        "runtime-tools",
        "error",
        "wecom-cli runtime tools currently require the Codex app-server adapter",
      ),
    );
  }

  if (options.live && !checks.some((item) => item.status === "error")) {
    let runtime;
    try {
      runtime = await createConfiguredAdapter({ env, tools: [] });
      await runtime.start?.();
      const health = await runtime.health();
      checks.push(
        check(
          "adapter-live-health",
          health.ok ? "ok" : "error",
          health.ok
            ? "Configured adapter is reachable"
            : "Configured adapter is unhealthy; inspect its local configuration",
        ),
      );
    } catch {
      checks.push(
        check(
          "adapter-live-health",
          "error",
          "Adapter probe failed; inspect its local configuration and authentication",
        ),
      );
    } finally {
      await runtime?.stop?.().catch(() => undefined);
    }
  }
  return checks;
}

async function adapterChecks(
  adapter: string,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck[]> {
  if (adapter === "codex") {
    if ((env.CODEX_ADAPTER || "app-server") === "sdk") return [];
    return [
      await executableCheck(
        "codex-executable",
        env.CODEX_EXECUTABLE || "codex",
        env,
      ),
    ];
  }
  if (adapter === "kimi") {
    return [
      await executableCheck(
        "kimi-executable",
        env.KIMI_EXECUTABLE || "kimi",
        env,
      ),
    ];
  }
  if (adapter === "acp") {
    return [
      presence("acp-adapter-id", env.ACP_ADAPTER_ID),
      ...(env.ACP_EXECUTABLE
        ? [await executableCheck("acp-executable", env.ACP_EXECUTABLE, env)]
        : [presence("acp-executable", undefined)]),
    ];
  }
  if (adapter === "openclaw") {
    const authenticated = Boolean(
      env.OPENCLAW_GATEWAY_TOKEN || env.OPENCLAW_GATEWAY_PASSWORD,
    );
    const url = env.OPENCLAW_GATEWAY_URL || "ws://127.0.0.1:18789";
    let local = false;
    try {
      local = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(
        new URL(url).hostname,
      );
    } catch {
      local = false;
    }
    return [
      check(
        "openclaw-gateway-url",
        local ? "ok" : "error",
        local
          ? "OpenClaw Gateway uses the supported loopback boundary"
          : "OPENCLAW_GATEWAY_URL must be a valid loopback WebSocket URL",
      ),
      presence("openclaw-gateway-auth", authenticated),
    ];
  }
  if (adapter === "pi") {
    return [
      await executableCheck("pi-executable", env.PI_EXECUTABLE || "pi", env),
    ];
  }
  if (adapter === "external") {
    const moduleSpecifier = env.GATEWAY_EXTERNAL_ADAPTER_MODULE;
    if (!moduleSpecifier) {
      return [presence("external-adapter-module", undefined)];
    }
    try {
      resolveRuntimeAdapterSpecifier(
        moduleSpecifier,
        env.GATEWAY_EXTERNAL_ADAPTER_BASE_DIRECTORY || process.cwd(),
        resolve(import.meta.dirname, ".."),
      );
      parseRuntimeAdapterConfig(env.GATEWAY_EXTERNAL_ADAPTER_CONFIG_JSON);
      return [
        check(
          "external-adapter-config",
          "ok",
          "External Adapter module and bounded JSON configuration are valid",
        ),
      ];
    } catch {
      return [
        check(
          "external-adapter-config",
          "error",
          "External Adapter module or JSON configuration is invalid",
        ),
      ];
    }
  }
  return [];
}

async function executableCheck(
  name: string,
  executable: string,
  env: NodeJS.ProcessEnv,
): Promise<DoctorCheck> {
  const candidates = isAbsolute(executable)
    ? [executable]
    : (env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => resolve(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return check(name, "ok", "Executable is available");
    } catch {
      // Continue without exposing local search paths in diagnostic output.
    }
  }
  return check(name, "error", "Configured executable is not available");
}

async function writableAncestorCheck(
  name: string,
  target: string,
): Promise<DoctorCheck> {
  let candidate = target;
  while (true) {
    try {
      await access(candidate, constants.W_OK);
      return check(name, "ok", "Storage parent is writable");
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return check(name, "error", "No writable storage ancestor is available");
}

async function fileMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
}

function hasAllowlist(env: NodeJS.ProcessEnv): boolean {
  return [
    env.WECOM_ALLOWED_SENDERS,
    env.WECOM_ALLOWED_CONVERSATIONS,
    env.WECOM_ALLOWED_DIRECT_SENDERS,
    env.WECOM_ALLOWED_GROUP_CONVERSATIONS,
  ].some((value) => Boolean(value?.trim()));
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function presence(name: string, value: unknown): DoctorCheck {
  return check(
    name,
    value ? "ok" : "error",
    value ? "Required value is configured" : "Required value is missing",
  );
}

function check(
  name: string,
  status: DoctorCheckStatus,
  detail: string,
): DoctorCheck {
  return { name, status, detail };
}
