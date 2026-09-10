import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeCrewRun, stepsFromPlan } from "../src/crew";
import { applyReviewCadence, briefingForCrewStep, fixerTitle, verifyInsertsFixer } from "../src/crew-run";
import type { PlanEntry } from "../src/plan-entries";

const root = dirname(fileURLToPath(import.meta.url));

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const entries: PlanEntry[] = [
  { id: "1", content: "Write src/a.ts", status: "pending" },
  { id: "2", content: "Review src/a.ts", status: "pending" },
];

describe("briefingForCrewStep", () => {
  it("feeds the next step with observed files, not just the previous self-report", () => {
    const run = makeCrewRun({
      runId: "run-1",
      goal: "Ship it",
      cwd: "/r",
      steps: stepsFromPlan(entries),
    });
    const brief = briefingForCrewStep({
      run,
      step: run.steps[1],
      previous: {
        summary: "wrote the parser",
        filesReported: ["src/a.ts"],
        filesObserved: ["src/a.ts", "src/b.ts"],
      },
    });
    expect(brief.files).toContain("src/b.ts");
    expect(brief.decisions?.some((d) => d.includes("did not report") && d.includes("src/b.ts"))).toBe(true);
    expect(brief.task).toBe("Review src/a.ts");
    expect(brief.goal).toBe("Ship it");
  });
});

describe("/crew async boundary (source pin)", () => {
  it("parses /crew synchronously at both intercepts, awaits only on a hit", () => {
    const src = readFileSync(join(root, "..", "src", "sidebar.ts"), "utf8");
    const sendCase = src.slice(src.indexOf('case "send":'), src.indexOf("let queuedSendCommit"));
    expect(sendCase).toContain('if (parseCrewCommand(msg.text).kind !== "none") {');
    expect(sendCase).not.toMatch(/if \(await this\.handleCrewCommand/);
    const headStart = src.indexOf("const session = target ?? this.focused;");
    const head = src.slice(
      headStart,
      src.indexOf("await this.waitForSessionStart(session);", headStart),
    );
    expect(head).toContain('if (parseCrewCommand(text).kind !== "none") {');
    const beforeCrew = stripComments(head.slice(0, head.indexOf("if (parseCrewCommand(text)")));
    // /agent and /handoff may await on THEIR hits; those are after their own
    // synchronous guards. Nothing may await before the first of the three.
    const beforeAgent = stripComments(head.slice(0, head.indexOf("if (parseAgentCommand(text)")));
    expect(beforeAgent).not.toMatch(/\bawait\b/);
    expect(beforeCrew).toContain("parseAgentCommand");
  });

  it("walks independent steps with Promise.all when the preset is parallel", () => {
    const src = readFileSync(join(root, "..", "src", "sidebar.ts"), "utf8");
    const from = src.indexOf("private async handleCrewCommand");
    const body = src.slice(from, src.indexOf("private async askCrewAssignment", from));
    expect(body).toContain("nextIndependentSteps");
    expect(body).toContain("Promise.all(prepared.map(runOne))");
    expect(body).toContain("createCrewWorktree");
    expect(body).toContain("applyCrewWorktree");
  });
});

describe("verifyInsertsFixer", () => {
  it("inserts fixer only when the check is red", () => {
    expect(verifyInsertsFixer(undefined)).toBe(false);
    expect(verifyInsertsFixer({ code: 0, output: "ok" })).toBe(false);
    expect(verifyInsertsFixer({ code: 1, output: "fail" })).toBe(true);
    expect(fixerTitle({ command: "npm test", output: "not ok\n" })).toMatch(/npm test/);
  });
});

/**
 * `review_every:` was parsed and never read, so a flow asking to be reviewed
 * every two steps was reviewed only at the end — the failure being that a
 * wrong decision in step 2 is found after step 9 has built on it.
 */
describe("applyReviewCadence", () => {
  const run = (titles: string[], role = "implementer") =>
    makeCrewRun({
      runId: "r1",
      goal: "g",
      cwd: "/w",
      steps: stepsFromPlan(titles.map((content, i) => ({ id: String(i), content, status: "pending" as const }))).map(
        (step) => ({ ...step, role }),
      ),
    });

  it("splices a review after every N working steps", () => {
    const next = applyReviewCadence(run(["a", "b", "c", "d", "e"]), 2, "reviewer");
    const roles = next.steps.map((step) => step.role);
    expect(roles).toEqual(["implementer", "implementer", "reviewer", "implementer", "implementer", "reviewer", "implementer"]);
    // Re-indexed contiguously — a spliced list with stale indexes would send
    // the run loop to the wrong step.
    expect(next.steps.map((step) => step.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("never adds a review as the very last step", () => {
    // The run already ends in `review` with the combined diff; a trailing
    // reviewer would be a second, redundant session on every crew.
    const next = applyReviewCadence(run(["a", "b", "c", "d"]), 2, "reviewer");
    expect(next.steps[next.steps.length - 1].role).toBe("implementer");
    expect(next.steps.filter((step) => step.role === "reviewer")).toHaveLength(1);
  });

  it("does not count planner or existing review steps towards the cadence", () => {
    const mixed = makeCrewRun({
      runId: "r1",
      goal: "g",
      cwd: "/w",
      steps: [
        { index: 1, title: "plan", role: "planner", status: "assigned", filesReported: [], filesObserved: [] },
        { index: 2, title: "a", role: "implementer", status: "assigned", filesReported: [], filesObserved: [] },
        { index: 3, title: "b", role: "implementer", status: "assigned", filesReported: [], filesObserved: [] },
        { index: 4, title: "c", role: "implementer", status: "assigned", filesReported: [], filesObserved: [] },
      ],
    });
    const next = applyReviewCadence(mixed, 2, "reviewer");
    expect(next.steps.map((step) => step.role)).toEqual(["planner", "implementer", "implementer", "reviewer", "implementer"]);
  });

  it("is a no-op for a cadence of zero, a missing role, or a run of one step", () => {
    const one = run(["a", "b", "c"]);
    expect(applyReviewCadence(one, 0, "reviewer")).toBe(one);
    expect(applyReviewCadence(one, 2, "")).toBe(one);
    expect(applyReviewCadence(run(["a"]), 1, "reviewer").steps).toHaveLength(1);
  });

  it("leaves the run it was given untouched", () => {
    const before = run(["a", "b", "c"]);
    const count = before.steps.length;
    applyReviewCadence(before, 2, "reviewer");
    expect(before.steps).toHaveLength(count);
  });

  it("marks the spliced step assigned, with a reason the log can carry", () => {
    const next = applyReviewCadence(run(["a", "b", "c"]), 2, "reviewer");
    const review = next.steps.find((step) => step.role === "reviewer")!;
    expect(review.status).toBe("assigned");
    expect(review.assignWhy).toContain("review cadence");
  });
});
