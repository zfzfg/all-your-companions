// Provider config files beside the AP-04 rule files (upstream 27a01d8, b83f62c):
// the directory must be the one each CLI actually reads.
import { describe, expect, it } from "vitest";
import { providerConfigFiles } from "../src/provider-config";

describe("providerConfigFiles", () => {
  it("follows GROK_HOME and CODEX_HOME, not a hard-coded home", () => {
    const files = providerConfigFiles({ HOME: "/home/u", GROK_HOME: "/g", CODEX_HOME: "/c" }, "linux");
    const byProvider = Object.fromEntries(files.map((f) => [f.providers[0], f.path]));
    expect(byProvider.grok).toBe("/g/config.toml");
    expect(byProvider.codex).toBe("/c/config.toml");
    expect(byProvider.claude).toBe("/home/u/.claude/settings.json");
    expect(byProvider.gemini).toMatch(/\.gemini/);
  });

  it("creates each file with a stub its CLI can parse", () => {
    const files = providerConfigFiles({ HOME: "/home/u" }, "linux");
    expect(files.every((f) => f.config && f.kind === "file" && f.scope === "global")).toBe(true);
    expect(files.find((f) => f.providers[0] === "claude")!.stub.trim()).toBe("{}");
  });
});
