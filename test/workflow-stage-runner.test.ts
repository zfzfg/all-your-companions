/**
 * Unit tests for WorkflowStageRunner (W-15 Schritt D4).
 */
import { describe, expect, it, vi } from "vitest";
import { WorkflowStageRunner, type WorkflowStageRunnerDeps } from "../src/workflow-stage-runner";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";
import { IDEA_TO_DONE } from "../src/workflow";

function makeRunner(inThread = false) {
  const memento: Record<string, unknown> = {};
  const emitted: Array<{ session: Session; msg: HostMsg }> = [];
  const appendLines: string[] = [];

  const deps: WorkflowStageRunnerDeps = {
    host: {
      appendLine: vi.fn((line: string) => { appendLines.push(line); }),
      getConfiguration: vi.fn((section: string) => ({
        get: (key: string, fallback: unknown) => {
          if (section === "companions" && key === "crew.inThreadCommand") return inThread;
          if (section === "companions" && key === "crew.defaultWorkflow") return "idea-to-done";
          if (section === "companions" && key === "crew.autoStartNextStage") return false;
          if (section === "companions" && key === "crew.maxFixerPasses") return 2;
          return fallback;
        },
      })),
    } as any,
    context: {
      globalStorageUri: { fsPath: "/storage" },
    } as any,
    state: {
      get: vi.fn((key: string, fallback: unknown) =>
        Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback),
      update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
    } as any,
    agentRuns: {
      newRunId: vi.fn(() => "run-12345"),
      writeBrief: vi.fn(),
      writeResult: vi.fn(),
      appendLog: vi.fn(),
      discard: vi.fn(),
    } as any,
    worktreeHost: {
      worktreeLocal: () => ({
        create: vi.fn(async (opts) => ({ worktreePath: `/wt/${opts.label}`, sourceGitRoot: opts.sourcePath })),
      }),
      applyWorktreeViaLocalGit: vi.fn(async () => {}),
    } as any,
    providerSetup: {
      usableProviders: () => ["grok", "codex", "claude"],
    } as any,
    pool: new Set<Session>(),
    focused: new Session(),
    sessionCwd: vi.fn(() => "/workspace"),
    newFocusedSession: vi.fn(async () => new Session()),
    setStatus: vi.fn(),
    runAgentRole: vi.fn(async () => ({ outcome: "completed", filesReported: [], filesObserved: [], summary: "done", planEntries: [] })),
    resolveRoleProvider: vi.fn(() => ({ provider: "grok" as const })),
    agentRoleSet: vi.fn(() => ({ roles: [], problems: [] })),
    crewPresetSet: vi.fn(() => ({
      presets: [
        { name: "idea-to-done", title: "Idea to Done", whenToUse: "Default", source: "builtin", roles: [], body: "" },
        { name: "fast", title: "Fast", whenToUse: "Speed", source: "builtin", roles: [], body: "" },
      ],
      problems: [],
    } as any)),
    crewEligibilityInput: vi.fn(() => ({
      purpose: "crew-stage",
      parent: undefined,
      roster: {},
      exhausted: new Set(),
      subagentsEnabled: true,
      forbiddenThisTurn: false,
    } as any)),
    steerSend: vi.fn(async () => {}),
    emitReviewCenter: vi.fn(),
    persistSessionType: vi.fn(),
    childWaitsForYou: vi.fn(() => false),
ui: {
emit: vi.fn((session: Session, msg: HostMsg) => { emitted.push({ session, msg }); }),
agentNotice: vi.fn((session: Session, level: any, text: string) => {
      emitted.push({ session, msg: { type: "hostNotice", level, text } });
    }),
confirmInChat: vi.fn(async () => true),
showQuestion: vi.fn()
}
};

  const runner = new WorkflowStageRunner(deps);
  return { runner, deps, emitted, appendLines };
}

describe("WorkflowStageRunner", () => {
  it("initializes workflow store and reads default workflow configuration", () => {
    const { runner } = makeRunner();
    expect(runner.defaultWorkflowName()).toBe("idea-to-done");
    expect(runner.autoStartNextStage()).toBe(false);
    expect(runner.maxFixerPasses()).toBe(2);
    expect(runner.inThreadCrewCommand()).toBe(false);
  });

  it("resolves builtin idea-to-done workflow definition", () => {
    const { runner } = makeRunner();
    const session = new Session();
    const def = runner.resolveWorkflow(session, "idea-to-done");
    expect(def.name).toBe(IDEA_TO_DONE.name);
    expect(def.stages.length).toBeGreaterThan(0);
  });

  it("handles /crew in agent session by directing to new crew session", async () => {
    const { runner, emitted } = makeRunner(false);
    const session = new Session();
    session.sessionType = "agent";
    const handled = await runner.handleCrewCommand("/crew idea-to-done build features", session);
    expect(handled).toBe(true);
    const notice = emitted.find((e) => e.msg.type === "hostNotice")?.msg as Extract<HostMsg, { type: "hostNotice" }>;
    expect(notice).toBeDefined();
    expect(notice.text).toBe("Crew runs live in their own session.");
    expect(notice.action?.id).toBe("openCrewWithGoal");
  });

  it("refuses /crew inside an existing crew session", async () => {
    const { runner, emitted } = makeRunner(false);
    const session = new Session();
    session.sessionType = "crew";
    const handled = await runner.handleCrewCommand("/crew", session);
    expect(handled).toBe(true);
    expect(emitted.some((e) => e.msg.type === "hostNotice" && /already a Crew session/.test(e.msg.text))).toBe(true);
  });

  it("validates empty idea when starting a workflow run", async () => {
    const { runner, emitted } = makeRunner(false);
    const session = new Session();
    session.sessionType = "crew";
    await runner.startWorkflowRun(session, "   ", "idea-to-done");
    expect(session.sessionTypeLockedAt).toBeTypeOf("number");
    expect(emitted.some((e) => e.msg.type === "hostNotice" && e.msg.text === "Idea required.")).toBe(true);
    expect(session.workflowRun).toBeUndefined();
  });

  it("parses gate actions correctly via gateActionFromMsg", () => {
    const { runner } = makeRunner();
    expect(runner.gateActionFromMsg({ action: "pause" })).toEqual({ type: "pause", at: expect.any(Number) });
    expect(runner.gateActionFromMsg({ action: "cancel" })).toEqual({ type: "cancel" });
    expect(runner.gateActionFromMsg({ action: "finish" })).toEqual({ type: "finish" });
    expect(runner.gateActionFromMsg({ action: "start", nextStageId: "s1" })).toEqual({ type: "start", nextStageId: "s1" });
    expect(runner.gateActionFromMsg({ action: "unknown" })).toBeUndefined();
  });

  it("creates and applies crew worktree using worktreeHost collaborator", async () => {
    const { runner, deps } = makeRunner();
    const session = new Session();
    const wt = await runner.createCrewWorktree("/workspace", "crew-label");
    expect("error" in wt).toBe(false);
    if (!("error" in wt)) {
      expect(wt.path).toBe("/wt/crew-label");
      await runner.applyCrewWorktree(session, wt);
      expect(deps.worktreeHost.applyWorktreeViaLocalGit).toHaveBeenCalledWith(session, wt.path, wt.sourceGitRoot, wt.label);
    }
  });

  it("records file claims for crew execution", () => {
    const { runner } = makeRunner();
    const claims = runner.crewFileClaims();
    expect(claims).toBeDefined();
    expect(runner.crewFileClaims()).toBe(claims);
  });
});
