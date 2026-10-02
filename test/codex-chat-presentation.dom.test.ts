import { expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

it("shows Codex catalog capacity and draws a ring from verified prompt input", () => {
  const h = bootWebview();
  dispatch(h.window, { type: "session", provider: "codex", sessionId: "s", currentModelId: "gpt-test",
    models: [{ modelId: "gpt-test", name: "GPT Test", totalContextTokens: 400000 }] });
  expect(h.doc.getElementById("donut")!.hidden).toBe(false);
  expect(h.doc.getElementById("donut-label")!.textContent).toBe("400K context");
  click(h.window, h.doc.getElementById("gear-btn")!);
  expect(h.doc.querySelector(".codex-context-capacity")!.textContent).toContain("Context limit (catalog)");
  const context = { provider: "codex" as const, sessionId: "s", modelId: "gpt-test", access: "a", generation: 1,
    source: "session" as const, usageSource: "session" as const, observedAt: 1, limitQuality: "verified" as const,
    usageSemantics: "last-request" as const, used: 32000, limits: { effectiveContextTokens: 400000 } };
  dispatch(h.window, { type: "contextUsage", context: { ...context, usageQuality: "unknown" } });
  expect(h.doc.getElementById("donut-arc")!.style.display).toBe("none");
  dispatch(h.window, { type: "contextUsage", context: { ...context, usageQuality: "verified" } });
  expect(h.doc.getElementById("donut-label")!.textContent).toBe("32K/400K");
  expect(h.doc.getElementById("donut-arc")!.style.display).toBe("");
  expect(h.doc.getElementById("donut")!.title).toContain("output excluded");
  click(h.window, h.doc.getElementById("donut")!);
  expect(h.doc.getElementById("context-popover")!.textContent).toContain((400000).toLocaleString());
  dispatch(h.window, { type: "contextUsage", context: { ...context, usageQuality: "unknown", usageStale: true, used: undefined } });
  expect(h.doc.getElementById("donut-arc")!.style.display).toBe("none");
  dispatch(h.window, { type: "modelChanged", modelId: "other" });
  expect(h.doc.getElementById("donut")!.hidden).toBe(true);
});

it("shows the selected model and effort while preserving the settings menu", () => {
  const h = bootWebview();
  dispatch(h.window, { type: "initialState", effort: "high" } as never);
  dispatch(h.window, { type: "session", provider: "codex", sessionId: "s", currentModelId: "gpt-test",
    models: [{ modelId: "gpt-test", name: "GPT Test" }] });
  const button = h.doc.getElementById("gear-btn")!;
  expect(button.querySelector(".composer-model-name")!.textContent).toBe("GPT Test");
  expect(button.querySelector(".composer-model-effort")!.textContent).toBe("high");
  click(h.window, button);
  expect(h.doc.getElementById("gear-popover")!.hidden).toBe(false);
  expect(h.doc.getElementById("gear-popover")!.textContent).toContain("Model and Effort");
});
