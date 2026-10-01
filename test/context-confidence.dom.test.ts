import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";
import type { ContextObservation } from "../src/context-budget";

const context: ContextObservation = { provider: "grok", access: "a", sessionId: "s", modelId: "m", generation: 1,
  source: "session", observedAt: 1, limitQuality: "verified", usageQuality: "verified",
  usageSemantics: "current-context", used: 80, limits: { contextWindow: 100 } };
function setup() {
  const h = bootWebview();
  dispatch(h.window, { type: "session", sessionId: "s", provider: "grok", currentModelId: "m" });
  return h;
}
describe("native versus estimated context presentation", () => {
  it("draws native ratios, including zero and occupancy above capacity", () => {
    const h = setup();
    for (const used of [80, 0, 110]) {
      dispatch(h.window, { type: "contextUsage", context: { ...context, used }, used, window: 100 });
      expect(h.doc.getElementById("donut-arc")!.style.display).toBe("");
      expect(h.doc.getElementById("donut-label")!.textContent).not.toContain("≈");
    }
    expect(h.doc.getElementById("donut")!.title).toContain("exceeds reported capacity");
  });
  it.each([{ usageQuality: "estimated" as const }, { stale: true }, { usageStale: true }, { sessionId: "old" }])(
    "does not draw a ratio for uncertain or foreign usage %j", patch => {
      const h = setup();
      dispatch(h.window, { type: "contextUsage", context: { ...context, ...patch }, used: 80, window: 100 });
      expect(h.doc.getElementById("donut-arc")!.style.display).toBe("none");
      expect(h.doc.getElementById("donut-label")!.textContent).not.toContain("/");
    });
  it("keeps confirmed Grok selection usable with an unknown effective budget", () => {
    const h = setup();
    dispatch(h.window, { type: "contextWindowSelection", selection: { sessionId: "s", modelId: "m", generation: 1,
      sizes: [256000, 500000], defaultSize: 256000, selectedSize: 500000, available: true, changing: false } });
    dispatch(h.window, { type: "contextUsage", context: { ...context, limitQuality: "estimated",
      limits: { contextWindow: 500000, activeWindow: 500000, configuredWindow: 500000 } }, used: 80, window: 500000 });
    click(h.window, h.doc.getElementById("donut")!);
    expect(h.doc.getElementById("context-popover")!.textContent).toContain("Active Grok context window");
    expect(h.doc.getElementById("context-popover")!.textContent).toMatch(/Effective input budget\s*Unknown/);
    expect(h.doc.querySelectorAll(".context-window-choice")).toHaveLength(2);
    expect(h.doc.getElementById("donut-arc")!.style.display).toBe("");
  });
  it("invalidates the displayed count and still offers advertised compact", () => {
    const h = setup();
    dispatch(h.window, { type: "contextUsage", context, used: 80 });
    dispatch(h.window, { type: "contextUsage", context: { ...context, used: undefined, usageStale: true, usageQuality: "unknown" } });
    dispatch(h.window, { type: "providerCapabilities", provider: "grok", capabilities: { manualCompact: { state: "yes" } } } as never);
    expect(h.doc.getElementById("donut-label")!.textContent).toBe("Context ?");
    click(h.window, h.doc.getElementById("donut")!);
    click(h.window, h.doc.querySelector(".context-compact")!);
    expect(h.posted.at(-1)).toEqual({ type: "send", text: "/compact", bare: true });
  });
});
