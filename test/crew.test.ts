import { describe, expect, it } from "vitest";
import {
  applyStepOutcome,
  cancelCrewRun,
  crewCostTicks,
  crewProgress,
  insertCrewStep,
  makeCrewRun,
  nextRunnableStep,
  startCrewStep,
  stepsFromPlan,
} from "../src/crew";
import type { PlanEntry } from "../src/plan-entries";

const entries: PlanEntry[] = [
  { id: "p1", content: "Write src/a.ts", status: "pending" },
  { id: "p2", content: "Review src/a.ts", status: "pending" },
  { id: "p3", content: "  ", status: "pending" },
  { id: "p4", content: "Ship it", status: "pending" },
];

describe("stepsFromPlan", () => {
  it("drops empty titles and numbers 1-based, keeping the AP-02 id only as a hint", () => {
    const steps = stepsFromPlan(entries);
    expect(steps.map((s) => ({ index: s.index, title: s.title, hint: s.planEntryHint }))).toEqual([
      { index: 1, title: "Write src/a.ts", hint: "p1" },
      { index: 2, title: "Review src/a.ts", hint: "p2" },
      { index: 3, title: "Ship it", hint: "p4" },
    ]);
    expect(steps.every((s) => s.status === "pending")).toBe(true);
  });
});

describe("nextRunnableStep / applyStepOutcome", () => {
  const base = makeCrewRun({
    runId: "run-1",
    goal: "Ship AP-12",
    cwd: "/repo",
    steps: stepsFromPlan(entries),
  });

  it("walks sequentially and never runs a step twice", () => {
    expect(nextRunnableStep(base)?.index).toBe(1);
    const running = startCrewStep(base, 1);
    expect(nextRunnableStep(running)).toBeUndefined();
    const after = applyStepOutcome(running, 1, { status: "done", filesObserved: ["src/a.ts"] });
    expect(after.steps[0].status).toBe("done");
    expect(after.steps[0].filesObserved).toEqual(["src/a.ts"]);
    expect(nextRunnableStep(after)?.index).toBe(2);
    const again = applyStepOutcome(after, 1, { status: "failed", detail: "no" });
    expect(again).toBe(after);
  });

  it("keeps the run `running` while a sibling step is still in flight", () => {
    const two = startCrewStep(startCrewStep(base, 1), 2);
    expect(two.steps.filter((s) => s.status === "running")).toHaveLength(2);
    const after = applyStepOutcome(two, 1, { status: "done" });
    expect(after.status).toBe("running");
    expect(after.steps[1].status).toBe("running");
    expect(nextRunnableStep(after)).toBeUndefined();
  });

  it("pauses the chain on failure rather than continuing", () => {
    const running = startCrewStep(base, 1);
    const paused = applyStepOutcome(running, 1, { status: "failed", detail: "boom" });
    expect(paused.status).toBe("paused");
    expect(paused.stoppedReason).toBe("boom");
    expect(nextRunnableStep(paused)).toBeUndefined();
  });

  it("is immutable — applyStepOutcome does not mutate the input", () => {
    const running = startCrewStep(base, 1);
    const copy = JSON.parse(JSON.stringify(running));
    applyStepOutcome(running, 1, { status: "done" });
    expect(running).toEqual(copy);
  });

  it("cancel skips remaining work and does not leave a running step", () => {
    const running = startCrewStep(base, 1);
    const cancelled = cancelCrewRun(running, "Stop");
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.steps[0].status).toBe("failed");
    expect(cancelled.steps.slice(1).every((s) => s.status === "skipped")).toBe(true);
    expect(nextRunnableStep(cancelled)).toBeUndefined();
  });

  it("inserts a fixer after the current step and reindexes", () => {
    const after = applyStepOutcome(startCrewStep(base, 1), 1, { status: "done" });
    const withFixer = insertCrewStep(after, 1, {
      title: "Make npm test pass",
      role: "fixer",
      assignWhy: "verify failed",
    });
    expect(withFixer.steps.map((s) => [s.index, s.role ?? "", s.title])).toEqual([
      [1, "", "Write src/a.ts"],
      [2, "fixer", "Make npm test pass"],
      [3, "", "Review src/a.ts"],
      [4, "", "Ship it"],
    ]);
    expect(nextRunnableStep(withFixer)?.index).toBe(2);
  });

  it("sums cost ticks across steps", () => {
    let run = applyStepOutcome(startCrewStep(base, 1), 1, { status: "done", costUsdTicks: 10 });
    run = applyStepOutcome(startCrewStep(run, 2), 2, { status: "done", costUsdTicks: 25 });
    expect(crewCostTicks(run)).toBe(35);
    expect(crewProgress(run)).toEqual({ done: 2, total: 3, failed: 0 });
  });

  it("moves to review when the last step completes", () => {
    let run = base;
    for (const i of [1, 2, 3]) {
      run = applyStepOutcome(startCrewStep(run, i), i, { status: "done" });
    }
    expect(run.status).toBe("review");
    expect(nextRunnableStep(run)).toBeUndefined();
  });
});
