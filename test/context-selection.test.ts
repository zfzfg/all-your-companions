import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { AcpClient } from "../src/acp";
import { parseContextWindowSize, contextWindowSizes } from "../src/context-selection";
import { parseContextCatalog } from "../src/context-catalog";
import { CodexBackend } from "../src/codex-backend";

function setup() {
  const client = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {}, grokVersion: "1.0.46", grokVersionVerified: true });
  client.sessionId = "s1";
  client.currentModelId = "grok-4.7";
  client.availableModels = [{ modelId: "grok-4.7", name: "Grok", contextWindowSizes: [256000, 500000] }];
  client.observeContext({ source: "session", limitQuality: "estimated", usageQuality: "verified", used: 10, limits: { contextWindow: 256000 } });
  let size = 256000;
  const request = vi.fn(async (method: string, params: any) => {
    if (method === "_x.ai/session/info") return { result: { context: { used: 10, total: size } } };
    size = params._meta?.contextWindow ?? size;
    return { _meta: { model: { Ok: "grok-4.7" } } };
  });
  (client as any).request = request;
  return { client, request };
}

describe("native context selection", () => {
  it("validates catalog choices without sorting or inventing a size", () => {
    expect(contextWindowSizes([500000, 256000, 500000, 0, -1, 2.5, "100", Infinity])).toEqual([500000, 256000]);
    expect(contextWindowSizes(undefined, 256000)).toEqual([256000]);
    expect(contextWindowSizes(undefined)).toEqual([]);
    const catalog = parseContextCatalog("grok", { models: { m: { info: { context_window: 256000, context_windows: [500000, 256000] } } } }, Date.now(), "grok");
    expect(catalog.models[0].limits.contextWindow).toBe(500000);
    expect(catalog.models[0].contextWindowSizes).toEqual([500000, 256000]);
  });
  it("accepts CLI shorthand and rejects non-native counts", () => {
    expect(parseContextWindowSize("500k")).toBe(500000);
    expect(parseContextWindowSize("256000")).toBe(256000);
    for (const text of ["0", "-1", "1.5k", "500kb", "500k high", "Infinity"]) expect(parseContextWindowSize(text)).toBeUndefined();
  });
  it("confirms the native override before publishing its active value", async () => {
    const { client, request } = setup();
    await client.getSessionInfo();
    await client.setContextWindow(500000, client.contextWindowSelection);
    expect(request).toHaveBeenCalledWith("session/set_model", { sessionId: "s1", modelId: "grok-4.7", _meta: { contextWindow: 500000 } });
    expect(client.contextWindowSelection.selectedSize).toBe(500000);
    expect(client.contextBudget?.limits.contextWindow).toBe(500000);
    expect(client.contextBudget?.limitQuality).toBe("estimated");
    (client as any).catalogSnapshot = parseContextCatalog("grok", { models: { "grok-4.7": { info: { context_window: 256000, context_windows: [256000, 500000] } } } }, Date.now(), "grok");
    (client as any).applyContextCatalog();
    expect(client.contextBudget?.limits.contextWindow).toBe(500000);
    expect(client.availableModels[0].totalContextTokens).toBe(500000);
  });
  it("preserves the last confirmed selection on rejection or missing confirmation", async () => {
    for (const fails of [true, false]) {
      const { client } = setup();
      await client.getSessionInfo();
      (client as any).request = vi.fn(async (method: string) => {
        if (method === "session/set_model" && fails) throw new Error("denied");
        return method === "session/set_model" ? { _meta: { model: { Ok: "grok-4.7" } } } : { context: { used: 10, total: 256000 } };
      });
      await expect(client.setContextWindow(500000, client.contextWindowSelection)).rejects.toThrow();
      expect(client.contextWindowSelection.selectedSize).toBe(256000);
      expect(client.contextWindowSelection.changing).toBe(false);
      expect(client.contextBudget?.stale).toBe(true);
    }
  });
  it("rejects stale identity, invalid sizes and tagged old updates", async () => {
    const { client, request } = setup();
    const old = client.contextWindowSelection;
    await expect(client.setContextWindow(500000, { ...old, sessionId: "other" })).rejects.toThrow("older");
    await expect(client.setContextWindow(1000000, old)).rejects.toThrow("offer");
    expect(request).not.toHaveBeenCalled();
    await client.setContextWindow(500000, old);
    client.observeContext({ source: "session", limitQuality: "verified", generation: old.generation, limits: { contextWindow: 256000 } });
    (client as any).handleSessionUpdate({ sessionUpdate: "usage_update", used: 9, size: 256000 }, { generation: old.generation }, "s1");
    expect(client.contextBudget?.limits.contextWindow).toBe(500000);
    await expect(client.setContextWindow(256000, old)).rejects.toThrow("older");
  });
  it("locks concurrent prompts and model switches until native confirmation", async () => {
    const { client } = setup();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    (client as any).request = vi.fn(async (method: string) => {
      if (method === "session/set_model") { await wait; return { _meta: { model: { Ok: "grok-4.7" } } }; }
      return { context: { used: 10, total: 500000 } };
    });
    const changing = client.setContextWindow(500000, client.contextWindowSelection);
    expect(client.contextWindowSelection.changing).toBe(true);
    await expect(client.getSessionInfo()).rejects.toThrow("retry");
    await expect(client.prompt("hello")).rejects.toThrow("Wait");
    await expect(client.setModel("other")).rejects.toThrow("Wait");
    release(); await changing;
  });
  it("uses only an advertised slash command and bypasses full-context preflight", async () => {
    const { client, request } = setup();
    client.availableCommands = [{ name: "context-window" }];
    (client as any).request = vi.fn(async (method: string) => method === "_x.ai/session/info" ? { context: { used: 600000, total: 500000 } } : {});
    await client.setContextWindow(500000, client.contextWindowSelection);
    expect((client as any).request.mock.calls[0]).toEqual(["session/prompt", { sessionId: "s1", prompt: [{ type: "text", text: "/context-window 500000" }] }]);
    expect(request).not.toHaveBeenCalled();
  });
  it("does not expose guessed capability or send an unsupported slash as prose", async () => {
    const client = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {} });
    client.sessionId = "s"; client.currentModelId = "m";
    client.availableModels = [{ modelId: "m", name: "m", contextWindowSizes: [256000, 500000] }];
    expect(client.contextWindowSelection.available).toBe(false);
    await expect(client.prompt("/context-window 500k")).rejects.toThrow("does not advertise");
    const codex = new AcpClient({ cliPath: "fake", cwd: "/", log: () => {}, backend: new CodexBackend() });
    expect(codex.contextWindowSelection.available).toBe(false);
  });
});

const clients: AcpClient[] = [];
const homes: string[] = [];
afterEach(async () => { for (const c of clients.splice(0)) await c.dispose(); for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });
describe("context selection over fake CLI stdio", () => {
  it("lets native compaction reduce occupancy after selecting a smaller window", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-context-")); homes.push(home);
    const client = new AcpClient({ cliPath: path.join(__dirname, "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh"),
      cwd: process.cwd(), env: { ...process.env, GROK_HOME: home, FAKE_CONTEXT_WINDOWS: "1", FAKE_CONTEXT_USED: "300000" },
      grokVersion: "1.0.46", grokVersionVerified: true, log: () => {} });
    clients.push(client); await client.start(); await client.newSession();
    const updates: any[] = [];
    client.on("xaiNotification", update => updates.push(update));
    await client.setContextWindow(256000, client.contextWindowSelection);
    expect(updates.map(u => u.sessionUpdate)).toContain("auto_compact_started");
    expect(updates.map(u => u.sessionUpdate)).toContain("auto_compact_completed");
    expect(client.contextBudget?.used).toBe(10000);
    expect(client.contextWindowSelection.selectedSize).toBe(256000);
  }, 30000);

  it.each([undefined, "FAKE_CONTEXT_ERROR", "FAKE_CONTEXT_UNCONFIRMED"])("confirms or reports native outcome %s", async (failure) => {
    const home = mkdtempSync(path.join(tmpdir(), "fake-context-")); homes.push(home);
    const client = new AcpClient({ cliPath: path.join(__dirname, "fixtures", process.platform === "win32" ? "fake-grok-acp.cmd" : "fake-grok-acp.sh"),
      cwd: process.cwd(), env: { ...process.env, GROK_HOME: home, FAKE_CONTEXT_WINDOWS: "1", ...(failure ? { [failure]: "1" } : {}) },
      grokVersion: "1.0.46", grokVersionVerified: true, log: () => {} });
    clients.push(client); await client.start(); await client.newSession();
    expect(client.contextWindowSelection.selectedSize).toBe(256000);
    const change = client.setContextWindow(500000, client.contextWindowSelection);
    if (failure) { await expect(change).rejects.toThrow(); expect(client.contextWindowSelection.selectedSize).toBe(256000); }
    else { await change; expect((await client.getSessionInfo() as any).window).toBe(500000); }
  }, 30000);
});
