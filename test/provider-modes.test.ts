import { describe, expect, it, vi } from "vitest";
import { AcpClient } from "../src/acp";
import { ACP_PROVIDERS } from "../src/acp-backend";
import { grokBackend } from "../src/grok-backend";
import { CodexBackend } from "../src/codex-backend";
import { ClaudeBackend } from "../src/claude-backend";
import { GeminiBackend } from "../src/gemini-backend";
import { MuseBackend } from "../src/muse-backend";
import { applyHostMode, type HostMode } from "../src/provider-modes";

const backends = { grok: grokBackend, codex: new CodexBackend(), claude: new ClaudeBackend(), gemini: new GeminiBackend(), muse: new MuseBackend() };
const expected = {
  grok: [["default"], ["default"], ["plan"]],
  codex: [["default", "agent"], ["default", "agent-full-access"], ["plan"]],
  claude: [["agent"], ["yolo"], ["plan"]],
  gemini: [["agent"], ["yolo"], ["plan"]],
  muse: [[], [], []],
};
describe("backend host mode sequences", () => {
  it.each(ACP_PROVIDERS)("preserves ordered RPCs for %s", async (provider) => {
    const client = new AcpClient({ cliPath: "unused", cwd: "/repo", log: () => {}, backend: backends[provider] });
    for (const [i, mode] of (["agent", "yolo", "plan"] as HostMode[]).entries()) {
      const steps: string[] = [];
      vi.spyOn(client, "setMode").mockImplementation(async (step) => { steps.push(step); });
      expect(backends[provider].hostModeSequence(mode)).toEqual(expected[provider][i]);
      await applyHostMode(client, provider, mode);
      expect(steps).toEqual(expected[provider][i]);
    }
  });
  it.each([0, 1])("stops the Codex sequence when step %i fails", async (failingStep) => {
    const client = new AcpClient({ cliPath: "unused", cwd: "/repo", log: () => {}, backend: backends.codex });
    let index = 0;
    const setMode = vi.spyOn(client, "setMode").mockImplementation(async () => {
      if (index++ === failingStep) throw new Error("RPC refused");
    });
    await expect(client.setHostMode("yolo")).rejects.toThrow("RPC refused");
    expect(setMode).toHaveBeenCalledTimes(failingStep + 1);
  });
  it("runs an injected facade sequentially without overlapping calls", async () => {
    const completed: string[] = [];
    const setMode = vi.fn(async (step: string) => {
      if (step === "agent-full-access") expect(completed).toEqual(["default"]);
      await Promise.resolve(); completed.push(step);
    });
    await applyHostMode({ setMode }, "codex", "yolo");
    expect(completed).toEqual(["default", "agent-full-access"]);
  });
});
