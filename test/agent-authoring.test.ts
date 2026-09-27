import { describe, expect, it, vi } from "vitest";
import {
  AgentAuthoring,
  createAgentAuthoring,
  agentCardErrorId,
  type AgentAuthoringDeps,
} from "../src/agent-authoring";
import { Session } from "../src/session";
import { AgentRunStore } from "../src/agent-run";
import type { AgentRole } from "../src/agent-roles";

function makeMockDeps(): AgentAuthoringDeps {
  const session = new Session();
  session.activeSessionId = "sess-1";
  session.provider = "grok";

  const runs = new AgentRunStore({
    root: "/tmp/runs",
    fs: {
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      appendFileSync: vi.fn(),
      existsSync: vi.fn(() => false),
      rmSync: vi.fn(),
    },
  });

  return {
    host: {
      appendLine: vi.fn(),
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      getConfiguration: vi.fn(() => ({
        get: vi.fn(),
        update: vi.fn(),
        inspect: vi.fn(),
      })),
    } as any,
    state: {
      get: vi.fn(() => ({})),
      update: vi.fn(async () => {}),
    } as any,
    getFocused: () => session,
    setFocused: vi.fn(),
    getPool: () => new Set([session]),
    getAgentRuns: () => runs,
    sessionOps: {
      sessionCwd: vi.fn(() => "/work/test"),
      setSessionCwd: vi.fn(),
      workspaceRoot: vi.fn(() => "/work/test"),
      newLocalSession: vi.fn(() => new Session()),
      startSession: vi.fn(async () => ({ sessionId: "sub-1" })),
      handleSend: vi.fn(async () => {}),
      parkFocused: vi.fn(),
      postSessionsList: vi.fn(),
      sessionTypeMetaFor: vi.fn(() => ({})),
      buildThreadContext: vi.fn(() => ({
        conversationSummary: "test summary",
        recentMessages: [],
        currentPlan: "",
        openFiles: [],
      }) as any),
      persistedUsageLedger: vi.fn(() => ({})),
      markHiddenChildSession: vi.fn(),
      noteChildStarted: vi.fn(),
      closeChildRelays: vi.fn(),
      postRunningChildren: vi.fn(),
      teardownEmptySession: vi.fn(),
      cancelSubagentsOf: vi.fn(),
      setStatus: vi.fn(),
      companionsList: vi.fn(() => []),
    },
    uiOps: {
      emit: vi.fn(),
      postLocal: vi.fn(),
      postToSettingsEditor: vi.fn(),
      confirmInChat: vi.fn(async () => true),
      postSessionName: vi.fn(),
      deleteSessionCache: vi.fn(),
    },
    providerOps: {
      usableProviders: vi.fn(() => ["grok", "codex", "claude"]),
      connectedProviders: vi.fn(() => ["grok", "codex", "claude"]),
      subagentRoster: vi.fn(() => ({})),
      subagentsEnabledGlobally: vi.fn(() => true),
      companionSettingsView: vi.fn(() => ({})),
      defaultWorkflowName: vi.fn(() => "default"),
      companionsSetting: vi.fn((_k: string, fb: any) => fb),
    },
    companionOps: {
      agentRoleSet: vi.fn(() => ({ roles: [], presets: [], problems: [] })),
      crewPresetSet: vi.fn(() => ({ presets: [], problems: [] })),
      companionsRoot: vi.fn(() => "/work/test/.grok"),
      logAgentRun: vi.fn(),
    },
  };
}

describe("AgentAuthoring", () => {
  it("creates an instance via factory", () => {
    const deps = makeMockDeps();
    const authoring = createAgentAuthoring(deps);
    expect(authoring).toBeInstanceOf(AgentAuthoring);
  });

  it("agentCardErrorId constructs stable card error keys", () => {
    expect(agentCardErrorId("role", "reviewer")).toBe("role:reviewer");
    expect(agentCardErrorId("flow", "trio")).toBe("flow:trio");
    expect(agentCardErrorId("workflow")).toBe("workflow:*new*");
  });

  it("resolves role provider correctly when provider is usable", () => {
    const deps = makeMockDeps();
    const authoring = createAgentAuthoring(deps);
    const session = deps.getFocused()!;

    const role: AgentRole = {
      name: "tester",
      whenToUse: "Testing role",
      source: "project",
      provider: "claude",
      systemPreamble: "You test things.",
    };

    const result = authoring.resolveRoleProvider(role, session);
    expect(result).toEqual({ provider: "claude" });
  });

  it("returns an error when the requested role provider is not usable", () => {
    const deps = makeMockDeps();
    deps.providerOps.usableProviders = vi.fn(() => ["grok"]);
    const authoring = createAgentAuthoring(deps);
    const session = deps.getFocused()!;

    const role: AgentRole = {
      name: "tester",
      whenToUse: "Testing role",
      source: "project",
      provider: "muse",
      systemPreamble: "You test things.",
    };

    const result = authoring.resolveRoleProvider(role, session);
    expect("error" in result).toBe(true);
  });

  it("manages generatorStore per session", () => {
    const deps = makeMockDeps();
    const authoring = createAgentAuthoring(deps);

    const store1 = authoring.generatorStore();
    const store2 = authoring.generatorStore();
    expect(store1).toBe(store2);
    expect(store1.state).toBeDefined();
  });

  it("refuses agent role saving when scope dir cannot be determined", async () => {
    const deps = makeMockDeps();
    deps.companionOps.companionsRoot = vi.fn(() => undefined);
    const authoring = createAgentAuthoring(deps);

    await authoring.handleSaveAgentRole({
      scope: "project",
      draft: {
        name: "test-role",
        provider: "grok",
        whenToUse: "Test description",
        systemPreamble: "Prompt",
      },
    });

    expect(authoring.agentRolesError?.message).toContain("Open a project folder first");
  });
});
