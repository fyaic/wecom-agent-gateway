import type { RuntimeInteractionAction } from "@fyaic/wecom-runtime-contract";

export function parseReplyActions(
  value: string | undefined,
): RuntimeInteractionAction[] | undefined {
  if (!value?.trim()) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("GATEWAY_REPLY_ACTIONS_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("GATEWAY_REPLY_ACTIONS_JSON must be an array");
  }
  return parsed.map((item) => {
    if (!isRecord(item)) {
      throw new Error("Each reply action must be an object");
    }
    const value = stringValue(item.value);
    const label = stringValue(item.label);
    const style = item.style;
    if (!value || !label) {
      throw new Error("Each reply action requires value and label");
    }
    if (
      style !== undefined &&
      style !== "default" &&
      style !== "primary" &&
      style !== "danger"
    ) {
      throw new Error("Reply action style is invalid");
    }
    return {
      value,
      label,
      ...(style ? { style } : {}),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
