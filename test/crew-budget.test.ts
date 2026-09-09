import { describe, expect, it } from "vitest";
import { checkBudget, countUnreapable, nextFailoverProvider, parallelSlotCap, repeatedFailingTool, USD_TICKS_PER_DOLLAR } from "../src/crew-budget";

describe("checkBudget", () => {
  it("is ok when there is no budget or the used amount is at the cap", () => {
    expect(checkBudget({ toolCalls: 9, tokens: 0, usdTicks: 0 }, undefined)).toEqual({ ok: true });
    expect(checkBudget({ toolCalls: 3, tokens: 0, usdTicks: 0 }, { toolCalls: 3 })).toEqual({ ok: true });
  });

  it("fails each limit individually, never silently", () => {
    expect(checkBudget({ toolCalls: 4, tokens: 0, usdTicks: 0 }, { toolCalls: 3 })).toEqual({
      ok: false, limit: "toolCalls", used: 4, cap: 3,
    });
    expect(checkBudget({ toolCalls: 0, tokens: 1001, usdTicks: 0 }, { tokens: 1000 })).toEqual({
      ok: false, limit: "tokens", used: 1001, cap: 1000,
    });
    expect(checkBudget({ toolCalls: 0, tokens: 0, usdTicks: USD_TICKS_PER_DOLLAR * 2 }, { usd: 1 })).toEqual({
      ok: false, limit: "usd", used: 2, cap: 1,
    });
  });
});

describe("parallelSlotCap", () => {
  it("is derived from the pool, never guessed, and at least 1", () => {
    expect(parallelSlotCap({ maxLive: 8, unreapable: 3 })).toBe(5);
    expect(parallelSlotCap({ maxLive: 8, unreapable: 8 })).toBe(1);
    expect(parallelSlotCap({ maxLive: 8, unreapable: 20 })).toBe(1);
  });
});

describe("nextFailoverProvider", () => {
  it("never returns an exhausted provider", () => {
    expect(nextFailoverProvider(["claude"], ["claude", "codex", "grok"])).toBe("codex");
    expect(nextFailoverProvider(["claude", "codex", "grok"], ["claude", "codex", "grok"])).toBeUndefined();
    expect(nextFailoverProvider(["claude"], ["claude"])).toBeUndefined();
  });
});

describe("countUnreapable", () => {
  it("counts focused plus working/needs-you, once each", () => {
    const focused = { status: "idle" };
    const working = { status: "working" };
    const ask = { status: "needs-you" };
    const idle = { status: "done" };
    expect(countUnreapable([focused, working, ask, idle], focused)).toBe(3);
  });
});

describe("repeatedFailingTool", () => {
  it("is true only when the same tool failed n times in a row", () => {
    expect(repeatedFailingTool([
      { tool: "edit", ok: false },
      { tool: "edit", ok: false },
      { tool: "edit", ok: false },
    ])).toBe(true);
    expect(repeatedFailingTool([
      { tool: "edit", ok: false },
      { tool: "edit", ok: true },
      { tool: "edit", ok: false },
    ])).toBe(false);
    expect(repeatedFailingTool([{ tool: "edit", ok: false }, { tool: "edit", ok: false }], 2)).toBe(true);
    expect(repeatedFailingTool([{ tool: "edit", ok: false }])).toBe(false);
  });
});
