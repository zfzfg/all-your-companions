// The crew engine in the host with the role run stubbed: overlay (C-01),
// gate preselection (C-03), limits (C-16), per-plan-step (C-12), panel (C-13),
// continue session (C-07/C-08), report (C-17), revise (C-07).
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { IDEA_TO_DONE, findStage, type WorkflowDefinition } from "../src/workflow";
import { WorkflowRunStore, makeWorkflowRun, startStage, type WorkflowRun } from "../src/workflow-run";
import { AgentRunStore } from "../src/agent-run";
import { ACP_PROVIDERS } from "../src/acp-backend";
import type { EligibilityInput } from "../src/target-eligibility";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

type Reply = { outcome?: "completed" | "failed" | "cancelled"; raw?: string; detail?: string; files?: string[]; tokens?: number };

function harness(settings: Record<string, unknown> = {}, usable = ["codex", "claude"]) {
  const root = mkdtempSync(path.join(tmpdir(), "crew-engine-"));
  dirs.push(root);
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  sidebar.state = { get: (k: string, f: unknown) => (k in memento ? memento[k] : f), update: async (k: string, v: unknown) => { memento[k] = v; } };
  sidebar.host = {
    appendLine: vi.fn(),
    getConfiguration: () => ({ get: (k: string, f: unknown) => (k in settings ? settings[k] : f) }),
    showInformationMessage: vi.fn(async () => undefined),
    openResource: vi.fn(),
  };
  const fsImpl = {
    mkdirSync: (p: string, o: { recursive: true }) => { fs.mkdirSync(p, o); },
    writeFileSync: (p: string, d: string) => fs.writeFileSync(p, d, "utf8"),
    readFileSync: (p: string, e: "utf8") => fs.readFileSync(p, e),
    renameSync: (a: string, b: string) => fs.renameSync(a, b),
    existsSync: (p: string) => fs.existsSync(p),
    appendFileSync: (p: string, d: string) => fs.appendFileSync(p, d),
    rmSync: (p: string, o: { recursive: boolean; force: boolean }) => fs.rmSync(p, o),
  };
  sidebar.workflowState = { store: new WorkflowRunStore({ root, fs: fsImpl, join: (...p: string[]) => path.join(...p) }), packets: new Map(), defs: new Map() };
  Object.defineProperty(sidebar, "agentRuns", { value: new AgentRunStore({ root, fs: fsImpl, join: (...p: string[]) => path.join(...p) }) });
  sidebar.pool = new Set();
  sidebar.sessionCache = new Map();
  Object.defineProperty(sidebar, "stageStepProgress", { value: new Map() });
  const emitted: any[] = [];
  sidebar.emit = (_s: Session, m: any) => emitted.push(m);
  sidebar.agentNotice = (_s: Session, level: string, text: string) => emitted.push({ type: "hostNotice", level, text });
  sidebar.setStatus = (s: Session, st: any) => { s.status = st; };
  sidebar.persistSessionType = vi.fn();
  sidebar.emitReviewCenter = vi.fn();
  sidebar.sessionCwd = () => root;
  sidebar.agentRoleSet = () => ({ roles: [], problems: [] });
  sidebar.usableProviders = () => usable;
  sidebar.runCrewVerify = vi.fn(async () => ({ code: 0, output: "ok" }));
  const eligibility: EligibilityInput = {
    purpose: "crew-stage",
    usable: usable as never,
    roster: {},
    capabilities: () => ({ companionSubagentTarget: { state: "yes" }, hostMcp: { state: "yes" } }),
    models: () => ({ checked: true, models: [{ id: "m1" }] }),
    limits: { maxConcurrent: 9, maxPerTurn: 9, maxPerSession: 9, running: 0, thisTurn: 0, thisSession: 0, poolHeadroom: 9 } as never,
    subagentsEnabled: true,
  };
  sidebar.crewEligibilityInput = () => ({ ...eligibility, exhausted: new Set() });
  const calls: Array<{ role: any; brief: any; coords: any }> = [];
  const replies: Reply[] = [];
  sidebar.runAgentRole = vi.fn(async (role: any, brief: any, _t: string, _c: Session, _o: string, coords: any) => {
    calls.push({ role, brief, coords });
    const r = replies.shift() ?? {};
    return {
      outcome: r.outcome ?? "completed",
      filesReported: r.files ?? [],
      filesObserved: r.files ?? [],
      totalTokens: r.tokens,
      durationMs: 1000,
      sessionId: `child-${calls.length}`,
      ...(r.detail ? { detail: r.detail } : {}),
      summary: "done",
      planEntries: [],
      reconciliation: { touched: [], unreported: [], claimedOnly: [] },
      rawReply: r.raw ?? "done",
    };
  });
  const session = new Session();
  session.provider = "codex";
  session.sessionType = "crew";
  return { sidebar, session, emitted, calls, replies, root };
}

function begin(h: ReturnType<typeof harness>, def: WorkflowDefinition = IDEA_TO_DONE, stageId = "plan"): WorkflowRun {
  const run = startStage(makeWorkflowRun({ runId: "run-t", sessionId: "s", workflow: def, idea: "Add login", cwd: h.root }), stageId, 1);
  h.session.workflowRun = run;
  h.sidebar.workflowState.defs.set(run.runId, def);
  return run;
}

const block = (obj: unknown) => ["prose", "```companions-result", JSON.stringify(obj), "```"].join("\n");

describe("a stage run in the host", () => {
  it("enforces read-only by overlay, preselects a different reviewer, writes the report at the end", async () => {
    const h = harness();
    let run = begin(h);
    h.replies.push({ raw: block({ planSteps: [{ id: "S1", title: "route", files: ["src/auth.ts"] }] }) });
    await h.sidebar.executeWorkflowStage(h.session, "local", IDEA_TO_DONE, run);
    expect(h.calls[0]!.role.mode).toBe("plan");
    expect(h.calls[0]!.role.permissions).toContainEqual({ kind: "edit", action: "deny" });
    run = h.session.workflowRun!;
    expect(run.status).toBe("at-gate");
    expect(run.gate?.nextStageId).toBe("implement");
    expect(run.gate?.preselectedTarget?.provider).toBeTruthy();

    // Implement: scoped to the plan's files; review then prefers another companion.
    await h.sidebar.handleWorkflowGateAction(h.session, "local", { type: "start", target: { provider: "codex" } });
    const impl = h.calls[1]!;
    expect(impl.role.permissions).toContainEqual({ kind: "edit", action: "allow", pathGlob: "src/auth.ts" });
    expect(impl.coords.stage.scope).toEqual(["src/auth.ts"]);
    expect(h.session.workflowRun!.gate?.preselectedTarget?.provider).toBe("claude");
    expect(h.session.workflowRun!.gate?.compare).toEqual({ stageTitle: "Implement", same: false });

    // Review on the preselection (no explicit target); read-only runs in agent mode.
    h.replies.push({ raw: block({ verdict: "pass", findings: [] }) });
    await h.sidebar.handleWorkflowGateAction(h.session, "local", { type: "start" });
    expect(h.calls[2]!.role.provider).toBe("claude");
    expect(h.calls[2]!.role.mode).toBe("agent");
    await h.sidebar.handleWorkflowGateAction(h.session, "local", { type: "start" });
    expect(h.session.workflowRun!.status).toBe("done");
    const report = path.join(h.root, "run-t", "run-report.md");
    expect(existsSync(report)).toBe(true);
    expect(readFileSync(report, "utf8")).toContain("## Stages");
  });

  it("stops at a limit gate by default (C-16 ask) and switches with a notice when told to", async () => {
    const ask = harness();
    begin(ask);
    ask.replies.push({ outcome: "failed", detail: "usage limit reached: quota exhausted (429)" });
    await ask.sidebar.executeWorkflowStage(ask.session, "local", IDEA_TO_DONE, ask.session.workflowRun, { provider: "codex" });
    expect(ask.session.workflowRun!.gate).toMatchObject({ kind: "limit", limitProvider: "codex" });
    expect(ask.calls).toHaveLength(1);

    const sw = harness({ "crew.onLimit": "switch" });
    begin(sw);
    sw.replies.push({ outcome: "failed", detail: "usage limit reached: quota exhausted (429)" }, { raw: block({ planSteps: [{ id: "S1", title: "x" }] }) });
    await sw.sidebar.executeWorkflowStage(sw.session, "local", IDEA_TO_DONE, sw.session.workflowRun, { provider: "codex" });
    expect(sw.calls[1]!.role.provider).toBe("claude");
    expect(sw.emitted.some((m) => m.type === "hostNotice" && /after Codex hit its usage limit/.test(m.text))).toBe(true);
    expect(sw.session.workflowRun!.gate?.forcedManual).toContain("provider-switched");
  });

  it("walks plan steps one run each, scoped per step (C-12)", async () => {
    const h = harness();
    const def: WorkflowDefinition = {
      ...IDEA_TO_DONE,
      stages: IDEA_TO_DONE.stages.map((s) => (s.id === "implement" ? { ...s, strategy: "per-plan-step" as const, verifyEach: true } : s)),
    };
    begin(h, def);
    h.session.workflowRun = { ...h.session.workflowRun!, verify: "npm test" };
    h.replies.push({ raw: block({ planSteps: [{ id: "S1", title: "a", files: ["a.ts"] }, { id: "S2", title: "b", files: ["b.ts"] }] }) });
    await h.sidebar.executeWorkflowStage(h.session, "local", def, h.session.workflowRun);
    h.replies.push({ files: ["a.ts"], tokens: 10 }, { files: ["b.ts"], tokens: 20 });
    h.sidebar.createCrewWorktree = vi.fn();
    await h.sidebar.handleWorkflowGateAction(h.session, "local", { type: "start", target: { provider: "codex" } });
    const steps = h.calls.slice(1);
    expect(steps).toHaveLength(2);
    expect(steps.map((c) => c.coords.stage.scope)).toEqual([["a.ts"], ["b.ts"]]);
    expect(steps.every((c) => c.coords.stage.subStep)).toBe(true);
    expect(h.sidebar.runCrewVerify).toHaveBeenCalledTimes(2);
    const packet = [...h.sidebar.workflowState.packets.values()].find((p: any) => p.stageId === "implement") as any;
    expect(packet.steps.map((s: any) => s.status)).toEqual(["done", "done"]);
    expect(packet.tokens).toBe(30);
  });

  it("fans a review out to two companions and merges it (C-13)", async () => {
    const h = harness();
    const def: WorkflowDefinition = {
      ...IDEA_TO_DONE,
      stages: IDEA_TO_DONE.stages.map((s) => (s.id === "review" ? { ...s, fanOut: { count: 2, distinctProviders: true } } : s)),
    };
    begin(h, def, "review");
    h.replies.push(
      { raw: block({ verdict: "pass", findings: [] }) },
      { raw: block({ verdict: "changes_requested", findings: [{ id: "F1", severity: "major", text: "bug" }] }) },
    );
    await h.sidebar.executeWorkflowStage(h.session, "local", def, h.session.workflowRun, { provider: "codex" });
    expect(new Set(h.calls.map((c) => c.role.provider))).toEqual(new Set(["codex", "claude"]));
    const packet = [...h.sidebar.workflowState.packets.values()][0] as any;
    expect(packet.verdict).toBe("changes_requested");
    expect(packet.panel).toHaveLength(2);
  });

  it("revise continues the stage's own session with the feedback (C-07)", async () => {
    const h = harness();
    begin(h);
    h.replies.push({ raw: block({ planSteps: [{ id: "S1", title: "x" }] }) });
    await h.sidebar.executeWorkflowStage(h.session, "local", IDEA_TO_DONE, h.session.workflowRun);
    const child = new Session();
    child.activeSessionId = "child-1";
    child.client = {} as never;
    h.sidebar.pool.add(child);
    h.replies.push({ raw: block({ planSteps: [{ id: "S1", title: "x" }, { id: "S2", title: "y" }] }) });
    const handled = await h.sidebar.handleHostGateAction(h.session, "local", { type: "workflowGateAction", runId: "run-t", action: "revise", message: "add a step for tests" });
    expect(handled).toBe(true);
    const revise = h.calls[1]!;
    expect(revise.coords.continueSession).toBe(child);
    expect(revise.coords.continueMessage).toContain("add a step for tests");
    expect(h.session.workflowRun!.executed.filter((e) => e.stageId === "plan")).toHaveLength(2);
    expect(findStage(IDEA_TO_DONE, "plan")).toBeTruthy();
  });
});
