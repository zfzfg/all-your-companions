import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { subagentPermissionOverlay } from "../src/companion-subagents";
import { rolePermissionsToRules } from "../src/agent-roles";
import { createRule, decidePermission } from "../src/permission-rules";
import {
  briefingFromContract,
  buildHandoffPacket,
  packetFiles,
  resolveInputPath,
  resolveStageScope,
  type HandoffPacket,
} from "../src/workflow-handoff";
import { IDEA_TO_DONE, findStage, stageRunMode } from "../src/workflow";
import { WorkflowRunStore, applyGateAction, makeWorkflowRun } from "../src/workflow-run";

function planPacket(): HandoffPacket {
  return buildHandoffPacket({
    runId: "r1",
    stageId: "plan",
    stageOrdinal: 1,
    visit: 1,
    role: "planner",
    target: { provider: "claude", modelVerified: true },
    status: "done",
    rawReply: [
      "Plan",
      "```companions-result",
      JSON.stringify({
        planSteps: [
          { id: "S1", title: "Add login route", acceptance: "route exists", files: ["src/auth.ts"] },
          { id: "S2", title: "Test it", files: ["test/auth.test.ts"] },
        ],
      }),
      "```",
    ].join("\n"),
    durationMs: 10,
    resultPath: "/runs/r1/stage-01.result.md",
    contract: IDEA_TO_DONE.contracts.plan,
  });
}

function roleRules(overlay: ReturnType<typeof subagentPermissionOverlay>) {
  return rolePermissionsToRules({ name: "stage", provider: "codex", whenToUse: "x", source: "builtin", permissions: overlay } as never);
}

const editFacts = (p: string) => ({ tool: "edit", kind: "edit" as const, paths: [p] });
const execFacts = (command: string) => ({ tool: "shell", kind: "execute" as const, command, paths: [] });

describe("stage scope (C-01)", () => {
  it("plan.files is filesReported plus every plan step's files", () => {
    const packet = planPacket();
    expect(packetFiles(packet)).toEqual(["src/auth.ts", "test/auth.test.ts"]);
    const packets = new Map([["plan", packet]]);
    expect(resolveInputPath("plan.files", { idea: "", packets }).paths).toEqual(["src/auth.ts", "test/auth.test.ts"]);
    const implement = findStage(IDEA_TO_DONE, "implement")!;
    expect(resolveStageScope(implement, packets)).toEqual({
      globs: ["src/auth.ts", "test/auth.test.ts"], sources: ["plan.files"], empty: false,
    });
  });

  it("an empty scope is empty, never 'anywhere'", () => {
    const implement = findStage(IDEA_TO_DONE, "implement")!;
    expect(resolveStageScope(implement, new Map()).empty).toBe(true);
    expect(resolveStageScope({ scope: ["docs/**"] }, new Map())).toEqual({ globs: ["docs/**"], sources: ["scope"], empty: false });
    expect(resolveStageScope({}, new Map()).empty).toBe(false);
  });

  it("read-only stages run in agent mode unless the workflow asks for plan", () => {
    expect(stageRunMode(findStage(IDEA_TO_DONE, "review")!)).toBe("agent");
    expect(stageRunMode(findStage(IDEA_TO_DONE, "plan")!)).toBe("plan");
  });
});

describe("the overlay is what enforces the profile (C-01, D15)", () => {
  const userAllowsAllEdits = [createRule({ id: "u1", action: "allow", scope: "global", createdAt: 0, match: { kind: "edit" } })];

  it("read-only denies every edit even over a user rule that allows all edits", () => {
    const rules = [...userAllowsAllEdits, ...roleRules(subagentPermissionOverlay("read-only", [], ["git status"]))];
    expect(decidePermission(rules, editFacts("/w/src/a.ts"), "/w").action).toBe("deny");
    expect(decidePermission(rules, execFacts("git status"), "/w").action).toBe("allow");
    expect(decidePermission(rules, execFacts("npm install"), "/w").action).toBe("ask");
  });

  it("scoped-edit allows its files without a card and asks outside them", () => {
    const rules = [...userAllowsAllEdits, ...roleRules(subagentPermissionOverlay("scoped-edit", ["src/auth.ts"], []))];
    expect(decidePermission(rules, editFacts("/w/src/auth.ts"), "/w").action).toBe("allow");
    expect(decidePermission(rules, editFacts("/w/src/db.ts"), "/w").action).toBe("ask");
    expect(decidePermission(rules, execFacts("rm -rf src"), "/w").action).toBe("ask");
  });

  it("a session grant from the relayed card (Allow for this stage) still wins after the overlay", () => {
    const grant = createRule({ id: "s1", action: "allow", scope: "workspace", createdAt: 0, match: { kind: "edit", pathGlob: "src/db.ts" } });
    const rules = [...roleRules(subagentPermissionOverlay("scoped-edit", ["src/auth.ts"], [])), grant];
    expect(decidePermission(rules, editFacts("/w/src/db.ts"), "/w").action).toBe("allow");
  });
});

describe("resume reads the packets back (C-02)", () => {
  it("a new store instance returns the plan packet, so the implement briefing carries the steps", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wf-resume-"));
    try {
      const mk = () => new WorkflowRunStore({
        root: dir,
        fs: {
          mkdirSync: (p, o) => { fs.mkdirSync(p, o); },
          writeFileSync: (p, d) => fs.writeFileSync(p, d, "utf8"),
          readFileSync: (p, e) => fs.readFileSync(p, e),
          renameSync: (a, b) => fs.renameSync(a, b),
          existsSync: (p) => fs.existsSync(p),
        },
        join: (...parts) => path.join(...parts),
      });
      const packet = planPacket();
      mk().writeHandoff("r1", 1, packet);
      const reread = mk().readHandoff("r1", 1)!;
      expect(reread.planSteps?.map((s) => s.id)).toEqual(["S1", "S2"]);
      expect(mk().readHandoff("r1", 2)).toBeUndefined();
      const brief = briefingFromContract({
        runId: "r1", step: 2, idea: "Add login", stage: findStage(IDEA_TO_DONE, "implement")!,
        def: IDEA_TO_DONE, packets: new Map([["plan", reread]]),
      });
      expect(brief.decisions?.join("\n")).toContain("S1. Add login route");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("start with allowAnywhere (C-01 gate checkbox)", () => {
  it("records the choice on the running stage", () => {
    const run = makeWorkflowRun({ runId: "r", sessionId: "s", workflow: IDEA_TO_DONE, idea: "x", cwd: "/w" });
    const started = applyGateAction(run, IDEA_TO_DONE, { type: "start", nextStageId: "plan", allowAnywhere: true }, 1);
    expect(started.current?.allowAnywhere).toBe(true);
  });
});
