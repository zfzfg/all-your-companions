import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeCrewRun, stepsFromPlan } from "../src/crew";
import { briefingForCrewStep, fixerTitle, verifyInsertsFixer } from "../src/crew-run";
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
