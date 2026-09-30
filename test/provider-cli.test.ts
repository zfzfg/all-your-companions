import { describe, expect, it } from "vitest";
import { ACP_PROVIDERS } from "../src/acp-backend";
import { PROVIDER_CLI } from "../src/provider-cli";
import { PROVIDER_USAGE } from "../src/provider-usage";
import { compactNotice, customModelItem } from "../src/provider-ui";

describe("provider CLI and usage policies", () => {
  const args = { grok: ["login"], codex: ["login"], claude: ["auth", "login"], gemini: [], muse: ["login"] };
  const logoutArgs = { ...args, gemini: ["auth", "login"] };
  const sources = { grok: "rpc", codex: "codex-file", claude: "updates", gemini: "none", muse: "none" };
  it.each(ACP_PROVIDERS)("defines explicit auth, storage and usage strategies for %s", (provider) => {
    const policy = PROVIDER_CLI[provider];
    expect(policy.loginArgs).toEqual(args[provider]);
    expect(policy.logoutArgs).toEqual(logoutArgs[provider].map((arg) => arg === "login" ? "logout" : arg));
    expect(typeof policy.locate).toBe("function");
    expect(policy.versionProbe).toMatch(/^probe[A-Z].*Version$/);
    expect(policy.credentialFiles().every((file) => typeof file === "string" && file.length > 0)).toBe(true);
    expect(PROVIDER_USAGE[provider].source).toBe(sources[provider]);
    expect(PROVIDER_USAGE[provider].cache).toBe(["grok", "codex"].includes(provider) ? "shared" : "session");
    expect(customModelItem(provider)?.modelId).toBe(provider === "gemini" ? "__custom__" : undefined);
    expect(!!compactNotice(provider)).toBe(provider === "gemini");
  });
  it("retains Muse's unsupported credential probe and both Gemini CLI variants", () => {
    expect(PROVIDER_CLI.muse.credentialProbe).toBe("unavailable");
    expect(PROVIDER_CLI.gemini.credentialProbe).toBe("warmConnectedGeminiModels");
    expect(PROVIDER_CLI.gemini.credentialFiles().map((file) => file.split(/[\\/]/).pop())).toEqual(["oauth.json", "settings.json"]);
  });
  it("uses Antigravity's interactive logout without sending an unsupported auth command", () => {
    expect(PROVIDER_CLI.gemini.interactiveLogout?.("C:/Users/test/.gemini/bin/agy.exe")).toBe("/logout");
    expect(PROVIDER_CLI.gemini.interactiveLogout?.("/usr/bin/gemini")).toBeUndefined();
  });
  it("offers the existing CLI update workflows without inventing updates", () => {
    expect(PROVIDER_CLI.codex.update).toMatchObject({ managed: true, packageName: "@openai/codex" });
    expect(PROVIDER_CLI.claude.update).toMatchObject({ managed: false, packageName: "@anthropic-ai/claude-code" });
    for (const provider of ["grok", "gemini", "muse"] as const) expect(PROVIDER_CLI[provider].update).toBeUndefined();
  });
});
