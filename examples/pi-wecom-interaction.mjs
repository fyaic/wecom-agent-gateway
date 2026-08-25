import { Type } from "@earendil-works/pi-ai";

/**
 * Safe demonstration tool for Pi's native RPC extension UI protocol.
 *
 * Load with:
 *   pi --extension ./examples/pi-wecom-interaction.mjs
 *
 * The tool has no side effects. Its select/confirm/input calls are surfaced by
 * the Gateway as WeCom interactions and the selected value is returned to Pi's
 * original tool call.
 */
export default function wecomInteractionDemo(pi) {
  pi.registerTool({
    name: "wecom_interaction_demo",
    label: "WeCom Interaction Demo",
    description:
      "Run a harmless WeCom interaction demo when the user explicitly asks to test a selection, confirmation, or text-input card.",
    parameters: Type.Object({
      kind: Type.Union([
        Type.Literal("select"),
        Type.Literal("confirm"),
        Type.Literal("input"),
      ]),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.kind === "select") {
        const selected = await ctx.ui.select("选择测试环境", [
          "生产环境",
          "测试环境",
          "开发环境",
        ]);
        return result(selected ? `用户选择：${selected}` : "用户取消了选择", {
          kind: params.kind,
          selected: selected ?? null,
        });
      }
      if (params.kind === "confirm") {
        const confirmed = await ctx.ui.confirm(
          "确认测试操作？",
          "这只是无副作用的交互链路测试，不会修改任何数据。",
        );
        return result(confirmed ? "用户已确认" : "用户未确认", {
          kind: params.kind,
          confirmed,
        });
      }
      const value = await ctx.ui.input("请输入测试文本", "例如：WeCom Gateway");
      return result(value ? `用户输入：${value}` : "用户取消了输入", {
        kind: params.kind,
        value: value ?? null,
      });
    },
  });
}

function result(text, details) {
  return { content: [{ type: "text", text }], details };
}
