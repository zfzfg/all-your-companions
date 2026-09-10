/**
 * P6 — the HOST half of promote-to-session (§6.6 point 8), delegation depth
 * (D10 / §12.3) and crew-stage delegation (§7.9).
 *
 * The pure decisions live in `session-type.ts` and `companion-subagents.ts` and
 * are covered there. What only the host can answer is which sessions actually
 * get the delegation server, and whether promoting really removes the metadata
 * that was hiding a child from the history list.
 */
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import type { HostMsg } from "../src/protocol";
import type { SessionMetaOverrides } from "../src/sessions";

const SESSION_META_KEY = "grok.sessionMeta";

function makeSidebar(settings: Record<string, unknown> = {}) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  const memento: Record<string, unknown> = {};
  const emitted: HostMsg[] = [];
  const config: Record<string, unknown> = {
    "subagents.enabled": true,
    "subagents.maxDepth": 1,
    "crew.stagesMayUseSubagents": false,
    ...settings,
  };
  sidebar.state = {
    get: vi.fn((key: string, fallback: unknown) =>
      Object.prototype.hasOwnProperty.call(memento, key) ? memento[key] : fallback),
    update: vi.fn(async (key: string, value: unknown) => { memento[key] = value; }),
  };
  sidebar.host = {
    appendLine: vi.fn(),
    getConfiguration: vi.fn(() => ({
      get: (key: string, fallback: unknown) =>
        Object.prototype.hasOwnProperty.call(config, key) ? config[key] : fallback,
      update: vi.fn(async () => {}),
    })),
  };
  sidebar.pool = new Set<Session>();
  sidebar.sessionCache = new Map();
  sidebar.emit = vi.fn((_session: Session, message: HostMsg) => { emitted.push(message); });
  sidebar.postSessionsList = vi.fn();
  sidebar.sessionDisplayName = vi.fn(() => "Refactor auth");
  sidebar.sessionCwd = vi.fn(() => "/repo");
  sidebar.reservedMcpIdentityFor = vi.fn(() => ({ names: [] }));
  // The pipe itself is covered by the IPC suites; here it only has to say yes.
  sidebar.spawnCompanionsServer = vi.fn(async (_s: Session, mode: string) => ({ name: mode }));
  return {
    sidebar,
    emitted,
    config,
    meta: () => (memento[SESSION_META_KEY] ?? {}) as SessionMetaOverrides,
    setMeta: (value: SessionMetaOverrides) => { memento[SESSION_META_KEY] = value; },
  };
}

function agentSession(over: Partial<Session> = {}): Session {
  const session = new Session();
  session.sessionType = "agent";
  session.activeSessionId = "parent-1";
  Object.assign(session, over);
  return session;
}

describe("who is handed the delegation server (D10, §7.9)", () => {
  it("gives it to the user's own Agent session", async () => {
    const { sidebar } = makeSidebar();
    expect(await sidebar.companionsMcpServer(agentSession())).toMatchObject({ name: "delegate" });
  });

  it("withholds it from a Crew session — the workflow is the orchestration", async () => {
    const { sidebar } = makeSidebar();
    const crew = agentSession();
    crew.sessionType = "crew";
    expect(await sidebar.companionsMcpServer(crew)).toBeUndefined();
  });

  it("withholds it from a subagent at the default depth", async () => {
    const { sidebar } = makeSidebar();
    const child = agentSession({
      pendingHiddenChild: {
        parentSessionId: "parent-1",
        subagentId: "sa_1",
        hiddenReason: "companion-subagent",
        depth: 1,
      },
    } as Partial<Session>);
    expect(await sidebar.companionsMcpServer(child)).toBeUndefined();
  });

  it("gives it to a depth-1 subagent once the user opted into depth 2", async () => {
    const { sidebar } = makeSidebar({ "subagents.maxDepth": 2 });
    const child = agentSession({
      pendingHiddenChild: {
        parentSessionId: "parent-1",
        subagentId: "sa_1",
        hiddenReason: "companion-subagent",
        depth: 1,
      },
    } as Partial<Session>);
    expect(await sidebar.companionsMcpServer(child)).toMatchObject({ name: "delegate" });
  });

  it("still withholds it at depth 2 — there is no depth 3", async () => {
    const { sidebar } = makeSidebar({ "subagents.maxDepth": 2 });
    const grandchild = agentSession({
      pendingHiddenChild: {
        parentSessionId: "child-1",
        subagentId: "sa_2",
        hiddenReason: "companion-subagent",
        depth: 2,
      },
    } as Partial<Session>);
    expect(await sidebar.companionsMcpServer(grandchild)).toBeUndefined();
  });

  it("clamps a setting deeper than 2, and says so once", async () => {
    const { sidebar } = makeSidebar({ "subagents.maxDepth": 7 });
    expect(sidebar.subagentMaxDepth()).toBe(2);
    sidebar.subagentMaxDepth();
    const clampLines = sidebar.host.appendLine.mock.calls
      .map((call: string[]) => call[0])
      .filter((line: string) => line.includes("maxDepth"));
    // Once per window, not once per session opened.
    expect(clampLines).toHaveLength(1);
  });

  describe("crew stages (§7.9) — both switches or neither", () => {
    const stageSession = (allowSubagents: boolean) =>
      agentSession({
        stageAllowsSubagents: allowSubagents,
        pendingHiddenChild: {
          parentSessionId: "crew-1",
          subagentId: "run-1:review",
          hiddenReason: "crew-stage",
          depth: 1,
        },
      } as Partial<Session>);

    it("withholds it when only the workflow asked", async () => {
      const { sidebar } = makeSidebar({ "subagents.maxDepth": 2 });
      expect(await sidebar.companionsMcpServer(stageSession(true))).toBeUndefined();
    });

    it("withholds it when only the setting is on", async () => {
      const { sidebar } = makeSidebar({
        "crew.stagesMayUseSubagents": true,
        "subagents.maxDepth": 2,
      });
      expect(await sidebar.companionsMcpServer(stageSession(false))).toBeUndefined();
    });

    it("gives it when both say yes and the depth allows", async () => {
      const { sidebar } = makeSidebar({
        "crew.stagesMayUseSubagents": true,
        "subagents.maxDepth": 2,
      });
      expect(await sidebar.companionsMcpServer(stageSession(true))).toMatchObject({ name: "delegate" });
    });

    it("still refuses when both say yes but the depth does not", async () => {
      // Depth is the harder limit: the two §7.9 switches decide whether nesting
      // is wanted, D10 decides whether it is allowed at all.
      const { sidebar } = makeSidebar({ "crew.stagesMayUseSubagents": true });
      expect(await sidebar.companionsMcpServer(stageSession(true))).toBeUndefined();
    });
  });

  it("gives a generator session its own tool set, even with subagents off", async () => {
    // The generator is not delegation, and the master switch must not disable
    // Settings → Generate workflow (§8.6).
    const { sidebar } = makeSidebar({ "subagents.enabled": false });
    const generator = agentSession({
      pendingHiddenChild: {
        parentSessionId: "parent-1",
        subagentId: "gen-1",
        hiddenReason: "workflow-generator",
        depth: 1,
      },
    } as Partial<Session>);
    expect(await sidebar.companionsMcpServer(generator)).toMatchObject({ name: "generator" });
  });
});

describe("promote to a session of its own (§6.6 point 8)", () => {
  function withSubagent(status: string, over: Record<string, unknown> = {}) {
    const harness = makeSidebar();
    harness.sidebar.subagents.add({
      subagentId: "sa_1",
      parentSessionId: "parent-1",
      childSessionId: "child-1",
      runId: "run-1",
      step: 1,
      label: "Auth inspector",
      target: { provider: "gemini" },
      profile: "read-only",
      status,
      startedAt: 1,
      background: false,
      spawnedInTurn: "1",
      ...over,
    });
    harness.setMeta({
      "child-1": {
        sessionType: "agent",
        sessionTypeLockedAt: 5,
        hiddenReason: "companion-subagent",
        parentSessionId: "parent-1",
        subagentId: "sa_1",
        depth: 1,
      },
    });
    return harness;
  }

  it("removes the metadata that was hiding it, and names it after its parent", async () => {
    const harness = withSubagent("completed");
    await harness.sidebar.promoteSubagentSession(agentSession(), "sa_1");
    const record = harness.meta()["child-1"];
    expect(record.hiddenReason).toBeUndefined();
    expect(record.parentSessionId).toBeUndefined();
    expect(record.subagentId).toBeUndefined();
    expect(record.depth).toBeUndefined();
    expect(record.customName).toBe("Auth inspector (from Refactor auth)");
    // The type and its lock are the child's own and survive.
    expect(record.sessionType).toBe("agent");
    expect(record.sessionTypeLockedAt).toBe(5);
  });

  it("refuses while the child is still running", async () => {
    // Promoting mid-flight would put a conversation in the list that the parent
    // is still driving and Stop still owns.
    const harness = withSubagent("running");
    await harness.sidebar.promoteSubagentSession(agentSession(), "sa_1");
    expect(harness.meta()["child-1"].hiddenReason).toBe("companion-subagent");
    expect(harness.emitted.find((m) => m.type === "hostNotice"))
      .toMatchObject({ text: expect.stringContaining("still running") });
  });

  it("refuses a child that never started a session", async () => {
    const harness = withSubagent("refused", { childSessionId: undefined });
    await harness.sidebar.promoteSubagentSession(agentSession(), "sa_1");
    expect(harness.emitted.find((m) => m.type === "hostNotice"))
      .toMatchObject({ text: expect.stringContaining("never started a session") });
  });

  it("clears the live child's own hidden marker too", async () => {
    // Otherwise a history refresh before the next reload would put the row back.
    const harness = withSubagent("completed");
    const live = new Session();
    live.activeSessionId = "child-1";
    live.pendingHiddenChild = {
      parentSessionId: "parent-1",
      subagentId: "sa_1",
      hiddenReason: "companion-subagent",
      depth: 1,
    };
    harness.sidebar.pool.add(live);
    await harness.sidebar.promoteSubagentSession(agentSession(), "sa_1");
    expect(live.pendingHiddenChild).toBeUndefined();
  });

  it("keeps the card, because the delegation still happened", async () => {
    const harness = withSubagent("completed");
    await harness.sidebar.promoteSubagentSession(agentSession(), "sa_1");
    const card = harness.emitted.find((m) => m.type === "companionSubagent") as any;
    expect(card).toBeDefined();
    // …and stops offering to promote it a second time.
    expect(card.promotable).toBeUndefined();
    expect(harness.sidebar.subagents.get("sa_1").promoted).toBe(true);
  });

  it("says what it did, by name", async () => {
    const harness = withSubagent("completed");
    await harness.sidebar.promoteSubagentSession(agentSession(), "sa_1");
    expect(harness.emitted.filter((m) => m.type === "hostNotice").at(-1))
      .toMatchObject({ text: "Kept as a session: Auth inspector (from Refactor auth)" });
  });

  it("does nothing for an id it has never heard of", async () => {
    const harness = withSubagent("completed");
    await harness.sidebar.promoteSubagentSession(agentSession(), "sa_nope");
    expect(harness.meta()["child-1"].hiddenReason).toBe("companion-subagent");
  });
});
