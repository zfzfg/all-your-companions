import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopAgyProcess } from "../src/agy-lifecycle";
import { AGY_INITIALIZE_RESULT, agyCliMode, agyTerminalToolUpdate } from "../src/agy-capabilities";
import type { InitializeResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";

class Process extends EventEmitter {
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  pid = 42; exitCode = null; signalCode = null;
  kill = vi.fn(() => true);
}
afterEach(() => { vi.useRealTimers(); });

describe("AGY process termination", () => {
  it("interrupts, escalates, and waits for confirmed exit", async () => {
    vi.useFakeTimers();
    const proc = new Process();
    const stopped = stopAgyProcess(proc as any, { platform: "linux" });
    // Exercise POSIX independent of the platform running CI.
    proc.emit("exit");
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("escalates POSIX SIGINT to SIGKILL without resolving on kill()", async () => {
    vi.useFakeTimers();
    const proc = new Process();
    const stopped = stopAgyProcess(proc as any, { platform: "linux" });
    let resolved = false;
    void stopped.then(() => { resolved = true; });
    expect(proc.kill).toHaveBeenCalledWith("SIGINT");
    await vi.advanceTimersByTimeAsync(1000);
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    expect(resolved).toBe(false);
    proc.emit("exit");
    await stopped;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fails closed when exit cannot be confirmed", async () => {
    vi.useFakeTimers();
    const proc = new Process();
    const stopped = stopAgyProcess(proc as any, { platform: "linux" });
    const assertion = expect(stopped).rejects.toThrow("restart blocked");
    await vi.advanceTimersByTimeAsync(3000);
    await assertion;
    expect(proc.listenerCount("exit")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("kills the hidden Windows tree and handles taskkill spawn errors", async () => {
    const proc = new Process();
    const taskkill = new EventEmitter();
    const spawnFn = vi.fn(() => taskkill);
    const stopped = stopAgyProcess(proc as any, { platform: "win32", spawnFn: spawnFn as any });
    expect(spawnFn).toHaveBeenCalledWith("taskkill", ["/PID", "42", "/T", "/F"], { stdio: "ignore", windowsHide: true });
    taskkill.emit("error", new Error("not found"));
    expect(proc.kill).toHaveBeenCalledWith("SIGKILL");
    proc.emit("exit");
    await stopped;
  });

  it("keeps ACP v1 cancellation schema-compatible and preserves CLI plan", () => {
    const initialize: InitializeResponse = AGY_INITIALIZE_RESULT;
    const update: ToolCallUpdate = agyTerminalToolUpdate("tool-1", true);
    expect(initialize.protocolVersion).toBe(1);
    expect(update.status).toBe("failed");
    expect(update._meta?.terminationReason).toBe("cancelled");
    expect(agyCliMode("plan")).toBe("plan");
    expect(agyCliMode("dangerously-skip-permissions")).toBe("yolo");
  });
});
