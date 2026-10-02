import { expect, it } from "vitest";
import { bootWebview, dispatch } from "./webview-harness";

it("keeps native workflow controls absent and associates reported agents with steps", () => {
  const h = bootWebview();
  try {
    dispatch(h.window, { type: "runProgress", update: { kind: "workflow", id: "native", title: "Review", phase: "paused", done: false, failed: false, cancelled: false, controlsAvailable: false,
      phases: [ { id: "a", title: "Inspect" }, { id: "b", title: "Review" }, { id: "c", title: "Verify" }, { id: "d", title: "Finish" } ], agents: [{ label: "Reviewer", phase: "b", state: "paused" }] } });
    const card = h.doc.querySelector(".run-progress-card")!;
    expect(card.textContent).toContain("Native workflow");
    expect(card.querySelector(".workflow-stepper")?.textContent).toBe("InspectReviewVerifyFinish");
    expect(card.querySelectorAll(".workflow-stepper button")).toHaveLength(1);
    expect(card.querySelector("summary")?.textContent).toContain("Review");
    expect(card.querySelector(".native-workflow-roster")?.textContent).toContain("Reviewer · paused");
    expect(card.querySelector(".blink-dots")).toBeNull();
    expect(card.querySelector(".run-progress-actions")?.hasAttribute("hidden")).toBe(true);
  } finally { void h.window.happyDOM.abort(); }
});

it("does not advertise Muse Plan or unconfirmed mode changes", () => {
  const h = bootWebview();
  try {
    dispatch(h.window, { type: "session", provider: "muse", sessionId: "muse", models: [] });
    dispatch(h.window, { type: "modeChanged", modeId: "agent", modes: ["agent", "yolo"] });
    h.doc.getElementById("mode-btn")!.click();
    const labels = [...h.doc.querySelectorAll(".mode-item-label")].map(el => el.textContent);
    expect(labels).toEqual(["Prompt unmatched", "Full access"]);
  } finally { void h.window.happyDOM.abort(); }
});
