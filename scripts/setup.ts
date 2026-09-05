import { mkdir, open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const profiles = ["codex", "kimi", "pi", "openclaw", "echo"] as const;
export type SetupProfile = (typeof profiles)[number];

export function createStarterConfig(
  profile: SetupProfile,
  workspace: string,
): string {
  // Single quotes preserve spaces, backslashes and double quotes in Node dotenv.
  if (/[\r\n'\0]/.test(workspace))
    throw new Error("Workspace contains unsupported characters");
  const common = [
    "# Fill in your API-mode, long-connection WeCom Bot credentials locally.",
    "WECOM_BOT_ID=",
    "WECOM_BOT_SECRET=",
    "# Filled by pnpm enroll:direct. Keep the Gateway stopped while enrolling.",
    "WECOM_ALLOWED_DIRECT_SENDERS=",
    `GATEWAY_ADAPTER=${profile === "echo" ? "external" : profile}`,
    `AGENT_WORKING_DIRECTORY='${workspace}'`,
    "GATEWAY_CONTROL_ENABLED=true",
    "GATEWAY_REPLY_ACTIONS_JSON=[]",
    "# Enable explicitly after your first conversation, if wanted.",
    "GATEWAY_RUN_CONTROL_ENABLED=false",
  ];
  const extra: Record<SetupProfile, string[]> = {
    codex: [
      "CODEX_ADAPTER=app-server",
      "CODEX_SANDBOX=read-only",
      "CODEX_APPROVAL_POLICY=never",
    ],
    kimi: ["KIMI_EXECUTABLE=kimi"],
    pi: [
      "PI_EXECUTABLE=pi",
      "# Reuses Pi's local login and model settings. To choose explicitly:",
      `PI_ARGS_JSON='[]'`,
      "# For an environment-based provider key, name it here and set it locally.",
      "PI_AGENT_ENV_ALLOWLIST=",
    ],
    openclaw: [
      "OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789",
      "# REQUIRED: use the existing local Gateway's token (or set PASSWORD).",
      "OPENCLAW_GATEWAY_TOKEN=",
      "# Optional: select an existing OpenClaw agent.",
      "OPENCLAW_AGENT_ID=",
    ],
    echo: [
      "# Deterministic connectivity check. This is NOT an AI model.",
      "GATEWAY_EXTERNAL_ADAPTER_MODULE=./examples/adapter-template/src/index.ts",
      `GATEWAY_EXTERNAL_ADAPTER_CONFIG_JSON='{"prefix":"[Echo / 非 AI] "}'`,
    ],
  };
  return [...common, ...extra[profile], ""].join("\n");
}

export async function setup(
  args: string[],
  cwd = process.cwd(),
): Promise<SetupProfile | undefined> {
  const { values } = parseArgs({
    args: args.filter((arg) => arg !== "--"),
    options: {
      adapter: { type: "string" },
      workspace: { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help || !values.adapter) {
    console.log(
      "Usage: pnpm onboard --adapter codex|kimi|pi|openclaw|echo [--workspace /path/to/project]\nCreates a minimal private .env; never overwrites an existing configuration.\nThen fill Bot credentials, run pnpm enroll:direct, and pnpm start:checked.\nSee docs/getting-started.md (English: docs/getting-started.en.md).",
    );
    if (!values.help)
      throw new Error("Choose an --adapter; use one you already run locally");
    return;
  }
  if (!profiles.includes(values.adapter as SetupProfile))
    throw new Error("Unsupported starter profile; see --help");
  const profile = values.adapter as SetupProfile;
  const workspace = resolve(cwd, values.workspace ?? "agent-workspace");
  // Validate before creating files. An explicit workspace must already exist.
  const config = createStarterConfig(profile, workspace);
  if (values.workspace && !(await stat(workspace)).isDirectory())
    throw new Error("Workspace must be a directory");
  let handle;
  try {
    handle = await open(resolve(cwd, ".env"), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        ".env already exists; kept unchanged. Edit GATEWAY_ADAPTER and its settings to switch Agents.",
      );
    }
    throw error;
  }
  try {
    if (!values.workspace)
      await mkdir(workspace, { recursive: true, mode: 0o700 });
    await handle.writeFile(config, "utf8");
  } finally {
    await handle.close();
  }
  console.log(
    `Created private .env for ${profile}.\n1. Fill WECOM_BOT_ID and WECOM_BOT_SECRET in .env.${profile === "openclaw" ? " Also fill OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD." : ""}\n2. Run pnpm enroll:direct and send its one-time code to your Bot.\n3. Run pnpm start:checked, then say hello to the Bot.\n${profile === "echo" ? "Echo is a connectivity probe, not an AI Agent." : "Your Agent must already be installed, authenticated and able to answer locally."}\nNext: docs/getting-started.md`,
  );
  return profile;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await setup(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Setup failed");
    process.exitCode = 1;
  }
}
