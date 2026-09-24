import { describe, expect, it, vi } from "vitest";
import {
  GROK_COMPACT_ENV,
  compactEventKind,
  compactSummaryPreview,
  compactThresholdLine,
  compactThresholdMismatch,
  contextTone,
  grokCompactThresholdEnv,
  normalizeCompactThreshold,
  shouldOfferNearFull,
} from "../src/grok-compaction";
import { isContextOverflowError } from "../src/limit-errors";
import { parseSessionInfoRpcResult } from "../src/acp-dispatch";
import { renderFreshSessionPrompt } from "../src/handoff";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { bootWebview, dispatch, click } from "./webview-harness";

describe("grokCompactThresholdEnv (K-01)", () => {
  it.each([
    [95, "95"], [1, "1"], [99, "99"], ["97", "97"],
    [0, undefined], [100, undefined], [150, undefined], [-5, undefined],
    [NaN, undefined], [95.5, undefined], ["", undefined], ["abc", undefined], [null, undefined], [undefined, undefined],
  ])("setting %p → %p", (setting, expected) => {
    expect(grokCompactThresholdEnv(setting, {})).toBe(expected);
  });

  it("never overwrites a variable the user set (shell or .env), even an empty one", () => {
    expect(grokCompactThresholdEnv(95, { [GROK_COMPACT_ENV]: "90" })).toBeUndefined();
    expect(grokCompactThresholdEnv(95, { [GROK_COMPACT_ENV]: "" })).toBeUndefined();
  });

  it("normalizes to an integer 1–99 or undefined", () => {
    expect(normalizeCompactThreshold("88")).toBe(88);
    expect(normalizeCompactThreshold(0)).toBeUndefined();
  });
});

describe("threshold display and decisions (K-02..K-04)", () => {
  it("detects a mismatch only when both sides are known", () => {
    expect(compactThresholdMismatch(95, 80)).toBe(true);
    expect(compactThresholdMismatch(95, 95)).toBe(false);
    expect(compactThresholdMismatch(undefined, 80)).toBe(false);
    expect(compactThresholdMismatch(95, undefined)).toBe(false);
  });

  it("formats the popover line with the token estimate", () => {
    expect(compactThresholdLine(95, 500000)).toBe("Auto-compacts at 95% (≈ 475k tokens)");
    expect(compactThresholdLine(95, undefined)).toBe("Auto-compacts at 95%");
  });

  it("colours relative to the threshold", () => {
    expect(contextTone(400, 1000, 95)).toBe("normal");
    expect(contextTone(900, 1000, 95)).toBe("warn");
    expect(contextTone(950, 1000, 95)).toBe("danger");
  });

  it("offers the near-full prompt from threshold − 3 once per cycle", () => {
    const base = { window: 1000, thresholdPercent: 95, armed: true, mode: "ask" as const };
    expect(shouldOfferNearFull({ ...base, used: 910 })).toBe(false);
    expect(shouldOfferNearFull({ ...base, used: 920 })).toBe(true);
    expect(shouldOfferNearFull({ ...base, used: 920, armed: false })).toBe(false);
    expect(shouldOfferNearFull({ ...base, used: 920, mode: "off" })).toBe(false);
    expect(shouldOfferNearFull({ ...base, used: 920, thresholdPercent: undefined })).toBe(false);
  });

  it("recognizes every compaction lifecycle kind, including cancelled", () => {
    expect(compactEventKind({ sessionUpdate: "auto_compact_cancelled" })).toBe("cancelled");
    expect(compactEventKind({ sessionUpdate: "auto_compact_started" })).toBe("started");
    expect(compactEventKind({ sessionUpdate: "other" })).toBeNull();
  });

  it("reads summary_preview only from a completed compaction", () => {
    expect(compactSummaryPreview({ sessionUpdate: "auto_compact_completed", summary_preview: "  kept auth  " })).toBe("kept auth");
    expect(compactSummaryPreview({ sessionUpdate: "auto_compact_completed" })).toBeNull();
    expect(compactSummaryPreview({ sessionUpdate: "auto_compact_started", summary_preview: "x" })).toBeNull();
  });

  it("parses compactionCount from session/info", () => {
    const parsed = parseSessionInfoRpcResult({ context: { used: 10, total: 100, autoCompactThresholdPercent: 95, compactionCount: 2 } });
    expect(parsed).toMatchObject({ autoCompactThresholdPercent: 95, compactionCount: 2 });
  });
});

describe("context overflow (K-05)", () => {
  it.each([
    "Error: context_length_exceeded",
    "This model's maximum context length is 500000 tokens. However, you requested 612000 tokens",
    "This model's maximum prompt length is 131072 but the request contains 140000 tokens.",
    "prompt is too long: 210000 tokens > 200000 maximum",
  ])("matches documented wording: %s", (text) => {
    expect(isContextOverflowError(text)).toBe(true);
  });
  it.each(["rate limit exceeded", "the context of this change is long", ""])("does not guess on %p", (text) => {
    expect(isContextOverflowError(text)).toBe(false);
  });
});

describe("fresh-session prompt (K-04)", () => {
  it("carries goal, task, decisions and files but no transcript", () => {
    const text = renderFreshSessionPrompt({
      goal: "Add login",
      task: "Carry on with the steps that are still open:\n  - write tests",
      acceptance: "The open steps are done.",
      files: ["src/auth.ts"],
      decisions: ["Already done, do not repeat: plan."],
      forbidden: [],
      provenance: [],
    } as never);
    expect(text).toContain("Goal: Add login");
    expect(text).toContain("- src/auth.ts");
    expect(text).toContain("Already settled:");
    expect(text).toContain("When you are done: The open steps are done.");
  });
});

function hostHarness(provider: Session["provider"] = "grok", settings: Record<string, unknown> = {}) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const session = new Session();
  session.provider = provider;
  session.cwd = "/proj";
  const emitted: any[] = [];
  const lines: string[] = [];
  sidebar.focused = session;
  sidebar.pool = new Set([session]);
  sidebar.emit = (_s: Session, msg: any) => emitted.push(msg);
  sidebar.host = {
    appendLine: (l: string) => lines.push(l),
    getConfiguration: () => ({ get: (key: string, def: unknown) => (key in settings ? settings[key] : def) }),
  };
  sidebar.readDotEnv = () => ({});
  return { sidebar, session, emitted, lines };
}

describe("host wiring (K-01, K-02, K-04)", () => {
  it("sets the env on the Grok spawn env from the setting, and leaves 0 alone", () => {
    const saved = process.env[GROK_COMPACT_ENV];
    delete process.env[GROK_COMPACT_ENV];
    try {
      const { sidebar } = hostHarness("grok", { "grok.autoCompactThresholdPercent": 97 });
      expect(sidebar.buildEnv("/proj")[GROK_COMPACT_ENV]).toBe("97");
      const zero = hostHarness("grok", { "grok.autoCompactThresholdPercent": 0 });
      expect(zero.sidebar.buildEnv("/proj")[GROK_COMPACT_ENV]).toBeUndefined();
      const dflt = hostHarness("grok");
      expect(dflt.sidebar.buildEnv("/proj")[GROK_COMPACT_ENV]).toBe("95");
    } finally {
      if (saved !== undefined) process.env[GROK_COMPACT_ENV] = saved;
    }
  });

  it("a workspace .env wins over the setting", () => {
    const { sidebar } = hostHarness("grok", { "grok.autoCompactThresholdPercent": 97 });
    sidebar.readDotEnv = () => ({ [GROK_COMPACT_ENV]: "85" });
    expect(sidebar.buildEnv("/proj")[GROK_COMPACT_ENV]).toBe("85");
  });

  it("warns exactly once per window when Grok reports another threshold", () => {
    const { sidebar, session, emitted, lines } = hostHarness();
    session.compactThresholdRequested = 95;
    sidebar.checkCompactThreshold(session, 80);
    sidebar.checkCompactThreshold(session, 80);
    const other = new Session();
    other.provider = "grok";
    other.compactThresholdRequested = 95;
    sidebar.checkCompactThreshold(other, 80);
    expect(emitted.filter((m) => m.type === "hostNotice")).toHaveLength(1);
    expect(lines.filter((l) => l.includes("reports auto-compaction at 80%"))).toHaveLength(2);
  });

  it("stays quiet when the threshold was honoured, or for other providers", () => {
    const { sidebar, session, emitted } = hostHarness();
    session.compactThresholdRequested = 95;
    sidebar.checkCompactThreshold(session, 95);
    const codex = hostHarness("codex");
    codex.session.compactThresholdRequested = 95;
    codex.sidebar.checkCompactThreshold(codex.session, 80);
    expect(emitted).toEqual([]);
    expect(codex.emitted).toEqual([]);
  });

  it.each(["grok", "codex", "claude", "gemini"] as const)("offers near-full once per cycle (%s)", (provider) => {
    const { sidebar, session, emitted } = hostHarness(provider);
    sidebar.maybeOfferNearFull(session, 930, 1000, 95);
    sidebar.maybeOfferNearFull(session, 940, 1000, 95);
    const offers = emitted.filter((m) => m.type === "nearFullPrompt");
    expect(offers).toHaveLength(1);
    expect(offers[0].canCompact).toBe(provider !== "gemini");
  });

  it("never offers it for Muse, or when the setting is off", () => {
    const muse = hostHarness("muse");
    muse.sidebar.maybeOfferNearFull(muse.session, 930, 1000, 95);
    const off = hostHarness("grok", { "context.nearFullPrompt": "off" });
    off.sidebar.maybeOfferNearFull(off.session, 930, 1000, 95);
    expect(muse.emitted).toEqual([]);
    expect(off.emitted).toEqual([]);
  });
});

describe("webview (K-03, K-04, K-06)", () => {
  it("marks the ring, uses the threshold for the colour and names it in the popover", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "contextUsage", used: 460000, window: 500000, autoCompactThresholdPercent: 95, compactionCount: 2 });
    const mark = doc.querySelector(".donut-threshold-mark");
    expect(mark?.getAttribute("data-threshold")).toBe("95");
    expect(doc.getElementById("donut-arc")!.getAttribute("stroke")).toContain("yellow");
    // a used-only frame keeps the threshold
    dispatch(window, { type: "contextUsage", used: 480000 });
    expect(doc.getElementById("donut-arc")!.getAttribute("stroke")).toContain("red");
    click(window, doc.getElementById("donut")!);
    const text = doc.getElementById("context-popover")!.textContent!;
    expect(text).toContain("Auto-compacts at 95%");
    expect(text).toContain("2× in this session");
  });

  it("shows the near-full block with three choices and posts /compact with a focus", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "nearFullPrompt", used: 920, window: 1000, threshold: 95, canCompact: true });
    const box = doc.getElementById("near-full-prompt")!;
    expect(box.textContent).toContain("compacts automatically at 95%");
    (box.querySelector(".near-full-focus") as HTMLInputElement).value = "keep the auth details";
    const compact = [...box.querySelectorAll("button")].find((b) => b.textContent === "Compact now")!;
    click(window, compact);
    expect(posted.some((p: any) => p.type === "send" && p.text === "/compact keep the auth details")).toBe(true);
    expect(doc.getElementById("near-full-prompt")).toBeNull();
  });

  it("offers only the fresh session where there is no /compact", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "nearFullPrompt", used: 920, window: 1000, threshold: 95, canCompact: false });
    const labels = [...doc.querySelectorAll("#near-full-prompt button")].map((b) => b.textContent);
    expect(labels).toEqual(["Continue in a fresh session", "Keep going"]);
    click(window, doc.querySelector("#near-full-prompt button") as HTMLElement);
    expect(posted.some((p: any) => p.type === "continueInFreshSession")).toBe(true);
  });

  it("renders the compaction summary collapsed and the overflow card with one retry", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "compactSummary", summary: "Kept: auth flow" });
    const row = doc.querySelector(".compact-summary") as HTMLDetailsElement;
    expect(row.open).toBe(false);
    expect(row.textContent).toContain("Kept: auth flow");
    dispatch(window, { type: "contextOverflow", id: "o1", text: "The context window overflowed.", canCompact: true });
    const retry = [...doc.querySelectorAll(".context-overflow button")].find((b) => b.textContent === "Compact and retry") as HTMLElement;
    click(window, retry);
    click(window, retry);
    expect(posted.filter((p: any) => p.type === "contextOverflowAnswer")).toEqual([
      { type: "contextOverflowAnswer", id: "o1", action: "compact-retry" },
    ]);
  });
});

void vi;
