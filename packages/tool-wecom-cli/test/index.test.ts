import { describe, expect, it } from "vitest";
import {
  createWeComContactSearchTool,
  createWeComTodoCreateTool,
  WeComCliAuthorizationExpiredError,
  WeComCliTool,
} from "../src/index.js";

describe("WeComCliTool", () => {
  it("executes an exact contact search argv without a shell", async () => {
    const calls: unknown[] = [];
    const cli = new WeComCliTool({
      executable: "/opt/tools/wecom-cli",
      configDirectory: "/protected/wecom-config",
      baseEnvironment: {
        PATH: "/usr/bin:/bin",
        WECOM_BOT_SECRET: "must-not-reach-cli",
        CODEX_HOME: "/must-not-reach-cli",
      },
      processRunner: async (executable, args, options) => {
        calls.push({ executable, args, options });
        return { stdout: '{"matched":1}', stderr: "" };
      },
    });
    const tool = createWeComContactSearchTool(cli);

    const result = await tool.execute(
      { keywords: ["Alice; $(touch /tmp/nope)"] },
      { sessionId: "opaque-session", callId: "opaque-call" },
    );

    expect(result).toEqual({
      success: true,
      content: [{ type: "text", text: '{"matched":1}' }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      executable: "/opt/tools/wecom-cli",
      args: [
        "contact",
        "users",
        "search",
        "--json",
        '{"keywords":["Alice; $(touch /tmp/nope)"]}',
      ],
      options: {
        env: {
          PATH: "/usr/bin:/bin",
          WECOM_CLI_CONFIG_DIR: "/protected/wecom-config",
        },
      },
    });
  });

  it("rejects malformed contact input before starting the CLI", async () => {
    let executed = false;
    const cli = new WeComCliTool({
      configDirectory: "/protected/wecom-config",
      processRunner: async () => {
        executed = true;
        return { stdout: "", stderr: "" };
      },
    });
    const tool = createWeComContactSearchTool(cli);

    await expect(
      tool.execute(
        { keywords: ["Alice"], extra: "unsupported" },
        { sessionId: "opaque-session", callId: "opaque-call" },
      ),
    ).rejects.toThrow("unsupported fields");
    expect(executed).toBe(false);
  });

  it("classifies capability authorization expiry without exposing CLI output", async () => {
    const cli = new WeComCliTool({
      configDirectory: "/protected/wecom-config",
      processRunner: async () => ({
        stdout: JSON.stringify({
          errcode: 850003,
          errmsg: "authorization expired: private upstream detail",
        }),
        stderr: "credential path=/private/config",
      }),
    });

    await expect(cli.execute(["todo", "create"])).rejects.toEqual(
      new WeComCliAuthorizationExpiredError(),
    );
  });

  it("does not treat an unrelated data value as authorization expiry", async () => {
    const cli = new WeComCliTool({
      configDirectory: "/protected/wecom-config",
      processRunner: async () => ({
        stdout: '{"matched":1,"extension":"850003"}',
        stderr: "",
      }),
    });

    await expect(cli.execute(["contact", "users", "search"])).resolves.toEqual({
      stdout: '{"matched":1,"extension":"850003"}',
      stderr: "",
    });
  });

  it("creates one approval-gated todo with exact argv and strips internal IDs", async () => {
    const calls: unknown[] = [];
    const cli = new WeComCliTool({
      executable: "/opt/tools/wecom-cli",
      configDirectory: "/protected/wecom-config",
      processRunner: async (executable, args) => {
        calls.push({ executable, args });
        return {
          stdout: JSON.stringify({
            items: [
              {
                success: true,
                todo_id: "internal-todo-id",
                title: "验证 Gateway 审批链路",
                followers: [
                  {
                    userid: "internal-user-id",
                    user_name: "Alice（测试成员）",
                  },
                ],
                extra_info: "将在截止时提醒",
              },
            ],
          }),
          stderr: "",
        };
      },
    });
    const tool = createWeComTodoCreateTool(cli);
    const input = {
      title: "验证 Gateway 审批链路",
      deadline: { type: "datetime", value: "2026-08-22 10:00:00" },
      remind_at_deadline: true,
    } as const;

    expect(tool.effect).toBe("write");
    expect(tool.approval).toBe("required");
    expect(tool.approvalSummary?.(input)).toBe(
      "创建待办「验证 Gateway 审批链路」，截止时间 2026-08-22 10:00:00",
    );
    const result = await tool.execute(input, {
      sessionId: "opaque-session",
      callId: "opaque-call",
    });

    expect(calls).toEqual([
      {
        executable: "/opt/tools/wecom-cli",
        args: ["todo", "create", "--json", JSON.stringify({ items: [input] })],
      },
    ]);
    expect(result).toEqual({
      success: true,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: true,
            title: "验证 Gateway 审批链路",
            followers: ["Alice（测试成员）"],
            deadline: input.deadline,
            extra_info: "将在截止时提醒",
          }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("internal-todo-id");
    expect(JSON.stringify(result)).not.toContain("internal-user-id");
  });

  it("rejects an invalid todo reminder before approval or CLI execution", async () => {
    let executed = false;
    const cli = new WeComCliTool({
      configDirectory: "/protected/wecom-config",
      processRunner: async () => {
        executed = true;
        return { stdout: "", stderr: "" };
      },
    });
    const tool = createWeComTodoCreateTool(cli);

    expect(() =>
      tool.approvalSummary?.({
        title: "无效提醒",
        deadline: { type: "date", value: "2026-08-22" },
        remind_at_deadline: true,
      }),
    ).toThrow("requires a datetime deadline");
    expect(executed).toBe(false);
  });

  it("returns a stable non-retryable result when todo authorization expired", async () => {
    let attempts = 0;
    const cli = new WeComCliTool({
      configDirectory: "/protected/wecom-config",
      processRunner: async () => {
        attempts += 1;
        throw new Error(
          "850003 authorization expired secret=must-not-reach-agent",
        );
      },
    });
    const tool = createWeComTodoCreateTool(cli);

    const result = await tool.execute(
      { title: "授权失效测试" },
      { sessionId: "opaque-session", callId: "opaque-call" },
    );

    expect(attempts).toBe(1);
    expect(result).toEqual({
      success: false,
      content: [
        {
          type: "text",
          text: JSON.stringify({
            success: false,
            error: "wecom_capability_authorization_expired",
            message: "企业微信能力授权已过期，需要重新授权后再试。",
          }),
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("must-not-reach-agent");
  });
});
