import { describe, expect, it } from "vitest";
import { HostSlotLedger, RootRunBudget } from "../src/crew-budget";
import { decideFailover, rateBackoffMs } from "../src/crew-failover";
import { CrewMailbox } from "../src/crew-mailbox";
import { diagnosisLine, redactDiagnosis } from "../src/crew-diagnosis";
import { createForkGroup, joinDecision, markBranch, noteJoined } from "../src/workflow-fork";
import { threeWayTextMerge } from "../src/worktree-merge";
import { workflowFromStagesJson } from "../src/workflow";

describe("HostSlotLedger", () => {
  it("does not hand the same free slot to two runs", () => {
    let free = 1;
    const ledger = new HostSlotLedger(() => free);
    expect(ledger.tryAcquire(1)).toBe(1);
    expect(ledger.tryAcquire(1)).toBe(0);
    ledger.release(1);
    expect(ledger.tryAcquire(1)).toBe(1);
    free = 0;
    ledger.release(1);
    expect(ledger.tryAcquire(1)).toBe(0);
  });
});

describe("RootRunBudget", () => {
  it("counts two grandchildren against one cap", () => {
    const budget = new RootRunBudget({ maxActive: 1, maxStarts: 2 });
    expect(budget.tryStart().ok).toBe(true);
    expect(budget.tryStart()).toMatchObject({ ok: false, reason: "active-children" });
    budget.finish();
    expect(budget.tryStart().ok).toBe(true);
    budget.finish();
    expect(budget.tryStart()).toMatchObject({ ok: false, reason: "starts" });
  });
});

describe("decideFailover", () => {
  it("waits on a short rate limit, switches only on quota, and stops on auth", () => {
    expect(decideFailover({
      kind: "rate", policy: "switch", attempt: 1, maxAttempts: 3, exhausted: [], usable: ["claude"], rand: () => 0,
    })).toMatchObject({ action: "wait" });
    expect(rateBackoffMs(1, () => 0)).toBe(1000);
    expect(decideFailover({
      kind: "quota", policy: "switch", attempt: 1, maxAttempts: 3, exhausted: ["claude"], usable: ["claude", "codex"],
    })).toMatchObject({ action: "switch", provider: "codex" });
    expect(decideFailover({
      kind: "auth", policy: "switch", attempt: 1, maxAttempts: 3, exhausted: [], usable: ["codex"],
    })).toMatchObject({ action: "stop" });
    expect(decideFailover({
      kind: "quota", policy: "switch", attempt: 1, maxAttempts: 3, exhausted: [], usable: ["codex"], explicitTarget: true,
    }).action).toBe("stop");
    expect(decideFailover({
      kind: "quota", policy: "ask", attempt: 1, maxAttempts: 3, exhausted: [], usable: ["codex"],
    }).action).toBe("stop");
  });
});

describe("CrewMailbox", () => {
  it("delivers once, rejects a foreign attempt, and does not duplicate an id", () => {
    let now = 1_000;
    const box = new CrewMailbox({ now: () => now, maxBody: 20, ttlMs: 50 });
    const sent = box.send({ id: "m1", from: "parent", to: "child", rootRunId: "run", attemptId: "1", type: "note", body: "look here" });
    expect(sent.ok).toBe(true);
    expect(box.send({ id: "m1", from: "parent", to: "child", rootRunId: "run", attemptId: "1", type: "note", body: "other" })).toMatchObject({ ok: true });
    expect(box.read("child", { rootRunId: "run", attemptId: "2" })).toEqual([]);
    const page = box.read("child", { rootRunId: "run", attemptId: "1" });
    expect(page.map((item) => item.body)).toEqual(["look here"]);
    expect(page[0]?.state).toBe("delivered");
    box.send({ id: "m-old", from: "parent", to: "child", rootRunId: "run", attemptId: "1", type: "note", body: "stale" });
    now = 2_000;
    expect(box.read("child", { rootRunId: "run", attemptId: "1" }).map((item) => item.id)).not.toContain("m-old");
    expect(box.send({ id: "m2", from: "parent", to: "child", rootRunId: "run", attemptId: "1", type: "note", body: "x".repeat(21) }).ok).toBe(false);
  });
});

describe("fork join", () => {
  it("joins once, and an old visit does not satisfy the new iteration", () => {
    let group = createForkGroup({
      runId: "run",
      groupId: "g",
      iteration: 2,
      branches: [{ id: "a", stageId: "ui" }, { id: "b", stageId: "api" }],
    });
    group = markBranch(group, "a", "succeeded", 1);
    expect(joinDecision(group).ready).toBe(false);
    group = markBranch(group, "a", "succeeded", 2);
    group = markBranch(group, "b", "failed", 2);
    expect(joinDecision(group)).toMatchObject({ ready: true, ok: false });
    group = markBranch(createForkGroup({
      runId: "run", groupId: "g", iteration: 2,
      branches: [{ id: "a", stageId: "ui" }, { id: "b", stageId: "api" }],
    }), "a", "succeeded", 2);
    group = markBranch(group, "b", "succeeded", 2);
    const once = noteJoined(group);
    expect(once.joined).toBe(true);
    expect(noteJoined(once)).toBe(once);
    expect(joinDecision(once).ready).toBe(false);
  });
});

describe("threeWayTextMerge", () => {
  it("merges disjoint edits and refuses an overlap without writing markers", () => {
    const base = "a\nb\nc\n";
    expect(threeWayTextMerge(base, "a\nB\nc\n", "a\nb\nC\n")).toEqual({ clean: true, text: "a\nB\nC\n" });
    const conflict = threeWayTextMerge(base, "a\nB\nc\n", "a\nX\nc\n");
    expect(conflict.clean).toBe(false);
    if (!conflict.clean) expect(conflict.reason).toBe("conflict");
    expect(threeWayTextMerge("a\0", "a", "b").clean).toBe(false);
  });
});

describe("workflow schema 2", () => {
  it("rejects a v1 document that carries a fork instead of dropping it", () => {
    const parsed = workflowFromStagesJson({
      name: "forked",
      whenToUse: "when",
      schemaVersion: 1,
      stages: [{ id: "plan", title: "Plan", role: "planner", contract: "plan", fork: { id: "g", join: "all", branches: [] }, next: [{ to: "$done" }] }],
      contracts: { plan: { purpose: "p", inputs: [{ from: "idea", as: "Goal" }], output: { sections: [], resultBlock: { required: ["summary"] } } } },
    }, { source: "project" });
    expect(parsed.ok).toBe(false);
  });
});

describe("diagnosis lines", () => {
  it("drops a bearer token", () => {
    expect(redactDiagnosis("auth Bearer abc.def failed")).not.toContain("abc.def");
    expect(diagnosisLine({ runId: "r", seq: 1, reason: "ok" })).toContain("run=r");
  });
});
