import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { beginAuthRecovery, oauthShadowsXaiApiKey } from "../src/auth-recovery";

describe("session-scoped auth recovery", () => {
  it("reloads the owning pool member instead of the locally focused session", () => {
    const source = readFileSync(new URL("../src/turn-edit.ts", import.meta.url), "utf8");
    const start = source.indexOf("public async recoverAuthAndResend");
    const recovery = source.slice(start);

    expect(recovery).toContain("this.startSession(resumeId, session)");
    expect(recovery).not.toContain("session !== this.focused");
  });

  it("arms a remote-owned session without requiring it to be locally focused", () => {
    const remote = { activeSessionId: "remote-session", authRecoveryTried: false };

    expect(beginAuthRecovery(remote)).toBe("remote-session");
    expect(remote.authRecoveryTried).toBe(true);
  });

  it("preserves resend-once bookkeeping independently for concurrent sessions", () => {
    const local = { activeSessionId: "local-session", authRecoveryTried: false };
    const remote = { activeSessionId: "remote-session", authRecoveryTried: false };

    expect(beginAuthRecovery(remote)).toBe("remote-session");
    expect(beginAuthRecovery(remote)).toBeUndefined();
    expect(beginAuthRecovery(local)).toBe("local-session");
  });

  it("requires persisted history to reload", () => {
    expect(beginAuthRecovery({ authRecoveryTried: false })).toBeUndefined();
  });
});

describe("OAuth shadow warning condition", () => {
  it("matches cached OAuth plus a configured XAI_API_KEY", () => {
    expect(oauthShadowsXaiApiKey("cached_token", { XAI_API_KEY: "xai-test" })).toBe(true);
  });

  it("does not guess from one side of the condition", () => {
    expect(oauthShadowsXaiApiKey("cached_token", {})).toBe(false);
    expect(oauthShadowsXaiApiKey("api_key", { XAI_API_KEY: "xai-test" })).toBe(false);
    expect(oauthShadowsXaiApiKey(undefined, { XAI_API_KEY: "xai-test" })).toBe(false);
    expect(oauthShadowsXaiApiKey("cached_token", { XAI_API_KEY: "   " })).toBe(false);
  });
});
