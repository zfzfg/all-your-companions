import { createRequire } from "node:module";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { probeOfficialAgy } = createRequire(__filename)("../research/agy-official-transport-probe.cjs");
afterEach(() => { vi.unstubAllEnvs(); });

describe("official Antigravity transport capability spike", () => {
  it.each(["hang", "exit", "error"])("cleans up a fake kernel after %s", async failure => {
    vi.stubEnv("FAKE_AGY_PROBE", failure);
    await expect(probeOfficialAgy({ binary: path.join(__dirname, "fixtures/fake-agy-official-acp.cjs"),
      harness: process.execPath, timeoutMs: 500 })).rejects.toThrow(
      failure === "hang" ? "timed out" : failure === "exit" ? "exited" : "RPC error -32000");
  });
  it("refuses a missing binary or harness without installing anything", async () => {
    await expect(probeOfficialAgy({})).rejects.toThrow("installed official kernel");
    await expect(probeOfficialAgy({ binary: process.execPath })).rejects.toThrow("localharness_external");
  });

  it("probes initialize and optional session creation with a fake kernel, without prompts or login", async () => {
    const result = await probeOfficialAgy({ binary: path.join(__dirname, "fixtures/fake-agy-official-acp.cjs"),
      harness: process.execPath, createSession: true });
    expect(result).toMatchObject({ platform: process.platform, protocolVersion: 1, agentVersion: "fixture",
      authMethodIds: ["oauth-personal"], sessionCreated: true, modeIds: ["default"] });
  });
});
