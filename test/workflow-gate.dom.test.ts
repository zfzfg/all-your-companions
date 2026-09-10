// AP-17 gate card — real chat.js in happy-dom.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const gateView = (over: Record<string, unknown> = {}) => ({
  runId: "run-1",
  idea: "Ship AP-17",
  workflowName: "idea-to-done",
  workflowTitle: "Idea to done",
  status: "at-gate",
  subtitle: "Crew · paused before Implement (1/4)",
  stages: [
    { id: "plan", title: "Plan", status: "done" },
    { id: "implement", title: "Implement", status: "pending" },
  ],
  currentStageId: "implement",
  gate: {
    kind: "normal",
    title: "Stage 1 of ~4 done: Plan",
    reason: "Next stage: Implement",
    summary: "A four-step plan.",
    proposedNext: [{ id: "implement", title: "Implement" }],
    nextStageId: "implement",
    eligible: [{ provider: "claude", displayName: "Claude" }],
    ineligible: [],
    ...((over.gate as object) ?? {}),
  },
  ...over,
});

describe("workflow gate card (real chat.js in a DOM)", () => {
  it("renders the copy-deck title and Start / Stop & resume later / Cancel", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "workflowRun", run: gateView() });
    const card = doc.querySelector(".workflow-gate-card")!;
    expect(card.textContent).toMatch(/Stage 1 of ~4 done: Plan/);
    const labels = [...card.querySelectorAll(".gate-actions button")].map((b) => b.textContent);
    expect(labels).toContain("Start Implement");
    expect(labels).toContain("Stop & resume later");
    expect(labels).toContain("Cancel run");
    expect(labels).toContain("Skip this stage");
  });

  it("Gate 0 uses Start stage / Change workflow / Stop & resume later", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "workflowRun",
      run: gateView({
        gate: {
          kind: "gate-0",
          title: "Next stage: Plan",
          reason: "Next stage: Plan",
          proposedNext: [{ id: "plan", title: "Plan" }],
          nextStageId: "plan",
          eligible: [],
          ineligible: [],
        },
      }),
    });
    const labels = [...doc.querySelectorAll(".gate-actions button")].map((b) => b.textContent);
    expect(labels).toContain("Start stage");
    expect(labels).toContain("Change workflow");
    expect(labels).toContain("Stop & resume later");
  });

  it("fixer-limit uses the copy-deck reason and the three options", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "workflowRun",
      run: gateView({
        gate: {
          kind: "fixer-limit",
          title: "Stage 5 of ~4 done: Review",
          reason: "Review still requests changes after 2 fix rounds.",
          proposedNext: [{ id: "$pause", title: "Paused" }, { id: "$done", title: "Done" }, { id: "$cancel", title: "Cancel" }],
          eligible: [],
          ineligible: [],
        },
      }),
    });
    expect(doc.querySelector(".workflow-gate-card")!.textContent).toMatch(
      /Review still requests changes after 2 fix rounds/,
    );
    const labels = [...doc.querySelectorAll(".gate-actions button")].map((b) => b.textContent);
    expect(labels).toContain("Another round");
    expect(labels).toContain("Accept as is");
    expect(labels).toContain("Cancel run");
  });

  it("staleness shows Continue anyway", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "workflowRun",
      run: gateView({
        gate: {
          kind: "stale",
          title: "Stage 1 of ~4 done: Plan",
          reason: "The workspace changed since this run paused.",
          staleDetails: ["HEAD moved."],
          proposedNext: [{ id: "implement", title: "Implement" }],
          eligible: [],
          ineligible: [],
        },
      }),
    });
    expect(doc.querySelector(".workflow-gate-card")!.textContent).toMatch(
      /The workspace changed since this run paused/,
    );
    expect([...doc.querySelectorAll(".gate-actions button")].map((b) => b.textContent)).toContain("Continue anyway");
  });

  it("Start posts workflowGateAction", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "workflowRun", run: gateView() });
    click(window, [...doc.querySelectorAll(".gate-actions button")].find((b) => b.textContent?.startsWith("Start"))!);
    expect(posted.some((m) => m.type === "workflowGateAction" && m.action === "start")).toBe(true);
  });

  it("D8 notice carries the copy-deck button", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "hostNotice",
      level: "warning",
      text: "Crew runs live in their own session.",
      action: { id: "openCrewWithGoal", label: "Open a new Crew session with this goal", goal: "ship it" },
    });
    const btn = [...doc.querySelectorAll("button")].find((b) => b.textContent === "Open a new Crew session with this goal")!;
    expect(btn).toBeTruthy();
    click(window, btn);
    expect(posted).toContainEqual({ type: "openCrewWithGoal", goal: "ship it" });
  });

  it("empty Crew session Start workflow posts workflowStart", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "sessionType", sessionId: "s-1", sessionType: "crew", locked: false });
    dispatch(window, {
      type: "workflowList",
      workflows: [{ name: "idea-to-done", title: "Idea to done", whenToUse: "Features.", source: "builtin" }],
      defaultWorkflow: "idea-to-done",
    });
    const input = doc.getElementById("input") as HTMLTextAreaElement;
    input.value = "Ship the parser";
    click(window, doc.getElementById("crew-start")!);
    expect(posted.some((m) => m.type === "workflowStart" && m.idea === "Ship the parser" && m.workflowName === "idea-to-done")).toBe(true);
  });
});
