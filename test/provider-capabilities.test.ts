import { describe, expect, it } from "vitest";
import { ACP_PROVIDERS } from "../src/acp-backend";
import {
  allProviderCapabilities,
  PROVIDER_CAPABILITIES,
  PROVIDER_CAPABILITY_NAMES,
  providerCapability,
  type ProviderCapability,
} from "../src/provider-capabilities";

describe("provider-capabilities (AP-01)", () => {
  it("defines all 11 capabilities explicitly across all 4 ACP providers with no missing cells", () => {
    expect(PROVIDER_CAPABILITY_NAMES).toHaveLength(11);
    expect(ACP_PROVIDERS).toHaveLength(4);

    for (const provider of ACP_PROVIDERS) {
      const providerMatrix = PROVIDER_CAPABILITIES[provider];
      expect(providerMatrix).toBeDefined();

      for (const cap of PROVIDER_CAPABILITY_NAMES) {
        const support = providerMatrix[cap];
        expect(support).toBeDefined();
        expect(["yes", "no", "probe"]).toContain(support.state);
        if (support.state === "no" || support.state === "probe") {
          expect(typeof support.reason).toBe("string");
          expect(support.reason.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("grok planMode defaults to probe when unobserved and resolves with runtime facts", () => {
    // Unobserved baseline
    const unobserved = providerCapability("grok", "planMode");
    expect(unobserved.state).toBe("probe");

    // Resolved positive
    const positive = providerCapability("grok", "planMode", { planModeAvailable: true });
    expect(positive).toEqual({ state: "yes" });

    // Resolved negative: verified old CLI
    const verifiedOld = providerCapability("grok", "planMode", {
      planModeAvailable: false,
      cliVerified: true,
    });
    expect(verifiedOld).toEqual({
      state: "no",
      reason: "Grok CLI is below the required version for Plan mode.",
    });

    // Resolved negative: unverified failure
    const unverified = providerCapability("grok", "planMode", {
      planModeAvailable: false,
      cliVerified: false,
    });
    expect(unverified).toEqual({
      state: "no",
      reason: "Grok CLI version could not be verified.",
    });

    // Custom unavailable reason preserved if present
    const customReason = providerCapability("grok", "planMode", {
      planModeAvailable: false,
      planModeUnavailableReason: "Custom probe failure note.",
    });
    expect(customReason).toEqual({
      state: "no",
      reason: "Custom probe failure note.",
    });
  });

  it("non-grok providers report planMode as yes natively", () => {
    expect(providerCapability("codex", "planMode")).toEqual({ state: "yes" });
    expect(providerCapability("claude", "planMode")).toEqual({ state: "yes" });
    expect(providerCapability("gemini", "planMode")).toEqual({ state: "yes" });
  });

  it("pins user-facing reason texts for unsupported steer, rewind, fork, worktree", () => {
    for (const provider of ["codex", "claude", "gemini"] as const) {
      const pName = provider === "codex" ? "Codex" : provider === "claude" ? "Claude" : "Gemini";

      expect(providerCapability(provider, "steer")).toEqual({
        state: "no",
        reason: `Steer is not supported by ${pName} — your message will be sent after the turn.`,
      });

      expect(providerCapability(provider, "rewind")).toEqual({
        state: "no",
        reason: `Rewind is not supported by ${pName}.`,
      });

      expect(providerCapability(provider, "fork")).toEqual({
        state: "no",
        reason: `Forking conversations is not supported by ${pName}.`,
      });

      expect(providerCapability(provider, "worktree")).toEqual({
        state: "no",
        reason: "Worktree isolation requires Grok (_x.ai/git/worktree).",
      });

      expect(providerCapability(provider, "clientPlanGate")).toEqual({
        state: "no",
        reason: `${pName} enforces plans natively in the adapter (no client-side gate).`,
      });

      expect(providerCapability(provider, "questionRpc")).toEqual({
        state: "no",
        reason: `Interactive question cards via x.ai/ask_user_question are not supported by ${pName}.`,
      });

      expect(providerCapability(provider, "feedback")).toEqual({
        state: "no",
        reason: `Thumbs feedback rating (_x.ai/feedback) is not supported by ${pName}.`,
      });

      expect(providerCapability(provider, "subagents")).toEqual({
        state: "no",
        reason: `Subagent delegation is not supported by ${pName}.`,
      });
    }
  });

  it("pins manualCompact differentiation (Gemini automated vs Grok/Codex/Claude manual)", () => {
    expect(providerCapability("grok", "manualCompact")).toEqual({ state: "yes" });
    expect(providerCapability("codex", "manualCompact")).toEqual({ state: "yes" });
    expect(providerCapability("claude", "manualCompact")).toEqual({ state: "yes" });
    expect(providerCapability("gemini", "manualCompact")).toEqual({
      state: "no",
      reason: "Antigravity manages and compacts context automatically in the background (no manual /compact needed).",
    });
  });

  it("allProviderCapabilities returns a complete map of all 11 dimensions", () => {
    const caps = allProviderCapabilities("codex");
    expect(Object.keys(caps).sort()).toEqual([...PROVIDER_CAPABILITY_NAMES].sort());
    expect(caps.steer.state).toBe("no");
    expect(caps.vision.state).toBe("yes");
  });

  it("handles unknown provider and unknown capability defensively", () => {
    expect(providerCapability("unknown" as any, "steer")).toEqual({
      state: "no",
      reason: "Unknown provider 'unknown'.",
    });

    expect(providerCapability("grok", "unknownCapability" as any)).toEqual({
      state: "no",
      reason: "Unknown capability 'unknownCapability'.",
    });
  });
});
