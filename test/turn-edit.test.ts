import { unwiredOps } from "./unwired-ops";
import { describe, expect, it, vi } from "vitest";
import { TurnEdit, createTurnEdit, type TurnEditDeps } from "../src/turn-edit";
import { Session } from "../src/session";
import { ContextBudgetExceededError } from "../src/context-budget";

function makeMockDeps(): TurnEditDeps {
  const session = new Session();
  session.activeSessionId = "sess-1";
  session.provider = "grok";
  return {
    sidebarOps: unwiredOps(),
    host: {
      appendLine: vi.fn(),
      showInformationMessage: vi.fn(async () => undefined),
      showWarningMessage: vi.fn(async () => undefined),
      showErrorMessage: vi.fn(async () => undefined),
      showQuickPick: vi.fn(async () => undefined),
    } as any,
    state: {
      get: vi.fn(() => ({})),
      update: vi.fn(async () => {}),
    } as any,
    context: {
      extensionVersion: "0.2.0",
    } as any,
    getFocused: () => session,
    getSessionCache: () => new Map(),
    steerOps: {
      emit: vi.fn(),
      emitQueuedSends: vi.fn(),
      refreshImplicitChip: vi.fn(),
      postChips: vi.fn(),
      notifyUser: vi.fn(),
      contextChipPayloads: vi.fn(() => () => undefined),
      readImageChip: vi.fn(async () => "gone"),
      retainUploadedFilesForSession: vi.fn(async () => {}),
      maybeFlushQueuedSends: vi.fn(async () => {}),
    },
    rewindOps: {
      notifyUser: vi.fn(),
      rewindFromClientCheckpoints: vi.fn(async () => {}),
      restoreComposerFor: vi.fn(),
      checkWorkspaceGitStatus: vi.fn(async () => ({ hasUncommittedChanges: false })),
      workspaceRoot: () => "/work/test",
      confirmInChat: vi.fn(async () => true),
      truncateSessionCardsAfterRewind: vi.fn(async () => {}),
      applyRewindToView: vi.fn(),
      sessionDisplayName: vi.fn(() => "Test Session"),
      sessionCwd: vi.fn(() => "/work/test"),
      openSession: vi.fn(async () => {}),
      rememberQueuedDraft: vi.fn(async () => {}),
    },
    authLimitOps: {
      usableProviders: () => ["grok", "claude"],
      emit: vi.fn(),
      post: vi.fn(),
      rememberProjectProvider: vi.fn(async () => {}),
      sessionCwd: vi.fn(() => "/work/test"),
      startSession: vi.fn(async () => ({ sessionId: "resumed-1" })),
      handleSend: vi.fn(async () => {}),
      setProviderNeedsLogin: vi.fn(),
      startTurnGitBaseline: vi.fn(),
      setStatus: vi.fn(),
      emitAbandonedSend: vi.fn(),
      turnEndFields: vi.fn(() => ({ status: "done" })),
      noteLiveTurnEnded: vi.fn(),
      maybeGenerateTitle: vi.fn(),
      postSessionName: vi.fn(),
      onboardingForSession: vi.fn(() => "none"),
    },
    feedbackOps: {
      ackTurnFeedback: vi.fn(),
      latchFeedbackUnavailable: vi.fn(),
      thumbsFeedbackEnabled: () => true,
      notifyUser: vi.fn(),
      contextExtensionVersion: () => "0.2.0",
      canSwitchWorkspaceFolder: () => true,
    },
  };
}

describe("TurnEdit", () => {
  it("keeps a blocked draft and restores its attachments once on reduce", async () => {
    const deps = makeMockDeps();
    const session = deps.getFocused();
    const emit = vi.fn();
    const edit = createTurnEdit({ ...deps, sidebarOps: { emit, host: deps.host, turnEndFields: () => ({}), noteLiveTurnEnded: vi.fn(), setStatus: vi.fn() } as any });
    const chip = { id: "attachment" } as any;
    const error = new ContextBudgetExceededError({ action: "block", reason: "overflow", quality: "verified", projected: 101, window: 100 });
    expect(edit.surfaceContextOverflow(session, error, "draft", [chip])).toBe(true);
    expect(emit.mock.calls.some(([, frame]) => frame.type === "restoreComposer")).toBe(false);
    session.chips = [chip];
    await edit.answerContextOverflow(session, { id: session.pendingOverflow!.id, action: "dismiss" });
    expect(session.chips).toEqual([chip]);
    expect(emit).toHaveBeenCalledWith(session, { type: "restoreComposer", text: "draft" });
  });
  it("restores the draft after failed compaction without retrying the turn", async () => {
    const deps = makeMockDeps();
    const session = deps.getFocused();
    const emit = vi.fn();
    const send = vi.fn(async () => { session.status = "error"; });
    session.pendingOverflow = { id: "overflow", text: "draft", chips: [] };
    await createTurnEdit({ ...deps, sidebarOps: { emit, handleSend: send } as any }).answerContextOverflow(session, { id: "overflow", action: "compact-retry" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith("/compact", true, session);
    expect(emit).toHaveBeenCalledWith(session, { type: "restoreComposer", text: "draft" });
  });
  it("creates an instance via factory", () => {
    const deps = makeMockDeps();
    const turnEdit = createTurnEdit(deps);
    expect(turnEdit).toBeInstanceOf(TurnEdit);
  });

  it("steerSend queues if session has no client", async () => {
    const deps = makeMockDeps();
    const turnEdit = createTurnEdit(deps);
    const session = deps.getFocused();
    session.client = undefined;

    await turnEdit.steerSend("hello steer", session);
    expect(session.queuedSends).toEqual([{ text: "hello steer", chips: [] }]);
    expect(deps.steerOps.emitQueuedSends).toHaveBeenCalledWith(session);
  });

  it("handleTurnFeedback acknowledges valid rating when enabled", async () => {
    const deps = makeMockDeps();
    const turnEdit = createTurnEdit(deps);
    const session = deps.getFocused();
    session.feedbackAvailable = true;
    session.liveFeedbackEligible = true;
    session.client = {
      sessionId: "s1",
      submitFeedback: vi.fn(async () => "ok"),
    } as any;

    await turnEdit.handleTurnFeedback(1, session);
    expect(deps.feedbackOps.ackTurnFeedback).toHaveBeenCalledWith(session, 1);
  });

  it("answerLimitOffer handles retry action", async () => {
    const deps = makeMockDeps();
    const turnEdit = createTurnEdit(deps);
    const session = deps.getFocused();
    session.pendingLimitOffer = {
      id: "offer-1",
      source: "grok",
      kind: "rate_limit",
      text: "original query",
      chips: [],
    } as any;

    await turnEdit.answerLimitOffer(session, { id: "offer-1", action: "retry" });
    expect(deps.steerOps.emit).toHaveBeenCalledWith(session, {
      type: "limitOfferResolved",
      id: "offer-1",
      action: "retry",
    });
    expect(deps.authLimitOps.handleSend).toHaveBeenCalledWith("original query", false, session);
  });

  it("forkFocusedSession warns if session has no conversation", async () => {
    const deps = makeMockDeps();
    const turnEdit = createTurnEdit(deps);
    const session = deps.getFocused();
    session.client = { forkSession: vi.fn() } as any;
    session.hasHistory = false;

    await turnEdit.forkFocusedSession(session);
    expect(deps.steerOps.notifyUser).toHaveBeenCalledWith("info", expect.stringContaining("Nothing to fork"));
  });
});
