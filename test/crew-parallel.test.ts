import { describe, expect, it } from "vitest";
import { applyStepOutcome, makeCrewRun, startCrewStep, stepsFromPlan, type CrewStep } from "../src/crew";
import {
  filesHint,
  isSerialRole,
  nextIndependentSteps,
  stepsConflict,
} from "../src/crew-parallel";
import type { PlanEntry } from "../src/plan-entries";

function runOf(titles: string[], extra?: { parallel?: boolean }) {
  const entries: PlanEntry[] = titles.map((content, i) => ({ id: `p${i + 1}`, content, status: "pending" }));
  const crew = makeCrewRun({
    runId: "run-1",
    goal: "ship",
    cwd: "/r",
    steps: stepsFromPlan(entries),
    ...extra,
  });
  return crew;
}

function assign(run: ReturnType<typeof runOf>, index: number, role: string) {
  const step = run.steps.find((s) => s.index === index)!;
  step.role = role;
  step.status = "assigned";
  return run;
}

describe("filesHint / stepsConflict", () => {
  it("pulls path-like tokens out of a title", () => {
    expect(filesHint("Write src/a.ts and src/b.ts")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(filesHint("Review the parser")).toEqual([]);
  });

  it("conflicts when files overlap or either side has none", () => {
    const a: CrewStep = { index: 1, title: "Write src/a.ts", status: "assigned", filesReported: [], filesObserved: [] };
    const b: CrewStep = { index: 2, title: "Write src/b.ts", status: "assigned", filesReported: [], filesObserved: [] };
    const c: CrewStep = { index: 3, title: "Polish docs", status: "assigned", filesReported: [], filesObserved: [] };
    const d: CrewStep = { index: 4, title: "Touch src/a.ts tests", status: "assigned", filesReported: [], filesObserved: [] };
    expect(stepsConflict(a, b)).toBe(false);
    expect(stepsConflict(a, d)).toBe(true);
    expect(stepsConflict(a, c)).toBe(true);
  });
});

describe("nextIndependentSteps", () => {
  it("returns a single step when parallel is off, even if two writers look independent", () => {
    const run = assign(assign(runOf(["Write src/a.ts", "Write src/b.ts"]), 1, "implementer"), 2, "implementer");
    expect(nextIndependentSteps(run, { parallel: false, cap: 8 }).map((s) => s.index)).toEqual([1]);
  });

  it("returns both independent writers up to the pool-derived cap", () => {
    const run = assign(assign(runOf(["Write src/a.ts", "Write src/b.ts"]), 1, "implementer"), 2, "implementer");
    expect(nextIndependentSteps(run, { parallel: true, cap: 8 }).map((s) => s.index)).toEqual([1, 2]);
    expect(nextIndependentSteps(run, { parallel: true, cap: 1 }).map((s) => s.index)).toEqual([1]);
  });

  it("holds a reviewer until previous work is done, and never shares its wave", () => {
    const run = assign(assign(runOf(["Write src/a.ts", "Review src/a.ts"]), 1, "implementer"), 2, "reviewer");
    expect(isSerialRole("reviewer")).toBe(true);
    expect(nextIndependentSteps(run, { parallel: true, cap: 8 }).map((s) => s.index)).toEqual([1]);
    const after = applyStepOutcome(startCrewStep(run, 1), 1, { status: "done" });
    expect(nextIndependentSteps(after, { parallel: true, cap: 8 }).map((s) => s.index)).toEqual([2]);
  });

  it("does not start a ninth role while the cap is 1 — it waits", () => {
    const titles = ["Write src/a.ts", "Write src/b.ts", "Write src/c.ts"];
    let run = runOf(titles);
    run = assign(assign(assign(run, 1, "implementer"), 2, "implementer"), 3, "implementer");
    expect(nextIndependentSteps(run, { parallel: true, cap: 1 }).map((s) => s.index)).toEqual([1]);
    const after = applyStepOutcome(startCrewStep(run, 1), 1, { status: "done" });
    expect(nextIndependentSteps(after, { parallel: true, cap: 1 }).map((s) => s.index)).toEqual([2]);
  });
});
