import { describe, expect, it } from "vitest";
import { bootWebview, click, dispatch } from "./webview-harness";

describe("workflow process design", () => {
  it("groups agents by step, folds completed steps and preserves native controls", () => {
    const h = bootWebview();
    const update = { kind: "workflow", id: "w", title: "Review", displayName: "review", phase: "running", done: false,
      failed: false, cancelled: false, currentPhaseId: "review", phases: [
        { id: "inspect", title: "Inspect", state: "done" }, { id: "review", title: "Review", state: "running" },
        { id: "verify", title: "Verify", state: "pending" },
      ], agents: [{ label: "Inspector", phase: "inspect", state: "done" }, { label: "Reviewer", phase: "review", state: "running" }] };
    dispatch(h.window, { type: "runProgress", update } as never);
    const card = h.doc.querySelector(".run-progress-card")!;
    const groups = card.querySelectorAll<HTMLDetailsElement>(".workflow-group");
    expect(groups).toHaveLength(2); expect(groups[0].open).toBe(false); expect(groups[1].open).toBe(true);
    expect(groups[0].textContent).toContain("Inspector"); expect(groups[0].textContent).not.toContain("Reviewer");
    expect(card.querySelector('[aria-current="step"]')?.textContent).toContain("Review");
    expect(card.querySelectorAll(".workflow-stepper button")).toHaveLength(2);
    expect(card.querySelectorAll(".workflow-stepper span.workflow-process-step")).toHaveLength(1);
    click(h.window, card.querySelector(".workflow-stepper button")!); expect(groups[0].open).toBe(true);
    click(h.window, card.querySelector(".run-progress-actions button")!);
    expect(h.posted.at(-1)).toEqual({ type: "workflowControl", action: "pause", displayName: "review" });
    dispatch(h.window, { type: "runProgress", update: { ...update, phase: "paused", phases: update.phases.map(p => p.id === "review" ? { ...p, state: "paused" } : p) } } as never);
    expect(card.querySelector('[data-state="paused"]')).not.toBeNull();
    click(h.window, card.querySelector(".run-progress-actions button")!);
    expect(h.posted.at(-1)).toEqual({ type: "workflowControl", action: "resume", displayName: "review" });
  });

  it.each(["failed", "cancelled", "done"])("shows terminal step state %s", state => {
    const h = bootWebview();
    dispatch(h.window, { type: "runProgress", update: { kind: "workflow", id: "w", title: "Run", phase: state,
      done: true, failed: state === "failed", cancelled: state === "cancelled", phases: [{ id: "a", title: "Inspect", state }], agents: [] } });
    expect(h.doc.querySelector(".workflow-process-step")?.getAttribute("data-state")).toBe(state);
    expect(h.doc.querySelector(".workflow-process-step")?.tagName).toBe("SPAN");
  });

  it("retains crew session actions and groups recorded stage runs", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "sessionType", sessionId: "s", sessionType: "crew", locked: true });
    dispatch(h.window, { type: "workflowRun", run: { runId: "r", idea: "Review", workflowName: "review-only", workflowTitle: "Review",
      subtitle: "", status: "running", currentStageId: "review", stages: [{ id: "plan", title: "Plan", status: "done", sessionId: "child" },
        { id: "review", title: "Review", status: "running" }], table: [{ ordinal: 1, stageId: "plan", title: "Plan", role: "Planner",
          target: "Codex", status: "done", files: 0, sessionId: "child", duration: "2m", tokens: "10k" }] } });
    expect(h.doc.querySelectorAll("#crew-run .workflow-process-step")).toHaveLength(2);
    expect(h.doc.querySelector<HTMLDetailsElement>("#crew-run .workflow-group")?.open).toBe(false);
    expect(h.doc.querySelector("#crew-run .workflow-agent")?.textContent).toContain("Planner · Codex · done · 2m · 10k");
    click(h.window, h.doc.querySelector("#crew-run .crew-step-open")!);
    expect(h.posted.at(-1)).toEqual({ type: "openCrewSession", sessionId: "child" });
  });
});

describe("startup strip", () => {
  it("owns startup messages and rejects stale status frames", () => {
    const h = bootWebview();
    dispatch(h.window, { type: "session", sessionId: "s", provider: "grok" });
    dispatch(h.window, { type: "sessionName", sessionId: "s", name: "Test", cwd: "" });
    const strip = h.doc.getElementById("startup-strip")!;
    dispatch(h.window, { type: "startupStatus", sessionId: "s", generation: 1, sequence: 1, stage: "session" });
    expect(strip.hidden).toBe(false); expect(strip.textContent).toBe("Starting conversation");
    expect(h.doc.getElementById("welcome-version")!.hidden).toBe(true);
    dispatch(h.window, { type: "startupStatus", sessionId: "s", generation: 1, sequence: 2, stage: "consent" });
    expect(strip.textContent).toBe("Waiting for approval");
    dispatch(h.window, { type: "startupStatus", sessionId: "s", generation: 1, sequence: 1, stage: "session" });
    expect(strip.textContent).toBe("Waiting for approval");
    dispatch(h.window, { type: "startupStatus", sessionId: "s", generation: 1, sequence: 3, stage: "cli-update" });
    expect(strip.textContent).toBe("Waiting for CLI update");
    dispatch(h.window, { type: "startupStatus", sessionId: "s", generation: 1, sequence: 4, stage: null });
    expect(strip.hidden).toBe(true);
  });
});
