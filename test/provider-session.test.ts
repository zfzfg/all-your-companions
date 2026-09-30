import { unwiredOps } from "./unwired-ops";
import { describe, expect, it, vi } from "vitest";
import {
  ProviderSession,
  createProviderSession,
  type ProviderSessionDeps,
} from "../src/provider-session";
import { Session } from "../src/session";
import { PROVIDER_MODEL_CACHE_KEY } from "../src/subagent-host";

function makeMockDeps(): ProviderSessionDeps {
  const session = new Session();
  session.activeSessionId = "sess-prov-1";
  session.provider = "grok";
  session.planActive = false;
  session.planModeAvailable = true;

  return {

    sidebarOps: unwiredOps<ProviderSessionDeps["sidebarOps"]>(),
    host: {
      appendLine: vi.fn(),
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      getConfiguration: vi.fn(() => ({
        get: vi.fn(() => ""),
        update: vi.fn(),
        inspect: vi.fn(),
      })),
    } as any,
    state: {
      get: vi.fn((key: string, fallback: any) => {
        if (key === PROVIDER_MODEL_CACHE_KEY) {
          return {
            grok: { models: [{ modelId: "grok-2" }, { modelId: "grok-beta" }] },
            claude: { models: [{ modelId: "claude-3-opus" }] },
          };
        }
        return fallback;
      }),
      update: vi.fn(async () => {}),
    } as any,
    context: {
      extensionVersion: "0.2.0",
    },
    getFocused: () => session,
    setFocused: vi.fn(),
    getPool: () => new Set([session]),
    sessionOps: {
      detachClient: vi.fn((s: Session) => { const client = s.client; s.client = undefined; s.gen++; return client; }),
      sessionCwd: vi.fn(() => "/workspace/test"),
      setSessionCwd: vi.fn(),
      workspaceRoot: vi.fn(() => "/workspace/test"),
      newLocalSession: vi.fn(() => new Session()),
      startSession: vi.fn(async () => ({ sessionId: "sess-new" })),
      restartSession: vi.fn(async () => true),
      disposeSession: vi.fn(),
      removeSessionFromDisk: vi.fn(),
      discardRestartedEmptySession: vi.fn(),
      discardAdapterEmptySession: vi.fn(async () => true),
      restoreStrandedDraft: vi.fn(),
      rememberQueuedDraft: vi.fn(async () => {}),
      rememberProjectProvider: vi.fn(async () => {}),
      rememberGrokConfig: vi.fn(async () => {}),
      sessionDisplayName: vi.fn(() => "Test Conversation"),
      authorizedSessionCwds: vi.fn(() => ["/workspace/test"]),
    },
    uiOps: {
      notifyUser: vi.fn(),
      emit: vi.fn(),
      emitLocalTransient: vi.fn(),
      post: vi.fn(),
      postSessionsList: vi.fn(),
      setStatus: vi.fn(),
      setPlanActive: vi.fn((s: Session, active: boolean) => { s.planActive = active; }),
      syncHumanWait: vi.fn(),
      persistPlanVerdict: vi.fn(),
      noteAnswered: vi.fn(),
      autoApprovePendingPermissions: vi.fn(),
      divertRacingSend: vi.fn(),
      pickRestartMode: vi.fn(async () => "clear" as const),
      childWriteClaimWarning: vi.fn(() => undefined),
      snapshotToolCallWrites: vi.fn(),
      loadPermissionRuleState: vi.fn(() => ({ active: [] })),
      maybePromptWorkspaceRulesAdoption: vi.fn(),
      turnInFlight: vi.fn(() => false),
      armCancelRecovery: vi.fn(),
    },
    providerOps: {
      modelsForSession: vi.fn(() => []),
      connectedProviders: vi.fn(() => ["grok", "claude"]),
      defaultProviderForProject: vi.fn(() => "grok"),
      locateProvider: vi.fn((p) => p === "grok" ? "/bin/grok" : undefined),
      readGrokVersion: vi.fn(async () => "grok 1.5.0"),
      getProviderCliVersions: vi.fn(() => ({ grok: "1.5.0" })),
    },
  };
}

describe("ProviderSession (W-15 S4)", () => {
  it("creates an instance via factory", () => {
    const deps = makeMockDeps();
    const sessionManager = createProviderSession(deps);
    expect(sessionManager).toBeInstanceOf(ProviderSession);
  });

  describe("providerForRequestedModel", () => {
    it("returns matching provider for model in model cache", () => {
      const deps = makeMockDeps();
      const ps = createProviderSession(deps);

      expect(ps.providerForRequestedModel("claude-3-opus", "grok")).toBe("claude");
      expect(ps.providerForRequestedModel("grok-beta", "claude")).toBe("grok");
    });

    it("returns fallback for unknown model or empty string", () => {
      const deps = makeMockDeps();
      const ps = createProviderSession(deps);

      expect(ps.providerForRequestedModel("", "grok")).toBe("grok");
      expect(ps.providerForRequestedModel("unknown-model", "claude")).toBe("claude");
    });
  });

  describe("setMode", () => {
    it("does not raise a Plan gate for a provider with no mode switching", async () => {
      const deps = makeMockDeps();
      const session = deps.getFocused();
      session.provider = "muse";
      session.planModeAvailable = true;
      const setMode = vi.fn(async () => {});
      session.client = { sessionId: "muse-session", setMode } as any;
      await createProviderSession(deps).setMode("plan", session);
      expect(setMode).not.toHaveBeenCalled();
      expect(deps.uiOps.setPlanActive).not.toHaveBeenCalledWith(session, true);
      expect(deps.uiOps.notifyUser).toHaveBeenCalledWith("error", expect.stringContaining("Couldn't switch mode:"));
    });
    it("updates planActive and calls client.setMode without remembering plan mode", async () => {
      const deps = makeMockDeps();
      const ps = createProviderSession(deps);
      const session = deps.getFocused();
      session.planModeAvailable = true;
      const mockClient = {
        sessionId: "sess-client-1",
        setMode: vi.fn(async () => {}),
        currentModeId: "default",
      };
      session.client = mockClient as any;

      await ps.setMode("plan", session);

      expect(deps.uiOps.setPlanActive).toHaveBeenCalledWith(session, true);
      expect(mockClient.setMode).toHaveBeenCalledWith("plan");
      // Plan mode is transient per-task, so it is not remembered
      expect(deps.sessionOps.rememberGrokConfig).not.toHaveBeenCalled();
    });

    it("remembers yolo mode when switching to yolo", async () => {
      const deps = makeMockDeps();
      const ps = createProviderSession(deps);
      const session = deps.getFocused();
      const mockClient = {
        sessionId: "sess-client-1",
        setMode: vi.fn(async () => {}),
        currentModeId: "default",
      };
      session.client = mockClient as any;

      await ps.setMode("yolo", session);

      expect(deps.state.update).toHaveBeenCalledWith("grok.modeByProvider", { [session.provider]: "yolo" });
    });
  });

  describe("handleExitPlan", () => {
    it("handles approved verdict, persists verdict and syncs human wait", () => {
      const deps = makeMockDeps();
      const ps = createProviderSession(deps);
      const session = deps.getFocused();
      const mockClient = {
        respondExitPlan: vi.fn(() => true),
      };
      session.client = mockClient as any;
      session.pendingExitPlans.set(101, {
        planText: "Step 1: Test\nStep 2: Validate",
      });

      ps.handleExitPlan(101, "approved", undefined, session);

      expect(mockClient.respondExitPlan).toHaveBeenCalledWith(101, "approved");
      expect(deps.uiOps.persistPlanVerdict).toHaveBeenCalledWith(
        session,
        "approved",
        "Step 1: Test\nStep 2: Validate",
      );
      expect(deps.uiOps.syncHumanWait).toHaveBeenCalledWith(session);
      expect(session.pendingExitPlans.has(101)).toBe(false);
    });

    it("handles rejected verdict without feedback", () => {
      const deps = makeMockDeps();
      const ps = createProviderSession(deps);
      const session = deps.getFocused();
      const mockClient = {
        respondExitPlan: vi.fn(() => true),
      };
      session.client = mockClient as any;
      session.pendingExitPlans.set(102, {
        planText: "Step 1: Write code",
      });

      ps.handleExitPlan(102, "rejected", undefined, session);

      expect(mockClient.respondExitPlan).toHaveBeenCalledWith(102, "rejected");
      expect(deps.uiOps.persistPlanVerdict).toHaveBeenCalledWith(
        session,
        "rejected",
        "Step 1: Write code",
      );
      expect(deps.uiOps.emit).toHaveBeenCalledWith(session, {
        type: "planNotice",
        text: "Plan rejected — staying in Plan mode.",
      });
    });
  });

  describe("queueInFlightPlanCommentsOnExit", () => {
    it("recovers in-flight comments into queued sends on unexpected exit", () => {
      const deps = makeMockDeps();
      const ps = createProviderSession(deps);
      const session = deps.getFocused();
      const client = {} as any;
      session.inFlightPlanComments.set("c1", { client, gen: 1, text: "Comment 1" });
      session.inFlightPlanComments.set("c2", { client, gen: 1, text: "Comment 2" });

      ps.queueInFlightPlanCommentsOnExit(session, client, 1);

      expect(session.inFlightPlanComments.size).toBe(0);
      expect(session.queuedSends.length).toBeGreaterThan(0);
      expect(session.queuedSends[0].text).toContain("Comment 1");
    });
  });

  describe("planModeCompatibility", () => {
    it("returns available when version is sufficient", async () => {
      const deps = makeMockDeps();
      deps.providerOps.readGrokVersion = vi.fn(async () => "grok 1.5.0");
      const ps = createProviderSession(deps);

      const result = await ps.planModeCompatibility("/bin/grok", { notify: false });
      expect(result.planModeAvailable).toBe(true);
    });
  });
});
