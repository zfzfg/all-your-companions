import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sessionStart = readFileSync(new URL("../src/session-start.ts", import.meta.url), "utf8");
const chat = readFileSync(new URL("../media/chat.js", import.meta.url), "utf8");

const toolCallStart = sessionStart.indexOf("    const replayedCommandOutputs = new Set<string>();");
const toolCallEnd = sessionStart.indexOf('    client.on("plan"', toolCallStart);
const replayHook = sessionStart.slice(toolCallStart, toolCallEnd);

const commandDoneStart = sessionStart.indexOf('    client.on("commandDone"');
const commandDoneEnd = sessionStart.indexOf('    client.on("permissionRequest"', commandDoneStart);
const commandDone = sessionStart.slice(commandDoneStart, commandDoneEnd);

describe("session/load commandOutput restore wiring (#44)", () => {
  it("hydrates commandOutput from a replayed tool_call / tool_call_update", () => {
    expect(toolCallStart).toBeGreaterThan(-1);
    expect(replayHook).toContain("commandOutputForToolCall(call, {");
    expect(replayHook).toContain("replaying: session.replaying");
    expect(replayHook).toContain("rememberedCommands: replayedCommandsByToolCallId");
    expect(replayHook).toContain('this.deps.emit(session, { type: "commandOutput", ...replayed })');
    expect(replayHook).toContain("prepareMcpToolCall");
    expect(replayHook).toContain("emitReplayedCommandOutput(prepared.call)");
    expect(replayHook.indexOf('client.on("toolCall"')).toBeGreaterThan(-1);
    expect(replayHook.indexOf("emitReplayedCommandOutput(prepared.call)")).toBeGreaterThan(
      replayHook.indexOf("emitToolCallEvent"),
    );
    expect(replayHook.indexOf('client.on("toolCallUpdate"')).toBeGreaterThan(-1);
    expect(replayHook).toContain('this.deps.emit(session, { type, call: prepared.call })');
  });

  it("leaves the live terminal commandDone path on the same cap, not the replay helper", () => {
    expect(commandDoneStart).toBeGreaterThan(-1);
    expect(commandDone).toContain("commandOutputFromLiveTerminal(info)");
    expect(commandDone).toContain('type: "commandOutput"');
    expect(commandDone).not.toContain("commandOutputForToolCall");
    expect(commandDone).not.toContain("session.replaying");
  });

  it("does not hide a cancelled marker just because historyReplay is on", () => {
    const start = chat.indexOf("function attachCommandOutput");
    const end = chat.indexOf("function maybeAttachToolResultOutput");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const attach = chat.slice(start, end);
    expect(attach).not.toContain("if (!state.replaying)");
    expect(attach).toContain("commandOutputWasCancelled(msg)");
  });

  it("does not suppress Claude string rawOutput just because historyReplay is on", () => {
    // historyReplay also wraps focusSession / rehydrate buffer rebuilds. Live
    // Claude has no commandOutput in that buffer, so a replaying-only guard
    // drops the only OUT those rows have.
    expect(chat).not.toContain("state.replaying && typeof call.rawOutput === \"string\"");
    expect(chat).toContain("extractToolResultOutput(call)");
  });
});
