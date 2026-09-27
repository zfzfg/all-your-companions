/**
 * Unit tests for SubagentHost (W-15 Schritt D3).
 */
import { describe, expect, it, vi } from "vitest";
import { SubagentHost, type SubagentHostDeps } from "../src/subagent-host";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";
import { PausableDeadline } from "../src/child-watch";

function makeSubagentHost(overrides: Partial<SubagentHostDeps> = {}) {
  const memento: Record<string, unknown> = {};
  const emitted: Array<{ session: Session; msg: HostMsg }> = [];
  const appendLines: string[] = [];
  const parent = new Session();
  parent.activeSessionId = "parent-session-1";
  parent.provider = "grok";
  parent.status = "working";

  const pool = new Set<Session>([parent]);

  const deps: SubagentHostDeps = {
    host: {
      appendLine: vi.fn((line: string) => { appendLines.push(line); }),
      isWindowFocused: vi.fn(() => true),
      showInformationMessage: vi.fn(async () => undefined),
      getConfiguration: vi.fn(() => ({
        get: (_k: string, d: unknown) => d,
        update: vi.fn(),
      })),
    } as any,
    context: {
      extensionUri: { fsPath: "/ext" },
      globalStorageUri: { fsPath: "/storage" },
    } as any,
    state: {
      get: vi.fn((key: string, fallback: unknown) =>
        Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback),
      update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
    } as any,
    agentRuns: {
      newRunId: vi.fn(() => "run-subagent"),
      writeBrief: vi.fn(),
      writeResult: vi.fn(),
      appendLog: vi.fn(),
      discard: vi.fn(),
    } as any,
    pool,
    getFocused: () => parent,
    focusSession: vi.fn(),
    sessionCwd: vi.fn(() => "/workspace"),
    emit: vi.fn((session: Session, msg: HostMsg) => { emitted.push({ session, msg }); }),
    post: vi.fn(),
    setStatus: vi.fn((session: Session, status: any) => { session.status = status; }),
    sessionTypeMetaFor: vi.fn(() => undefined),
    agentNotice: vi.fn(),
    confirmInChat: vi.fn(async () => true),
    runAgentRole: vi.fn(async () => ({ summary: "ok" })),
    usableProviders: () => ["grok", "codex", "claude", "gemini", "muse"],
    companionsSetting: vi.fn((_key: string, fallback: any) => fallback),
    agentRoleSet: vi.fn(() => ({ roles: [], problems: [] })),
    sessionDisplayName: vi.fn(() => "Session 1"),
    steerSend: vi.fn(),
    crewFileClaims: vi.fn(() => ({} as any)),
    mcpOps: {
      hostPipe: vi.fn(() => ({}) as any),
      reservedMcpIdentityFor: vi.fn(() => ({ names: [] })),
    },
    worktreeOps: {
      createCrewWorktree: vi.fn(async (cwd, b) => ({ path: `${cwd}/${b}`, label: b, sourceGitRoot: cwd })),
      applyCrewWorktree: vi.fn(async () => {}),
      worktreeLocal: vi.fn(),
    },
    lifecycleOps: {
      emitWorkflowRun: vi.fn(),
      persistWorkflowRun: vi.fn(),
      getWorkflowDefs: vi.fn(),
      getWorkflowStore: vi.fn(),
      handleGeneratorTool: vi.fn(),
      turnEndFields: vi.fn(() => ({ status: "completed" })),
      noteLiveTurnEnded: vi.fn(),
      noteSessionActivity: vi.fn(),
      setProviderNeedsLogin: vi.fn(),
      maybeGenerateTitle: vi.fn(),
      postSessionName: vi.fn(),
      postSessionsList: vi.fn(),
      sessionCacheDelete: vi.fn(),
    },
    ...overrides,
  };

  const host = new SubagentHost(deps);
  return { host, deps, parent, pool, emitted, appendLines, memento };
}

describe("SubagentHost (W-15 Schritt D3)", () => {
  it("instantiates cleanly with empty registry and maps", () => {
    const { host } = makeSubagentHost();
    expect(host.subagents).toBeDefined();
    expect(host.reports).toBeInstanceOf(Map);
    expect(host.waiters).toBeInstanceOf(Map);
    expect(host.outcomes).toBeInstanceOf(Map);
    expect(host.reports.size).toBe(0);
    expect(host.waiters.size).toBe(0);
    expect(host.outcomes.size).toBe(0);
  });

  it("lists eligible targets in companionsList", () => {
    const { host, parent } = makeSubagentHost();
    const result = host.companionsList(parent, { includeIneligible: false }) as any;
    expect(result).toBeDefined();
    expect(result.targets).toBeInstanceOf(Array);
    expect(result.targets.length).toBeGreaterThan(0);
    const providers = result.targets.map((t: any) => t.provider);
    expect(providers).toContain("grok");
    expect(providers).toContain("codex");
  });

  it("handles turn hold lifecycle when children are active and when they settle", () => {
    const { host, parent, emitted } = makeSubagentHost();
    parent.subagentTurnHold = { turnId: "turn-abc", meta: { stopReason: "end_turn" } };

    // With running child: hold remains
    host.subagentStore().registry.turnHasLiveChildren = () => true;
    host.maybeFinishSubagentTurn(parent);
    expect(parent.subagentTurnHold).toBeDefined();
    expect(parent.status).toBe("working");

    // Once all children settle: hold cleared, agentEnd emitted, session marked done
    host.subagentStore().registry.turnHasLiveChildren = () => false;
    host.subagentStore().registry.uncollectedFinished = () => [];
    host.maybeFinishSubagentTurn(parent);
    expect(parent.subagentTurnHold).toBeUndefined();
    expect(parent.status).toBe("done");
    expect(emitted.some((e) => e.msg.type === "agentEnd")).toBe(true);
  });

  it("routes child relays and resolves answers back to child", () => {
    const { host, parent } = makeSubagentHost();
    const child = new Session();
    child.activeSessionId = "child-session-1";
    child.provider = "codex";
    child.pendingHiddenChild = {
      parentSessionId: parent.activeSessionId!,
      subagentId: "sa_child_1",
      hiddenReason: "companion-subagent",
      depth: 1,
    };

    const table = host.relayTable();
    expect(table).toBeDefined();

    // Open route
    const route = table.open(child, parent, 42, "permissionRequest");
    expect(route).toBeDefined();
    expect(table.pendingFor(child)).toBe(1);

    // Resolve route
    const resolved = host.resolveRelayedAnswer({
      type: "permissionAnswer",
      requestId: route,
      optionId: "allow",
    });
    expect(resolved).toBeDefined();
    expect(resolved?.session).toBe(child);
    expect((resolved?.msg as any).requestId).toBe(42);

    // Closing child relays settles remaining
    table.open(child, parent, 99, "questionRequest");
    const closed = table.closeChild(child);
    expect(closed.length).toBe(2);
    expect(closed.map((c) => c.requestId)).toContain(99);
    expect(table.pendingFor(child)).toBe(0);
  });

  it("pauses subagent deadline when human attention is required", () => {
    const { host, parent } = makeSubagentHost();
    const child = new Session();
    child.activeSessionId = "child-deadline-1";
    child.provider = "claude";
    child.pendingHiddenChild = {
      parentSessionId: parent.activeSessionId!,
      subagentId: "sa_deadline_1",
      hiddenReason: "companion-subagent",
      depth: 1,
    };

    host.subagentDeadlines = new Map([
      ["sa_deadline_1", new PausableDeadline(30_000, Date.now())],
    ]);

    host.childNeedsYouChanged(child, true);
    expect(host.subagentDeadlines.get("sa_deadline_1")?.paused).toBe(true);

    host.childNeedsYouChanged(child, false);
    expect(host.subagentDeadlines.get("sa_deadline_1")?.paused).toBe(false);
  });

  it("disposes channels and timers without errors", () => {
    const { host } = makeSubagentHost();
    expect(() => host.dispose()).not.toThrow();
  });
});
