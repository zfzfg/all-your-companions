import { expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

it("keeps Codex catalog estimates in settings and shows only native ACP request usage", () => {
  const h = bootWebview();
  dispatch(h.window, { type: "session", provider: "codex", sessionId: "s", currentModelId: "gpt-test",
    models: [{ modelId: "gpt-test", name: "GPT Test", totalContextTokens: 400000 }] });
  expect(h.doc.getElementById("donut")!.hidden).toBe(true);
  click(h.window, h.doc.getElementById("gear-btn")!);
  expect(h.doc.querySelector(".codex-context-estimate")!.textContent).toContain("Estimated context limit (catalog)");
  dispatch(h.window, { type: "contextUsage", context: { provider: "codex", sessionId: "s", modelId: "gpt-test",
    access: "a", generation: 1, source: "session", usageSource: "session", observedAt: 1,
    limitQuality: "verified", usageQuality: "unknown", usageSemantics: "last-request", used: 32000,
    limits: { effectiveContextTokens: 400000 } } });
  expect(h.doc.getElementById("donut-label")!.textContent).toBe("32K");
  expect(h.doc.getElementById("donut-arc")!.style.display).toBe("none");
  click(h.window, h.doc.getElementById("donut")!);
  expect(h.doc.getElementById("context-popover")!.textContent).toContain(`${(32000).toLocaleString()} tokens (ACP)`);
  expect(h.doc.getElementById("context-popover")!.textContent).not.toContain((400000).toLocaleString());
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
