// AP-11 — deriving a briefing from a live thread, without copying it.
//
// The properties pinned here are the ones the derivation is worth nothing
// without: it is deterministic, it never carries prose beyond the single user
// message it is allowed, it refuses rather than inventing an empty task, and
// it distinguishes "no steps" from "no step protocol" — the same distinction
// AP-02 had to make one level down.
import { describe, expect, it } from "vitest";
import { deriveBriefing, defaultRoleFor, handoffLabel, type ThreadContext } from "../src/handoff";
import { makeBriefing, renderBriefing } from "../src/briefing";
import { BUILTIN_ROLES } from "../src/agent-roles";
import type { PlanEntry } from "../src/plan-entries";

function entry(content: string, status: PlanEntry["status"]): PlanEntry {
  return { id: content.toLowerCase().replace(/\s+/g, "-"), content, status };
}

function ctx(over: Partial<ThreadContext> = {}): ThreadContext {
  return {
    kind: "handoff",
    lastUserText: "Get the checkout flow off the legacy token.",
    planEntries: [],
    structuredPlan: "yes",
    changedFiles: [],
    chipPaths: [],
    callerLabel: "Claude · claude-opus-5",
    ...over,
  };
}

function ok(c: ThreadContext) {
  const d = deriveBriefing(c);
  if (d.kind !== "ok") throw new Error(`expected ok, got refused: ${d.reason}`);
  return d.briefing;
}

describe("deriveBriefing — determinism", () => {
  it("returns identical output for identical input", () => {
    const c = ctx({
      planEntries: [entry("Swap the reader", "completed"), entry("Swap the writer", "pending")],
      changedFiles: ["src/a.ts"],
      chipPaths: ["src/b.ts"],
    });
    expect(JSON.stringify(deriveBriefing(c))).toBe(JSON.stringify(deriveBriefing(c)));
  });

  it("does not depend on the order of the object's own keys", () => {
    const a = ok(ctx({ changedFiles: ["src/a.ts"] }));
    const b = ok({
      callerLabel: "Claude · claude-opus-5",
      chipPaths: [],
      changedFiles: ["src/a.ts"],
      structuredPlan: "yes",
      planEntries: [],
      lastUserText: "Get the checkout flow off the legacy token.",
      kind: "handoff",
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("deriveBriefing — handoff", () => {
  it("carries open steps as the task and completed ones as decisions", () => {
    const b = ok(ctx({
      planEntries: [
        entry("Swap the reader", "completed"),
        entry("Swap the writer", "pending"),
        entry("Delete the shim", "in_progress"),
      ],
    }));
    expect(b.task).toContain("Swap the writer");
    expect(b.task).toContain("Delete the shim");
    expect(b.task).not.toContain("Swap the reader");
    expect(b.decisions.join("\n")).toContain("Swap the reader");
    expect(b.forbidden.join("\n")).toContain("Do not redo the completed steps");
  });

  it("still produces a task when no steps were reported", () => {
    const b = ok(ctx({ changedFiles: ["src/a.ts"] }));
    expect(b.task).toContain("Carry on from the state described below");
    // No completed steps means no "do not redo" line — a forbidden list that
    // points at nothing reads as a rule the role cannot check itself against.
    expect(b.forbidden.join("\n")).not.toContain("Do not redo");
  });

  it("names who did the work so far", () => {
    expect(ok(ctx()).decisions.join("\n")).toContain("Claude · claude-opus-5");
  });

  it("refuses only when the conversation is genuinely empty", () => {
    const d = deriveBriefing(ctx({ lastUserText: "" }));
    expect(d.kind).toBe("refused");
    // …but a goal alone is enough to hand over.
    expect(deriveBriefing(ctx()).kind).toBe("ok");
  });
});

describe("deriveBriefing — second opinion", () => {
  it("forbids editing, ahead of the shared base rules", () => {
    const b = ok(ctx({ kind: "second-opinion", changedFiles: ["src/a.ts"] }));
    expect(b.forbidden[0]).toContain("Do not edit, create or delete any file");
  });

  it("demands file and line in every finding", () => {
    const b = ok(ctx({ kind: "second-opinion", changedFiles: ["src/a.ts"] }));
    expect(b.acceptance).toContain("names a file and a line");
  });

  it("refuses when there is nothing to review", () => {
    const d = deriveBriefing(ctx({ kind: "second-opinion" }));
    expect(d.kind).toBe("refused");
    if (d.kind !== "refused") throw new Error("unreachable");
    expect(d.reason).toContain("nothing to review");
  });

  it("accepts completed steps as the thing under review when no diff was recorded", () => {
    // A role can finish work the diff machinery never saw (a shell command, a
    // generated file). Refusing there would refuse a legitimate review.
    expect(deriveBriefing(ctx({
      kind: "second-opinion",
      planEntries: [entry("Swap the reader", "completed")],
    })).kind).toBe("ok");
  });
});

describe("deriveBriefing — files", () => {
  it("merges changed files and chips without duplicating a path spelled differently", () => {
    const b = ok(ctx({ changedFiles: ["src\\a.ts", "src/b.ts"], chipPaths: ["./src/a.ts"] }));
    expect(b.files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("carries paths only — never a diff or a file body", () => {
    const b = ok(ctx({ changedFiles: ["src/a.ts"] }));
    const rendered = JSON.stringify(b);
    expect(rendered).not.toContain("@@");
    expect(rendered).not.toContain("+++");
  });
});

describe("deriveBriefing — provenance", () => {
  const noSteps = (over: Partial<ThreadContext>) =>
    ok(ctx({ changedFiles: ["src/a.ts"], ...over })).provenance.join("\n");

  it("separates 'no step protocol' from 'no steps reported'", () => {
    const cannot = noSteps({ structuredPlan: "no" });
    const didNot = noSteps({ structuredPlan: "yes" });
    expect(cannot).toContain("does not report a structured step list at all");
    expect(didNot).toContain("does report step lists, and reported none here");
    expect(cannot).not.toBe(didNot);
  });

  it("says so plainly when it does not know which of the two it is", () => {
    expect(noSteps({ structuredPlan: "unknown" })).toContain("not known whether this companion reports them");
  });

  it("counts the steps when there are some, whatever the capability says", () => {
    const line = ok(ctx({
      structuredPlan: "unknown",
      planEntries: [entry("a", "completed"), entry("b", "pending")],
    })).provenance.join("\n");
    expect(line).toContain("1 completed, 1 still open");
  });

  it("always states that the conversation itself did not travel", () => {
    expect(ok(ctx()).provenance.join("\n")).toContain("Not included: the conversation itself");
  });

  it("admits a missing goal instead of inventing one", () => {
    const b = ok(ctx({ lastUserText: "", changedFiles: ["src/a.ts"] }));
    expect(b.provenance.join("\n")).toContain("no user message to quote");
    expect(b.goal).toContain("did not state a goal");
  });
});

describe("the derived briefing renders through the AP-10 format", () => {
  const role = BUILTIN_ROLES.find((r) => r.name === "reviewer")!;

  it("emits the provenance section, between Already decided and Do not", () => {
    const derived = ok(ctx({ kind: "second-opinion", changedFiles: ["src/a.ts"] }));
    const md = renderBriefing(makeBriefing({ runId: "run-x", step: 1, ...derived }), role);
    expect(md).toContain("## Where this came from");
    expect(md.indexOf("## Already decided")).toBeLessThan(md.indexOf("## Where this came from"));
    expect(md.indexOf("## Where this came from")).toBeLessThan(md.indexOf("## Do not"));
  });

  it("still renders no such section for an /agent briefing", () => {
    const md = renderBriefing(makeBriefing({ runId: "run-x", step: 1, task: "do a thing" }), role);
    expect(md).not.toContain("## Where this came from");
  });
});

describe("action defaults", () => {
  it("sends a second opinion to a role that wants a different provider", () => {
    const reviewer = BUILTIN_ROLES.find((r) => r.name === defaultRoleFor("second-opinion"));
    expect(reviewer?.preferDifferentProvider).toBe(true);
  });

  it("names a shipped role for both actions, so a button always has a target", () => {
    for (const kind of ["handoff", "second-opinion"] as const) {
      expect(BUILTIN_ROLES.some((r) => r.name === defaultRoleFor(kind))).toBe(true);
      expect(handoffLabel(kind).length).toBeGreaterThan(0);
    }
  });
});
