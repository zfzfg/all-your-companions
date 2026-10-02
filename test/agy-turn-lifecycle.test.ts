import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyAcpAdapterServer, ensureAntigravityToolRules, stripAgyAdapterInstructions, type AgyAdapterOptions } from "../src/agy-acp-adapter";

class Process extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  killed = false;
  autoExit = true;
  kill() { this.killed = true; if (this.autoExit) this.emit("exit", 0); return true; }
  event(event: unknown) { this.stdout.write(JSON.stringify(event) + "\n"); }
  text(text = "done") { this.event({ event: "step_update", step_update: { step_type: "agent_response", text_delta: text } }); }
  result() { this.event({ event: "result", result: { status: "SUCCESS" } }); }
}
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.useRealTimers(); });
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function harness(options: Partial<AgyAdapterOptions> = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-lifecycle-"));
  const input = new PassThrough(); const output = new PassThrough();
  const procs: Process[] = []; const messages: any[] = [];
  const server = new AgyAcpAdapterServer({ geminiHome: home, cwd: home, supportsInputFormat: true,
    inputStream: input, outputStream: output, spawnFn: () => { const proc = new Process(); procs.push(proc); return proc as any; },
    toolRules: "off", ...options });
  output.on("data", data => { for (const line of data.toString().trim().split("\n")) messages.push(JSON.parse(line)); });
  server.start();
  const send = (id: number | undefined, method: string, params: unknown = {}) => {
    input.write(JSON.stringify({ id, method, params }) + "\n");
  };
  const prompt = (id: number, text = "work") => send(id, "session/prompt", { text });
  cleanups.push(() => { for (const proc of procs) proc.autoExit = true; server.dispose(); fs.rmSync(home, { recursive: true, force: true }); });
  return { server, home, input, procs, messages, send, prompt };
}

describe("AGY turn ownership", () => {
  it("waits for the child to exit during idempotent shutdown", async () => {
    const h = harness(); h.prompt(1); await tick(); h.procs[0].autoExit = false;
    let finished = false;
    const closing = h.server.shutdown().then(() => { finished = true; });
    h.server.dispose(); await tick();
    expect(finished).toBe(false);
    h.procs[0].emit("exit", 0); await closing;
    expect(h.messages.filter(m => m.id === 1)).toHaveLength(1);
  });

  it("does not count an unknown tool state as visible output", async () => {
    const h = harness(); h.prompt(1); await tick();
    h.procs[0].event({ event: "step_update", step_update: { step_type: "tool", state: "UNRECOGNIZED" } });
    h.procs[0].result(); await tick();
    expect(h.messages.find(m => m.id === 1)?.error.code).toBe(-32000);
  });

  it("hides transient adapter instructions from transcript user text", () => {
    expect(stripAgyAdapterInstructions("<companions_adapter_instructions>\ninternal rules\n</companions_adapter_instructions>\n\nuser title"))
      .toBe("user title");
    expect(stripAgyAdapterInstructions("ordinary user content")).toBe("ordinary user content");
  });
  it("reserves before a slow capability probe and cancels without spawning", async () => {
    const h = harness();
    let complete!: (supported: boolean) => void;
    vi.spyOn(h.server, "probeSupportsInputFormat").mockReturnValue(new Promise(resolve => { complete = resolve; }));
    h.prompt(1); h.prompt(2);
    h.send(undefined, "session/cancel");
    await tick();
    expect(h.messages.find(m => m.id === 1)?.result.stopReason).toBe("cancelled");
    expect(h.procs).toHaveLength(0);
    complete(true); await tick();
    expect(h.procs).toHaveLength(1);
    h.procs[0].text(); h.procs[0].result(); await tick();
    expect(h.messages.filter(m => m.id === 2)).toHaveLength(1);
  });

  it("stops a child attached after cancellation during spawn", async () => {
    let h!: ReturnType<typeof harness>;
    const proc = new Process();
    h = harness({ spawnFn: () => { h.send(undefined, "session/cancel"); return proc as any; } });
    h.prompt(1); await tick();
    expect(proc.killed).toBe(true);
    expect(h.messages.filter(m => m.id === 1)).toHaveLength(1);
    expect(h.messages.find(m => m.id === 1)?.result.stopReason).toBe("cancelled");
  });

  it("waits for exit after cancel and ignores the replaced child's late events", async () => {
    const h = harness(); h.prompt(1); await tick();
    const first = h.procs[0]; first.autoExit = false;
    h.send(undefined, "session/cancel"); h.prompt(2); await tick();
    expect(h.procs).toHaveLength(1);
    expect(h.messages.find(m => m.id === 1)).toBeUndefined();
    first.emit("exit", 0); await tick();
    expect(h.procs).toHaveLength(2);
    first.emit("exit", 1); first.text("stale"); first.result();
    h.procs[1].text("fresh"); h.procs[1].result(); await tick();
    expect(h.messages.filter(m => m.id === 1)).toHaveLength(1);
    expect(h.messages.filter(m => m.id === 2)).toHaveLength(1);
    expect(h.messages.some(m => m.params?.update?.content?.text === "stale")).toBe(false);
  });

  it("blocks replacement after a termination timeout", async () => {
    vi.useFakeTimers();
    const h = harness({ processStopGraceMs: 10, processStopTimeoutMs: 30 });
    h.prompt(1); await tick(); h.procs[0].autoExit = false;
    h.send(undefined, "session/cancel"); h.prompt(2);
    await vi.advanceTimersByTimeAsync(30); await tick();
    expect(h.procs).toHaveLength(1);
    expect(h.messages.find(m => m.id === 1)?.error.message).toContain("restart blocked");
    expect(h.messages.find(m => m.id === 2)?.error.message).toContain("restart blocked");
  });

  it.each(["session/delete", "session/new"])("%s aborts active and queued requests", async method => {
    const h = harness(); h.prompt(1); h.prompt(2); await tick();
    h.send(3, method); await tick();
    expect(h.messages.find(m => m.id === 1)?.result.stopReason).toBe("cancelled");
    expect(h.messages.find(m => m.id === 2)?.result.stopReason).toBe("cancelled");
    expect(h.procs).toHaveLength(1);
  });

  it("EOF abandons all queued turns", async () => {
    const h = harness(); h.prompt(1); h.prompt(2); await tick();
    h.input.end(); await new Promise(resolve => setImmediate(resolve)); await tick();
    expect(h.messages.filter(m => m.id === 1 || m.id === 2)).toHaveLength(2);
    expect(h.procs).toHaveLength(1);
  });

  it("reports an empty successful result and a result-less exit as errors", async () => {
    const h = harness(); h.prompt(1); await tick(); h.procs[0].result(); await tick();
    expect(h.messages.find(m => m.id === 1)?.error.code).toBe(-32000);
    h.prompt(2); await tick(); h.procs[0].text(); h.procs[0].emit("exit", 0); await tick();
    expect(h.messages.find(m => m.id === 2)?.error.message).toContain("without a turn result");
  });

  it.each(["result", "cancel", "crash"])("terminalizes an open tool before %s response", async cause => {
    const h = harness(); h.prompt(1); await tick();
    h.procs[0].event({ event: "step_update", step_update: { step_type: "tool", step_index: 1, tool_name: "run_command", state: "ACTIVE" } });
    await tick();
    if (cause === "result") h.procs[0].result();
    if (cause === "cancel") h.send(undefined, "session/cancel");
    if (cause === "crash") h.procs[0].emit("exit", 1);
    await tick();
    const terminal = h.messages.findIndex(m => m.params?.update?.status === "failed");
    expect(terminal).toBeGreaterThanOrEqual(0);
    expect(terminal).toBeLessThan(h.messages.findIndex(m => m.id === 1));
    expect(h.messages.filter(m => m.params?.update?.status === "failed")).toHaveLength(1);
  });

  it("keeps the slot while a diff is finalizing and cancels its delayed output", async () => {
    const h = harness({ diskPollAttempts: 10, diskPollDelayMs: 10 });
    const file = path.join(h.home, "edit.txt"); fs.writeFileSync(file, "before");
    h.prompt(1); await tick();
    for (const state of ["ACTIVE", "DONE"]) h.procs[0].event({ event: "step_update",
      step_update: { step_type: "tool", step_index: 1, tool_name: "replace_file_content", state, tool_info: { parameters: { TargetFile: file } } } });
    h.procs[0].result(); h.prompt(2); await tick();
    expect(h.messages.find(m => m.id === 1)).toBeUndefined();
    expect(h.procs[0].stdin.read().toString()).not.toContain("Second");
    h.send(undefined, "session/cancel"); await tick();
    expect(h.messages.find(m => m.id === 1)?.result.stopReason).toBe("cancelled");
    expect(h.messages.filter(m => m.params?.update?.status === "failed")).toHaveLength(1);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(h.messages.some(m => m.params?.update?.status === "completed")).toBe(false);
  });

  it("reports synchronous spawn failures exactly once", async () => {
    const h = harness({ spawnFn: () => { throw new Error("spawn unavailable"); } });
    h.prompt(1); await tick();
    expect(h.messages.filter(m => m.id === 1)).toHaveLength(1);
    expect(h.messages[0].error.message).toContain("spawn unavailable");
  });

  it("retries an initial effort mismatch only once before visible output", async () => {
    const h = harness(); h.prompt(1); await tick();
    h.procs[0].event({ event: "result", result: { status: "ERROR", error: "requires --effort" } }); await tick();
    expect(h.procs).toHaveLength(2);
    h.procs[1].event({ event: "result", result: { status: "ERROR", error: "requires --effort" } }); await tick();
    expect(h.procs).toHaveLength(2);
    expect(h.messages.filter(m => m.id === 1)).toHaveLength(1);
    expect(h.messages.find(m => m.id === 1)?.error.message).toContain("requires --effort");
  });

  it("does not retry an effort error after visible tool or assistant output", async () => {
    const h = harness(); h.prompt(1); await tick(); h.procs[0].text();
    h.procs[0].event({ event: "result", result: { status: "ERROR", error: "conflicts with --effort" } }); await tick();
    expect(h.procs).toHaveLength(1);
    expect(h.messages.find(m => m.id === 1)?.error.message).toContain("conflicts with --effort");
  });

  it.each(["stdin", "stdout", "stderr"] as const)("handles an asynchronous %s stream failure", async stream => {
    const h = harness(); h.prompt(1); await tick();
    h.procs[0][stream].emit("error", new Error("stream failed")); await tick();
    expect(h.messages.filter(m => m.id === 1)).toHaveLength(1);
    expect(h.messages.find(m => m.id === 1)?.error.message).toContain("stream failed");
    expect(h.procs[0].killed).toBe(true);
  });

  it("hides CLI windows and quotes a Windows command shim executable", async () => {
    const spawnFn = vi.fn((_command: string, _args: string[], _options: any) => new Process() as any);
    const h = harness({ agyPath: "C:\\temp with spaces\\agy.cmd", spawnFn });
    h.prompt(1); await tick();
    expect(spawnFn.mock.calls[0][0]).toBe(process.platform === "win32" ? '"C:\\temp with spaces\\agy.cmd"' : "C:\\temp with spaces\\agy.cmd");
    expect(spawnFn.mock.calls[0][2]).toMatchObject({ windowsHide: true, shell: process.platform === "win32" });
  });

  it("reports asynchronous spawn and stdin failures exactly once", async () => {
    const h = harness(); h.prompt(1); await tick();
    h.procs[0].emit("error", new Error("spawn EACCES")); await tick();
    expect(h.messages.filter(m => m.id === 1)).toHaveLength(1);
    expect(h.messages.find(m => m.id === 1)?.error.message).toContain("EACCES");
    h.prompt(2); await tick();
    const stdin = h.procs[1].stdin;
    vi.spyOn(stdin, "write").mockImplementation(((_data: unknown, callback: any) => { callback(new Error("broken stdin")); return false; }) as any);
    h.procs[1].text(); h.procs[1].result(); await tick();
    h.prompt(3); await tick();
    expect(h.messages.filter(m => m.id === 3)).toHaveLength(1);
    expect(h.messages.find(m => m.id === 3)?.error.message).toContain("broken stdin");
  });

  it("keeps rules transient and does not overwrite even an empty existing user file", async () => {
    const h = harness({ toolRules: "prompt" }); h.prompt(1, "original user title"); await tick();
    const request = JSON.parse(h.procs[0].stdin.read().toString());
    expect(request.message.content).toContain("Antigravity tool rules:");
    expect(request.message.content).toContain("original user title");
    expect(fs.existsSync(path.join(h.home, "GEMINI.md"))).toBe(false);
    fs.writeFileSync(path.join(h.home, "GEMINI.md"), "");
    ensureAntigravityToolRules(h.home);
    expect(fs.readFileSync(path.join(h.home, "GEMINI.md"), "utf8")).toBe("");
  });

  it("uses the dynamic model catalog consistently for effort and config options", async () => {
    const h = harness({ modelDiscovery: async () => "future-model-low\tFuture (Low)\nfuture-model-high\tFuture (High)\nopaque-id\tOpaque" });
    h.send(10, "session/new"); await tick();
    const response = h.messages.find(m => m.id === 10).result;
    expect(response.configOptions.find((c: any) => c.id === "model").options.map((m: any) => m.value))
      .toEqual(response.models.availableModels.map((m: any) => m.modelId));
    expect(h.server.effectiveModelRequiresEffort("future-model")).toBe(true);
    expect(h.server.effectiveModelRequiresEffort("opaque-id")).toBe(false);
  });

  it("uses only discovered effort values in configuration and CLI arguments", async () => {
    const spawnFn = vi.fn((_command: string, _args: string[], _options: any) => new Process() as any);
    const h = harness({ spawnFn, modelDiscovery: async () => JSON.stringify([{ id: "future", reasoningEfforts: ["high"] }]) });
    h.send(10, "session/new"); await tick();
    h.send(11, "session/set_config_option", { configId: "model", value: "future" }); await tick();
    const effort = h.messages.find(m => m.id === 11).result.configOptions.find((c: any) => c.id === "reasoning_effort");
    expect(effort.currentValue).toBe("high");
    expect(effort.options.map((o: any) => o.value)).toEqual(["high"]);
    h.prompt(1); await tick();
    const args = spawnFn.mock.calls[0][1];
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  it("deduplicates replay by position, repairs a truncated record, and replays for a fresh generation", async () => {
    const h = harness();
    const logs = path.join(h.home, "brain", "conversation", ".system_generated", "logs");
    fs.mkdirSync(logs, { recursive: true });
    const file = path.join(logs, "transcript_full.jsonl");
    const record = JSON.stringify({ type: "PLANNER_RESPONSE", content: "same text" });
    fs.writeFileSync(file, `${record}\n${record}\n{"type":`);
    h.server.replayTranscript("conversation");
    h.server.replayTranscript("conversation");
    expect(h.messages.filter(m => m.params?.update?.sessionUpdate === "agent_message_chunk")).toHaveLength(2);
    fs.writeFileSync(file, `${record}\n${record}\n${record}`);
    h.server.replayTranscript("conversation");
    expect(h.messages.filter(m => m.params?.update?.sessionUpdate === "agent_message_chunk")).toHaveLength(3);
    h.send(10, "session/new"); await tick();
    h.server.replayTranscript("conversation");
    expect(h.messages.filter(m => m.params?.update?.sessionUpdate === "agent_message_chunk")).toHaveLength(6);
  });

  it("pauses the idle watchdog for human waits, then fails a silent turn", async () => {
    vi.useFakeTimers();
    const h = harness({ watchdogIdleTimeoutMs: 30000 });
    h.send(10, "session/new"); await tick(); h.prompt(1); await tick();
    h.send(undefined, "_companions/human_wait", { sessionId: h.server.sessionId, active: true });
    await vi.advanceTimersByTimeAsync(60000);
    expect(h.messages.find(m => m.id === 1)).toBeUndefined();
    h.send(undefined, "_companions/human_wait", { sessionId: h.server.sessionId, active: false });
    await vi.advanceTimersByTimeAsync(30000); await tick();
    expect(h.messages.find(m => m.id === 1)?.error.message).toContain("watchdog");
    expect(h.procs[0].killed).toBe(true);
  });

  it("does not carry a cancelled human wait into the next turn", async () => {
    vi.useFakeTimers();
    const h = harness({ watchdogIdleTimeoutMs: 30000 });
    h.send(10, "session/new"); await tick(); h.prompt(1); await tick();
    h.send(undefined, "_companions/human_wait", { sessionId: h.server.sessionId, active: true });
    h.send(undefined, "session/cancel"); await tick(); h.prompt(2); await tick();
    await vi.advanceTimersByTimeAsync(30000); await tick();
    expect(h.messages.find(m => m.id === 2)?.error.message).toContain("watchdog");
  });
});
