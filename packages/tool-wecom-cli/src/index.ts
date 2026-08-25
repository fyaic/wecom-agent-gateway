import { execFile } from "node:child_process";
import type {
  RuntimeJsonValue,
  RuntimeTool,
} from "@fyaic/wecom-runtime-contract";

interface ProcessResult {
  stdout: string;
  stderr: string;
}

type ProcessRunner = (
  executable: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
) => Promise<ProcessResult>;

export interface WeComCliToolOptions {
  executable?: string;
  configDirectory: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  processRunner?: ProcessRunner;
  baseEnvironment?: NodeJS.ProcessEnv;
}

export class WeComCliTool {
  constructor(private readonly options: WeComCliToolOptions) {}

  async execute(
    args: readonly string[],
  ): Promise<{ stdout: string; stderr: string }> {
    if (args.length === 0)
      throw new Error("wecom-cli requires at least one argument");
    if (args.some((arg) => arg.includes("\0")))
      throw new Error("wecom-cli arguments must not contain NUL bytes");
    const runner = this.options.processRunner ?? runProcess;
    return runner(this.options.executable ?? "wecom-cli", args, {
      env: safeCliEnvironment(
        this.options.baseEnvironment ?? process.env,
        this.options.configDirectory,
      ),
      timeoutMs: this.options.timeoutMs ?? 60_000,
      maxOutputBytes: this.options.maxOutputBytes ?? 2 * 1024 * 1024,
    });
  }
}

/** First production-safe slice: an exact, read-only command, not arbitrary argv. */
export function createWeComContactSearchTool(cli: WeComCliTool): RuntimeTool {
  return {
    name: "wecom_contact_search",
    description:
      "按姓名、拼音、英文名或别名搜索当前已授权企业微信通讯录成员。结果中的内部 ID 只供后续工具内部使用，不得展示给最终用户。",
    inputSchema: {
      type: "object",
      properties: {
        keywords: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          items: {
            type: "string",
            minLength: 1,
            maxLength: 128,
          },
          description: "姓名、拼音、英文名或别名列表，多个关键词为 OR 关系。",
        },
        search_mode: {
          type: "string",
          enum: ["list"],
          description: "只有需要完整命中名单时才传 list。",
        },
      },
      required: ["keywords"],
      additionalProperties: false,
    },
    effect: "read-only",
    approval: "never",
    async execute(input) {
      const payload = contactSearchPayload(input);
      const result = await cli.execute([
        "contact",
        "users",
        "search",
        "--json",
        JSON.stringify(payload),
      ]);
      return {
        success: true,
        content: [{ type: "text", text: result.stdout }],
      };
    },
  };
}

/** First approval-gated write slice: create one todo for the authorized user. */
export function createWeComTodoCreateTool(cli: WeComCliTool): RuntimeTool {
  return {
    name: "wecom_todo_create",
    description:
      "在当前授权人的企业微信待办中创建一条待办。只在用户明确要求创建待办时调用。",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          minLength: 1,
          maxLength: 256,
          description: "待办短标题。",
        },
        description: {
          type: "string",
          minLength: 1,
          maxLength: 4096,
          description: "标题之外确有必要的补充说明，不要复述标题。",
        },
        deadline: {
          type: "object",
          properties: {
            type: { type: "string", enum: ["date", "datetime"] },
            value: { type: "string" },
          },
          required: ["type", "value"],
          additionalProperties: false,
        },
        remind_at_deadline: {
          type: "boolean",
          description:
            "仅在用户明确要求于具体截止时刻提醒且 deadline.type=datetime 时传 true。",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    effect: "write",
    approval: "required",
    approvalSummary(input) {
      const payload = todoCreatePayload(input);
      const deadline = payload.items[0]!.deadline;
      return deadline
        ? `创建待办「${payload.items[0]!.title}」，截止时间 ${deadline.value}`
        : `创建待办「${payload.items[0]!.title}」`;
    },
    async execute(input) {
      const payload = todoCreatePayload(input);
      const result = await cli.execute([
        "todo",
        "create",
        "--json",
        JSON.stringify(payload),
      ]);
      return todoCreateResult(result.stdout, payload);
    },
  };
}

interface TodoCreatePayload {
  items: Array<{
    title: string;
    description?: string;
    deadline?: { type: "date" | "datetime"; value: string };
    remind_at_deadline?: boolean;
  }>;
}

function todoCreatePayload(input: RuntimeJsonValue): TodoCreatePayload {
  if (!isRecord(input)) throw new Error("todo create input must be an object");
  const allowed = new Set([
    "title",
    "description",
    "deadline",
    "remind_at_deadline",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("todo create input contains unsupported fields");
  }
  const title = boundedSingleLine(input.title, "todo title", 256);
  const description =
    input.description === undefined
      ? undefined
      : boundedText(input.description, "todo description", 4096);
  const deadline = todoDeadline(input.deadline);
  const remind = input.remind_at_deadline;
  if (remind !== undefined && typeof remind !== "boolean") {
    throw new Error("todo remind_at_deadline must be a boolean");
  }
  if (remind !== undefined && !deadline) {
    throw new Error("todo remind_at_deadline requires a deadline");
  }
  if (remind === true && deadline?.type !== "datetime") {
    throw new Error("todo deadline reminder requires a datetime deadline");
  }
  return {
    items: [
      {
        title,
        ...(description ? { description } : {}),
        ...(deadline ? { deadline } : {}),
        ...(remind !== undefined ? { remind_at_deadline: remind } : {}),
      },
    ],
  };
}

function todoDeadline(
  input: RuntimeJsonValue | undefined,
): { type: "date" | "datetime"; value: string } | undefined {
  if (input === undefined) return undefined;
  if (!isRecord(input)) throw new Error("todo deadline must be an object");
  if (
    Object.keys(input).some((key) => key !== "type" && key !== "value") ||
    (input.type !== "date" && input.type !== "datetime") ||
    typeof input.value !== "string"
  ) {
    throw new Error("todo deadline is invalid");
  }
  if (!validDeadlineValue(input.type, input.value)) {
    throw new Error("todo deadline value is invalid");
  }
  return { type: input.type, value: input.value };
}

function validDeadlineValue(type: "date" | "datetime", value: string): boolean {
  const match =
    type === "date"
      ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
      : /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const normalized = new Date(Date.UTC(year, month - 1, day));
  if (
    normalized.getUTCFullYear() !== year ||
    normalized.getUTCMonth() !== month - 1 ||
    normalized.getUTCDate() !== day
  ) {
    return false;
  }
  if (type === "date") return true;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  return hour <= 23 && minute <= 59 && second <= 59;
}

function todoCreateResult(
  stdout: string,
  payload: TodoCreatePayload,
): { success: boolean; content: Array<{ type: "text"; text: string }> } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("wecom-cli returned an invalid todo result");
  }
  const item =
    isUnknownRecord(parsed) && Array.isArray(parsed.items)
      ? parsed.items[0]
      : undefined;
  if (!isUnknownRecord(item) || typeof item.success !== "boolean") {
    throw new Error("wecom-cli returned an invalid todo result");
  }
  const followers = Array.isArray(item.followers)
    ? item.followers
        .filter(isUnknownRecord)
        .map((follower) => follower.user_name)
        .filter((name): name is string => typeof name === "string")
    : [];
  const safe = {
    success: item.success,
    title:
      typeof item.title === "string" ? item.title : payload.items[0]!.title,
    ...(followers.length > 0 ? { followers } : {}),
    ...(payload.items[0]!.deadline
      ? { deadline: payload.items[0]!.deadline }
      : {}),
    ...(typeof item.extra_info === "string"
      ? { extra_info: item.extra_info }
      : {}),
    ...(!item.success ? { error: "创建待办失败" } : {}),
  };
  return {
    success: item.success,
    content: [{ type: "text", text: JSON.stringify(safe) }],
  };
}

function boundedSingleLine(
  value: RuntimeJsonValue | undefined,
  label: string,
  maxLength: number,
): string {
  const text = boundedText(value, label, maxLength);
  if (/[\r\n\u0000-\u001F\u007F]/.test(text)) {
    throw new Error(`${label} must be a single printable line`);
  }
  return text;
}

function boundedText(
  value: RuntimeJsonValue | undefined,
  label: string,
  maxLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maxLength ||
    value.includes("\0")
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeCliEnvironment(
  base: NodeJS.ProcessEnv,
  configDirectory: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    WECOM_CLI_CONFIG_DIR: configDirectory,
  };
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]) {
    if (base[name] !== undefined) env[name] = base[name];
  }
  return env;
}

function contactSearchPayload(input: RuntimeJsonValue): {
  keywords: string[];
  search_mode?: "list";
} {
  if (!isRecord(input))
    throw new Error("contact search input must be an object");
  if (
    Object.keys(input).some(
      (key) => key !== "keywords" && key !== "search_mode",
    )
  ) {
    throw new Error("contact search input contains unsupported fields");
  }
  const keywords = input.keywords;
  if (
    !Array.isArray(keywords) ||
    keywords.length === 0 ||
    keywords.length > 10 ||
    keywords.some(
      (keyword) =>
        typeof keyword !== "string" ||
        keyword.trim().length === 0 ||
        keyword.length > 128 ||
        keyword.includes("\0"),
    )
  ) {
    throw new Error("contact search requires 1-10 valid keywords");
  }
  if (input.search_mode !== undefined && input.search_mode !== "list") {
    throw new Error("contact search_mode must be list when provided");
  }
  return {
    keywords: keywords as string[],
    ...(input.search_mode === "list" ? { search_mode: "list" as const } : {}),
  };
}

function isRecord(
  value: RuntimeJsonValue,
): value is { [key: string]: RuntimeJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function runProcess(
  executable: string,
  args: readonly string[],
  options: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
  },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxOutputBytes,
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = "code" in error ? String(error.code) : "unknown";
          reject(new Error(`wecom-cli failed (code=${code})`));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}
