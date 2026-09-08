// Pure tests for AP-06 limit classification and failover targeting.
//
// The load-bearing rule: a false-positive limit is worse than a missed one.
// The word "rate" in ordinary prose, a context-window overflow, and auth
// failures must all return null / "auth" — never a failover card.
import { describe, expect, it } from "vitest";
import { RATE_LIMITED_ERROR_CODE, AUTH_REQUIRED_ERROR_CODE } from "../src/acp-dispatch";
import {
  DISMISS_BUTTON_LABEL,
  RETRY_BUTTON_LABEL,
  classifyLimitError,
  continueButtonLabel,
  failoverTargets,
  limitOfferHint,
  limitOfferTargets,
  limitOfferTitle,
  recommendedLimitAction,
  switchTranscriptLine,
} from "../src/limit-errors";

describe("classifyLimitError — grok", () => {
  // OSS sampling/error.rs + pager billing.rs (same strings as #57).
  const OAUTH_COPY = "You\u{2019}ve hit the rate limit for your plan. Upgrade your account or try again later.";
  const WEEKLY_COPY = "You hit your weekly limit.";
  const FREE_USAGE_COPY = "You\u{2019}ve reached your free Grok Build usage limit for now.";

  it("treats ACP -32003 as a short-lived rate limit regardless of wording", () => {
    expect(classifyLimitError("grok", "anything at all", RATE_LIMITED_ERROR_CODE)).toBe("rate");
    expect(classifyLimitError("grok", "Rate limited", RATE_LIMITED_ERROR_CODE)).toBe("rate");
  });

  it("refines -32003 to quota when the wire names a usage ceiling", () => {
    expect(classifyLimitError("grok", WEEKLY_COPY, RATE_LIMITED_ERROR_CODE)).toBe("quota");
    expect(classifyLimitError("grok", FREE_USAGE_COPY, RATE_LIMITED_ERROR_CODE)).toBe("quota");
    expect(classifyLimitError("grok", "You\u{2019}ve hit your spending cap.", RATE_LIMITED_ERROR_CODE)).toBe("quota");
  });

  it("classifies the CLI's OAuth rate-limit copy as rate", () => {
    expect(classifyLimitError("grok", OAUTH_COPY)).toBe("rate");
    expect(classifyLimitError("grok", "HTTP 429 Too Many Requests")).toBe("rate");
  });

  it("classifies free-usage-exhausted as quota even without the code", () => {
    expect(classifyLimitError("grok", "subscription:free-usage-exhausted: no free usage left")).toBe("quota");
  });
});

describe("classifyLimitError — claude", () => {
  // docs.anthropic.com/en/api/errors — 429 type rate_limit_error is RPM/ITPM.
  it("treats Anthropic rate_limit_error as a short-lived rate limit", () => {
    expect(classifyLimitError("claude", '{"type":"rate_limit_error","message":"Rate limited. Please try again later."}')).toBe("rate");
    expect(classifyLimitError("claude", "This request would exceed your organization\u{2019}s rate limit of 30,000 input tokens per minute.")).toBe("rate");
  });

  // platform.claude.com/docs/en/api/rate-limits.md — spend cap reuses the
  // rate_limit_error type but names usage limits / enforced_spend_limit_reached.
  it("treats Anthropic spend-cap copy as quota, not a wait-it-out rate limit", () => {
    expect(classifyLimitError(
      "claude",
      "You have reached your API usage limits: your organization has crossed its monthly API usage threshold",
    )).toBe("quota");
    expect(classifyLimitError("claude", "enforced_spend_limit_reached")).toBe("quota");
  });
});

describe("classifyLimitError — codex", () => {
  // platform.openai.com/docs/guides/error-codes
  it("treats rate_limit_exceeded / 429 as rate", () => {
    expect(classifyLimitError("codex", "Rate limit reached for gpt-4o in organization org-x on requests per min. Limit: 3, RPM.", undefined)).toBe("rate");
    expect(classifyLimitError("codex", "error code: rate_limit_exceeded")).toBe("rate");
    expect(classifyLimitError("codex", "HTTP 429 Too Many Requests")).toBe("rate");
  });

  it("treats insufficient_quota as quota even though the shared regex misses the underscore code", () => {
    expect(classifyLimitError(
      "codex",
      "You exceeded your current quota, please check your plan and billing details. code: insufficient_quota",
    )).toBe("quota");
    expect(classifyLimitError("codex", "insufficient_quota")).toBe("quota");
    expect(classifyLimitError("codex", "credit_balance_exhausted")).toBe("quota");
  });
});

describe("classifyLimitError — gemini", () => {
  // ai.google.dev generate-content API errors: 429 RESOURCE_EXHAUSTED.
  it("treats bare RESOURCE_EXHAUSTED as rate (wait is the documented retry)", () => {
    expect(classifyLimitError("gemini", "RESOURCE_EXHAUSTED")).toBe("rate");
  });

  it("treats Gemini's prose exhausted-with-quota copy as quota", () => {
    expect(classifyLimitError("gemini", "Resource has been exhausted (e.g. check quota).")).toBe("quota");
  });

  it("treats quota-metric copy as quota", () => {
    expect(classifyLimitError("gemini", "RESOURCE_EXHAUSTED: Quota exceeded for quota metric")).toBe("quota");
    expect(classifyLimitError("gemini", "Generative Language API quota limit reached")).toBe("quota");
  });
});

describe("classifyLimitError — auth vs null (false positives)", () => {
  it("returns auth for credential failures, not a failover card", () => {
    expect(classifyLimitError("grok", "401 Unauthorized")).toBe("auth");
    expect(classifyLimitError("grok", "access token expired")).toBe("auth");
    expect(classifyLimitError("grok", "odd wording", AUTH_REQUIRED_ERROR_CODE)).toBe("auth");
    expect(classifyLimitError("claude", "authentication required")).toBe("auth");
  });

  it("does not treat a weekly limit as auth — #57 login-redirect trap", () => {
    expect(classifyLimitError("grok", "You hit your weekly limit.")).toBe("quota");
    expect(classifyLimitError("grok", "subscription:free-usage-exhausted: You\u{2019}ve reached your free usage limit")).toBe("quota");
  });

  it("returns null for the word 'rate' in ordinary prose", () => {
    expect(classifyLimitError("grok", "The success rate is high.")).toBeNull();
    expect(classifyLimitError("claude", "I will rate the options.")).toBeNull();
    expect(classifyLimitError("codex", "Generate a bitrate chart.")).toBeNull();
    expect(classifyLimitError("gemini", "Please rate this change.")).toBeNull();
  });

  it("returns null for a context-window overflow (not a usage limit)", () => {
    expect(classifyLimitError("grok", "prompt exceeds the model's context limit")).toBeNull();
    expect(classifyLimitError("claude", "The context window limit was exceeded")).toBeNull();
  });

  it("returns null for ordinary faults", () => {
    expect(classifyLimitError("grok", "network timeout")).toBeNull();
    expect(classifyLimitError("grok", "Tool call failed: file not found")).toBeNull();
    expect(classifyLimitError("grok", "Grok process exited (code 1)")).toBeNull();
    expect(classifyLimitError("grok", "the payload was too large")).toBeNull();
    expect(classifyLimitError("grok", "")).toBeNull();
  });
});

describe("failoverTargets", () => {
  it("never offers the exhausted provider — another of its models is the same account", () => {
    expect(failoverTargets("claude", ["grok", "codex", "claude", "gemini"])).toEqual([
      "grok", "codex", "gemini",
    ]);
  });

  it("keeps Grok-first provider order and drops anyone not usable", () => {
    expect(failoverTargets("grok", ["claude", "gemini"])).toEqual(["claude", "gemini"]);
    expect(limitOfferTargets("grok", ["claude"])).toEqual([{ id: "claude", name: "Claude" }]);
  });

  it("is empty when no other companion is connected", () => {
    expect(failoverTargets("grok", ["grok"])).toEqual([]);
    expect(failoverTargets("grok", [])).toEqual([]);
  });
});

describe("recommendedLimitAction + copy", () => {
  const claude = { id: "claude" as const, name: "Claude" };

  it("recommends waiting for a rate limit even when a partner exists", () => {
    expect(recommendedLimitAction("rate", [claude])).toBe("retry");
  });

  it("recommends continuing for a quota only when a partner exists", () => {
    expect(recommendedLimitAction("quota", [claude])).toBe("continue");
    expect(recommendedLimitAction("quota", [])).toBe("retry");
  });

  it("names the source in the title and the target in the continue button", () => {
    expect(limitOfferTitle("quota", "claude")).toBe("Claude usage limit reached");
    expect(limitOfferTitle("rate", "grok")).toBe("Grok is rate-limited");
    expect(continueButtonLabel(claude)).toBe("Continue with Claude");
    expect(RETRY_BUTTON_LABEL).toBe("Wait and try again");
    expect(DISMISS_BUTTON_LABEL).toBe("Dismiss");
  });

  it("says a same-provider model would not help, when suggesting a switch", () => {
    expect(limitOfferHint("quota", true)).toMatch(/same companion will not help/i);
    expect(limitOfferHint("rate", true)).toMatch(/Waiting is the right first try/i);
  });

  it("writes every switch as a reconstructable transcript line", () => {
    expect(switchTranscriptLine("grok", "claude")).toBe(
      "Switched from Grok to Claude after a usage limit.",
    );
  });
});
