import { CodexAppServerRuntimeAdapter } from "../packages/adapter-codex/src/index.js";
import type {
  InboundMessage,
  RuntimeTool,
} from "../packages/runtime-contract/src/index.js";
import {
  createWeComContactSearchTool,
  WeComCliTool,
} from "../packages/tool-wecom-cli/src/index.js";

if (!process.argv.includes("--confirm-readonly-contact-search")) {
  throw new Error("Refusing to run without --confirm-readonly-contact-search");
}

const contactQuery = required("WECOM_SMOKE_CONTACT_QUERY");
const expectedReadableText =
  process.env.WECOM_SMOKE_CONTACT_EXPECT?.trim() || contactQuery;

const baseTool = createWeComContactSearchTool(
  new WeComCliTool({
    executable: process.env.WECOM_CLI_EXECUTABLE || undefined,
    configDirectory: required("WECOM_CLI_CONFIG_DIR"),
    timeoutMs: positiveInteger(process.env.WECOM_CLI_TIMEOUT_MS, 60_000),
    maxOutputBytes: positiveInteger(
      process.env.WECOM_CLI_MAX_OUTPUT_BYTES,
      256 * 1024,
    ),
  }),
);
let toolCalls = 0;
const toolLifecycle: string[] = [];
const observedTool: RuntimeTool = {
  ...baseTool,
  async execute(input, context) {
    toolCalls += 1;
    return baseTool.execute(input, context);
  },
};
const adapter = new CodexAppServerRuntimeAdapter({
  cwd: process.env.CODEX_WORKING_DIRECTORY || process.cwd(),
  executable: process.env.CODEX_EXECUTABLE || undefined,
  codexHome: process.env.CODEX_RUNTIME_HOME || undefined,
  model: process.env.CODEX_MODEL || undefined,
  serviceTier: process.env.CODEX_SERVICE_TIER || undefined,
  effort: "low",
  sandbox: "read-only",
  approvalPolicy: "never",
  responsesWebsocket: false,
  tools: [observedTool],
  toolTimeoutMs: positiveInteger(process.env.RUNTIME_TOOL_TIMEOUT_MS, 60_000),
  maxToolOutputBytes: positiveInteger(
    process.env.RUNTIME_TOOL_MAX_OUTPUT_BYTES,
    256 * 1024,
  ),
  onToolLifecycle: (event) => toolLifecycle.push(event.phase),
});

const message: InboundMessage = {
  id: "codex-dynamic-tool-smoke",
  accountId: "local-smoke",
  conversationId: "local-smoke",
  conversationType: "direct",
  senderId: "local-operator",
  receivedAt: new Date().toISOString(),
  parts: [
    {
      type: "text",
      text: `请调用 wecom_contact_search 搜索 ${contactQuery}。只回答匹配到的可读姓名、职务和部门，不要输出任何内部 ID。`,
    },
  ],
};

let finalText = "";
let completed = false;
try {
  await adapter.start();
  for await (const event of adapter.run({ message })) {
    if (event.type === "failed") throw new Error(event.message);
    if (event.type === "message-completed") {
      finalText = event.text ?? "";
      completed = true;
    }
  }
} finally {
  await adapter.stop();
}

if (!completed) throw new Error("Codex dynamic tool smoke did not complete");
if (toolCalls !== 1) {
  throw new Error(
    `Expected exactly one dynamic tool call, received ${toolCalls}`,
  );
}
if (toolLifecycle.join(",") !== "started,succeeded") {
  throw new Error("Codex dynamic tool smoke observed an invalid lifecycle");
}
if (!finalText.includes(expectedReadableText)) {
  throw new Error("Codex dynamic tool smoke returned no readable contact name");
}
if (
  /(?:user|open_vid|department|chat|mail|media|file|space|folder|doc|content|msg)_?id/i.test(
    finalText,
  )
) {
  throw new Error("Codex dynamic tool smoke exposed an internal identifier");
}

console.log(
  JSON.stringify({
    event: "codex_dynamic_tool_smoke",
    completed,
    toolCalls,
    toolLifecycle,
    readableContact: true,
    internalIdentifiersExposed: false,
  }),
);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}
