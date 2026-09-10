import { describe, expect, it } from "vitest";
import { IDEA_TO_DONE, applyMaxFixerPasses, workflowSnapshotHash } from "../src/workflow";
import {
  applyGateAction,
  applyStageOutcome,
  applyStaleness,
  forcedManualReasons,
  historySubtitle,
  makeWorkflowRun,
  markExhausted,
  nextFromTransitions,
  observedFilesHash,
  parseGateMessage,
  parseWorkflowRun,
  resumeStaleness,
  serializeWorkflowRun,
  skipProposed,
  snapshotDrift,
  startStage,
  visitCount,
  withSnapshotHash,
  writeAtomic,
  WorkflowRunStore,
  type WorkflowRun,
} from "../src/workflow-run";
import type { HandoffPacket } from "../src/workflow-handoff";

function runAtGate0(over: Partial<Parameters<typeof makeWorkflowRun>[0]> = {}) {
  return makeWorkflowRun({
    runId: "run-1",
    sessionId: "s-1",
    workflow: IDEA_TO_DONE,
    idea: "Ship AP-17",
    cwd: "/repo",
    ...over,
  });
}

function donePacket(over: Partial<HandoffPacket> & { stageId: string; stageOrdinal: number; visit?: number }): HandoffPacket {
  return {
    version: 1,
    runId: "run-1",
    visit: over.visit ?? 1,
    role: over.stageId,
    target: { provider: "claude", modelVerified: true },
    status: "done",
    summary: "ok",
    filesReported: [],
    filesObserved: [],
    unreported: [],
    claimedOnly: [],
    durationMs: 1,
    resultPath: `/runs/run-1/stage-0${over.stageOrdinal}.result.md`,
    ...over,
  };
}

function walk(run: WorkflowRun, packet: HandoffPacket, packets: HandoffPacket[], auto = false) {
  return applyStageOutcome(run, IDEA_TO_DONE, packet, packets, { autoStartNextStage: auto });
}

describe("idea-to-done walk", () => {
  it("gates after every stage and ends on Done after a passing review", () => {
    let run = runAtGate0();
    expect(run.status).toBe("at-gate");
    expect(run.gate?.kind).toBe("gate-0");
    expect(run.gate?.proposedNext).toEqual(["plan"]);

    run = startStage(run, "plan", 1);
    expect(run.status).toBe("running");
    const plan = donePacket({
      stageId: "plan",
      stageOrdinal: 1,
      planSteps: [{ id: "S1", title: "Do it" }],
    });
    run = walk(run, plan, [plan]);
    expect(run.status).toBe("at-gate");
    expect(run.gate?.autoProceed).toBeFalsy();
    expect(run.gate?.proposedNext).toEqual(["implement"]);

    run = applyGateAction(run, IDEA_TO_DONE, { type: "start", target: { provider: "codex" } }, 2);
    expect(run.current?.stageId).toBe("implement");
    const impl = donePacket({ stageId: "implement", stageOrdinal: 2, filesObserved: ["src/a.ts"] });
    run = walk(run, impl, [plan, impl]);
    expect(run.gate?.proposedNext).toEqual(["review"]);

    run = applyGateAction(run, IDEA_TO_DONE, { type: "start" }, 3);
    const review = donePacket({ stageId: "review", stageOrdinal: 3, verdict: "pass" });
    run = walk(run, review, [plan, impl, review]);
    expect(run.gate?.proposedNext).toEqual(["$done"]);
    run = applyGateAction(run, IDEA_TO_DONE, { type: "finish" }, 4);
    expect(run.status).toBe("done");
    expect(historySubtitle(run, IDEA_TO_DONE)).toMatch(/^Done · /);
  });

  it("Review → Fix → Review loops at most maxVisits, then pauses with the three options", () => {
    let run = runAtGate0();
    run = startStage(run, "review", 1);
    const packets: HandoffPacket[] = [];
    for (let visit = 1; visit <= 2; visit += 1) {
      const review = donePacket({
        stageId: "review",
        stageOrdinal: visit * 2 - 1,
        visit,
        verdict: "changes_requested",
        findings: [{ id: "F1", severity: "major", text: "x" }],
      });
      packets.push(review);
      run = walk(run, review, packets);
      expect(run.gate?.proposedNext[0]).toBe("fix");
      run = applyGateAction(run, IDEA_TO_DONE, { type: "start" }, visit);
      const fix = donePacket({ stageId: "fix", stageOrdinal: visit * 2, visit });
      packets.push(fix);
      run = walk(run, fix, packets);
      run = applyGateAction(run, IDEA_TO_DONE, { type: "start" }, visit);
    }
    const third = donePacket({
      stageId: "review",
      stageOrdinal: 5,
      visit: 3,
      verdict: "changes_requested",
    });
    packets.push(third);
    run = walk(run, third, packets);
    expect(run.gate?.kind).toBe("fixer-limit");
    expect(run.gate?.reason).toBe("Review still requests changes after 2 fix rounds.");
    expect(run.gate?.proposedNext).toEqual(["$pause", "$done", "$cancel"]);
    expect(visitCount(run, "fix")).toBe(2);
  });

  it("pause, serialize, re-parse, start continues at the same gate", () => {
    let run = startStage(runAtGate0(), "plan", 1);
    const plan = donePacket({ stageId: "plan", stageOrdinal: 1, planSteps: [{ id: "S1", title: "x" }] });
    run = walk(run, plan, [plan]);
    run = applyGateAction(run, IDEA_TO_DONE, { type: "pause", at: 10, gitHead: "abc", observedHash: "h1" }, 10);
    expect(run.status).toBe("paused");
    expect(run.pausedAt?.gitHead).toBe("abc");
    const round = parseWorkflowRun(serializeWorkflowRun(run));
    expect(round?.gate?.proposedNext).toEqual(["implement"]);
    const continued = applyGateAction(round!, IDEA_TO_DONE, { type: "start" }, 11);
    expect(continued.status).toBe("running");
    expect(continued.current?.stageId).toBe("implement");
  });

  it("an interrupted stage is never skipped silently", () => {
    let run = startStage(runAtGate0(), "implement", 1);
    const packet = donePacket({ stageId: "implement", stageOrdinal: 1, status: "interrupted" });
    run = walk(run, packet, [packet]);
    expect(run.gate?.kind).toBe("interrupted");
    expect(run.gate?.proposedNext).toContain("implement");
    expect(run.gate?.forcedManual).toContain("stage-interrupted");
  });
});

describe("forced manual gates", () => {
  it("verify failure, unreadable verdict, unreported edits and quota force a gate even under auto", () => {
    const impl = donePacket({
      stageId: "implement",
      stageOrdinal: 1,
      unreported: ["src/secret.ts"],
      verify: { command: "npm test", exitCode: 1, outputTail: "fail" },
    });
    const reasons = forcedManualReasons(impl, IDEA_TO_DONE, [impl]);
    expect(reasons).toEqual(expect.arrayContaining(["verify-failed", "unreported-edits"]));

    const review = donePacket({ stageId: "review", stageOrdinal: 2, verdict: undefined });
    expect(forcedManualReasons(review, IDEA_TO_DONE, [impl, review])).toContain("unreadable-verdict");

    let run = startStage(runAtGate0(), "implement", 1);
    run = walk(run, impl, [impl], true);
    expect(run.gate?.autoProceed).toBeFalsy();
    expect(run.status).toBe("at-gate");
  });

  it("autoStartNextStage proceeds only when nothing requires attention", () => {
    let run = startStage(runAtGate0(), "plan", 1);
    const plan = donePacket({ stageId: "plan", stageOrdinal: 1, planSteps: [{ id: "S1", title: "x" }] });
    run = walk(run, plan, [plan], true);
    expect(run.gate?.autoProceed).toBe(true);
    expect(run.gate?.proposedNext).toEqual(["implement"]);
  });
});

describe("staleness and snapshot", () => {
  it("triggers on a changed HEAD or edited observed file", () => {
    const paused = { at: 1, gitHead: "aaa", observedHash: "h1" };
    expect(resumeStaleness(paused, { gitHead: "bbb", observedHash: "h1" }).ok).toBe(false);
    expect(resumeStaleness(paused, { gitHead: "aaa", observedHash: "h2" }).ok).toBe(false);
    expect(resumeStaleness(paused, { gitHead: "aaa", observedHash: "h1" }).ok).toBe(true);
  });

  it("a deleted worktree is unresumable", () => {
    const stale = resumeStaleness(
      { at: 1, worktree: "/wt" },
      { worktreeExists: false, worktree: "/wt" },
    );
    expect(stale).toMatchObject({ ok: false, code: "worktree-gone" });
    const run = applyStaleness(runAtGate0({ worktree: "/wt" }), stale);
    expect(run.gate?.kind).toBe("unresumable");
    expect(run.status).toBe("failed");
  });

  it("a later edit of the workflow file does not change a snapshotted run", () => {
    const snap = workflowSnapshotHash(IDEA_TO_DONE);
    const run = withSnapshotHash(runAtGate0(), snap);
    const live = workflowSnapshotHash(applyMaxFixerPasses(IDEA_TO_DONE, 9));
    expect(snapshotDrift(run, live)).toBe(true);
    expect(snapshotDrift(run, snap)).toBe(false);
  });

  it("observedFilesHash is order-insensitive", () => {
    expect(
      observedFilesHash([{ path: "b.ts", hash: "2" }, { path: "a.ts", hash: "1" }]),
    ).toBe(observedFilesHash([{ path: "a.ts", hash: "1" }, { path: "b.ts", hash: "2" }]));
  });
});

describe("gate actions and chat", () => {
  it("skip advances to the stage after the proposed one", () => {
    const run = skipProposed(runAtGate0(), IDEA_TO_DONE);
    expect(run.executed[0]?.status).toBe("skipped");
    expect(run.gate?.nextStageId).toBe("implement");
  });

  it("parseGateMessage maps copy-deck commands and everything else to notes", () => {
    expect(parseGateMessage("/pause")).toEqual({ kind: "command", command: "pause" });
    expect(parseGateMessage("skip this stage")).toEqual({ kind: "command", command: "skip" });
    expect(parseGateMessage("keep the public API stable")).toEqual({
      kind: "notes",
      text: "keep the public API stable",
    });
  });

  it("quota marks a provider exhausted and never retries it from the run itself", () => {
    const run = markExhausted(runAtGate0(), "claude");
    expect(run.exhausted).toEqual(["claude"]);
    expect(markExhausted(run, "claude").exhausted).toEqual(["claude"]);
  });
});

describe("atomic run.json", () => {
  it("writes via temp + rename and round-trips", () => {
    const files = new Map<string, string>();
    const fs = {
      mkdirSync: () => undefined,
      writeFileSync: (path: string, data: string) => { files.set(path, data); },
      renameSync: (from: string, to: string) => {
        const data = files.get(from);
        if (data === undefined) throw new Error("missing tmp");
        files.set(to, data);
        files.delete(from);
      },
      existsSync: (path: string) => files.has(path),
      readFileSync: (path: string) => files.get(path) ?? "",
    };
    const store = new WorkflowRunStore({ root: "/runs", fs, join: (...p) => p.join("/") });
    const run = withSnapshotHash(runAtGate0(), "deadbeef");
    store.writeRun(run);
    store.writeSnapshot(run.runId, '{"name":"idea-to-done"}');
    expect(files.has("/runs/run-1/run.json")).toBe(true);
    expect(files.has("/runs/run-1/run.json.tmp")).toBe(false);
    expect(store.readRun("run-1")?.idea).toBe("Ship AP-17");
    expect(store.readSnapshot("run-1")).toMatch(/idea-to-done/);
    writeAtomic(fs, "/runs/run-1/x.json", "ok");
    expect(files.get("/runs/run-1/x.json")).toBe("ok");
  });
});
