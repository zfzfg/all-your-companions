/** This stream-json bridge implements ACP v1, not the draft-v2 session contract. */
export const AGY_INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: { loadSession: true },
} as const;

export function agyCliMode(value: unknown): "agent" | "yolo" | "plan" {
  if (value === "plan") return "plan";
  return ["yolo", "agent-full-access", "bypassPermissions", "dangerously-skip-permissions"].includes(String(value))
    ? "yolo" : "agent";
}

export function agyTerminalToolUpdate(toolCallId: string, cancelled: boolean) {
  return {
    sessionUpdate: "tool_call_update", toolCallId, status: "failed",
    rawOutput: { output: cancelled ? "Tool cancelled" : "Tool ended without a confirmed completion" },
    _meta: { terminationReason: cancelled ? "cancelled" : "incomplete" },
  } as const;
}
