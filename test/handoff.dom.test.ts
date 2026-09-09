// DOM-level test of the AP-11 thread actions — drives the real media/chat.js
// inside happy-dom.
//
// Two placements are load-bearing and are what this file pins. "Second
// opinion" belongs to the turn that just ended, so it lives on that turn's
// single footer and disappears from older ones; "Hand off" belongs to the
// state of the work, so it lives in the review panel, which is only on screen
// when there is work to hand over.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

function completeTurn(window: Window, text = "hello") {
  dispatch(window, { type: "userMessage", text });
  dispatch(window, { type: "agentStart" });
  dispatch(window, { type: "messageChunk", text: "sure" });
  dispatch(window, { type: "promptComplete", meta: { totalTokens: 10 } });
  dispatch(window, { type: "agentEnd" });
}

function withChanges(window: Window, path = "src/a.ts") {
  dispatch(window, {
    type: "reviewCenter",
    currentTurnId: "1",
    files: [{
      path,
      added: 3,
      removed: 1,
      turnAdded: 3,
      turnRemoved: 1,
      completed: true,
      turnCompleted: true,
      diff: { path, oldText: "a", newText: "b" },
      turnDiff: { path, oldText: "a", newText: "b" },
    }],
  });
}

const RESULT = {
  type: "agentResult" as const,
  id: "run-1-1",
  runId: "run-1",
  step: 1,
  role: "reviewer",
  provider: "claude" as const,
  providerName: "Claude",
  model: "claude-opus-5",
  cost: "$0.12",
  outcome: "completed" as const,
  summary: "Read the diff.",
  files: [],
  open: [],
  failed: [],
};

describe("second opinion lives on the turn footer", () => {
  it("appears on a completed turn and asks the host for a second opinion", () => {
    const { window, doc, posted } = bootWebview();
    completeTurn(window);
    withChanges(window);
    const btn = doc.querySelector(".msg-second-opinion-btn") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
    click(window, btn);
    expect(posted).toContainEqual({ type: "requestHandoff", kind: "second-opinion" });
  });

  it("is visible but disabled when the turn changed nothing", () => {
    // Disabled, not hidden — the AP-01 rule for an action that does not apply.
    // Hiding it would also make the footer jump as turns come and go.
    const { window, doc, posted } = bootWebview();
    completeTurn(window);
    const btn = doc.querySelector(".msg-second-opinion-btn") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(true);
    expect(btn.title).toContain("Nothing changed");
    click(window, btn);
    expect(posted).toEqual([]);
  });

  it("exists once, on the newest turn only", () => {
    // A turn's prose is split across several .msg.agent blocks and several
    // turns pile up in a thread. One button, on the latest conclusion.
    const { window, doc } = bootWebview();
    completeTurn(window, "first");
    withChanges(window);
    completeTurn(window, "second");
    withChanges(window);
    const buttons = [...doc.querySelectorAll(".msg-second-opinion-btn")];
    expect(buttons).toHaveLength(1);
    const footers = [...doc.querySelectorAll(".msg.agent .msg-actions")];
    expect(footers.length).toBeGreaterThan(1);
    expect(footers[footers.length - 1].querySelector(".msg-second-opinion-btn")).toBeTruthy();
  });

  it("does not disturb the footer order the thumbs rely on", () => {
    // turn-feedback.dom.test.ts pins Copy → thumbs → timestamp as adjacent.
    // This button is appended after all of it rather than woven in.
    const { window, doc } = bootWebview();
    dispatch(window, { type: "session", sessionId: "s1", models: [], currentModelId: "grok-build", provider: "grok" });
    dispatch(window, { type: "feedbackAvailability", available: true });
    completeTurn(window);
    withChanges(window);
    const actions = doc.querySelector(".msg.agent .msg-actions") as HTMLElement;
    const thumbs = actions.querySelector(".msg-thumbs") as HTMLElement;
    const ts = actions.querySelector(".msg-timestamp") as HTMLElement;
    expect(thumbs.nextElementSibling).toBe(ts);
    expect(ts.nextElementSibling).toBe(actions.querySelector(".msg-second-opinion-btn"));
  });
});

describe("handoff lives in the review panel", () => {
  it("asks the host for a handoff when clicked", () => {
    const { window, doc, posted } = bootWebview();
    withChanges(window);
    const panel = doc.getElementById("review-center") as HTMLElement;
    expect(panel.hidden).toBe(false);
    const btn = doc.getElementById("review-handoff") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    click(window, btn);
    expect(posted).toContainEqual({ type: "requestHandoff", kind: "handoff" });
  });

  it("is out of sight together with the panel when nothing has changed", () => {
    // The panel hides itself on an empty list, and the action goes with it:
    // there is nothing to hand over before the first edit.
    const { window, doc } = bootWebview();
    dispatch(window, { type: "reviewCenter", currentTurnId: "1", files: [] });
    expect((doc.getElementById("review-center") as HTMLElement).hidden).toBe(true);
  });
});

describe("the result card says what commissioned the run", () => {
  it("labels a second opinion", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...RESULT, origin: "second-opinion" });
    expect(doc.querySelector(".card.agent-result .card-subtitle")!.textContent)
      .toContain("second opinion");
  });

  it("labels a handoff", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { ...RESULT, origin: "handoff" });
    expect(doc.querySelector(".card.agent-result .card-subtitle")!.textContent)
      .toContain("handoff");
  });

  it("renders a card from before AP-11, which carries no origin at all", () => {
    // Replayed buffers hold cards written by an older host. The field is
    // additive, so its absence must read as "typed", not as a blank chip.
    const { window, doc } = bootWebview();
    dispatch(window, RESULT);
    const meta = doc.querySelector(".card.agent-result .card-subtitle")!.textContent!;
    expect(meta).toContain("Claude");
    expect(meta).not.toContain("handoff");
    expect(meta).not.toContain("second opinion");
    expect(meta).not.toContain("undefined");
  });
});
