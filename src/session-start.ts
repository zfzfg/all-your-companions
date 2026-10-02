import { MuseBackend } from "./muse-backend";
import { isMuseModeId, museSettings, musePosture, MUSE_MODE_PREF_KEY, sessionModes } from "./mode-prefs";
import { compactNotice } from "./provider-ui";
import { effectiveContextWindow, type ContextObservation } from "./context-budget";
import { PROVIDER_CLI } from "./provider-cli";
import { providerCapability } from "./provider-capabilities";
import { applyHostMode, autoApproveNativePlanTools } from "./provider-modes";
export interface SessionStartSidebarOps {
  readonly focused: Session;
}
/**
 * Session lifecycle management: exclusive startup, process spawning,
 * ACP handshake, resume/load replay, and outbound send dispatch.
 * Extracted from GrokSidebar (W-15 Schritt D9).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  AcpClient,
  EffortLevel,
  ExitPlanRequest,
  PermissionRequest,
  QuestionRequest
} from "./acp";
import type { AcpProvider } from "./acp-backend";
import { isAdapterProvider, supportsClientMcpServers } from "./acp-backend";
import { allProviderCapabilities } from "./provider-capabilities";
import { missingProviderState, providerDisplayName } from "./provider-ui";
import { Uri } from "./host";
import type { Host, HostContext } from "./host";
import {
  Session,
  SessionStartIntent,
  SessionStatus,
  beginTurn,
  decideSessionStart,
  endTurn,
  finishQueuedSendCommit,
  sessionReadyForPrompt,
  turnIsInFlight,
  type QuestionResponder
} from "./session";
import type { HostMsg } from "./protocol";
import { OpenClock } from "./open-timing";
import {
  GROK_COMPACT_ENV,
  compactEventKind,
  compactSummaryPreview,
  normalizeCompactThreshold
} from "./grok-compaction";
import {
  EXTENSION_HOST_SLASH_COMMANDS,
  matchSlashCommand,
  parseAgentCommand,
  parseCrewCommand,
  parseHandoffCommand,
  parseSubagentsCommand
} from "./slash-filter";
import { applyAgentModeToHostPlan } from "./plan-gate";
import {
  countsAsUserBubble,
  decideRestoreState,
  isInterjectionText,
  planRestoreSource
} from "./plan-restore";
import {
  SessionMetaOverrides,
  capAutoName,
  defaultFs,
  resolveGrokHome,
  sessionDirFor
} from "./sessions";
import { SESSION_META_KEY } from "./worktree-host";
import type { TerminalManager } from "./terminal-manager";
import {
  agentTimestampMsFromMeta,
  autoCompactStartedNote,
  childStreamFromRoute,
  commandOutputForToolCall,
  commandOutputFromLiveTerminal,
  contextUsedFromCompactNotification,
  errorDetail,
  gateZeroTokenMeta,
  isCredentialError,
  isIncompatibleAgentError,
  isResumeNotFound,
  isSubagentLifecycleUpdate,
  promptErrorText,
  replayedTurnDuration,
  summarizeBackgroundCommand,
  turnStatusFromPromptResult,
  type MediaRef,
  type UpdateRoute
} from "./acp-dispatch";
import { createMcpPrepareState, prepareMcpToolCall } from "./mcp-tool";
import {
  consumeChips,
  isImageChip,
  isImplicitChip,
  type FileChip
} from "./chips";
import { isFileChip, type ContextChip } from "./context-chips";
import { parseSubagentMentions } from "./subagent-directives";
import { explicitVisibleChips, type QueuedSendEntry } from "./queued-send";
import {
  buildPromptWithImages,
  buildQueuedPromptWithImages,
  type PromptImageInput,
  type QueuedPromptContribution
} from "./prompt-builder";
import { historyImagePreviews } from "./image-history";
import { isPrimerText } from "./grok-primer";
import { rememberedEffort, startsInYolo, type EffortPrefs } from "./mode-prefs";
import { commandsAdvertiseFeedback, parseFeedbackEnabledMeta } from "./feedback";
import { GROK_STDIO_DOWNGRADE_TARGET, parseGrokVersion, shouldReactivelyDowngrade } from "./cli-locator";
import { parseRunProgressUpdate } from "./run-progress";
import type { SubscriptionWindow } from "./subscription-usage";


type OnboardingState = Extract<HostMsg, { type: "onboarding" }>["state"];

/** Same shape as the sidebar's Plan-availability probe result. */
export interface PlanModeCompatibility {
  planModeAvailable: boolean;
  planModeUnavailableReason?: string;
  planModeVersionVerified: boolean;
  usedCache?: boolean;
  cliVersion?: string;
}

export interface SessionStartWorkspaceOps {
  openWorkspaceFolders(): readonly any[];
  isAuthorizedCwd(cwd: string): boolean;
  presentEmptyProjectState(target: Session): void;
  postRepoCatalog(): void;
  postSessionsList(): void;
  postSessionName(session: Session): void;
  updateSessionMeta(
    updater: (current: SessionMetaOverrides) => SessionMetaOverrides | null,
  ): Promise<void>;
  sessionCacheDelete(id: string): void;
  findWorkspaceSensitiveFiles(workspaceRoot?: string): string[];
}

export interface SessionStartProviderOps {
  locateProvider(provider: AcpProvider): string | undefined;
  usableProviders(): AcpProvider[];
  connectedProviders(): AcpProvider[];
  defaultProviderForProject(cwd: string): AcpProvider;
  providerDefaultForProject(cwd: string, provider: AcpProvider): string | undefined;
  rememberProjectProvider(cwd: string, provider: AcpProvider, model?: string): Promise<void>;
  postProviderState(): void;
  setProviderNeedsLogin(provider: AcpProvider, needs: boolean): void;
  onboardingForSession(session: Session): OnboardingState;
  createProviderBackend(provider: AcpProvider, effort?: EffortLevel): any;
  acpClientTimeouts(): any;
  buildEnv(cwd: string): NodeJS.ProcessEnv;
  readonly providerCliVersions: Record<string, string>;
  cacheProviderModels(provider: AcpProvider, models: any[], current?: string): PromiseLike<void>;
  modelsForSession(session: Session, models: any[], current?: string, allowDefault?: boolean): any[];
  refreshFeedbackAvailability(session: Session): void;
  maybeUpdateCliOnUpgrade(cliPath: string): Promise<void>;
  maybePinBrokenCli(cliPath: string): Promise<void>;
  readGrokVersion(cliPath: string): Promise<string>;
  downgradeBrokenCli(cliPath: string, version: string, mode: "proactive" | "reactive"): Promise<boolean>;
  rememberGrokConfig(key: "defaultEffort" | "defaultModel" | "defaultMode", value: string): Promise<void>;
}

export interface SessionStartReviewAndPlanOps {
  planModeCompatibility(cliPath: string): Promise<PlanModeCompatibility>;
  applyPlanModeCompatibility(session: Session, compatibility: PlanModeCompatibility): void;
  setPlanActive(session: Session, active: boolean): void;
  postMode(): void;
  recoverUnavailablePlanMode(session: Session, client: AcpClient, gen: number, reqId?: string | number): void;
  withPlanReviewPaths(saved: any[], resumeId: string): Promise<any[]>;
  createPlanReviewSnapshot(text: string, resumeId: string): Promise<{ path: string; name: string } | undefined>;
  applyPlanUpdate(session: Session, u: any): void;
  postExitPlanRequest(req: ExitPlanRequest, session: Session, gen: number): Promise<void>;
  snapshotAbsPaths(session: Session, paths: string[]): void;
  noteCheckpointAfterContent(session: Session, path: string, content: string): void;
  snapshotPendingEditToolCall(session: Session, call: any): void;
  beginCheckpointTurn(session: Session, text: string): void;
  finishCheckpointTurn(session: Session): void;
  noteReviewToolCall(session: Session, call: any): void;
  startTurnGitBaseline(session: Session, turn: any): void | Promise<void>;
  settleUnavailablePlanTurn(session: Session, client: AcpClient, gen: number): void;
}

export interface SessionStartTurnAndSendOps {
  turnInFlight(session: Session): boolean;
  divertRacingSend(session: Session, text: string, bare: boolean, chips?: ContextChip[]): void;
  readonly pendingAttach: Set<Promise<unknown>>;
  readImageChip(chip: FileChip, session: Session, gen: number): Promise<PromptImageInput | "gone" | "failed">;
  contextChipPayloads(chips: ContextChip[]): any;
  applyTurnDirectives(session: Session, text: string, chips?: readonly ContextChip[]): { text: string; block?: string };
  retainUploadedFilesForSession(session: Session, chips: ContextChip[]): Promise<void>;
  refreshImplicitChip(force?: boolean): void;
  postChips(session: Session): void;
  emitQueuedSends(session: Session): void;
  maybeFlushQueuedSends(session: Session): Promise<void>;
  reportSessionStart(session: Session): void;
  lockSessionTypeNow(session: Session): void;
  refreshContextAfterCompact(client: AcpClient, session: Session, gen: number): Promise<void>;
  holdTurnForSubagents(session: Session, meta?: any): boolean;
  maybeGenerateTitle(session: Session): void;
  surfaceLimitError(session: Session, err: unknown, text: string, chips: ContextChip[]): boolean;
  surfaceContextOverflow(session: Session, err: unknown, text: string, chips: ContextChip[]): boolean;
  recoverAuthAndResend(session: Session, err: unknown, text: string, chips: ContextChip[], blocks: any[]): Promise<boolean>;
  emitAbandonedSend(session: Session): void;
  turnEndFields(session: Session, status: any): any;
}

export interface SessionStartLifecycleOps {
  detachClient(session: Session): void;
  replayLoadedHistory(session: Session, action: () => Promise<void>): Promise<void>;
  restoreSessionType(session: Session): void;
  persistSessionType(session: Session): void;
  postSessionType(session: Session): void;
  flushHiddenChildMeta(session: Session): void;
  restorePersistedDraft(session: Session): void;
}
export interface SessionStartUsageOps {
  emitContextUsage(session: Session): void;
  refreshContextFromSessionInfo(session: Session, gen: number, opts?: { force?: boolean }): Promise<boolean>;
  restoreUsage(session: Session): void;
  bindSubscriptionUsage(session: Session, env: NodeJS.ProcessEnv): void;
  refreshSubscriptionUsage(session: Session): Promise<void>;
  publishSubscriptionUsage(session: Session): void;
  noteAdapterCompactSignal(session: Session, signal: any): void;
  adapterTurnOccupancy(session: Session, meta?: any): number | undefined;
  rememberAdapterContext(session: Session, patch: any): any;
  accumulateUsage(session: Session, meta?: any): PromiseLike<void> | undefined;
}
export interface SessionStartEventOps {
  confirmRepoForcedAutoApprove(cwd: string): Promise<boolean>;
  configForcesAutoApprove(cwd: string): boolean;
  noticeAlwaysApproveOnce(cwd: string): void;
  queueInFlightPlanCommentsOnExit(session: Session, client: AcpClient, gen: number): void;
  stopVoiceInput(session: Session): void;
  drainPendingConfirms(session: Session): void;
  dropPendingQuestions(session: Session): void;
  revokeAskUserToken(session: Session): void;
  warnOAuthShadowOnce(authMethodId: string | undefined, env: NodeJS.ProcessEnv): void;
  syncHumanWait(session: Session): void;
  showQuestion(session: Session, req: QuestionRequest, responder: QuestionResponder): void;
  closeQuestionsForToolCall(session: Session, call: any): void;
  handlePermissionRequest(session: Session, client: AcpClient, req: PermissionRequest, cwd: string): void;
  applyMcpNotification(session: Session, method: string, params: unknown): void;
  noteNativeChild(session: Session, u: any): void;
  postGeneratedMedia(m: MediaRef, session: Session, gen: number): Promise<void>;
  hostMcpServersFor(session: Session): Promise<any[]>;
  imageStagingDir(): string;
}

export interface SessionStartWorkflowCommandsOps {
  handleAgentCommand(text: string, session: Session): Promise<boolean | void>;
  handleHandoffCommand(text: string, session: Session): Promise<boolean | void>;
  handleCrewCommand(text: string, session: Session): Promise<boolean | void>;
  handleSubagentsCommand(text: string, session: Session): void;
  handleCrewSessionInput(text: string, session: Session): Promise<boolean | void>;
}

export interface SessionStartFlags {
  getTestSessionStartDelay(): any;
  setTestSessionStartDelay(val: any): void;
  getMcpConnectorKeysReady(): Promise<void> | undefined;
  getReactiveDowngradeInFlight(): boolean;
  setReactiveDowngradeInFlight(val: boolean): void;
  getWarnedSensitiveFiles(): boolean;
  setWarnedSensitiveFiles(val: boolean): void;
  postLocal(msg: any): void;
}

/**
 * Top-level context interface for SessionStart.
 * Capped to <= 25 members by design.
 */
export interface SessionStartDeps {
  readonly host: Host;
  readonly state: HostContext["globalState"];
  emit(session: Session, msg: HostMsg): void;
  post(msg: HostMsg): void;
  sessionCwd(session: Session): string;
  workspaceRoot(): string;
  getFocused(): Session;
  getPool(): Set<Session>;
  touch(session: Session): void;
  reapPool(): void;
  setStatus(session: Session, status: SessionStatus): void;
  noteSessionActivity(session: Session): void;
  noteLiveTurnEnded(session: Session): void;
  readonly terminalManager: TerminalManager;
  readonly workspaceOps: SessionStartWorkspaceOps;
  readonly providerOps: SessionStartProviderOps;
  readonly reviewAndPlanOps: SessionStartReviewAndPlanOps;
  readonly turnAndSendOps: SessionStartTurnAndSendOps;
  readonly sessionLifecycleOps: SessionStartLifecycleOps;
  readonly workflowCommandsOps: SessionStartWorkflowCommandsOps;
  readonly flags: SessionStartFlags;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;

  readonly usageOps: SessionStartUsageOps;
  readonly eventOps: SessionStartEventOps;

  readonly sidebarOps: SessionStartSidebarOps;
}

export class SessionStart {
  private sessionStartTails = new WeakMap<Session, Promise<void>>();

  constructor(public readonly deps: SessionStartDeps) { }

  private sessionStartTailMap(): WeakMap<Session, Promise<void>> {
    return this.sessionStartTails;
  }

  public runExclusiveSessionStart<R>(session: Session, action: () => Promise<R>): Promise<R> {
    const tails = this.sessionStartTailMap();
    const previous = tails.get(session) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(action);
    const tail = run.then(() => undefined, () => undefined);
    tails.set(session, tail);
    return run.finally(() => {
      if (tails.get(session) === tail) tails.delete(session);
    });
  }

  public async waitForSessionStart(session: Session): Promise<void> {
    const tail = this.sessionStartTailMap().get(session);
    if (tail) await tail;
  }

  public async startSession(
    resumeId?: string,
    target: Session = this.deps.getFocused(),
    intent: SessionStartIntent = "replace",
    clock?: OpenClock,
  ): Promise<AcpClient | undefined> {
    return this.runExclusiveSessionStart(target, async () => {
      this.postStartupStatus(target, "session");
      let started: AcpClient | undefined;
      try { return started = await this.startSessionBody(resumeId, target, intent, clock); }
      finally {
        if (!started && !target.client) { target.priming = false; this.deps.emit(target, { type: "setBusy", value: false }); }
        this.postStartupStatus(target, null);
      }
    });
  }

  private postStartupStatus(session: Session, stage: "session" | "consent" | "cli-update" | null): void {
    session.startupStatus = { type: "startupStatus", stage, sessionId: session.composerDraftId ?? session.activeSessionId,
      generation: session.gen, sequence: ++session.startupSequence };
    this.deps.emit(session, session.startupStatus);
  }

  /**
   * Main startup coordinator. Executes the exclusive startup steps:
   * pre-flight checks, consent gate, version & compatibility checks,
   * client spawn, and transcript load/resume.
   */
  public async startSessionBody(
    resumeId: string | undefined,
    target: Session,
    intent: SessionStartIntent,
    startedClock?: OpenClock,
  ): Promise<AcpClient | undefined> {
    const clock = startedClock ?? new OpenClock();
    const priorMs = clock.collapse("downgrade");
    const resolveMs = clock.totalMs() - priorMs;
    let approveGateMs = 0;

    if (
      this.deps.host.canSwitchWorkspaceFolder &&
      !this.deps.workspaceOps.openWorkspaceFolders().length &&
      !resumeId &&
      !target.cwd
    ) {
      this.deps.workspaceOps.presentEmptyProjectState(target);
      return undefined;
    }

    if (
      this.deps.host.canSwitchWorkspaceFolder &&
      target.cwd &&
      !this.deps.workspaceOps.isAuthorizedCwd(target.cwd)
    ) {
      this.deps.host.appendLine(
        `[sessions] refused startSession (cwd not authorized): ${target.cwd}` +
        (resumeId ? ` resumeId=${resumeId}` : ""),
      );
      if (!this.deps.workspaceOps.openWorkspaceFolders().length) {
        this.deps.workspaceOps.presentEmptyProjectState(target);
      } else {
        target.priming = false;
        this.deps.emit(target, { type: "setBusy", value: false });
        this.deps.workspaceOps.postRepoCatalog();
        this.deps.workspaceOps.postSessionsList();
      }
      return undefined;
    }

    if (!resumeId && !target.hasHistory && !this.deps.providerOps.usableProviders().includes(target.provider)) {
      const fallback = this.deps.providerOps.defaultProviderForProject(this.deps.sessionCwd(target));
      if (fallback !== target.provider && this.deps.providerOps.usableProviders().includes(fallback)) {
        this.deps.host.appendLine(
          `[providers] ${target.provider} cannot answer; empty session retargeted to ${fallback}`,
        );
        target.provider = fallback;
        await this.deps.providerOps.rememberProjectProvider(this.deps.sessionCwd(target), fallback);
        this.deps.providerOps.postProviderState();
      }
    }

    if (!this.deps.providerOps.connectedProviders().includes(target.provider)) {
      const testDelay = this.deps.flags.getTestSessionStartDelay();
      if (testDelay && testDelay.resumeId === resumeId) {
        this.deps.flags.setTestSessionStartDelay(undefined);
        testDelay.started();
        await testDelay.wait;
      }
      target.priming = false;
      this.deps.emit(target, { type: "setBusy", value: false });
      this.deps.providerOps.postProviderState();
      this.deps.emit(target, {
        type: "onboarding",
        state: this.deps.providerOps.usableProviders().length ? missingProviderState(target.provider) : "connect-agent",
        platform: process.platform,
        provider: target.provider,
      });
      return undefined;
    }

    this.postStartupStatus(target, "consent");
    const consentAt = clock.now();
    if (autoApproveNativePlanTools(target.provider) && !(await this.deps.eventOps.confirmRepoForcedAutoApprove(this.deps.sessionCwd(target)))) {
      return undefined;
    }
    approveGateMs = clock.elapsed(consentAt);
    this.postStartupStatus(target, "session");

    const startDecision = decideSessionStart(target, resumeId, intent);
    if (startDecision === "reuse" || startDecision === "refuse-turn") {
      if (startDecision === "refuse-turn") {
        this.deps.host.appendLine(`[sessions] refused startSession (turn in flight)`);
      }
      return target.client;
    }
    if (startDecision === "refuse-mismatch") {
      this.deps.host.appendLine(
        `[sessions] refused startSession (ensure resumeId=${resumeId} does not match live session)`,
      );
      return undefined;
    }

    const session = target;
    clock.record("resolve", resolveMs);
    clock.record("approve-gate", approveGateMs);
    const openedAt = clock.now();
    const replacedClient = session.client;
    if (replacedClient) {
      this.deps.eventOps.queueInFlightPlanCommentsOnExit(session, replacedClient, session.gen);
    }
    const gen = ++session.gen;
    const testDelay = this.deps.flags.getTestSessionStartDelay();
    if (testDelay && testDelay.resumeId === resumeId) {
      this.deps.flags.setTestSessionStartDelay(undefined);
      testDelay.started();
      await testDelay.wait;
      if (gen !== session.gen) return undefined;
    }

    const keepTranscript = session.keepTranscriptOnStart === true;
    session.keepTranscriptOnStart = false;
    if (!keepTranscript) session.buffer = [];
    session.subscriptionUsage = undefined;
    session.companionsMcpInjected = undefined;
    session.companionsSkipReason = undefined;
    session.companionsSkipAnnounced = false;
    session.status = "idle";
    session.turnToken = undefined;

    this.deps.eventOps.stopVoiceInput(session);
    this.deps.eventOps.drainPendingConfirms(session);
    session.client = undefined;

    const disposeAt = clock.now();
    if (replacedClient) {
      try {
        const n = this.deps.terminalManager.releaseOwnedBy(replacedClient);
        if (n > 0) this.deps.host.appendLine(`[terminal] released ${n} command(s) with the replaced client`);
      } catch { /* teardown is not worth failing over */ }
      await replacedClient.dispose();
      if (gen !== session.gen) return undefined;
    }
    const disposeMs = replacedClient ? clock.elapsed(disposeAt) : 0;
    clock.record("dispose", disposeMs);

    const rememberedYolo = startsInYolo(
      this.deps.state.get<Record<string, string>>("grok.modeByProvider", {})[session.provider] ?? this.deps.host.getConfiguration("grok").get<string>("defaultMode", ""),
      !!resumeId,
    );
    const configAutoApprove = autoApproveNativePlanTools(session.provider) && this.deps.eventOps.configForcesAutoApprove(this.deps.sessionCwd(session));
    session.musePosture = session.provider === "muse" ? musePosture(this.deps.state.get(MUSE_MODE_PREF_KEY),
      resumeId ? this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[resumeId]?.musePosture : undefined,
      museSettings(this.deps.host.getConfiguration("grok"))) : undefined;
    session.autoApprove = session.musePosture ? session.musePosture.mode === "yolo" : rememberedYolo || configAutoApprove;
    session.planActive = false;
    session.sessionPermissionRules = [];
    session.hasHistory = !!resumeId;
    session.suppressContent = false;
    session.captureAgentText = undefined;
    session.lastSessionInfoAt = 0;
    session.lastSessionInfoUsed = undefined;
    session.sessionInfoStale = false;
    session.sessionInfoUnsupported = false;
    session.sawCompactNotification = false;
    session.lastPlanText = "";
    session.planEntries = [];
    session.reviewBlocks = [];
    session.pendingExitPlans.clear();
    this.deps.eventOps.dropPendingQuestions(session);
    this.deps.eventOps.revokeAskUserToken(session);
    session.inFlightPlanComments.clear();
    if (session.planModeRecovery?.warningTimer) clearTimeout(session.planModeRecovery.warningTimer);
    session.planModeRecovery = undefined;
    session.interjectionCount = 0;
    session.historyEventCount = 0;
    session.replayUserRaw = "";
    session.replayUserCounted = false;
    session.replayUserIsInterjection = false;
    session.userMessageCount = 0;
    session.inUserMessage = false;
    session.feedbackAvailable = false;
    session.feedbackUnsupported = false;
    session.feedbackMetaEnabled = undefined;
    session.feedbackCommandsAdvertise = undefined;
    session.liveFeedbackEligible = false;
    session.turnRating = 0;
    session.activeSessionId = undefined;
    session.titleGenerated = false;
    session.firstUserMessageForTitle = undefined;
    session.priming = true;
    session.compactUsageArmed = false;
    session.adapterCompactThisTurn = false;
    session.adapterTurnCallUsed = [];


    if (configAutoApprove) this.deps.eventOps.noticeAlwaysApproveOnce(this.deps.sessionCwd(session));
    if (resumeId || !keepTranscript) this.deps.emit(session, { type: "clearMessages" });

    this.deps.emit(session, { type: "setBusy", value: true, locked: true });

    const cliPath = this.deps.getOverride?.("locateProvider")?.(session.provider) ?? this.deps.providerOps.locateProvider(session.provider);
    if (!cliPath) {
      if (gen !== session.gen) return undefined;
      this.deps.getPool().delete(session);
      session.priming = false;
      this.deps.emit(session, { type: "setBusy", value: false });
      this.deps.emit(session, {
        type: "onboarding",
        state: missingProviderState(session.provider),
        platform: process.platform,
        provider: session.provider,
      });
      return undefined;
    }

    clock.record("prep", Math.max(0, clock.elapsed(openedAt) - disposeMs));
    const versionAt = clock.now();
    const handshake = await this.performSessionHandshake(session, cliPath, gen);
    if (gen !== session.gen) return undefined;
    clock.record("version", clock.elapsed(versionAt), handshake.versionNote);
    const afterVersionAt = clock.now();

    const envConfig = await this.configureSessionEnvironment(session, resumeId, gen);
    if (gen !== session.gen) return undefined;

    const startSpawnAttempts = 3;
    const startSpawnBackoffMs = [300, 900] as const;

    for (let attempt = 1; attempt <= startSpawnAttempts; attempt++) {
      if (gen !== session.gen) return undefined;
      const client = this.spawnSessionProcess(
        session,
        cliPath,
        envConfig.cwd,
        envConfig.env,
        envConfig.effort,
        handshake,
        gen,
        resumeId,
      );
      if (attempt === 1) clock.record("client", clock.elapsed(afterVersionAt));
      let replayBegan = false;

      try {
        const spawnAt = clock.now();
        await client.start();
        clock.record("spawn+init", clock.elapsed(spawnAt));
        if (gen !== session.gen) { void client.dispose(); return undefined; }

        const startOverrides = session.startOverrides;
        session.startOverrides = undefined;
        const defaultModel = startOverrides?.model
          || this.deps.providerOps.providerDefaultForProject(envConfig.cwd, session.provider)
          || "";

        if (resumeId) {
          replayBegan = true;
          await this.loadOrResumeSession(session, client, defaultModel, resumeId, clock, gen, envConfig.cwd);
        } else {
          const newAt = clock.now();
          await client.newSession(defaultModel || undefined);
          clock.record("new", clock.elapsed(newAt));
          clock.record("load", 0);
          clock.record("replay(post)", 0);
          session.activeSessionId = client.sessionId;
          this.deps.sessionLifecycleOps.flushHiddenChildMeta(session);
          this.deps.sessionLifecycleOps.persistSessionType(session);
          this.deps.sessionLifecycleOps.postSessionType(session);

          if (startOverrides?.mode === "plan" && session.planModeAvailable) {
            this.deps.reviewAndPlanOps.setPlanActive(session, true);
            try { await applyHostMode(client, session.provider, "plan"); } catch { /* best-effort */ }
          }
          if (session.autoApprove) {
            try {
              if (session.provider !== "muse") await applyHostMode(client, session.provider, "yolo");
            } catch { /* best-effort */ }
          }
        }

        if (gen !== session.gen) { void client.dispose(); session.client = undefined; return undefined; }
        this.deps.host.appendLine(clock.summary(session.historyEventCount));
        this.deps.workspaceOps.postSessionName(session);

        if (session.provider === "grok" && defaultModel && client.currentModelId && client.currentModelId !== defaultModel) {
          const hasModel = client.availableModels.some((m) => m.modelId === defaultModel);
          if (!hasModel) {
            this.deps.host.appendLine(
              `[startup] Default model '${defaultModel}' is not available; switching grok.defaultModel to '${client.currentModelId}'.`,
            );
            void this.deps.providerOps.rememberGrokConfig("defaultModel", client.currentModelId);
          }
        }

        if (session.provider === "grok") {
          const warnEnabled = this.deps.host.getConfiguration("companions").get<boolean>(
            "sensitiveFilesWarn",
            this.deps.host.getConfiguration("grok").get<boolean>("sensitiveFilesWarn", true),
          );
          if (warnEnabled && !this.deps.flags.getWarnedSensitiveFiles()) {
            const sensitive = this.deps.workspaceOps.findWorkspaceSensitiveFiles(session.cwd || this.deps.workspaceRoot());
            if (sensitive.length > 0) {
              this.deps.flags.setWarnedSensitiveFiles(true);
              this.deps.host.appendLine(
                `[security] Sensitive file(s) detected in workspace (${sensitive.slice(0, 3).join(", ")}). Note: Grok CLI ignores are configured in ~/.grok/config.toml.`,
              );
              this.deps.flags.postLocal({
                type: "hostNotice",
                level: "warning",
                text: `Sensitive file(s) detected in workspace (${sensitive.slice(0, 3).join(", ")}). Configure exclusions in ~/.grok/config.toml.`,
              });
            }
          }
        }

        if (session.client !== client) throw new Error("the provider exited during startup");
        this.deps.usageOps.bindSubscriptionUsage(session, envConfig.env);
        void this.deps.usageOps.refreshSubscriptionUsage(session);

        session.priming = false;
        session.needsProvider = false;
        this.deps.getPool().add(session);
        this.deps.touch(session);
        this.reapPool(); // enforce the LRU cap now that the pool grew
        this.emit(session, { type: "setBusy", value: false });
        this.deps.sessionLifecycleOps.restorePersistedDraft(session);
        if (gen === session.gen) void this.deps.turnAndSendOps.maybeFlushQueuedSends(session);

        if (session.client !== client) { this.deps.getPool().delete(session); return undefined; }
        return client;
      } catch (err) {
        if (gen !== session.gen) { void client.dispose(); return undefined; }
        const msg = (err as any).message ?? String(err);
        const credentialFailure =
          (client.provider !== "grok" && client.isCredentialError(err)) ||
          /auth|unauthor|401|api[_\s-]?key|credential|sign.?in/i.test(msg);
        const stdioRegression =
          session.provider === "grok" &&
          process.platform === "win32" &&
          /timed out: (initialize|session\/(new|load))|exited \(code null\)/i.test(msg);
        const userFacing = credentialFailure || stdioRegression || replayBegan || attempt >= startSpawnAttempts;
        client.removeAllListeners("exit");
        this.deps.eventOps.drainPendingConfirms(session);
        void client.dispose();
        session.client = undefined;
        if (!userFacing) {
          await new Promise<void>((resolve) => setTimeout(resolve, startSpawnBackoffMs[attempt - 1]));
          if (gen !== session.gen) return undefined;
          continue;
        }
        this.deps.getPool().delete(session);
        session.priming = false;
        this.deps.emit(session, { type: "setBusy", value: false });

        if (credentialFailure) {
          if (client.isCredentialError(err) || isCredentialError(err)) {
            this.deps.providerOps.setProviderNeedsLogin(session.provider, true);
          }
          this.deps.emit(session, { type: "onboarding", state: this.deps.providerOps.onboardingForSession(session) });
        } else if (stdioRegression) {
          const version = await this.deps.providerOps.readGrokVersion(cliPath);
          if (gen !== session.gen) return undefined;
          if (!this.deps.flags.getReactiveDowngradeInFlight() && shouldReactivelyDowngrade(version, process.platform)) {
            this.deps.flags.setReactiveDowngradeInFlight(true);
            try {
              const detected = parseGrokVersion(version)?.join(".") ?? version;
              if (await this.deps.providerOps.downgradeBrokenCli(cliPath, detected, "reactive")) {
                if (gen !== session.gen) return undefined;
                return await this.startSessionBody(resumeId, session, intent, clock);
              }
            } finally {
              this.deps.flags.setReactiveDowngradeInFlight(false);
            }
          }
          this.deps.emit(session, {
            type: "error",
            text:
              `Failed to start Grok: ${msg}. This matches the Grok CLI 0.2.61–0.2.70 stdio ` +
              `regression (issue #22, fixed after 0.2.70). Workaround: run ` +
              `\`grok update --version ${GROK_STDIO_DOWNGRADE_TARGET}\` in a terminal, then start a new session.`,
          });
        } else if (isResumeNotFound(err)) {
          this.deps.emit(session, {
            type: "error",
            text:
              `This conversation could not be opened. It may never have recorded `
              + `anything, or ${providerDisplayName(session.provider)} may not have `
              + `finished starting — try opening it again, and start a new `
              + `conversation if it stays this way.`,
          });
        } else {
          this.deps.emit(session, { type: "error", text: `Failed to start ${providerDisplayName(session.provider)}: ${msg}` });
        }
        return undefined;
      }
    }
    return undefined;
  }

  /**
   * Internal step 1: Perform ACP handshake and version capability check.
   */
  private async performSessionHandshake(
    session: Session,
    cliPath: string,
    gen: number,
  ): Promise<{
    versionNote?: string;
    grokHandshakeVersion?: string;
    grokVersionVerified: boolean;
  }> {
    let versionNote: string | undefined;
    let grokHandshakeVersion: string | undefined;
    let grokVersionVerified = false;

    if (providerCapability(session.provider, "planMode").state === "probe") {
      this.postStartupStatus(session, "cli-update");
      try { await this.deps.providerOps.maybeUpdateCliOnUpgrade(cliPath); }
      finally { if (gen === session.gen) this.postStartupStatus(session, "session"); }
      if (gen !== session.gen) return { grokVersionVerified: false };
      await this.deps.providerOps.maybePinBrokenCli(cliPath);
      if (gen !== session.gen) return { grokVersionVerified: false };
      const compatibility = await this.deps.reviewAndPlanOps.planModeCompatibility(cliPath);
      if (gen !== session.gen) return { grokVersionVerified: false };
      if (compatibility.usedCache) versionNote = "cached";
      grokVersionVerified = compatibility.planModeVersionVerified;
      grokHandshakeVersion = grokVersionVerified ? compatibility.cliVersion : undefined;
      this.deps.reviewAndPlanOps.applyPlanModeCompatibility(session, compatibility);
    } else {
      session.planModeAvailable = providerCapability(session.provider, "planMode").state === "yes";
      session.planModeVersionVerified = true;
      session.planModeUnavailableReason = undefined;
      this.deps.emit(session, {
        type: "providerCapabilities",
        provider: session.provider,
        capabilities: allProviderCapabilities(session.provider, {
          planModeAvailable: session.planModeAvailable,
          cliVerified: true,
        }),
      });
    }

    return { versionNote, grokHandshakeVersion, grokVersionVerified };
  }

  /**
   * Internal step 2: Configure session environment, cwd, worktree, effort, and compact threshold.
   */
  private async configureSessionEnvironment(
    session: Session,
    resumeId: string | undefined,
    gen: number,
  ): Promise<{ cwd: string; env: NodeJS.ProcessEnv; effort: EffortLevel | undefined }> {
    const cwd = session.cwd || this.deps.workspaceRoot();
    session.cwd = cwd;

    if (!session.worktree && resumeId) {
      const o = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[resumeId];
      if (o?.worktreePath) {
        session.worktree = {
          path: o.worktreePath,
          label: o.worktreeLabel || path.basename(o.worktreePath),
          sourceGitRoot: o.sourceGitRoot || this.deps.workspaceRoot(),
        };
      }
    }

    const mcpReady = this.deps.flags.getMcpConnectorKeysReady();
    if (mcpReady !== undefined) await mcpReady;
    if (gen !== session.gen) return { cwd, env: process.env, effort: undefined };

    const env = PROVIDER_CLI[session.provider].environment === "grok" ? this.deps.providerOps.buildEnv(cwd) : { ...process.env };
    session.compactThresholdRequested = session.provider === "grok" ? normalizeCompactThreshold(env[GROK_COMPACT_ENV]) : undefined;
    session.compactThresholdChecked = false;

    const cfg = this.deps.host.getConfiguration("grok");
    const effortStr = session.startOverrides?.effort
      || rememberedEffort(
        cfg.get<EffortPrefs>("defaultEffortByProvider", {}),
        session.provider,
        cfg.get<string>("defaultEffort", ""),
      );
    const effort = effortStr ? (effortStr as EffortLevel) : undefined;

    return { cwd, env, effort };
  }

  /**
   * Internal step 3: Construct AcpClient, wire fs and terminal, and wire all event listeners.
   */
  private spawnSessionProcess(
    session: Session,
    cliPath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    effort: EffortLevel | undefined,
    handshake: { grokHandshakeVersion?: string; grokVersionVerified: boolean },
    gen: number,
    resumeId?: string,
  ): AcpClient {
    const client = new AcpClient({
      cliPath,
      cwd,
      env,
      effort,
      log: (msg) => this.deps.host.appendLine(msg),
      timeouts: this.deps.providerOps.acpClientTimeouts(),
      mcpServers: async () => supportsClientMcpServers(session.provider) ? this.deps.eventOps.hostMcpServersFor(session) : [],
      ...(session.provider === "grok"
        ? { grokVersion: handshake.grokHandshakeVersion, grokVersionVerified: handshake.grokVersionVerified }
        : { backend: session.provider === "muse" ? new MuseBackend(session.musePosture) : this.deps.providerOps.createProviderBackend(session.provider, effort) }),
    });

    session.client = client;
    this.deps.eventOps.syncHumanWait(session);
    session.lastSessionInfoAt = 0;
    session.lastSessionInfoUsed = undefined;
    session.sessionInfoStale = false;
    session.sessionInfoUnsupported = false;

    client.fsRead = async (p: string) => {
      try {
        const bytes = await this.deps.host.fs.readFile(Uri.file(p));
        return Buffer.from(bytes).toString("utf8");
      } catch {
        return fs.readFileSync(p, "utf8");
      }
    };
    client.fsWrite = async (p: string, content: string) => {
      this.deps.reviewAndPlanOps.snapshotAbsPaths(session, [p]);
      this.deps.reviewAndPlanOps.noteCheckpointAfterContent(session, p, content);
      try {
        await this.deps.host.fs.createDirectory(Uri.file(path.dirname(p)));
        await this.deps.host.fs.writeFile(Uri.file(p), Buffer.from(content, "utf8"));
      } catch {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
      }
    };
    client.terminal = this.deps.terminalManager.ownedBy(client);

    this.wireSessionListeners(session, client, gen, cwd, env, cliPath, resumeId);
    return client;
  }

  /**
   * Internal step 4: Wire all streaming, tool-calls, modes, subagents, and status listeners.
   */
  private wireSessionListeners(
    session: Session,
    client: AcpClient,
    gen: number,
    cwd: string,
    env: NodeJS.ProcessEnv,
    cliPath: string,
    resumeId?: string,
  ): void {
    client.on("initialized", (init) => {
      if (gen !== session.gen) return;
      this.deps.eventOps.warnOAuthShadowOnce(init?._meta?.defaultAuthMethodId, env);
      const handshakeVersion = init?.serverInfo?.version ?? init?.version ?? null;
      if (session.provider === "grok" && typeof handshakeVersion === "string" && handshakeVersion.trim()) {
        this.deps.providerOps.providerCliVersions.grok = handshakeVersion.trim().replace(/^v/i, "");
        this.deps.providerOps.postProviderState();
      }
      this.deps.emit(session, {
        type: "initialized",
        info: {
          cliPath,
          cwd,
          version: handshakeVersion,
          provider: session.provider,
          init: { protocolVersion: init?.protocolVersion },
          steeringSupported: client.supportsInterject?.() ?? false,
        },
      });
    });

    client.on("session", (res) => {
      if (gen !== session.gen) return;
      if (res?.sessionId) session.activeSessionId = res.sessionId;
      this.deps.providerOps.cacheProviderModels(session.provider, client.availableModels, client.currentModelId);
      if (res?.sessionId) {
        void this.deps.workspaceOps.updateSessionMeta((current) => ({
          ...current,
          [res.sessionId]: {
            ...(current[res.sessionId] ?? {}),
            provider: session.provider,
            providerCwd: cwd,
            ...(session.musePosture ? { musePosture: session.musePosture } : {}),
          },
        }));
      }
      this.deps.emit(session, { type: "modeChanged", modeId: session.musePosture?.mode ?? (session.autoApprove ? "yolo" : "agent"), modes: sessionModes(session.provider, session.musePosture?.shellSandbox) });
      if (session.composerDraftId && res.sessionId) {
        this.deps.emit(session, { type: "composerDraftSession", draftId: session.composerDraftId, sessionId: res.sessionId });
        session.composerDraftId = undefined;
      }
      this.deps.emit(session, {
        type: "session",
        sessionId: res.sessionId,
        models: this.deps.providerOps.modelsForSession(
          session,
          client.availableModels,
          client.currentModelId,
          !resumeId || (session.historyEventCount === 0 && session.userMessageCount === 0),
        ),
        currentModelId: client.currentModelId,
        worktree: !!session.worktree,
        provider: session.provider,
      });
      this.deps.emit(session, { type: "contextWindowSelection", selection: client.contextWindowSelection });
      if (providerCapability(session.provider, "feedback").state === "yes") {
        const metaEnabled = parseFeedbackEnabledMeta(res);
        if (metaEnabled !== undefined) session.feedbackMetaEnabled = metaEnabled;
        this.deps.providerOps.refreshFeedbackAvailability(session);
      }
    });

    client.on("sessionTitle", (title: string) => {
      if (gen !== session.gen || !title.trim()) return;
      const sid = client.sessionId ?? session.activeSessionId;
      if (!sid) return;
      void this.deps.workspaceOps.updateSessionMeta((current) => {
        const entry = current[sid];
        const autoName = capAutoName(title);
        if (!autoName || entry?.customName || entry?.autoName === autoName) return null;
        return { ...current, [sid]: { ...(entry ?? {}), autoName } };
      }).then(() => {
        this.deps.workspaceOps.sessionCacheDelete(sid);
        this.deps.workspaceOps.postSessionName(session);
        this.deps.workspaceOps.postSessionsList();
      });
    });

    client.on("modelsCatalogChanged", () => {
      if (gen !== session.gen || !client.sessionId) return;
      this.deps.providerOps.cacheProviderModels(session.provider, client.availableModels, client.currentModelId);
      this.deps.emit(session, { type: "session", sessionId: client.sessionId,
        models: this.deps.providerOps.modelsForSession(session, client.availableModels, client.currentModelId),
        currentModelId: client.currentModelId, provider: session.provider, worktree: !!session.worktree, preserveContext: true });
      this.deps.emit(session, { type: "contextWindowSelection", selection: client.contextWindowSelection });
    });

    client.on("contextWindowSelection", (selection) => {
      if (gen !== session.gen) return;
      this.deps.emit(session, { type: "contextWindowSelection", selection });
    });

    client.on("contextBudget", (context: ContextObservation & { reset?: boolean }) => {
      if (gen !== session.gen) return;
      const window = context.limits && effectiveContextWindow(context.limits);
      const sid = client.sessionId ?? session.activeSessionId;
      if (sid) void this.deps.workspaceOps.updateSessionMeta(current => ({ ...current, [sid]: {
        ...(current[sid] ?? {}), contextObservation: context,
        contextWindow: window, contextUsed: context.used,
      } }));
      if (context.reset) {
        session.lastSessionInfoUsed = undefined;
        session.lastSessionInfoAt = 0;
        session.sessionInfoStale = true;
        session.adapterTurnCallUsed = [];
      }
      this.deps.emit(session, { type: "contextUsage", reset: context.reset, context,
        window, used: context.used });
    });
    client.on("contextBudgetNotice", (text: string) => {
      if (gen !== session.gen) return;
      this.deps.emit(session, { type: "hostNotice", level: "warning", text });
    });

    client.on("modelChanged", (id) => {
      if (gen !== session.gen) return;
      this.deps.emit(session, { type: "modelChanged", modelId: id });
    });

    client.on("modeChanged", (id) => {
      if (gen !== session.gen) return;
      if (session.provider === "muse" && isMuseModeId(id)) {
        if (session.musePosture) session.musePosture = { ...session.musePosture, mode: id };
        session.autoApprove = id === "yolo";
        this.deps.emit(session, { type: "modeChanged", modeId: id, modes: sessionModes("muse", session.musePosture?.shellSandbox) });
        return;
      }
      if (id === "plan") {
        session.autoApprove = false;
        this.deps.reviewAndPlanOps.setPlanActive(session, true);
        if (!session.planModeAvailable) {
          if (session.replaying) return;
          this.deps.reviewAndPlanOps.recoverUnavailablePlanMode(session, client, gen);
          return;
        }
      } else if (!client.usesClientPlanGate) {
        const next = applyAgentModeToHostPlan(id, false);
        if (next) {
          session.autoApprove = next.autoApprove;
          this.deps.reviewAndPlanOps.setPlanActive(session, next.planActive);
        }
      } else if (session === this.deps.getFocused()) {
        this.deps.reviewAndPlanOps.postMode();
      }
    });

    client.on("commandsUpdate", (cmds) => {
      if (gen !== session.gen) return;
      const merged = [...cmds];
      if (session.provider === "grok" && !merged.some(c => c.name === "context-window")) merged.push({ name: "context-window", description: "Choose the native context window for this session (e.g. 500k)" });
      for (const hostCmd of EXTENSION_HOST_SLASH_COMMANDS) {
        if (!merged.some((c) => c.name === hostCmd.name)) {
          merged.push(hostCmd);
        }
      }
      this.deps.emit(session, { type: "commandsUpdate", commands: merged });
      if (providerCapability(session.provider, "feedback").state === "yes") {
        session.feedbackCommandsAdvertise = commandsAdvertiseFeedback(cmds);
        this.deps.providerOps.refreshFeedbackAvailability(session);
      }
    });

    client.on("messageChunk", (text: string) => {
      if (gen !== session.gen) return;
      session.agentTextTap?.(text);
      if (session.captureAgentText !== undefined) {
        session.captureAgentText += text;
        return;
      }
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.deps.emit(session, { type: "messageChunk", text });
      this.deps.usageOps.noteAdapterCompactSignal(session, text);
    });

    client.on("userMessageChunk", (text: string, meta?: any) => {
      if (gen !== session.gen) return;
      if (!session.replaying) return;
      if (!session.inUserMessage && isPrimerText(text)) {
        session.inUserMessage = true;
        this.deps.emit(session, {
          type: "userMessageChunk",
          text,
          timestampMs: agentTimestampMsFromMeta(meta),
          images: historyImagePreviews(text, this.deps.eventOps.imageStagingDir(), this.deps.sessionCwd(session)),
        });
        return;
      }
      if (!session.inUserMessage) {
        session.replayUserRaw = "";
        session.replayUserCounted = countsAsUserBubble(text);
        session.replayTurnStartedAt = session.replayUserCounted ? agentTimestampMsFromMeta(meta) : undefined;
        session.replayUserIsInterjection = false;
        if (session.replayUserCounted) session.userMessageCount += 1;
        session.inUserMessage = true;
      }
      session.replayUserRaw += text;
      if (!session.replayUserIsInterjection && isInterjectionText(session.replayUserRaw)) {
        session.replayUserIsInterjection = true;
        session.interjectionCount += 1;
        if (session.replayUserCounted) {
          session.userMessageCount = Math.max(0, session.userMessageCount - 1);
          session.replayUserCounted = false;
        }
        session.replayTurnStartedAt = undefined;
      }
      this.deps.emit(session, {
        type: "userMessageChunk",
        text,
        timestampMs: agentTimestampMsFromMeta(meta),
        images: historyImagePreviews(
          session.replayUserRaw,
          this.deps.eventOps.imageStagingDir(),
          this.deps.sessionCwd(session),
        ),
      });
    });

    client.on("thoughtChunk", (text: string) => {
      if (gen !== session.gen) return;
      session.inUserMessage = false;
      session.historyEventCount += 1;
      this.deps.emit(session, { type: "thoughtChunk", text });
    });

    const mcpState = createMcpPrepareState();
    client.on("childStream", (ev: { childSessionId: string; route: UpdateRoute }) => {
      if (gen !== session.gen) return;
      const payload = childStreamFromRoute(ev.childSessionId, ev.route);
      if (!payload) return;
      if (payload.event === "toolCall" || payload.event === "toolCallUpdate") {
        const prepared = prepareMcpToolCall(payload.call, mcpState);
        this.deps.emit(session, { type: "childStream", ...payload, call: prepared.call });
        this.deps.reviewAndPlanOps.noteReviewToolCall(session, prepared.call);
        return;
      }
      this.deps.emit(session, { type: "childStream", ...payload });
    });

    client.on("mediaContent", (m: MediaRef) => {
      if (gen !== session.gen) return;
      void this.deps.eventOps.postGeneratedMedia(m, session, gen);
    });

    client.on("taskBackgrounded", (u: any) => {
      if (gen !== session.gen) return;
      const cmd = typeof u?.command === "string" ? u.command : "";
      this.deps.host.appendLine(`[task] backgrounded: ${cmd.slice(0, 200)}`);
    });

    client.on("taskCompleted", (u: any) => {
      if (gen !== session.gen) return;
      if (session.replaying) return;
      const snap = u?.task_snapshot ?? u ?? {};
      const cmd = typeof snap.command === "string" ? snap.command : "";
      const exit = snap.exit_code ?? snap.exitCode ?? snap.status?.exitCode;
      const ok = exit == null || exit === 0;
      const label = summarizeBackgroundCommand(cmd);
      const text = `Grok background task ${ok ? "completed" : `exited (code ${exit})`}${label ? `: ${label}` : ""}`;
      this.deps.host.appendLine(`[task] ${text}`);
      void this.deps.host.showInformationMessage(text, "Show Logs").then((choice) => {
        if (choice === "Show Logs") this.deps.host.showOutput();
      });
    });

    const replayedCommandOutputs = new Set<string>();
    const replayedCommandsByToolCallId = new Map<string, string>();
    const emitReplayedCommandOutput = (call: unknown) => {
      const replayed = commandOutputForToolCall(call, {
        replaying: session.replaying,
        rememberedCommands: replayedCommandsByToolCallId,
      });
      if (!replayed) return;
      const id = typeof (call as { toolCallId?: unknown })?.toolCallId === "string"
        && (call as { toolCallId: string }).toolCallId
        ? (call as { toolCallId: string }).toolCallId
        : replayed.command;
      if (replayedCommandOutputs.has(id)) return;
      replayedCommandOutputs.add(id);
      this.deps.emit(session, { type: "commandOutput", ...replayed });
    };

    const emitToolCallEvent = (type: "toolCall" | "toolCallUpdate", u: unknown) => {
      const prepared = prepareMcpToolCall(u, mcpState);
      session.inUserMessage = false;
      session.historyEventCount += 1;
      if (!session.replaying) this.deps.reviewAndPlanOps.snapshotPendingEditToolCall(session, prepared.call);
      this.deps.emit(session, { type, call: prepared.call });
      this.deps.reviewAndPlanOps.noteReviewToolCall(session, prepared.call);
      this.deps.usageOps.noteAdapterCompactSignal(session, prepared.call);
      if (prepared.commandOutput) {
        this.deps.emit(session, { type: "commandOutput", ...prepared.commandOutput });
      }
      emitReplayedCommandOutput(prepared.call);
    };

    client.on("toolCall", (u) => {
      if (gen !== session.gen) return;
      if (u?.subagent_id) this.deps.eventOps.noteNativeChild(session, { ...u, sessionUpdate: "subagent_spawned", description: u.title });
      emitToolCallEvent("toolCall", u);
    });

    client.on("toolCallUpdate", (u) => {
      if (gen !== session.gen) return;
      if (u?.subagent_id && ["completed", "failed", "cancelled"].includes(u.status)) this.deps.eventOps.noteNativeChild(session, { ...u, sessionUpdate: "subagent_finished" });
      this.deps.eventOps.closeQuestionsForToolCall(session, u);
      emitToolCallEvent("toolCallUpdate", u);
    });

    client.on("plan", (u) => {
      if (gen !== session.gen) return;
      this.deps.reviewAndPlanOps.applyPlanUpdate(session, u);
    });

    client.on("promptComplete", (meta) => {
      if (gen !== session.gen) return;
      const gated = gateZeroTokenMeta(meta);
      if (isAdapterProvider(session.provider) && !session.replaying) {
        const occupancy = this.deps.usageOps.adapterTurnOccupancy(session, meta);
        const remembered = this.deps.usageOps.rememberAdapterContext(session, occupancy !== undefined ? { occupancy } : {});
        this.deps.emit(session, {
          type: "promptComplete",
          meta: { ...gated, totalTokens: remembered?.used ?? gated.totalTokens },
        });
      } else {
        if (
          typeof gated.totalTokens === "number"
          && session.lastSessionInfoUsed != null
          && gated.totalTokens !== session.lastSessionInfoUsed
        ) {
          session.sessionInfoStale = true;
        }
        this.deps.emit(session, { type: "promptComplete", meta: gated });
      }
      if (session.captureAgentText === undefined) void this.deps.usageOps.accumulateUsage(session, meta);
      session.adapterTurnCallUsed = [];
      if (!session.replaying) this.deps.reviewAndPlanOps.finishCheckpointTurn(session);
    });

    client.on("contextUsage", (used: number | undefined, window?: number) => {
      if (gen !== session.gen) return;
      if (isAdapterProvider(session.provider)) {
        this.deps.usageOps.rememberAdapterContext(session, {
          ...(typeof used === "number" && client.contextBudget?.usageQuality === "verified" ? { occupancy: used, authoritative: true } : {}),
          ...(typeof window === "number" && Number.isFinite(window) && window > 0 ? { window } : {}),
        });
        return;
      }
      if (
        typeof used === "number" && Number.isFinite(used) && used > 0
        && session.lastSessionInfoUsed != null
        && used !== session.lastSessionInfoUsed
      ) {
        session.sessionInfoStale = true;
      }
      this.deps.emit(session, {
        type: "contextUsage",
        ...(typeof used === "number" && Number.isSafeInteger(used) && used >= 0 ? { used } : {}),
        ...(typeof window === "number" && Number.isFinite(window) && window > 0 ? { window } : {}),
      });
    });

    client.on("subscriptionUsage", (windows: SubscriptionWindow[]) => {
      if (gen !== session.gen || session.client !== client || session.replaying) return;
      session.subscriptionUsage?.observe(windows);
      this.deps.usageOps.publishSubscriptionUsage(session);
    });

    client.on("adapterUsageUpdate", (used: number, window?: number) => {
      if (gen !== session.gen) return;
      if (!isAdapterProvider(session.provider) || session.replaying) {
        if (typeof window === "number" && Number.isFinite(window) && window > 0) {
          this.deps.usageOps.rememberAdapterContext(session, { window });
        }
        return;
      }
      if (session.compactUsageArmed) {
        session.compactUsageArmed = false;
        // Older Claude adapters synthesize zero when post_tokens is absent.
        if (used === 0) return;
        // Older Claude adapters synthesize zero when post_tokens is absent.
        if (used === 0) return;
        this.deps.usageOps.rememberAdapterContext(session, {
          occupancy: used,
          compacted: true,
          ...(typeof window === "number" && Number.isFinite(window) && window > 0 ? { window } : {}),
        });
        return;
      }
      if (typeof used === "number" && Number.isFinite(used) && used > 0) {
        session.adapterTurnCallUsed.push(used);
      }
      if (typeof window === "number" && Number.isFinite(window) && window > 0) {
        this.deps.usageOps.rememberAdapterContext(session, { window });
      }
    });

    client.on("mcpNotification", (method: string, params: unknown) => {
      if (gen !== session.gen) return;
      this.deps.eventOps.applyMcpNotification(session, method, params);
    });

    client.on("xaiNotification", (u, notificationSessionId?: string) => {
      if (gen !== session.gen) return;
      if (notificationSessionId && session.activeSessionId && notificationSessionId !== session.activeSessionId) return;
      const kind = (u as { sessionUpdate?: string })?.sessionUpdate;
      const compactUsed = contextUsedFromCompactNotification(u);
      if (compactUsed !== null) {
        this.deps.emit(session, { type: "contextUsage", used: compactUsed });
        session.sawCompactNotification = true;
      }
      if (kind === "auto_compact_failed") {
        session.sawCompactNotification = true;
        session.sawCompactFailed = true;
        const err = (u as { error?: unknown })?.error;
        this.deps.emit(session, {
          type: "autoCompactNotice",
          text: typeof err === "string" && err.trim() ? `Compaction failed: ${err.trim()}` : "Compaction failed.",
        });
      }
      const compactKind = compactEventKind(u);
      if (compactKind === "cancelled") {
        this.deps.emit(session, { type: "autoCompactNotice", text: "Compaction cancelled." });
      }
      if (compactKind === "completed") {
        session.nearFullArmed = true;
        session.compactionCount += 1;
        const summary = compactSummaryPreview(u);
        if (summary) {
          this.deps.emit(session, { type: "compactSummary", summary });
        } else if (!session.manualCompactInFlight) {
          const tokenStr = compactUsed !== null ? ` to ${compactUsed.toLocaleString("en-US")} tokens` : "";
          this.deps.emit(session, { type: "autoCompactNotice", text: `Context compacted${tokenStr}.` });
        }
      }
      if (isSubagentLifecycleUpdate(u)) {
        this.deps.emit(session, { type: "subagentUpdate", update: u });
        this.deps.eventOps.noteNativeChild(session, u);
      }
      const runProg = parseRunProgressUpdate(u);
      if (runProg) this.deps.emit(session, { type: "runProgress", update: runProg });
      const autoCompactNote = autoCompactStartedNote(u);
      if (autoCompactNote) this.deps.emit(session, { type: "autoCompactNotice", text: autoCompactNote });
    });

    client.on("notice", (text: string) => {
      if (gen === session.gen && session.client === client) this.deps.emit(session, { type: "hostNotice", level: "info", text });
    });
    client.on("workflowUpdate", (update: unknown) => {
      if (gen !== session.gen || session.client !== client) return;
      const progress = parseRunProgressUpdate(update);
      if (progress) this.deps.emit(session, { type: "runProgress", update: progress });
    });

    client.on("subagentLifecycle", (u: unknown, meta?: any) => {
      if (gen !== session.gen) return;
      if ((u as { sessionUpdate?: unknown })?.sessionUpdate === "turn_completed") {
        if (session.replaying) {
          const timestampMs = agentTimestampMsFromMeta(meta);
          const turnDurationMs = replayedTurnDuration(u, meta, session.replayTurnStartedAt);
          this.deps.emit(session, {
            type: "subagentUpdate",
            update: u,
            timestampMs,
            ...(turnDurationMs !== undefined ? { turnDurationMs, turnStatus: "completed" as const } : {}),
          });
        }
        return;
      }
      this.deps.emit(session, { type: "subagentUpdate", update: u });
    });

    client.on("commandDone", (info: { command: string; output: string; exitCode: number | null; truncated: boolean }) => {
      if (gen !== session.gen) return;
      this.deps.emit(session, { type: "commandOutput", ...commandOutputFromLiveTerminal(info) });
    });

    client.on("permissionRequest", (req: PermissionRequest) => {
      if (gen !== session.gen) return;
      this.deps.eventOps.handlePermissionRequest(session, client, req, cwd);
    });

    client.on("mutationBlocked", (info: { kind: string; target: string }) => {
      if (gen !== session.gen) return;
      this.deps.emit(session, { type: "planBlocked", kind: info.kind, target: info.target });
    });

    client.on("planFileContent", (content: string) => {
      if (gen !== session.gen) return;
      if (typeof content === "string" && content.trim()) session.lastPlanText = content;
    });

    client.on("exitPlanRequest", (req: ExitPlanRequest) => {
      if (gen !== session.gen) return;
      if (!session.planModeAvailable) {
        this.deps.reviewAndPlanOps.recoverUnavailablePlanMode(session, client, gen, req.id);
        return;
      }
      void this.deps.reviewAndPlanOps.postExitPlanRequest(req, session, gen);
    });

    client.on("questionRequest", (req: QuestionRequest) => {
      if (gen !== session.gen) return;
      this.deps.eventOps.showQuestion(session, req, {
        toolCallId: req.toolCallId,
        answer: (answers, annotations) => client.respondQuestion(req.id, answers, annotations),
        cancel: () => client.respondQuestionCancelled(req.id),
        abandon: () => { },
      });
    });

    client.on("exit", (code) => {
      if (gen !== session.gen) return;
      if (session.priming) {
        if (session.client === client) {
          this.deps.eventOps.drainPendingConfirms(session);
          session.client = undefined;
          this.deps.getPool().delete(session);
        }
        return;
      }
      this.deps.emit(session, {
        type: "exit",
        code,
        ...(turnIsInFlight(session) ? this.deps.turnAndSendOps.turnEndFields(session, "failed") : {}),
      });
      if (session.queuedSends.length) {
        session.queuedSendCommit = undefined;
        session.queuedSends = [];
        this.deps.turnAndSendOps.emitQueuedSends(session);
      }
      this.deps.setStatus(session, "error");
      this.deps.getPool().delete(session);
      this.deps.sessionLifecycleOps.detachClient(session);
      void client.dispose();
    });

    client.on("stderr", (text: string) => this.deps.host.append(text));
  }

  /**
   * Internal step 5: Load or resume an existing session, replaying history and restoring plan gate.
   */
  private async loadOrResumeSession(
    session: Session,
    client: AcpClient,
    defaultModel: string,
    resumeId: string,
    clock: OpenClock,
    gen: number,
    cwd: string,
  ): Promise<void> {
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const savedPerms = overrides[resumeId]?.permissions ?? [];
    if (savedPerms.length > 0) {
      this.deps.emit(session, { type: "permissionHistoryQueue", permissions: savedPerms });
    }

    const saved = overrides[resumeId]?.plans;
    const planSource = planRestoreSource(saved);
    if (planSource === "saved") {
      this.deps.emit(session, { type: "planHistoryQueue", plans: await this.deps.reviewAndPlanOps.withPlanReviewPaths(saved!, resumeId) });
      session.lastPlanText = saved![saved!.length - 1].text;
    } else if (client.usesClientPlanGate && planSource === "disk") {
      const sessDir = sessionDirFor(resolveGrokHome(process.env), cwd, resumeId, { fs: defaultFs });
      const planPath = sessDir ? path.join(sessDir, "plan.md") : "";
      if (planPath && fs.existsSync(planPath)) {
        try {
          const planText = fs.readFileSync(planPath, "utf8");
          let snapshot: { path: string; name: string } | undefined;
          try {
            snapshot = await this.deps.reviewAndPlanOps.createPlanReviewSnapshot(planText, resumeId);
          } catch (e) {
            this.deps.host.appendLine(`[plan-review] ${(e as Error).message}`);
          }
          this.deps.emit(session, {
            type: "planHistoryQueue",
            plans: [{
              text: planText,
              verdict: undefined as any,
              planPath: snapshot?.path,
              planName: snapshot?.name,
            }],
          });
          session.lastPlanText = planText;
        } catch (e) {
          this.deps.host.appendLine(`[plan-restore] ${(e as Error).message}`);
        }
      }
    }

    const loadAt = clock.now();
    let replayAt = 0;
    await this.deps.sessionLifecycleOps.replayLoadedHistory(session, async () => {
      try {
        await client.loadSession(resumeId, defaultModel || undefined);
      } catch (e) {
        if (!isIncompatibleAgentError(e)) throw e;
        this.deps.host.appendLine(
          `[resume] kept the session's own model; default '${defaultModel}' needs a different agent`,
        );
      }
      clock.record("new", 0);
      clock.record("load", clock.elapsed(loadAt));
      replayAt = clock.now();
    });
    clock.record("replay(post)", clock.elapsed(replayAt));
    session.activeSessionId = resumeId;
    session.titleGenerated = true;
    this.deps.sessionLifecycleOps.restoreSessionType(session);

    if (client.usesClientPlanGate) {
      const decision = decideRestoreState(saved);
      const unavailablePlan = !session.planModeAvailable && (
        decision.planActive || session.planActive || client.currentModeId === "plan"
      );
      if (unavailablePlan) {
        this.deps.reviewAndPlanOps.recoverUnavailablePlanMode(session, client, gen);
      } else {
        const restorePlan = decision.planActive && session.planModeAvailable;
        this.deps.reviewAndPlanOps.setPlanActive(session, restorePlan);
        const targetMode = restorePlan ? "plan" : "agent";
        try { if (session.provider !== "muse") await applyHostMode(client, session.provider, targetMode); } catch { /* best-effort */ }
      }
    }

    // Seed the context donut
    this.deps.usageOps.emitContextUsage(session);
    if (providerCapability(session.provider, "sessionInfo").state === "yes") {
      void this.deps.usageOps.refreshContextFromSessionInfo(session, gen, { force: true });
    }
    this.deps.usageOps.restoreUsage(session);
  }

  /**
   * Dispatches an outbound send. Handles special commands (/agent, /handoff, /crew, /subagents),
   * concurrency guards, staging/attachments, prompt construction, client invocation,
   * compact tracking, turn completion, and error classification.
   */
  public async handleSend(
    text: string,
    bare = false,
    target?: Session,
    queuedSendCommit?: { text: string; items: QueuedSendEntry[] },
    submissionId?: string,
  ): Promise<void> {
    const session = target ?? this.deps.getFocused();

    if (parseAgentCommand(text).kind !== "none") {
      await this.deps.workflowCommandsOps.handleAgentCommand(text, session);
      return;
    }
    if (parseHandoffCommand(text).kind !== "none") {
      await this.deps.workflowCommandsOps.handleHandoffCommand(text, session);
      return;
    }
    if (parseCrewCommand(text).kind !== "none") {
      await this.deps.workflowCommandsOps.handleCrewCommand(text, session);
      return;
    }
    if (parseSubagentsCommand(text).kind !== "none") {
      this.deps.workflowCommandsOps.handleSubagentsCommand(text, session);
      return;
    }
    if (session.sessionType === "crew" && !session.pendingHiddenChild) {
      await this.deps.workflowCommandsOps.handleCrewSessionInput(text, session);
      return;
    }

    await this.waitForSessionStart(session);

    if (this.deps.turnAndSendOps.turnInFlight(session)) {
      if (!queuedSendCommit) this.deps.turnAndSendOps.divertRacingSend(session, text, bare);
      return;
    }

    if (session.priming || (session.client && !sessionReadyForPrompt(session))) {
      if (!queuedSendCommit) this.deps.turnAndSendOps.divertRacingSend(session, text, bare);
      return;
    }

    const client = session.client ?? await this.ensureClient(session);
    if (!client) {
      const id = session.activeSessionId ?? session.composerDraftId;
      if (session === this.deps.getFocused() || session.composerDraftId) this.deps.emit(session, { type: "restoreComposer", text, chips: session.chips, sessionId: id, draft: true });
      else if (id) await this.deps.workspaceOps.updateSessionMeta(current => ({ ...current, [id]: { ...current[id], queuedDraft: text, queuedDraftChips: session.chips } }));
      return;
    }

    if (!sessionReadyForPrompt(session)) {
      if (!queuedSendCommit) this.deps.turnAndSendOps.divertRacingSend(session, text, bare);
      return;
    }
    const gen = session.gen;

    const staging = [...this.deps.turnAndSendOps.pendingAttach];
    if (staging.length) {
      await Promise.allSettled(staging);
      if (gen !== session.gen) return;
    }

    const queuedItems = !bare && queuedSendCommit?.items.length
      ? queuedSendCommit.items.map((item) => ({ text: item.text, chips: item.chips ?? [] }))
      : undefined;
    const implicitChips = session.chips.filter((chip) => isImplicitChip(chip));
    let chips: ContextChip[] = [];
    let contributions: QueuedPromptContribution[] | undefined;
    if (bare) {
      chips = [];
    } else if (queuedItems) {
      contributions = [];
      const queuedChips: ContextChip[] = [];
      for (const item of queuedItems) {
        const itemImages: PromptImageInput[] = [];
        for (const chip of item.chips) {
          if (chip.hidden || !isFileChip(chip) || !isImageChip(chip)) continue;
          const read = await this.deps.turnAndSendOps.readImageChip(chip, session, gen);
          if (read === "gone" || read === "failed") return;
          itemImages.push(read);
        }
        contributions.push({ text: item.text, chips: item.chips, images: itemImages });
        queuedChips.push(...item.chips);
      }
      chips = [...queuedChips, ...implicitChips];
    } else {
      chips = [...session.chips];
    }

    const images: PromptImageInput[] = contributions
      ? contributions.flatMap((contribution) => contribution.images)
      : [];
    if (!contributions) {
      for (const chip of chips) {
        if (chip.hidden || !isFileChip(chip) || !isImageChip(chip)) continue;
        const read = await this.deps.turnAndSendOps.readImageChip(chip, session, gen);
        if (read === "gone" || read === "failed") return;
        images.push(read);
      }
    }
    if (gen !== session.gen) return;

    const slashCommand = matchSlashCommand(
      text,
      client.availableCommands.map((c) => c.name),
    );
    const promptDeps = {
      readFile: (p: string) => fs.readFileSync(p, "utf8"),
      extName: (p: string) => path.extname(p),
      contextChipPayload: this.deps.turnAndSendOps.contextChipPayloads(chips),
    };
    let directives: { text: string; block?: string };
    try {
      directives = this.deps.turnAndSendOps.applyTurnDirectives(session, text, chips);
    } catch (error) {
      this.deps.emit(session, { type: "hostNotice", level: "warning", text: (error as Error).message });
      this.deps.emit(session, { type: "setBusy", value: false });
      if (!queuedSendCommit) this.deps.emit(session, { type: "restoreComposer", text, chips, sessionId: session.activeSessionId ?? session.composerDraftId, draft: true });
      return;
    }
    const directiveText = directives.text;
    if (contributions) contributions = contributions.map(contribution => ({ ...contribution, text: parseSubagentMentions(contribution.text).text }));
    const { blocks: promptBlocks } = contributions
      ? buildQueuedPromptWithImages(contributions, implicitChips, promptDeps, slashCommand != null)
      : buildPromptWithImages(directiveText, chips, images, promptDeps, slashCommand != null);
    if (directives.block) {
      const last = promptBlocks[promptBlocks.length - 1];
      if (last && last.type === "text") {
        last.text = `${last.text}\n\n${directives.block}`;
      } else {
        promptBlocks.push({ type: "text", text: directives.block });
      }
    }

    await this.deps.turnAndSendOps.retainUploadedFilesForSession(session, chips);
    if (gen !== session.gen) return;

    if (this.deps.turnAndSendOps.turnInFlight(session)) {
      if (!queuedSendCommit) this.deps.turnAndSendOps.divertRacingSend(session, text, bare, explicitVisibleChips(chips));
      return;
    }

    if (queuedSendCommit) {
      if (!finishQueuedSendCommit(session, queuedSendCommit, true)) return;
      this.deps.turnAndSendOps.emitQueuedSends(session);
      if (session === this.deps.getFocused()) this.deps.turnAndSendOps.refreshImplicitChip(true);
      else this.deps.turnAndSendOps.postChips(session);
    }

    if (bare) {
      this.deps.turnAndSendOps.postChips(session);
    } else if (!queuedSendCommit) {
      session.chips = consumeChips(session.chips, chips);
      if (session === this.deps.getFocused()) this.deps.turnAndSendOps.refreshImplicitChip(true);
      else this.deps.turnAndSendOps.postChips(session);
    }

    const isFirstSend = !session.hasHistory;
    session.hasHistory = true;
    if (isFirstSend) {
      void this.deps.providerOps.rememberProjectProvider(
        this.deps.sessionCwd(session),
        session.provider,
        session.client?.currentModelId,
      );
      if (session.client?.sessionId) {
        this.deps.emit(session, {
          type: "session",
          sessionId: session.client.sessionId,
          models: this.deps.providerOps.modelsForSession(session, session.client.availableModels, session.client.currentModelId, false),
          currentModelId: session.client.currentModelId,
          worktree: !!session.worktree,
          provider: session.provider,
        });
      }
      session.firstUserMessageForTitle = text;
      this.deps.turnAndSendOps.reportSessionStart(session);
      this.deps.turnAndSendOps.lockSessionTypeNow(session);
    }
    const sentChips = chips.filter((c) => !c.hidden);
    session.userMessageCount += 1;
    this.deps.reviewAndPlanOps.beginCheckpointTurn(session, text);
    session.inUserMessage = false;
    this.deps.emit(session, { type: "userMessage", text, chips: sentChips, submissionId });
    this.deps.emit(session, { type: "agentStart" });

    const turn = beginTurn(session);
    await this.deps.reviewAndPlanOps.startTurnGitBaseline(session, turn);
    this.deps.setStatus(session, "working");
    this.deps.noteSessionActivity(session);

    try {
      session.adapterCompactThisTurn = false;
      session.compactUsageArmed = false;
      session.adapterTurnCallUsed = [];

      const notice = slashCommand === "compact" ? compactNotice(session.provider) : undefined;
      if (notice) {
        this.deps.emit(session, {
          type: "messageChunk",
          text: notice,
        });
        if (endTurn(session, turn)) {
          if (!turnIsInFlight(session)) this.deps.emit(session, { type: "agentEnd" });
          this.deps.noteLiveTurnEnded(session);
          if (!turnIsInFlight(session)) this.deps.setStatus(session, "done");
          this.deps.noteSessionActivity(session);
        }
        return;
      }

      if (slashCommand === "compact") {
        session.sawCompactFailed = false;
        session.sawCompactNotification = false;
        session.manualCompactInFlight = true;
        if (isAdapterProvider(session.provider)) {
          session.adapterCompactThisTurn = true;
          this.deps.usageOps.rememberAdapterContext(session, { compacted: true });
        }
      }

      let meta;
      try {
        meta = await client.prompt(promptBlocks);
      } finally {
        if (slashCommand === "compact") {
          session.manualCompactInFlight = false;
        }
      }
      if (gen !== session.gen) {
        this.deps.turnAndSendOps.emitAbandonedSend(session);
        return;
      }

      if (!endTurn(session, turn)) return;

      if (slashCommand === "compact") {
        if (!session.sawCompactFailed) this.deps.emit(session, { type: "messageChunk", text: "Compacted." });
        if (session.provider === "grok" && !session.sawCompactNotification) {
          await this.deps.turnAndSendOps.refreshContextAfterCompact(client, session, gen);
          if (gen !== session.gen) return;
        }
      }

      if (this.deps.turnAndSendOps.holdTurnForSubagents(session, meta)) return;
      if (!turnIsInFlight(session)) {
        this.deps.emit(session, {
          type: "agentEnd",
          meta,
          ...this.deps.turnAndSendOps.turnEndFields(session, turnStatusFromPromptResult(meta)),
        });
      }
      this.deps.noteLiveTurnEnded(session);
      if (!turnIsInFlight(session)) this.deps.setStatus(session, "done");
      this.deps.noteSessionActivity(session);
      session.authRecoveryTried = false; // a clean turn resets the needs-login flag
      this.deps.providerOps.setProviderNeedsLogin(session.provider, false);
      this.deps.turnAndSendOps.maybeGenerateTitle(session);
      this.deps.workspaceOps.postSessionName(session);
    } catch (err) {
      if (gen !== session.gen) {
        this.deps.turnAndSendOps.emitAbandonedSend(session);
        return;
      }
      if (!endTurn(session, turn)) return;
      const e = err as any;
      if (this.deps.turnAndSendOps.surfaceLimitError(session, e, text, sentChips)) return;
      if (this.deps.turnAndSendOps.surfaceContextOverflow(session, e, text, sentChips)) return;
      if (await this.deps.turnAndSendOps.recoverAuthAndResend(session, e, text, sentChips, promptBlocks)) return;

      this.deps.host.appendLine(
        `[${session.provider}] prompt failed for session ${session.client?.sessionId ?? session.activeSessionId ?? "none"}`
        + `: ${errorDetail(e)}`,
      );
      this.deps.emit(session, {
        type: "agentError",
        text: promptErrorText(e),
        ...this.deps.turnAndSendOps.turnEndFields(session, "failed"),
      });
      this.deps.noteLiveTurnEnded(session);
      this.deps.setStatus(session, "error");
    } finally {
      endTurn(session, turn);
      if (gen === session.gen) {
        this.deps.reviewAndPlanOps.settleUnavailablePlanTurn(session, client, gen);
        void this.deps.turnAndSendOps.maybeFlushQueuedSends(session);
      }
    }
  }

  private reapPool(): void {
    const override = this.deps.getOverride?.<() => void>("reapPool");
    if (override) return override();
    return this.deps.reapPool();
  }

  private emit(session: Session, msg: HostMsg): void {
    const override = this.deps.getOverride?.<(s: Session, m: HostMsg) => void>("emit");
    if (override) return override(session, msg);
    return this.deps.emit(session, msg);
  }


  // ---------- internals ----------

  public async ensureClient(session: Session = this.deps.sidebarOps.focused): Promise<AcpClient | undefined> {
    const testOverride = this.deps.getOverride?.<typeof this.ensureClient>("ensureClient");
    if (testOverride) return testOverride(session);

    if (session.client) return session.client;
    // After a CLI crash the focused session keeps its grok id but loses its
    // client — respawn by RESUMING that id, so the next send continues the same
    // conversation (a bare startSession would open a blank-context session
    // under the old transcript). Fresh/unstarted sessions have no id and start
    // clean as before.
    await this.waitForSessionStart(session);
    if (session.client) return session.client;
    return this.startSession(session.activeSessionId, session, "ensure");
  }

  /** Restart the session. "clear" drops the visible history; "summarize" first
     *  captures a one-paragraph summary of the conversation and re-injects it as
     *  hidden context after the restart so the new session keeps the thread. */
  public async restartSession(mode: "clear" | "summarize", session: Session = this.deps.sidebarOps.focused): Promise<void> {
    const testOverride = this.deps.getOverride?.<typeof this.restartSession>("restartSession");
    if (testOverride) return testOverride(mode, session);

    if (mode === "clear") {
      this.emit(session, { type: "clearMessages" });
      await this.startSession(undefined, session);
      return;
    }
    const currentClient = session.client;
    this.emit(session, { type: "summarizing" });
    const chunks: string[] = [];
    const captureChunk = (t: string) => chunks.push(t);
    currentClient?.on("messageChunk", captureChunk);
    session.suppressContent = true;
    try {
      await currentClient?.prompt(
        "Summarize our conversation so far in a concise paragraph. Be brief.",
      );
    } catch { /* best effort */ } finally {
      currentClient?.off("messageChunk", captureChunk);
      session.suppressContent = false;
    }
    const summary = chunks.join("").trim();

    await this.startSession(undefined, session); // resets suppressContent

    if (summary && session.client) {
      this.emit(session, { type: "sessionContext" });
      session.suppressContent = true;
      try {
        await session.client.prompt(`[Context from previous session]\n${summary}`);
      } catch { /* best effort */ } finally {
        session.suppressContent = false;
      }
    }
  }
}

export function createSessionStart(deps: SessionStartDeps): SessionStart {
  return new SessionStart(deps);
}
