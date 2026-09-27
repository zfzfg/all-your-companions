import { Session, createPendingPermission } from "./session";
import type { Host } from "./host";
import type { MementoLike } from "./persisted-state";
import {
  type AcpProvider,
  isAdapterProvider,
  supportsModeSwitching,
} from "./acp-backend";
import {
  providerDisplayName,
  type ProviderModelCache,
  PROVIDER_ORDER,
} from "./provider-ui";
import { PROVIDER_MODEL_CACHE_KEY } from "./subagent-host";
import { isIncompatibleAgentError } from "./acp-dispatch";
import type { AcpClient, PermissionRequest } from "./acp";
import {
  effectivePlanActive,
  isPlanReviewPermission,
  permissionOptionsForPlan,
  pickRejectOption,
  planTextFromPermissionToolCall,
  shouldRejectPermission,
} from "./plan-gate";
import {
  CLI_VERSION_CACHE_KEY,
  GROK_REQUIRED_VERSION,
  extensionWasUpgraded,
  grokUpdatePolicy,
  parseGrokVersion,
  readCliBinaryIdentity,
  resolvePlanModeAvailability,
  type CliVersionCache,
} from "./cli-locator";
import { execGrokCli } from "./cli-process";
import { modeToRemember } from "./mode-prefs";
import { enqueueQueuedSend, queuedSendsText } from "./queued-send";
import { resolveGrokHome } from "./sessions";
import { resolvedTerminalShellDialect } from "./terminal-manager";
import {
  decidePermission,
  extractPermissionFacts,
  permissionRulesNotice,
  suggestRules,
  pickAllowOnceOption,
} from "./permission-rules";
import { allProviderCapabilities } from "./provider-capabilities";
import { authorizedListCwd } from "./workspace-auth";
import { pathsEqual } from "./worktree";

export const CLI_UPDATE_VERSION_KEY = "grok.cliUpdateExtVersion";
export const ACT_MODE_ID = "default";

export interface CliCompatibilityResult {
  planModeAvailable: boolean;
  planModeUnavailableReason?: string;
  planModeVersionVerified: boolean;
  usedCache?: boolean;
  cliVersion?: string;
}

export interface ProviderSessionSessionOps {
  sessionCwd(session?: Session): string;
  setSessionCwd(session: Session, cwd: string, root?: string): void;
  workspaceRoot(): string;
  newLocalSession(): Session;
  startSession(model?: string, targetSession?: Session): Promise<any>;
  restartSession(mode: any, session: Session): Promise<any>;
  disposeSession(session: Session): void;
  removeSessionFromDisk(id: string, cwd: string): void;
  discardRestartedEmptySession(id?: string, session?: Session): void;
  discardAdapterEmptySession(provider: AcpProvider, id?: string, cwd?: string, client?: any): Promise<boolean | void>;
  restoreStrandedDraft(session: Session): void;
  rememberQueuedDraft(id: string, text: string): Promise<void>;
  rememberProjectProvider(cwd: string, provider: AcpProvider, model?: string): Promise<void>;
  rememberGrokConfig(key: "defaultModel" | "defaultEffort" | "defaultMode", value: any): Promise<void>;
  sessionDisplayName(session: Session): string;
  authorizedSessionCwds(): string[];
}

export interface ProviderSessionUiOps {
  notifyUser(level: "info" | "warning" | "error", text: string): void;
  emit(session: Session, msg: any): void;
  emitLocalTransient(session: Session, msg: any): void;
  post(msg: any): void;
  postSessionsList(): void;
  setStatus(session: Session, status: any): void;
  setPlanActive(session: Session, active: boolean): void;
  syncHumanWait(session: Session): void;
  persistPlanVerdict(session: Session, verdict: "approved" | "abandoned" | "rejected", text?: string): void;
  noteAnswered(session: Session): void;
  autoApprovePendingPermissions(session: Session): void;
  divertRacingSend(session: Session, text: string, isSteer: boolean): void;
  pickRestartMode(message: string): Promise<"clear" | "summarize" | undefined>;
  childWriteClaimWarning(session: Session, req: any): string | undefined;
  snapshotToolCallWrites(session: Session, call: any, cwd: string): void;
  loadPermissionRuleState(cwd: string): any;
  maybePromptWorkspaceRulesAdoption(session: Session, cwd: string, state: any): void;
  turnInFlight(session: Session): boolean;
  armCancelRecovery(session: Session, token: object): void;
}

export interface ProviderSessionProviderOps {
  modelsForSession(session: Session, models: any[], currentId?: string, isFirst?: boolean): any[];
  connectedProviders(): AcpProvider[];
  defaultProviderForProject(cwd: string): AcpProvider;
  locateProvider(provider: AcpProvider): string | undefined;
  readGrokVersion(cliPath: string): Promise<string>;
  getProviderCliVersions(): Partial<Record<AcpProvider, string>>;
}

export interface ProviderSessionDeps {
  host: Host;
  state: MementoLike;
  context: { extensionVersion: string };
  getFocused(): Session;
  setFocused(s: Session): void;
  getPool(): Set<Session>;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
  sessionOps: ProviderSessionSessionOps;
  uiOps: ProviderSessionUiOps;
  providerOps: ProviderSessionProviderOps;
}

export class ProviderSession {
  public cliUpdateChecked = false;

  constructor(private readonly deps: ProviderSessionDeps) {}

  public providerForRequestedModel(modelId: string, fallback: AcpProvider): AcpProvider {
    const override = this.deps.getOverride?.<typeof this.providerForRequestedModel>("providerForRequestedModel");
    if (override) return override(modelId, fallback);

    if (!modelId) return fallback;
    const cache = this.deps.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    const matches = PROVIDER_ORDER.filter((provider) =>
      cache[provider]?.models.some((model) => model.modelId === modelId));
    return matches.length === 1 ? matches[0] : fallback;
  }

  public async pickModel(): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.pickModel>("pickModel");
    if (override) return override();

    const focused = this.deps.getFocused();
    if (!focused.client || !focused.client.availableModels.length) {
      this.deps.host.showInformationMessage("Start a session first.");
      return;
    }
    const models = this.deps.providerOps.modelsForSession(
      focused,
      focused.client.availableModels,
      focused.client.currentModelId,
      !focused.hasHistory,
    );
    const items = models.map((m) => ({
      label: `${providerDisplayName(m.provider)} · ${m.name ?? m.modelId}`,
      description: m.provider === focused.provider && m.modelId === focused.client!.currentModelId ? "$(check) current" : "",
      detail: m.description,
      modelId: m.modelId,
      provider: m.provider,
    }));
    if (focused.provider === "gemini") {
      items.push({
        label: "$(edit) Custom Gemini model ID...",
        description: "",
        detail: "Enter a custom Antigravity/Gemini model name (e.g. gemini-3.9-pro)",
        modelId: "__custom__",
        provider: "gemini",
      });
    }
    const picked = await this.deps.host.showQuickPick(items, {
      placeHolder: focused.hasHistory ? "Pick a model" : "Pick an agent and model",
    });
    if (picked) {
      let targetModelId = picked.modelId;
      if (targetModelId === "__custom__") {
        const input = await this.deps.host.showInputBox({
          prompt: "Enter custom model ID (e.g. gemini-3.9-pro)",
          placeHolder: "gemini-3.9-pro",
        });
        if (!input || !input.trim()) return;
        targetModelId = input.trim();
      }
      await this.switchModel(targetModelId, focused, picked.provider);
    }
  }

  public async switchModel(
    modelId: string,
    session: Session = this.deps.getFocused(),
    provider: AcpProvider = session.provider,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.switchModel>("switchModel");
    if (override) return override(modelId, session, provider);

    const client = session.client;
    if (!client || session.priming) return;
    if (provider !== session.provider) {
      if (session.hasHistory) {
        const current = providerDisplayName(session.provider);
        const requested = providerDisplayName(provider);
        this.deps.uiOps.notifyUser("warning",
          `This ${current} conversation can only use ${current} models. Start a new conversation to switch to ${requested}.`,
        );
        return;
      }
      if (!this.deps.providerOps.connectedProviders().includes(provider)) {
        this.deps.uiOps.notifyUser("warning", `${providerDisplayName(provider)} is not connected.`);
        return;
      }
      const oldProvider = session.provider;
      const discardId = session.activeSessionId;
      if (isAdapterProvider(oldProvider) && discardId) {
        try { await client.deleteSession(discardId); }
        catch (error) { this.deps.host.appendLine(`[${oldProvider}] could not discard empty session ${discardId}: ${(error as Error).message}`); }
      }
      session.provider = provider;
      await this.deps.sessionOps.rememberProjectProvider(this.deps.sessionOps.sessionCwd(session), provider, modelId || undefined);
      await this.deps.sessionOps.startSession(undefined, session);
      if (oldProvider === "grok") this.deps.sessionOps.discardRestartedEmptySession(discardId, session);
      return;
    }
    if (modelId === client.currentModelId) return;
    if (!modelId) {
      if (session.hasHistory) return;
      const discardId = session.activeSessionId;
      await this.deps.sessionOps.rememberProjectProvider(this.deps.sessionOps.sessionCwd(session), provider, undefined);
      if (provider === "grok") await this.deps.sessionOps.rememberGrokConfig("defaultModel", "");
      else if (isAdapterProvider(provider) && discardId) await this.deps.sessionOps.discardAdapterEmptySession(provider, discardId, this.deps.sessionOps.sessionCwd(session), client);
      await this.deps.sessionOps.startSession(undefined, session);
      if (provider === "grok") this.deps.sessionOps.discardRestartedEmptySession(discardId, session);
      return;
    }
    try {
      await client.setModel(modelId);
      await this.deps.sessionOps.rememberProjectProvider(this.deps.sessionOps.sessionCwd(session), provider, modelId);
      if (provider === "grok") await this.deps.sessionOps.rememberGrokConfig("defaultModel", modelId);
    } catch (e) {
      if (!isIncompatibleAgentError(e)) {
        this.deps.uiOps.notifyUser("error", `Failed to set model: ${(e as Error).message}`);
        return;
      }
      if (!session.hasHistory) {
        const discardId = session.activeSessionId;
        await this.deps.sessionOps.rememberGrokConfig("defaultModel", modelId);
        await this.deps.sessionOps.startSession(undefined, session);
        this.deps.sessionOps.discardRestartedEmptySession(discardId, session);
        return;
      }
      const mode = await this.deps.uiOps.pickRestartMode("Switching to this model requires a new session.");
      if (!mode) return;
      await this.deps.sessionOps.rememberGrokConfig("defaultModel", modelId);
      await this.deps.sessionOps.restartSession(mode, session);
    }
  }

  public async setMode(
    modeId: "agent" | "plan" | "yolo",
    session: Session = this.deps.getFocused(),
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.setMode>("setMode");
    if (override) return override(modeId, session);

    if (!session.client || !session.client.sessionId || session.priming) return;
    if (modeId === "plan" && !session.planModeAvailable) {
      if (!session.planModeVersionVerified) {
        const rechecked = await this.recheckPlanModeAvailability(session);
        if (!rechecked || !session.planModeAvailable) {
          this.deps.uiOps.notifyUser("warning",
            session.planModeUnavailableReason ?? "Plan mode is unavailable for this Grok CLI version.",
          );
          return;
        }
      } else {
        this.deps.uiOps.notifyUser("warning",
          session.planModeUnavailableReason ?? "Plan mode is unavailable for this Grok CLI version.",
        );
        return;
      }
    }
    if (!session.planModeAvailable && session.planActive) {
      this.recoverUnavailablePlanMode(session, session.client, session.gen);
      return;
    }
    const remember = modeToRemember(modeId);
    if (remember) {
      void this.deps.sessionOps.rememberGrokConfig("defaultMode", remember);
    }
    if (modeId === "yolo") {
      session.autoApprove = true;
      this.deps.uiOps.setPlanActive(session, false);
      this.deps.uiOps.autoApprovePendingPermissions(session);
      if (session.client && supportsModeSwitching(session.provider)) {
        try {
          if (session.provider === "codex") {
            await session.client.setMode("default");
            await session.client.setMode("agent-full-access");
          } else if (session.provider === "claude" || session.provider === "gemini") {
            await session.client.setMode("yolo");
          } else {
            await session.client.setMode(ACT_MODE_ID);
          }
        } catch { /* CLI stays put; gate is what matters */ }
      }
      return;
    }
    if (modeId === "plan") {
      if (session.client) {
        try {
          await session.client.setMode("plan");
          session.autoApprove = false;
          this.deps.uiOps.setPlanActive(session, true);
        } catch (e) {
          this.deps.uiOps.notifyUser("error", `Couldn't switch mode: ${(e as Error).message}`);
        }
      }
      return;
    }
    session.autoApprove = false;
    this.deps.uiOps.setPlanActive(session, false);
    if (session.client && supportsModeSwitching(session.provider)) {
      try {
        if (session.provider === "codex") {
          await session.client.setMode("default");
          await session.client.setMode("agent");
        } else if (session.provider === "claude" || session.provider === "gemini") {
          await session.client.setMode("agent");
        } else {
          await session.client.setMode(ACT_MODE_ID);
        }
      } catch (e) {
        this.deps.uiOps.notifyUser("error", `Couldn't switch mode: ${(e as Error).message}`);
      }
    }
  }

  public handleExitPlan(
    requestId: number | string,
    verdict: "approved" | "abandoned" | "rejected",
    comment?: string,
    session: Session = this.deps.getFocused(),
  ): void {
    const override = this.deps.getOverride?.<typeof this.handleExitPlan>("handleExitPlan");
    if (override) return override(requestId, verdict, comment, session);

    const client = session.client;
    const pending = session.pendingExitPlans.get(requestId);
    if (!client || !pending) return;
    const feedback = comment?.trim();
    const planText = pending.planText;
    const gen = session.gen;
    const sidebar = this.deps.uiOps;
    const resolveCard = () => this.deps.uiOps.emit(session, { type: "planResolved", requestId, verdict });
    if (verdict === "approved") {
      session.autoApprove = this.deps.host.getConfiguration("grok").get<string>("defaultMode", "") === "yolo";
      this.deps.uiOps.setPlanActive(session, false);
    } else if (verdict === "rejected") {
      session.autoApprove = false;
      this.deps.uiOps.setPlanActive(session, true);
    } else {
      // explicit Cancel lands in Agent, not remembered YOLO
      session.autoApprove = false;
      this.deps.uiOps.setPlanActive(session, false);
    }

    if (verdict === "abandoned") {
      if (!client.respondExitPlan(requestId, verdict)) {
        session.autoApprove = false;
        this.deps.uiOps.setPlanActive(session, true);
        this.deps.uiOps.setStatus(session, "needs-you");
        return;
      }
      commitVerdict();
      if (feedback) this.deps.uiOps.divertRacingSend(session, feedback, false);
      resolveCard();
      return;
    }

    const inFlightComment = feedback ? { text: feedback, client, gen } : undefined;
    if (inFlightComment) session.inFlightPlanComments.set(requestId, inFlightComment);
    const commentDelivery = feedback
      ? client.interject(feedback, () => {
          if (session.inFlightPlanComments.get(requestId) === inFlightComment) {
            session.inFlightPlanComments.delete(requestId);
          }
          if (gen === session.gen && session.client === client) session.interjectionCount += 1;
        })
      : undefined;
    const verdictWritten = client.respondExitPlan(requestId, verdict);
    if (!verdictWritten) {
      void commentDelivery?.catch(() => {});
      session.autoApprove = false;
      this.deps.uiOps.setPlanActive(session, true);
      this.deps.uiOps.setStatus(session, "needs-you");
      return;
    }
    commitVerdict();
    resolveCard();

    if (!feedback || !commentDelivery) return;

    void commentDelivery.then((result) => {
      if (!verdictWritten) return;
      if (gen !== session.gen || session.client !== client) return;
      if (result === "ok") {
        this.deps.uiOps.emit(session, { type: "userMessage", text: feedback, chips: [], steer: true });
        this.deps.host.appendLine(`[plan-verdict] interjected ${feedback.length} comment chars`);
      } else {
        if (session.inFlightPlanComments.get(requestId) === inFlightComment) {
          session.inFlightPlanComments.delete(requestId);
        }
        this.deps.uiOps.emit(session, { type: "steerUnavailable" });
        this.deps.uiOps.divertRacingSend(session, feedback, false);
      }
    }).catch((e: any) => {
      if (!verdictWritten) return;
      if (gen !== session.gen || session.client !== client) return;
      if (session.inFlightPlanComments.get(requestId) === inFlightComment) {
        session.inFlightPlanComments.delete(requestId);
      }
      this.deps.uiOps.emit(session, {
        type: "error",
        text: `Plan comment steering failed: ${e?.message ?? e}. Your comment was queued instead.`,
      });
      this.deps.uiOps.divertRacingSend(session, feedback, false);
    });

    function commitVerdict(): void {
      session.pendingExitPlans.delete(requestId);
      sidebar.syncHumanWait(session);
      sidebar.persistPlanVerdict(session, verdict, planText);
      sidebar.noteAnswered(session);
      if (verdict === "approved" && session.autoApprove) {
        sidebar.autoApprovePendingPermissions(session);
      }
      if (verdict === "rejected" && !feedback) {
        sidebar.emit(session, { type: "planNotice", text: "Plan rejected — staying in Plan mode." });
      } else if (verdict === "abandoned" && !feedback) {
        sidebar.emit(session, { type: "planNotice", text: "Plan abandoned — switched to Agent mode." });
      }
    }
  }

  public queueInFlightPlanCommentsOnExit(session: Session, client: AcpClient, gen: number): void {
    const recovered: string[] = [];
    for (const [requestId, pending] of session.inFlightPlanComments) {
      if (pending.client !== client || pending.gen !== gen) continue;
      session.inFlightPlanComments.delete(requestId);
      recovered.push(pending.text);
    }
    if (!recovered.length) return;
    session.queuedSends = enqueueQueuedSend(session.queuedSends, recovered.join("\n\n"), []);
  }

  public recoverUnavailablePlanMode(
    session: Session,
    client: AcpClient,
    gen: number,
    exitPlanRequestId?: number | string,
  ): void {
    const attempt = ++session.planModeRecoveryAttempt;
    if (session.planModeRecovery?.warningTimer) {
      clearTimeout(session.planModeRecovery.warningTimer);
    }
    const recovery = {
      attempt,
      modeConfirmed: false,
      turnSettled: !this.deps.uiOps.turnInFlight(session),
      warningTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    session.planModeRecovery = recovery;
    session.autoApprove = false;
    this.deps.uiOps.setPlanActive(session, true);
    if (exitPlanRequestId !== undefined) {
      client.respondExitPlanUnavailable(exitPlanRequestId);
    }
    if (!recovery.turnSettled) {
      const cancelled = session.turnToken;
      void client.cancel("unavailable Plan recovery");
      if (cancelled) this.deps.uiOps.armCancelRecovery(session, cancelled);
    }
    this.deps.uiOps.emit(session, {
      type: "planNotice",
      text:
        `${session.planModeUnavailableReason ?? "Plan mode is unavailable for this Grok CLI version."} ` +
        "Returning to Agent mode; write and terminal actions remain blocked until the planning turn stops and Agent mode is confirmed.",
    });

    recovery.warningTimer = setTimeout(() => {
      if (
        gen !== session.gen ||
        session.client !== client ||
        session.planModeRecovery !== recovery
      ) return;
      this.deps.uiOps.emit(session, {
        type: "error",
        text:
          "Could not finish leaving unavailable Plan mode promptly. " +
          "Write and terminal actions remain blocked for safety; start a new session if recovery does not complete.",
      });
    }, 10_000);

    void client.setMode(ACT_MODE_ID).then(() => {
      if (
        gen !== session.gen ||
        session.client !== client ||
        session.planModeRecovery !== recovery
      ) return;
      recovery.modeConfirmed = true;
      this.finishUnavailablePlanRecovery(session, client, gen, recovery);
    }).catch((e: any) => {
      if (
        gen !== session.gen ||
        session.client !== client ||
        session.planModeRecovery !== recovery
      ) return;
      if (recovery.warningTimer) clearTimeout(recovery.warningTimer);
      session.planModeRecovery = undefined;
      this.deps.uiOps.emit(session, {
        type: "error",
        text:
          `Could not leave unavailable Plan mode: ${e?.message ?? e}. ` +
          "Write and terminal actions remain blocked for safety. Update Grok Build or start a new session.",
      });
    });
  }

  public finishUnavailablePlanRecovery(
    session: Session,
    client: AcpClient,
    gen: number,
    recovery: NonNullable<Session["planModeRecovery"]>,
  ): void {
    if (
      gen !== session.gen ||
      session.client !== client ||
      session.planModeRecovery !== recovery ||
      !recovery.modeConfirmed ||
      !recovery.turnSettled
    ) return;
    if (recovery.warningTimer) clearTimeout(recovery.warningTimer);
    session.planModeRecovery = undefined;
    this.deps.uiOps.setPlanActive(session, false);
    this.deps.uiOps.emit(session, { type: "planNotice", text: "Returned to Agent mode." });
  }

  public settleUnavailablePlanTurn(session: Session, client: AcpClient, gen: number): void {
    const recovery = session.planModeRecovery;
    if (!recovery || gen !== session.gen || session.client !== client) return;
    recovery.turnSettled = true;
    this.finishUnavailablePlanRecovery(session, client, gen, recovery);
  }

  public handlePermissionRequest(
    session: Session,
    client: AcpClient,
    req: PermissionRequest,
    cwd: string,
  ): void {
    const override = this.deps.getOverride?.<typeof this.handlePermissionRequest>("handlePermissionRequest");
    if (override) return override(session, client, req, cwd);

    const planActive = effectivePlanActive(
      client.usesClientPlanGate,
      client.planActive,
      session.planActive,
    );
    if (client.usesClientPlanGate && planActive && shouldRejectPermission(req.toolCall, {
      active: true,
      workspaceRoot: cwd,
      grokHome: resolveGrokHome(process.env),
      shellDialect: resolvedTerminalShellDialect(),
    })) {
      const rejectId = pickRejectOption(req.options);
      if (rejectId) {
        client.respondPermission(req.id, rejectId);
      } else {
        client.respondPermissionCancelled(req.id);
      }
      const kind = String(req.toolCall?.kind || "tool").toLowerCase();
      this.deps.uiOps.emit(session, {
        type: "planNotice",
        text: kind === "execute"
          ? "Plan mode declined this command because it was not verified as safe to run while planning. Question-card answers are unaffected."
          : `Plan mode declined this ${kind} request because workspace changes are blocked while planning. Question-card answers are unaffected.`,
      });
      return;
    }

    const claimWarning = this.deps.uiOps.childWriteClaimWarning(session, req);
    if (!claimWarning && !isPlanReviewPermission(req.toolCall?.kind) &&
        this.applyPermissionRules(session, client, req, cwd)) {
      return;
    }

    if (!claimWarning && session.autoApprove && !planActive && !isPlanReviewPermission(req.toolCall?.kind)) {
      const opt = req.options.find((o: any) => o.kind === "allow_always") ??
                  req.options.find((o: any) => o.kind === "allow_once");
      if (opt) {
        this.deps.uiOps.snapshotToolCallWrites(session, req.toolCall, cwd);
        client.respondPermission(req.id, opt.optionId);
        return;
      }
    }

    const visibleOptions = permissionOptionsForPlan(
      req.options ?? [],
      planActive,
      req.toolCall?.kind,
    );
    if (
      planActive &&
      String(req.toolCall?.kind ?? "").toLowerCase() === "execute" &&
      visibleOptions.length === 0
    ) {
      client.respondPermissionCancelled(req.id);
      this.deps.uiOps.emit(session, {
        type: "planNotice",
        text: "Plan mode declined this command because it offered no safe one-time or reject option.",
      });
      return;
    }
    const plan = isPlanReviewPermission(req.toolCall?.kind)
      ? planTextFromPermissionToolCall(req.toolCall)
      : undefined;
    session.pendingPermissions.set(req.id, createPendingPermission({
      title: req.toolCall?.title || `permission: ${req.toolCall?.kind || "tool"}`,
      toolCallId: req.toolCall?.toolCallId,
      toolKind: req.toolCall?.kind,
      paths: extractPermissionFacts(req.toolCall).paths.slice(),
      plan,
      options: (req.options ?? []).map((o: any) => ({
        optionId: o.optionId,
        kind: o.kind,
        name: o.name,
      })),
    }));
    this.deps.uiOps.syncHumanWait(session);
    const ruleSuggestions = isPlanReviewPermission(req.toolCall?.kind)
      ? undefined
      : suggestRules(extractPermissionFacts(req.toolCall), cwd);
    this.deps.uiOps.emit(session, {
      type: "permissionRequest",
      req: {
        ...req,
        options: visibleOptions,
        ...(plan !== undefined ? { plan } : {}),
      },
      ...(ruleSuggestions && ruleSuggestions.length ? { ruleSuggestions } : {}),
      ...(claimWarning ? { warning: claimWarning } : {}),
    });
    this.deps.uiOps.setStatus(session, "needs-you");
  }

  public applyPermissionRules(
    session: Session,
    client: AcpClient,
    req: PermissionRequest,
    cwd: string,
  ): boolean {
    const facts = { ...extractPermissionFacts(req.toolCall), shellDialect: resolvedTerminalShellDialect() };
    const loaded = this.deps.uiOps.loadPermissionRuleState(cwd);
    this.deps.uiOps.maybePromptWorkspaceRulesAdoption(session, cwd, loaded);
    const decision = decidePermission(
      [...loaded.active, ...(session.rolePermissionRules ?? []), ...(session.sessionPermissionRules ?? [])],
      facts,
      cwd,
    );
    if (decision.action === "ask") return false;
    if (decision.action === "deny") {
      const rejectId = pickRejectOption(req.options ?? []);
      if (rejectId) client.respondPermission(req.id, rejectId);
      else client.respondPermissionCancelled(req.id);
      this.deps.uiOps.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: permissionRulesNotice(decision),
      });
      return true;
    }
    const allowId = pickAllowOnceOption(req.options ?? []);
    if (!allowId) return false;
    this.deps.uiOps.snapshotToolCallWrites(session, req.toolCall, cwd);
    client.respondPermission(req.id, allowId);
    this.deps.uiOps.emit(session, {
      type: "hostNotice",
      level: "info",
      text: permissionRulesNotice(decision),
    });
    return true;
  }

  public async resetProviderSessionsAfterLogout(provider: AcpProvider): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.resetProviderSessionsAfterLogout>("resetProviderSessionsAfterLogout");
    if (override) return override(provider);

    const connected = this.deps.providerOps.connectedProviders();
    const needsProvider = connected.length === 0;
    const replacementProvider = (cwd: string) => this.deps.providerOps.defaultProviderForProject(cwd);
    const providerName = providerDisplayName(provider);
    const pool = this.deps.getPool();
    const focused = this.deps.getFocused();
    const affectedSessions = new Set<Session>(
      [...pool].filter((session) => session.provider === provider),
    );
    if (focused.provider === provider) affectedSessions.add(focused);
    const replacingFocused = focused.provider === provider;
    const focusedQueuedText = replacingFocused ? queuedSendsText(focused.queuedSends) : "";
    const focusedDraftId = replacingFocused ? focused.activeSessionId : undefined;
    const focusedCwd = replacingFocused ? this.deps.sessionOps.sessionCwd(focused) : "";
    const backgroundQueued = [...affectedSessions]
      .filter((session) => session !== focused && session.queuedSends.length > 0)
      .map((session) => ({
        id: session.activeSessionId,
        name: this.deps.sessionOps.sessionDisplayName(session) || "a background conversation",
        text: queuedSendsText(session.queuedSends),
      }));

    for (const affected of affectedSessions) {
      const text = queuedSendsText(affected.queuedSends);
      if (text && affected.activeSessionId) {
        await this.deps.sessionOps.rememberQueuedDraft(affected.activeSessionId, text);
      }
    }

    const shells = [...affectedSessions]
      .filter((s) => !s.hasHistory && !s.worktree && s.chips.length === 0 && !s.priming
        && !s.strandedDraft && s.queuedSends.length === 0 && !!s.activeSessionId)
      .map((s) => ({ id: s.activeSessionId!, cwd: this.deps.sessionOps.sessionCwd(s), provider: s.provider }));

    for (const session of affectedSessions) void this.deps.sessionOps.disposeSession(session);
    for (const shell of shells) {
      if (isAdapterProvider(shell.provider)) {
        void this.deps.sessionOps.discardAdapterEmptySession(shell.provider, shell.id, shell.cwd);
      } else {
        this.deps.sessionOps.removeSessionFromDisk(shell.id, shell.cwd);
      }
    }

    let localReplacement: Session | undefined;
    if (replacingFocused) {
      const cwd = authorizedListCwd(focusedCwd, this.deps.sessionOps.authorizedSessionCwds(), pathsEqual)
        ?? this.deps.sessionOps.workspaceRoot();
      const replacement = this.deps.sessionOps.newLocalSession();
      replacement.provider = replacementProvider(cwd);
      replacement.needsProvider = needsProvider;
      this.deps.sessionOps.setSessionCwd(replacement, cwd, this.deps.sessionOps.workspaceRoot());
      replacement.priming = connected.length > 0;
      replacement.lastActiveAt = Date.now();
      this.deps.setFocused(replacement);
      pool.add(replacement);
      localReplacement = replacement;
      this.deps.uiOps.post({ type: "clearMessages" });
      if (focusedQueuedText) {
        replacement.strandedDraft = focusedQueuedText;
        replacement.strandedDraftSessionId = focusedDraftId;
      }
      if (connected.length) this.deps.uiOps.emit(replacement, { type: "setBusy", value: true, locked: true });
      else this.deps.uiOps.post({ type: "onboarding", state: "connect-agent", platform: process.platform });
    }

    const draftNoticeTarget = localReplacement ?? this.deps.getFocused();
    for (const queued of backgroundQueued) {
      if (!queued.id) {
        this.deps.uiOps.emitLocalTransient(draftNoticeTarget, {
          type: "error",
          text: `${providerName} was signed out while ${queued.name} had an unsaved draft:\n\n${queued.text}`,
        });
        continue;
      }
      this.deps.uiOps.emitLocalTransient(draftNoticeTarget, {
        type: "error",
        text: `${providerName} was signed out while “${queued.name}” had a draft. It is saved — open that conversation to get it back.`,
      });
    }

    if (localReplacement && connected.length) {
      const started = await this.deps.sessionOps.startSession(undefined, localReplacement);
      if (started && !localReplacement.needsProvider) this.deps.sessionOps.restoreStrandedDraft(localReplacement);
    }
  }

  public async maybeUpdateCliOnUpgrade(cliPath: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.maybeUpdateCliOnUpgrade>("maybeUpdateCliOnUpgrade");
    if (override) return override(cliPath);

    if (this.cliUpdateChecked) return;
    this.cliUpdateChecked = true;
    const current = this.deps.context.extensionVersion;
    const lastSeen = this.deps.state.get<string>(CLI_UPDATE_VERSION_KEY);
    try {
      if (!extensionWasUpgraded(lastSeen, current)) return;
      const policy = grokUpdatePolicy(await this.deps.providerOps.readGrokVersion(cliPath), process.platform);
      if (!policy.allow) {
        this.deps.host.appendLine(
          `Extension upgraded ${lastSeen} → ${current}; skipping silent CLI update (${policy.note}).`,
        );
        return;
      }
      const args = policy.target ? ["update", "--version", policy.target] : ["update"];
      this.deps.host.appendLine(
        `Extension upgraded ${lastSeen} → ${current}; updating grok CLI (silent: ${args.join(" ")}).`,
      );
      this.deps.uiOps.post({ type: "cliUpdating" });
      try {
        const { stdout, stderr } = await execGrokCli(cliPath, args, { timeout: 20_000 });
        if (stdout?.trim()) this.deps.host.appendLine(stdout.trim());
        if (stderr?.trim()) this.deps.host.appendLine(stderr.trim());
      } catch (e) {
        this.deps.host.appendLine(`grok update failed (continuing with current binary): ${(e as Error).message}`);
      }
    } finally {
      void this.deps.state.update(CLI_UPDATE_VERSION_KEY, current);
    }
  }

  public async planModeCompatibility(
    cliPath: string,
    opts: { notify?: boolean } = {},
  ): Promise<CliCompatibilityResult> {
    const override = this.deps.getOverride?.<typeof this.planModeCompatibility>("planModeCompatibility");
    if (override) return override(cliPath, opts);

    const notify = opts.notify !== false;
    const cache = this.deps.state.get<CliVersionCache>(CLI_VERSION_CACHE_KEY, {});
    const { decision, nextCache, usedCache, versionOutput } = await resolvePlanModeAvailability({
      readOnce: () => this.deps.providerOps.readGrokVersion(cliPath),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      identity: readCliBinaryIdentity(cliPath),
      cache,
    });
    if (nextCache) void this.deps.state.update(CLI_VERSION_CACHE_KEY, nextCache);
    const parsed = parseGrokVersion(versionOutput);
    const cliVersion = parsed ? parsed.join(".") : undefined;
    if (cliVersion) this.deps.providerOps.getProviderCliVersions().grok = cliVersion;
    if (decision.available) {
      if (usedCache) {
        this.deps.host.appendLine("grok --version failed; using last verified version for Plan mode.");
      }
      return { planModeAvailable: true, planModeVersionVerified: decision.verified, usedCache, cliVersion };
    }
    if (decision.verified) {
      const message =
        `grok CLI ${decision.installed} is below required version ${GROK_REQUIRED_VERSION}; ` +
        "Plan mode is unavailable.";
      this.deps.host.appendLine(message);
      if (notify) void this.deps.host.showWarningMessage(message);
      return {
        planModeAvailable: false,
        planModeVersionVerified: true,
        planModeUnavailableReason: decision.reason,
        usedCache,
        cliVersion,
      };
    }
    const message =
      `Could not verify the Grok CLI version (the check failed or timed out — a first run after install can be slow). ` +
      `Plan mode is unavailable until it can be checked. Pick Plan again or reload the window to retry. ` +
      `Continuing best-effort with the current binary.`;
    this.deps.host.appendLine(message);
    if (notify) {
      void this.deps.host.showWarningMessage(
        `Could not verify the Grok CLI version (the check failed or timed out — a first run after install can be slow). ` +
          `Pick Plan again or reload the window to retry.`,
      );
    }
    return {
      planModeAvailable: false,
      planModeVersionVerified: false,
      planModeUnavailableReason: decision.reason,
      usedCache,
      cliVersion,
    };
  }

  public applyPlanModeCompatibility(session: Session, compatibility: CliCompatibilityResult): void {
    const override = this.deps.getOverride?.<typeof this.applyPlanModeCompatibility>("applyPlanModeCompatibility");
    if (override) return override(session, compatibility);

    session.planModeAvailable = compatibility.planModeAvailable;
    session.planModeUnavailableReason = compatibility.planModeUnavailableReason;
    session.planModeVersionVerified = compatibility.planModeVersionVerified;
    this.deps.uiOps.emit(session, {
      type: "planModeAvailability",
      available: compatibility.planModeAvailable,
      reason: compatibility.planModeUnavailableReason,
      recheckable: !compatibility.planModeAvailable && !compatibility.planModeVersionVerified,
    });
    this.deps.uiOps.emit(session, {
      type: "providerCapabilities",
      provider: session.provider,
      capabilities: allProviderCapabilities(session.provider, {
        planModeAvailable: compatibility.planModeAvailable,
        cliVerified: compatibility.planModeVersionVerified,
        planModeUnavailableReason: compatibility.planModeUnavailableReason,
        steeringSupported: session.client?.supportsInterject?.(),
      }),
    });
  }

  public async recheckPlanModeAvailability(session: Session): Promise<boolean> {
    const override = this.deps.getOverride?.<typeof this.recheckPlanModeAvailability>("recheckPlanModeAvailability");
    if (override) return override(session);

    const gen = session.gen;
    const cliPath = this.deps.providerOps.locateProvider("grok");
    if (!cliPath) return false;
    this.deps.host.appendLine("Re-checking Grok CLI version for Plan mode…");
    const compatibility = await this.planModeCompatibility(cliPath, { notify: false });
    if (gen !== session.gen) return false;
    this.applyPlanModeCompatibility(session, compatibility);
    return true;
  }
}

export function createProviderSession(deps: ProviderSessionDeps): ProviderSession {
  return new ProviderSession(deps);
}
