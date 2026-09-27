import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AgentRole,
  type AgentRoleSet,
  AGENT_ROLES_DIR,
  findAgentRole,
  isValidRoleName,
  rolePermissionsToRules,
  validateRoleModel,
} from "./agent-roles";
import {
  type AgentRoleDraft,
  type RoleScope,
  type CrewFlowDraft,
  roleToDraft,
  presetToDraft,
  validateAgentRoleDraft,
  validateCrewFlowDraft,
} from "./agent-role-write";
import {
  type CrewPresetSet,
  presetToStageGraph,
} from "./crew-preset";
import {
  type WorkflowDraft,
  draftFromUnknown,
  validateWorkflowDraft,
  workflowToDraft,
} from "./workflow-write";
import {
  validateWorkflowDefinition,
  validateWorkflowRaw,
  type ValidateWorkflowContext,
} from "./workflow-validate";
import {
  type GeneratorState,
  acceptSubmission,
  COMPANIONS_LIST_ROLES_TOOL,
  COMPANIONS_LIST_WORKFLOWS_TOOL,
  COMPANIONS_SUBMIT_WORKFLOW_TOOL,
  COMPANIONS_VALIDATE_WORKFLOW_TOOL,
  COMPANIONS_WORKFLOW_SCHEMA_TOOL,
  extractCompanionsWorkflow,
  generatorMetaPrompt,
  makeGeneratorState,
  recordValidation,
  workflowArg,
  WORKFLOW_AUTHORING_GUIDE,
} from "./workflow-generator";
import { parseAgentCommand, parseHandoffCommand } from "./slash-filter";
import {
  type HandoffKind,
  type ThreadContext,
  defaultRoleFor,
  deriveBriefing,
  handoffLabel,
  renderFreshSessionPrompt,
} from "./handoff";
import {
  type AgentResult,
  type Briefing,
  type BriefingInput,
  type FileReconciliation,
  RESULT_FORMAT,
  makeBriefing,
  parseResult,
  reconcileFiles,
  renderBriefing,
  renderResult,
  roleForbidden,
} from "./briefing";
import { filesForScope, reviewCenterSnapshot } from "./review-center";
import { cancelCrewRun } from "./crew";
import { AgentRunStore, formatRunCost, type AgentRunTrigger } from "./agent-run";
import { EFFORT_ORDER, parseRoutingRules, type RoutingRule } from "./target-eligibility";
import {
  PROVIDER_ORDER,
  providerDisplayName,
  type ProviderModelCache,
} from "./provider-ui";
import type { AcpProvider } from "./acp-backend";
import type { HostMsg, WorkflowGeneratorView } from "./protocol";
import type { Host } from "./host";
import type { MementoLike } from "./persisted-state";
import { type Session } from "./session";
import { SESSION_META_KEY } from "./worktree-host";
import { type SessionMetaOverrides } from "./sessions";
import { type HiddenReason } from "./session-type";
import {
  COMPANIONS_LIST_TOOL,
  normalizeListArguments,
} from "./companions-protocol";
import type { CompanionsCall } from "./companions-server";
import { PROVIDER_MODEL_CACHE_KEY } from "./subagent-host";
import type { PlanEntry } from "./plan-entries";
import { workflowToMermaid } from "./workflow";

/**
 * Which Agents & Crew card a refusal belongs to. Prefixed by kind because a
 * role, a crew flow and a workflow may share a name, and an unsaved card has
 * no name at all. media/settings.js `agentCardId` builds the same string.
 */
export function agentCardErrorId(kind: "role" | "flow" | "workflow", name?: string): string {
  return kind + ":" + (name || "*new*");
}

export interface AgentAuthoringSessionOps {
  sessionCwd(session?: Session): string;
  setSessionCwd(session: Session, cwd: string, root?: string): void;
  workspaceRoot(): string;
  newLocalSession(): Session;
  startSession(requestedModel?: string, targetSession?: Session): Promise<any>;
  handleSend(text: string, isSteer: boolean, target?: Session): Promise<void>;
  parkFocused(): void;
  postSessionsList(): void;
  sessionTypeMetaFor(session: Session): any;
  buildThreadContext(session: Session, reason: HandoffKind): ThreadContext;
  persistedUsageLedger(sessionId: string, count?: number): { usage?: { totalTokens?: number; costUsdTicks?: number } };
  markHiddenChildSession(session: Session, parent: Session, tag: string, reason?: HiddenReason): void;
  noteChildStarted(caller: Session, child: Session, subagentId?: string): void;
  closeChildRelays(child: Session): void;
  postRunningChildren(): void;
  teardownEmptySession(session: Session): void;
  cancelSubagentsOf(caller: Session, reason: string): void;
  setStatus(session: Session, status: any): void;
  companionsList(session: Session, args: any): any;
}

export interface AgentAuthoringUiOps {
  emit(session: Session, msg: any): void;
  postLocal(msg: any): void;
  postToSettingsEditor(msg: any): void;
  confirmInChat(session: Session, opts: any): Promise<boolean>;
  postSessionName(session: Session): void;
  deleteSessionCache(id: string): void;
}

export interface AgentAuthoringProviderOps {
  usableProviders(): AcpProvider[];
  connectedProviders(): AcpProvider[];
  subagentRoster(): Record<string, any>;
  subagentsEnabledGlobally(): boolean;
  companionSettingsView(): Record<string, string | number | boolean>;
  defaultWorkflowName(): string;
  companionsSetting<T>(key: string, fallback: T): T;
}

export interface AgentAuthoringCompanionOps {
  agentRoleSet(cwd: string): AgentRoleSet;
  crewPresetSet(cwd: string): CrewPresetSet;
  companionsRoot(scope: RoleScope, cwd: string): string | undefined;
  logAgentRun(entry: any): void;
}

export interface AgentAuthoringDeps {
  host: Host;
  state: MementoLike;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
  getFocused(): Session | undefined;
  setFocused(s: Session): void;
  getPool(): Set<Session>;
  getAgentRuns(): AgentRunStore;
  sessionOps: AgentAuthoringSessionOps;
  uiOps: AgentAuthoringUiOps;
  providerOps: AgentAuthoringProviderOps;
  companionOps: AgentAuthoringCompanionOps;
}

export class AgentAuthoring {
  public agentRolesError?: { id?: string; message: string };
  public generatorState?: {
    requestId: string;
    cancelled: boolean;
    state: GeneratorState;
    roleSession?: Session;
    caller?: Session;
    submitted?: ReturnType<typeof acceptSubmission>;
    compiler?: { provider?: string; model?: string; sourcePrompt?: string; generatedAt?: string };
    scope: RoleScope;
    lastProgressAt: number;
  };

  constructor(private readonly deps: AgentAuthoringDeps) {}

  public resolveRoleProvider(role: AgentRole, caller: Session): { provider: AcpProvider } | { error: string } {
    const override = this.deps.getOverride?.<typeof this.resolveRoleProvider>("resolveRoleProvider");
    if (override) return override(role, caller);

    const usable = this.deps.providerOps.usableProviders();
    if (!usable.length) return { error: "No companion is connected, so there is nothing to run a role on." };
    if (role.preferDifferentProvider && role.source === "builtin") {
      const elsewhere = usable.find((candidate) => candidate !== caller.provider);
      if (elsewhere) return { provider: elsewhere };
    }
    if (usable.includes(role.provider)) return { provider: role.provider };
    if (role.source !== "builtin") {
      return {
        error:
          `Role \`${role.name}\` runs on ${providerDisplayName(role.provider)}, which is not connected. `
          + `Connect it, or change its companion in Settings → Agents & Crew `
          + `(\`${role.path ?? AGENT_ROLES_DIR}\`).`,
      };
    }
    return { provider: usable.includes(caller.provider) ? caller.provider : usable[0] };
  }

  public agentNotice(session: Session, level: "info" | "warning", text: string): void {
    const override = this.deps.getOverride?.<typeof this.agentNotice>("agentNotice");
    if (override) return override(session, level, text);

    this.deps.host.appendLine(`[agent] ${text}`);
    this.deps.uiOps.emit(session, { type: "hostNotice", level, text });
  }

  public async handleAgentCommand(text: string, session: Session): Promise<boolean> {
    const override = this.deps.getOverride?.<typeof this.handleAgentCommand>("handleAgentCommand");
    if (override) return override(text, session);

    const parsed = parseAgentCommand(text);
    if (parsed.kind === "none") return false;

    const cwd = this.deps.sessionOps.sessionCwd(session);
    const set = this.deps.companionOps.agentRoleSet(cwd);
    for (const problem of set.problems) this.agentNotice(session, "warning", problem.message);

    this.deps.uiOps.emit(session, { type: "userMessage", text, chips: [] });

    if (parsed.kind === "list") {
      const lines = set.roles.map((role) => {
        const where = role.source === "builtin"
          ? "built-in"
          : `${role.path ?? role.source}${role.overrides ? `, overrides ${role.overrides}` : ""}`;
        const mode = role.mode === "plan" ? "Plan mode" : "Agent mode";
        return `- \`/agent ${role.name}\` — **${role.name}** (${mode}, ${where})\n  ${role.whenToUse}`;
      });
      this.agentNotice(
        session,
        "info",
        [
          `### Available Agent Roles`,
          `Run any role in its own session with \`/agent <name> <task>\`. Click a role below to paste it:`,
          ``,
          ...lines,
          ``,
          `---`,
          `**Configuring Roles:** Open **Settings (⚙) → Agents & Crew** to set each role's companion, model and scope — `
          + `or write the file yourself as \`${AGENT_ROLES_DIR}/<name>.md\` (this project) or \`~/${AGENT_ROLES_DIR}/<name>.md\` (every project).`,
        ].join("\n"),
      );
      return true;
    }
    if (parsed.kind === "error") {
      this.agentNotice(session, "warning", parsed.message);
      return true;
    }

    const { name, task } = parsed.command;
    const role = findAgentRole(set, name);
    if (!role) {
      this.agentNotice(
        session,
        "warning",
        `There is no role \`${name}\`. Available: ${set.roles.map((entry) => entry.name).join(", ")}. `
        + `Define your own as \`${AGENT_ROLES_DIR}/${name}.md\`.`,
      );
      return true;
    }
    if (session.agentRun) {
      this.agentNotice(
        session,
        "warning",
        `Role \`${session.agentRun.roleName}\` is still running. Stop it first, or wait for its card.`,
      );
      return true;
    }
    const resolved = this.resolveRoleProvider(role, session);
    if ("error" in resolved) {
      this.agentNotice(session, "warning", resolved.error);
      return true;
    }
    const provider = resolved.provider;
    if (provider === role.provider) {
      const cache = this.deps.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {})[provider];
      const verdict = validateRoleModel(role, cache?.models, providerDisplayName(provider));
      if (!verdict.ok) {
        this.agentNotice(session, "warning", verdict.message);
        return true;
      }
      if (!verdict.checked && role.model) {
        this.deps.host.appendLine(
          `[agent] ${providerDisplayName(provider)} model list is not warmed yet — `
          + `role \`${role.name}\` model '${role.model}' not verified.`,
        );
      }
    }

    await this.runAgentRole(
      { ...role, provider },
      {
        goal: task,
        task,
        acceptance:
          "The task above is done, or the reason it could not be done is stated in the result. "
          + "Nothing outside the task has been changed.",
        files: session.chips.filter((chip) => !chip.hidden && chip.relPath).map((chip) => chip.relPath),
        decisions: [
          "This role was commissioned from an existing conversation that you are not in and cannot see. "
          + "Everything you were told is in this briefing.",
        ],
        forbidden: roleForbidden({ ...role, provider }),
        returnFormat: RESULT_FORMAT,
      },
      "command",
      session,
    );
    return true;
  }

  public async runAgentRole(
    role: AgentRole,
    brief: BriefingInput,
    trigger: AgentRunTrigger,
    caller: Session,
    coords?: {
      runId: string;
      step: number;
      cwd?: string;
      live?: boolean;
      subagent?: { subagentId: string; label: string; profile: string };
      stage?: { stageId: string; allowSubagents?: boolean; scope?: string[]; subStep?: boolean };
      generator?: { requestId: string };
      continueSession?: Session;
      continueMessage?: string;
    },
  ): Promise<{
    outcome: "completed" | "failed" | "cancelled";
    filesReported: string[];
    filesObserved: string[];
    costUsdTicks?: number;
    totalTokens?: number;
    durationMs: number;
    sessionId?: string;
    detail?: string;
    summary: string;
    planEntries: PlanEntry[];
    reconciliation?: FileReconciliation;
    parsed?: AgentResult;
    rawReply?: string;
  }> {
    const override = this.deps.getOverride?.<typeof this.runAgentRole>("runAgentRole");
    if (override) return override(role, brief, trigger, caller, coords);

    const cwd = coords?.cwd ?? this.deps.sessionOps.sessionCwd(caller);
    const agentRuns = this.deps.getAgentRuns();
    const runId = coords?.runId ?? agentRuns.newRunId();
    const step = coords?.step ?? 1;
    const startedAt = Date.now();

    const briefing: Briefing = makeBriefing({ ...brief, runId, step });
    const pool = this.deps.getPool();
    const reuse = coords?.continueSession && coords.continueMessage?.trim()
      && pool.has(coords.continueSession) && coords.continueSession.client
      ? coords.continueSession
      : undefined;
    const briefMarkdown = reuse ? coords!.continueMessage!.trim() : renderBriefing(briefing, role);

    const artifactKind = coords?.stage && !coords.stage.subStep ? "stage" as const : "step" as const;
    try {
      agentRuns.writeBrief(runId, step, briefMarkdown, artifactKind);
    } catch (error) {
      this.agentNotice(
        caller,
        "warning",
        `Could not write the briefing for run ${runId}: ${(error as Error).message}. The role was not started.`,
      );
      return {
        outcome: "failed",
        filesReported: [],
        filesObserved: [],
        durationMs: 0,
        detail: (error as Error).message,
        summary: "",
        planEntries: [],
      };
    }
    this.deps.companionOps.logAgentRun({
      at: startedAt,
      runId,
      step,
      role: role.name,
      provider: role.provider,
      ...(role.model ? { model: role.model } : {}),
      event: "briefed",
    });

    const caution = role.preferDifferentProvider && role.provider === caller.provider
      ? `This ran on ${providerDisplayName(role.provider)}, the same companion as this conversation — `
        + `a fresh session with only the briefing, but not an outside opinion. `
        + `Connect a second companion for a stronger review.`
      : undefined;

    const roleSession = reuse ?? this.deps.sessionOps.newLocalSession();
    const overlay = rolePermissionsToRules(role);
    if (!reuse) {
      roleSession.provider = role.provider;
      roleSession.startOverrides = {
        ...(role.model ? { model: role.model } : {}),
        ...(role.effort ? { effort: role.effort } : {}),
        ...(role.mode ? { mode: role.mode } : {}),
      };
      this.deps.sessionOps.setSessionCwd(roleSession, cwd, this.deps.sessionOps.workspaceRoot());
      pool.add(roleSession);
    }
    if (overlay.length) roleSession.rolePermissionRules = overlay;
    const tokensBefore = reuse?.activeSessionId
      ? this.deps.sessionOps.persistedUsageLedger(reuse.activeSessionId, reuse.userMessageCount).usage?.totalTokens
      : undefined;
    const subagentCoords = coords?.subagent;
    const stageCoords = coords?.stage;
    const generatorCoords = coords?.generator;
    if (subagentCoords && !reuse) this.deps.sessionOps.markHiddenChildSession(roleSession, caller, subagentCoords.subagentId);
    if (stageCoords && !reuse) {
      this.deps.sessionOps.markHiddenChildSession(
        roleSession,
        caller,
        `${coords?.runId ?? runId}:${stageCoords.stageId}`,
        "crew-stage",
      );
      roleSession.stageAllowsSubagents = stageCoords.allowSubagents === true;
      if (stageCoords.scope) roleSession.stageScope = [...stageCoords.scope];
    }
    if (generatorCoords) {
      this.deps.sessionOps.markHiddenChildSession(roleSession, caller, generatorCoords.requestId, "workflow-generator");
      const gen = this.generatorStore();
      if (gen.requestId === generatorCoords.requestId) gen.roleSession = roleSession;
    }
    const subagentHandle = subagentCoords
      ? { subagentId: subagentCoords.subagentId, roleSession, cancelled: false }
      : undefined;
    const liveHandle = (coords?.live || stageCoords) && !subagentCoords && !generatorCoords
      ? { runId, step, roleName: role.name, roleSession, cancelled: false }
      : undefined;
    if (subagentHandle) {
      caller.subagentLive = [...(caller.subagentLive ?? []), subagentHandle];
    } else if (liveHandle) {
      caller.crewLive = [...(caller.crewLive ?? []), liveHandle];
    } else if (!generatorCoords) {
      caller.agentRun = { runId, step, roleName: role.name, roleSession, cancelled: false };
      this.deps.sessionOps.setStatus(caller, "working");
      this.deps.uiOps.emit(caller, { type: "setBusy", value: true });
    }
    const roleCancelled = () =>
      !!(subagentHandle?.cancelled
        || liveHandle?.cancelled
        || (generatorCoords && this.generatorStore().cancelled)
        || (!subagentHandle && !generatorCoords && caller.agentRun?.cancelled)
        || (!subagentHandle && caller.crewRun?.status === "cancelled"));
    if (!subagentCoords && !stageCoords && !generatorCoords) {
      this.agentNotice(
        caller,
        "info",
        `Running role \`${role.name}\` on ${providerDisplayName(role.provider)}`
        + `${role.model ? ` (${role.model})` : ""} in its own session — run ${runId}, step ${step}.`,
      );
    }

    let reply = "";
    roleSession.agentTextTap = (chunk) => {
      reply += chunk;
      if (!generatorCoords) return;
      const store = this.generatorStore();
      const now = Date.now();
      if (store.requestId !== generatorCoords.requestId || now - store.lastProgressAt < 400) return;
      store.lastProgressAt = now;
      this.postWorkflowGenerator({
        status: "running",
        requestId: generatorCoords.requestId,
        progress: reply.slice(-500),
      });
    };
    let outcome: "completed" | "failed" | "cancelled" = "completed";
    let detail: string | undefined;
    try {
      const client = reuse?.client ?? await this.deps.sessionOps.startSession(undefined, roleSession);
      if (!client) {
        outcome = "failed";
        detail = `${providerDisplayName(role.provider)} could not start a session for this role.`;
      } else if (roleCancelled()) {
        outcome = "cancelled";
        detail = "Stopped before the briefing was sent.";
      } else {
        if (!reuse) this.nameAgentRoleSession(roleSession, role, runId, step);
        this.deps.sessionOps.noteChildStarted(caller, roleSession, subagentCoords?.subagentId);
        await this.deps.sessionOps.handleSend(briefMarkdown, false, roleSession);
        if (roleCancelled()) {
          outcome = "cancelled";
          detail = "Stopped while the role was working.";
        } else if (roleSession.status === "error") {
          outcome = "failed";
          detail = "The role's turn ended in an error — open its session for the message.";
        }
      }
    } catch (error) {
      outcome = "failed";
      detail = (error as Error).message;
    } finally {
      roleSession.agentTextTap = undefined;
      this.deps.sessionOps.closeChildRelays(roleSession);
      this.deps.sessionOps.postRunningChildren();
    }

    const result = parseResult(reply);
    const snapshot = reviewCenterSnapshot(roleSession.reviewBlocks, String(roleSession.userMessageCount));
    const observed = (reuse ? filesForScope(snapshot, "turn") : snapshot).map((file) => file.path);
    const reconciliation = reconcileFiles(result.files, observed);
    const producedNothing = outcome === "cancelled" && !reply.trim();
    if (producedNothing) {
      this.discardAgentRoleSession(roleSession);
    } else {
      try {
        const resultPath = agentRuns.writeResult(runId, step, renderResult(result, reply, reconciliation), artifactKind);
        this.deps.host.appendLine(`[agent] run ${runId} step ${step}: ${resultPath}`);
      } catch (error) {
        this.deps.host.appendLine(`[agent] could not write the result for run ${runId}: ${(error as Error).message}`);
      }
    }

    const roleSessionId = roleSession.activeSessionId;
    const ledgerUsage = roleSessionId
      ? this.deps.sessionOps.persistedUsageLedger(roleSessionId, roleSession.userMessageCount).usage
      : undefined;
    const usage = ledgerUsage && reuse && typeof tokensBefore === "number" && typeof ledgerUsage.totalTokens === "number"
      ? { ...ledgerUsage, totalTokens: Math.max(0, ledgerUsage.totalTokens - tokensBefore) }
      : ledgerUsage;
    const durationMs = Date.now() - startedAt;

    if (subagentHandle) {
      caller.subagentLive = (caller.subagentLive ?? []).filter((h) => h !== subagentHandle);
    } else if (liveHandle) {
      caller.crewLive = (caller.crewLive ?? []).filter((h) => h !== liveHandle);
    } else if (!generatorCoords) {
      caller.agentRun = undefined;
      this.deps.sessionOps.setStatus(caller, outcome === "failed" ? "error" : "done");
      this.deps.uiOps.emit(caller, { type: "setBusy", value: false });
    }
    if (subagentCoords || stageCoords || generatorCoords) {
      return {
        outcome,
        filesReported: result.files,
        filesObserved: observed,
        ...(usage?.costUsdTicks !== undefined ? { costUsdTicks: usage.costUsdTicks } : {}),
        ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
        durationMs,
        ...(roleSessionId ? { sessionId: roleSessionId } : {}),
        ...(detail ? { detail } : {}),
        summary: result.summary,
        planEntries: roleSession.planEntries,
        reconciliation,
        parsed: result,
        rawReply: reply,
      };
    }
    this.deps.uiOps.emit(caller, {
      type: "agentResult",
      id: `${runId}-${step}`,
      runId,
      step,
      role: role.name,
      provider: role.provider,
      providerName: providerDisplayName(role.provider),
      ...(role.model ? { model: role.model } : {}),
      ...(role.effort ? { effort: role.effort } : {}),
      ...(role.mode ? { mode: role.mode } : {}),
      cost: formatRunCost(usage?.costUsdTicks, usage?.totalTokens),
      durationMs,
      outcome,
      summary: result.summary,
      files: result.files,
      open: result.open,
      failed: result.failed,
      ...(reconciliation.unreported.length ? { unreported: reconciliation.unreported } : {}),
      ...(reconciliation.claimedOnly.length ? { claimedOnly: reconciliation.claimedOnly } : {}),
      ...(caution ? { caution } : {}),
      origin: trigger,
      ...(roleSessionId ? { sessionId: roleSessionId } : {}),
      cwd,
      ...(detail ? { detail } : {}),
    });
    if (producedNothing) {
      this.deps.host.appendLine(`[agent] run ${runId} was stopped before it produced anything; discarded.`);
      if (step <= 1) {
        try { agentRuns.discard(runId); } catch { /* nothing to clean up */ }
      }
    } else {
      this.deps.companionOps.logAgentRun({
        at: Date.now(),
        runId,
        step,
        role: role.name,
        provider: role.provider,
        ...(role.model ? { model: role.model } : {}),
        event: outcome === "completed" ? "finished" : outcome === "cancelled" ? "cancelled" : "failed",
        ...(roleSessionId ? { sessionId: roleSessionId } : {}),
        ...(detail ? { detail } : {}),
        durationMs,
        ...(usage?.costUsdTicks !== undefined ? { costUsdTicks: usage.costUsdTicks } : {}),
      });
    }
    this.deps.sessionOps.postSessionsList();
    return {
      outcome,
      filesReported: result.files,
      filesObserved: observed,
      ...(usage?.costUsdTicks !== undefined ? { costUsdTicks: usage.costUsdTicks } : {}),
      ...(usage?.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      durationMs,
      ...(roleSessionId ? { sessionId: roleSessionId } : {}),
      ...(detail ? { detail } : {}),
      summary: result.summary,
      planEntries: [...roleSession.planEntries],
    };
  }

  public nameAgentRoleSession(roleSession: Session, role: AgentRole, runId: string, step: number): void {
    const override = this.deps.getOverride?.<typeof this.nameAgentRoleSession>("nameAgentRoleSession");
    if (override) return override(roleSession, role, runId, step);

    const id = roleSession.activeSessionId;
    if (!id) return;
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    void this.deps.state.update(SESSION_META_KEY, {
      ...overrides,
      [id]: { ...(overrides[id] ?? {}), customName: `${role.name} · ${runId} step ${step}` },
    });
    this.deps.uiOps.deleteSessionCache(id);
    this.deps.uiOps.postSessionName(roleSession);
  }

  public discardAgentRoleSession(roleSession: Session): void {
    const override = this.deps.getOverride?.<typeof this.discardAgentRoleSession>("discardAgentRoleSession");
    if (override) return override(roleSession);

    if (roleSession.hasHistory) return;
    this.deps.sessionOps.teardownEmptySession(roleSession);
  }

  public cancelAgentRun(caller: Session): boolean {
    const override = this.deps.getOverride?.<typeof this.cancelAgentRun>("cancelAgentRun");
    if (override) return override(caller);

    this.deps.sessionOps.cancelSubagentsOf(caller, "the user pressed Stop");
    const run = caller.agentRun;
    if (caller.crewRun && caller.crewRun.status === "running") {
      caller.crewRun = cancelCrewRun(caller.crewRun, "Stopped.");
      this.deps.uiOps.emit(caller, { type: "crewRun", run: caller.crewRun ?? null });
    }
    let stopped = false;
    if (caller.crewLive?.length) {
      for (const live of caller.crewLive) {
        live.cancelled = true;
        void live.roleSession.client?.cancel("user Stop click (/crew)");
      }
      stopped = true;
    }
    if (!run) return stopped || !!caller.crewRun;
    run.cancelled = true;
    void run.roleSession.client?.cancel("user Stop click (/agent)");
    return true;
  }

  public runningRoleName(session: Session): string | undefined {
    const override = this.deps.getOverride?.<typeof this.runningRoleName>("runningRoleName");
    if (override) return override(session);

    return session.agentRun?.roleName ?? session.crewLive?.[0]?.roleName;
  }

  public async startHandoff(
    kind: HandoffKind,
    roleName: string | undefined,
    session: Session,
    confirm: boolean,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.startHandoff>("startHandoff");
    if (override) return override(kind, roleName, session, confirm);

    const label = handoffLabel(kind);
    const cwd = this.deps.sessionOps.sessionCwd(session);
    const set = this.deps.companionOps.agentRoleSet(cwd);
    for (const problem of set.problems) this.agentNotice(session, "warning", problem.message);

    const wanted = roleName || defaultRoleFor(kind);
    const role = findAgentRole(set, wanted);
    if (!role) {
      this.agentNotice(
        session,
        "warning",
        `${label} needs a role \`${wanted}\`, and there is none. Available: `
        + `${set.roles.map((entry) => entry.name).join(", ")}.`,
      );
      return;
    }
    if (session.agentRun) {
      this.agentNotice(
        session,
        "warning",
        `Role \`${session.agentRun.roleName}\` is still running. Stop it first, or wait for its card.`,
      );
      return;
    }

    const derived = deriveBriefing(this.deps.sessionOps.buildThreadContext(session, kind));
    if (derived.kind === "refused") {
      this.agentNotice(session, "info", `${label}: ${derived.reason}`);
      return;
    }

    const resolved = this.resolveRoleProvider(role, session);
    if ("error" in resolved) {
      this.agentNotice(session, "warning", resolved.error);
      return;
    }
    const provider = resolved.provider;
    if (provider === role.provider) {
      const cache = this.deps.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {})[provider];
      const verdict = validateRoleModel(role, cache?.models, providerDisplayName(provider));
      if (!verdict.ok) {
        this.agentNotice(session, "warning", verdict.message);
        return;
      }
    }

    const runsOn = `${providerDisplayName(provider)}${role.model ? ` · ${role.model}` : ""}`;
    if (confirm) {
      const ok = await this.deps.uiOps.confirmInChat(session, {
        title: `${label}: run \`${role.name}\`?`,
        body:
          `${runsOn}, in its own session. The briefing is written from this conversation — `
          + `the goal, the steps reported so far and the files that changed. The conversation `
          + `itself is not sent.`,
        confirmLabel: `Run ${role.name}`,
      });
      if (!ok) return;
      const running = this.runningRoleName(session);
      if (running) {
        this.agentNotice(
          session,
          "warning",
          `Role \`${running}\` started in the meantime. Stop it first, or wait for its card.`,
        );
        return;
      }
    }

    if (confirm) {
      this.deps.uiOps.emit(session, {
        type: "userMessage",
        text: `/${kind} ${role.name}`,
        chips: [],
      });
    }
    await this.runAgentRole(
      { ...role, provider },
      {
        ...derived.briefing,
        forbidden: [...derived.briefing.forbidden, ...roleForbidden({ ...role, provider })],
        returnFormat: RESULT_FORMAT,
      },
      kind,
      session,
    );
  }

  public async continueInFreshSession(session: Session): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.continueInFreshSession>("continueInFreshSession");
    if (override) return override(session);

    const derived = deriveBriefing(this.deps.sessionOps.buildThreadContext(session, "handoff"));
    if (derived.kind === "refused") {
      this.agentNotice(session, "info", derived.reason);
      return;
    }
    const prompt = renderFreshSessionPrompt(derived.briefing);
    const provider = session.provider;
    const model = session.client?.currentModelId;
    const cwd = this.deps.sessionOps.sessionCwd(session);
    this.deps.sessionOps.parkFocused();
    const fresh = this.deps.sessionOps.newLocalSession();
    this.deps.sessionOps.setSessionCwd(fresh, cwd, this.deps.sessionOps.workspaceRoot());
    fresh.provider = provider;
    if (model) fresh.startOverrides = { ...(fresh.startOverrides ?? {}), model };
    this.deps.setFocused(fresh);
    this.deps.getPool().add(fresh);
    this.deps.uiOps.emit(fresh, { type: "clearMessages" });
    await this.deps.sessionOps.startSession();
    this.deps.sessionOps.postSessionsList();
    this.deps.host.appendLine(`[context] continued in a fresh ${provider} session`);
    await this.deps.sessionOps.handleSend(prompt, false, fresh);
  }

  public async handleHandoffCommand(text: string, session: Session): Promise<boolean> {
    const override = this.deps.getOverride?.<typeof this.handleHandoffCommand>("handleHandoffCommand");
    if (override) return override(text, session);

    const parsed = parseHandoffCommand(text);
    if (parsed.kind === "none") return false;
    this.deps.uiOps.emit(session, { type: "userMessage", text, chips: [] });
    if (parsed.kind === "error") {
      this.agentNotice(session, "warning", parsed.message);
      return true;
    }
    await this.startHandoff(parsed.handoff, parsed.role, session, false);
    return true;
  }

  public buildAgentRolesMessage(): Extract<HostMsg, { type: "agentRoles" }> {
    const override = this.deps.getOverride?.<typeof this.buildAgentRolesMessage>("buildAgentRolesMessage");
    if (override) return override();

    const cwd = this.deps.sessionOps.sessionCwd();
    const roleSet = this.deps.companionOps.agentRoleSet(cwd);
    const flowSet = this.deps.companionOps.crewPresetSet(cwd);
    const cache = this.deps.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    const connected = new Set(this.deps.providerOps.connectedProviders());
    return {
      type: "agentRoles",
      roles: roleSet.roles.map((role) => {
        const effective = role.source === "builtin" ? this.effectiveRoleProvider(role) : role.provider;
        return {
          name: role.name,
          provider: effective,
          providerLabel: providerDisplayName(effective),
          providerPinned: role.source !== "builtin",
          ...(role.model ? { model: role.model } : {}),
          mode: role.mode ?? "agent",
          scope: role.source,
          ...(role.overrides ? { overrides: role.overrides } : {}),
          ...(role.path ? { path: role.path } : {}),
          whenToUse: role.whenToUse,
          editable: true,
          draft: { ...roleToDraft(role), provider: effective },
        };
      }),
      flows: flowSet.presets.map((preset) => ({
        name: preset.name,
        roles: [...preset.roles],
        ...(preset.verify ? { verify: preset.verify } : {}),
        ...(preset.reviewEvery ? { reviewEvery: preset.reviewEvery } : {}),
        ...(preset.parallel ? { parallel: true } : {}),
        scope: preset.source,
        ...(preset.overrides ? { overrides: preset.overrides } : {}),
        ...(preset.path ? { path: preset.path } : {}),
        draft: presetToDraft(preset),
      })),
      subagentRoster: (() => {
        const roster = this.deps.providerOps.subagentRoster();
        const usable = new Set(this.deps.providerOps.usableProviders());
        return PROVIDER_ORDER.map((id: AcpProvider) => ({
          id,
          label: providerDisplayName(id),
          status: usable.has(id)
            ? ("usable" as const)
            : connected.has(id)
              ? ("needs-login" as const)
              : ("not-connected" as const),
          enabled: roster[id]?.enabled !== false,
          allowWrite: roster[id]?.allowWrite !== false,
          allowedModels: roster[id]?.allowedModels ?? [],
          defaultModel: roster[id]?.defaultModel ?? "",
          defaultEffort: roster[id]?.defaultEffort ?? "",
          maxEffort: roster[id]?.maxEffort ?? "",
          notes: roster[id]?.notes ?? "",
        }));
      })(),
      subagentsEnabled: this.deps.providerOps.subagentsEnabledGlobally(),
      crewStagesMayUseSubagents: this.deps.providerOps.companionsSetting<boolean>("crew.stagesMayUseSubagents", false),
      companionSettings: this.deps.providerOps.companionSettingsView(),
      subagentRouting: parseRoutingRules(
        this.deps.providerOps.companionsSetting<unknown>("subagents.routing", []),
      ).map((rule: RoutingRule) => ({
        match: [...rule.match],
        provider: rule.target.provider ?? "",
        model: rule.target.model ?? "",
        effort: rule.target.effort ?? "",
      })),
      efforts: [...EFFORT_ORDER],
      providers: PROVIDER_ORDER.map((id: AcpProvider) => ({
        id,
        label: providerDisplayName(id),
        connected: connected.has(id),
        models: (cache[id]?.models ?? []).map((model: { modelId: string; name?: string }) => ({
          modelId: model.modelId,
          ...(model.name ? { name: model.name } : {}),
        })),
      })),
      problems: [
        ...roleSet.problems.map((problem) => problem.message),
        ...flowSet.problems.map((problem) => problem.message),
      ],
      cwd,
      hasProject: !!cwd,
      ...(this.agentRolesError ? { error: this.agentRolesError.message } : {}),
      ...(this.agentRolesError?.id ? { errorId: this.agentRolesError.id } : {}),
      workflows: this.buildWorkflowViews(flowSet, roleSet.roles.map((role) => role.name)),
      defaultWorkflow: this.deps.providerOps.defaultWorkflowName(),
    };
  }

  public effectiveRoleProvider(role: AgentRole): AcpProvider {
    const override = this.deps.getOverride?.<typeof this.effectiveRoleProvider>("effectiveRoleProvider");
    if (override) return override(role);

    const usable = this.deps.providerOps.usableProviders();
    if (!usable.length) return role.provider;
    const caller = this.deps.getFocused()?.provider;
    if (role.preferDifferentProvider) {
      const elsewhere = usable.find((candidate) => candidate !== caller);
      if (elsewhere) return elsewhere;
    }
    if (caller && usable.includes(caller)) return caller;
    return usable[0]!;
  }

  public postAgentRoles(): void {
    const override = this.deps.getOverride?.<typeof this.postAgentRoles>("postAgentRoles");
    if (override) return override();

    const message = this.buildAgentRolesMessage();
    this.deps.uiOps.postLocal(message);
    this.deps.uiOps.postToSettingsEditor(message);
  }

  public companionsWriteDir(scope: RoleScope, kind: "agents" | "crews"): string | undefined {
    const override = this.deps.getOverride?.<typeof this.companionsWriteDir>("companionsWriteDir");
    if (override) return override(scope, kind);

    const root = this.deps.companionOps.companionsRoot(scope, this.deps.sessionOps.sessionCwd());
    return root ? path.join(root, kind) : undefined;
  }

  public refuseAgentRoles(id: string | undefined, message: string): void {
    const override = this.deps.getOverride?.<typeof this.refuseAgentRoles>("refuseAgentRoles");
    if (override) return override(id, message);

    this.agentRolesError = { ...(id ? { id } : {}), message };
    this.postAgentRoles();
  }

  public agentRoleNamesInScope(scope: RoleScope, kind: "agents" | "crews"): string[] {
    const override = this.deps.getOverride?.<typeof this.agentRoleNamesInScope>("agentRoleNamesInScope");
    if (override) return override(scope, kind);

    const root = this.deps.companionOps.companionsRoot(scope, this.deps.sessionOps.sessionCwd());
    if (!root) return [];
    try {
      return fs
        .readdirSync(path.join(root, kind))
        .filter((name) => name.toLowerCase().endsWith(".md"))
        .map((name) => name.replace(/\.md$/i, "").toLowerCase());
    } catch {
      return [];
    }
  }

  public dropSupersededCompanionFile(opts: {
    kind: "agents" | "crews";
    savedName: string;
    savedScope: RoleScope;
    originalName?: string;
    originalScope?: RoleScope;
  }): void {
    const override = this.deps.getOverride?.<typeof this.dropSupersededCompanionFile>("dropSupersededCompanionFile");
    if (override) return override(opts);

    const previousName = (opts.originalName ?? "").trim().toLowerCase();
    if (!previousName || !isValidRoleName(previousName)) return;
    const previousScope = opts.originalScope ?? opts.savedScope;
    if (previousName === opts.savedName && previousScope === opts.savedScope) return;
    const root = this.deps.companionOps.companionsRoot(previousScope, this.deps.sessionOps.sessionCwd());
    if (!root) return;
    try {
      fs.rmSync(path.join(root, opts.kind, `${previousName}.md`), { force: true });
    } catch {
      /* the file is already gone, which is the end state this wanted */
    }
  }

  public async handleSaveAgentRole(
    msg: { scope: RoleScope; originalName?: string; originalScope?: RoleScope; draft: AgentRoleDraft },
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.handleSaveAgentRole>("handleSaveAgentRole");
    if (override) return override(msg);

    const id = agentCardErrorId("role", msg.originalName);
    const dir = this.companionsWriteDir(msg.scope, "agents");
    if (!dir) {
      this.refuseAgentRoles(id, "Open a project folder first — a project role needs somewhere to live.");
      return;
    }
    const cache = this.deps.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    const result = validateAgentRoleDraft(msg.draft ?? ({} as AgentRoleDraft), {
      providers: PROVIDER_ORDER,
      knownModels: Object.fromEntries(PROVIDER_ORDER.map((id2: AcpProvider) => [id2, cache[id2]?.models ?? []])),
      providerLabel: (provider: string) => providerDisplayName(provider as AcpProvider),
      existingNames: this.agentRoleNamesInScope(msg.scope, "agents"),
      ...(msg.originalName ? { originalName: msg.originalName } : {}),
    });
    if (!result.ok) {
      this.refuseAgentRoles(id, result.error);
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${result.value.name}.md`), result.text, "utf8");
      this.dropSupersededCompanionFile({
        kind: "agents",
        savedName: result.value.name,
        savedScope: msg.scope,
        ...(msg.originalName ? { originalName: msg.originalName } : {}),
        ...(msg.originalScope ? { originalScope: msg.originalScope } : {}),
      });
    } catch (error) {
      this.refuseAgentRoles(id, `Could not write the role file — ${(error as Error).message}`);
      return;
    }
    this.agentRolesError = undefined;
    this.postAgentRoles();
  }

  public async handleSaveCrewFlow(
    msg: { scope: RoleScope; originalName?: string; originalScope?: RoleScope; draft: CrewFlowDraft },
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.handleSaveCrewFlow>("handleSaveCrewFlow");
    if (override) return override(msg);

    const id = agentCardErrorId("flow", msg.originalName);
    const dir = this.companionsWriteDir(msg.scope, "crews");
    if (!dir) {
      this.refuseAgentRoles(id, "Open a project folder first — a project crew flow needs somewhere to live.");
      return;
    }
    const result = validateCrewFlowDraft(msg.draft ?? ({} as CrewFlowDraft), {
      roleNames: this.deps.companionOps.agentRoleSet(this.deps.sessionOps.sessionCwd()).roles.map((role) => role.name),
      existingNames: this.agentRoleNamesInScope(msg.scope, "crews"),
      ...(msg.originalName ? { originalName: msg.originalName } : {}),
    });
    if (!result.ok) {
      this.refuseAgentRoles(id, result.error);
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${result.value.name}.md`), result.text, "utf8");
      this.dropSupersededCompanionFile({
        kind: "crews",
        savedName: result.value.name,
        savedScope: msg.scope,
        ...(msg.originalName ? { originalName: msg.originalName } : {}),
        ...(msg.originalScope ? { originalScope: msg.originalScope } : {}),
      });
    } catch (error) {
      this.refuseAgentRoles(id, `Could not write the crew flow file — ${(error as Error).message}`);
      return;
    }
    this.agentRolesError = undefined;
    this.postAgentRoles();
  }

  public workflowValidateContext(over: Partial<ValidateWorkflowContext> = {}): ValidateWorkflowContext {
    const override = this.deps.getOverride?.<typeof this.workflowValidateContext>("workflowValidateContext");
    if (override) return override(over);

    const cwd = this.deps.sessionOps.sessionCwd();
    const cache = this.deps.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    return {
      roleNames: this.deps.companionOps.agentRoleSet(cwd).roles.map((role) => role.name),
      knownModels: Object.fromEntries(PROVIDER_ORDER.map((id: AcpProvider) => [
        id,
        {
          checked: Array.isArray(cache[id]?.models),
          ids: (cache[id]?.models ?? []).map((model: { modelId: string; name?: string }) => model.modelId),
        },
      ])),
      ...over,
    };
  }

  public buildWorkflowViews(
    flowSet: CrewPresetSet,
    roleNames: string[],
  ): import("./protocol").WorkflowManagerView[] {
    const override = this.deps.getOverride?.<typeof this.buildWorkflowViews>("buildWorkflowViews");
    if (override) return override(flowSet, roleNames);

    const defaultName = this.deps.providerOps.defaultWorkflowName();
    const context = this.workflowValidateContext({ roleNames });
    return flowSet.presets.map((preset) => {
      const graph = presetToStageGraph(preset);
      const validation = validateWorkflowDefinition(graph, context);
      const hasStages = preset.stages !== undefined || preset.name === "idea-to-done";
      return {
        name: preset.name,
        title: preset.title || graph.title || preset.name,
        whenToUse: preset.whenToUse || graph.whenToUse || "",
        scope: preset.source,
        ...(preset.overrides ? { overrides: preset.overrides } : {}),
        ...(preset.path ? { path: preset.path } : {}),
        hasStages,
        defaultGraph: !hasStages,
        isDefault: preset.name === defaultName,
        mermaid: workflowToMermaid(graph),
        stages: graph.stages.map((stage) => ({
          id: stage.id,
          title: stage.title,
          role: stage.role,
          profile: stage.profile,
        })),
        draft: {
          ...workflowToDraft(graph),
          body: preset.body,
          verify: preset.verify ?? graph.defaults.verify,
        },
        validation,
        ...(graph.compiler ? { compiler: graph.compiler } : {}),
      };
    });
  }

  public async handleSaveWorkflow(msg: {
    scope: RoleScope;
    originalName?: string;
    originalScope?: RoleScope;
    draft: WorkflowDraft;
    setDefault?: boolean;
  }): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.handleSaveWorkflow>("handleSaveWorkflow");
    if (override) return override(msg);

    const id = agentCardErrorId("workflow", msg.originalName);
    const dir = this.companionsWriteDir(msg.scope, "crews");
    if (!dir) {
      this.refuseAgentRoles(id, "Open a project folder first — a project workflow needs somewhere to live.");
      return;
    }
    const result = validateWorkflowDraft(msg.draft ?? ({} as WorkflowDraft), this.workflowValidateContext({
      existingNames: this.agentRoleNamesInScope(msg.scope, "crews"),
      ...(msg.originalName ? { originalName: msg.originalName } : {}),
    }));
    if (!result.ok) {
      this.refuseAgentRoles(id, result.error);
      return;
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${result.workflow.name}.md`), result.text, "utf8");
      this.dropSupersededCompanionFile({
        kind: "crews",
        savedName: result.workflow.name,
        savedScope: msg.scope,
        ...(msg.originalName ? { originalName: msg.originalName } : {}),
        ...(msg.originalScope ? { originalScope: msg.originalScope } : {}),
      });
    } catch (error) {
      this.refuseAgentRoles(id, `Could not write the workflow file — ${(error as Error).message}`);
      return;
    }
    if (msg.setDefault) {
      await this.deps.host.getConfiguration("companions").update("crew.defaultWorkflow", result.workflow.name, "global");
    }
    this.agentRolesError = undefined;
    this.postAgentRoles();
  }

  public postWorkflowValidation(draft: WorkflowDraft): void {
    const override = this.deps.getOverride?.<typeof this.postWorkflowValidation>("postWorkflowValidation");
    if (override) return override(draft);

    const result = validateWorkflowDraft(draft ?? ({} as WorkflowDraft), this.workflowValidateContext());
    this.postWorkflowGenerator({
      status: result.ok ? "preview" : "error",
      requestId: "validate",
      draft,
      ...(result.ok ? { mermaid: workflowToMermaid(result.workflow), validation: result.validation } : {}),
      ...(!result.ok ? {
        error: result.error,
        ...(result.validation ? { validation: result.validation } : {}),
      } : {}),
    });
  }

  public async handleAddWorkflowStagesBlock(scope: RoleScope, name: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.handleAddWorkflowStagesBlock>("handleAddWorkflowStagesBlock");
    if (override) return override(scope, name);

    const preset = this.deps.companionOps.crewPresetSet(this.deps.sessionOps.sessionCwd()).presets.find((p) => p.name === name);
    if (!preset) {
      this.refuseAgentRoles(agentCardErrorId("workflow", name), "That workflow is not loaded.");
      return;
    }
    if (preset.stages !== undefined) {
      this.refuseAgentRoles(agentCardErrorId("workflow", name), "This workflow already has a stages block.");
      return;
    }
    const graph = presetToStageGraph(preset);
    await this.handleSaveWorkflow({
      scope,
      originalName: name,
      originalScope: preset.source === "builtin" ? undefined : preset.source,
      draft: { ...workflowToDraft(graph), body: preset.body, verify: preset.verify },
    });
  }

  public async handleGenerateWorkflow(msg: {
    description: string;
    scope: RoleScope;
    reuseRoles?: boolean;
    newRoles?: "inline" | "files";
    allowWrite?: boolean;
    maxStages?: number;
    provider?: AcpProvider;
    model?: string;
    effort?: string;
    refine?: string;
  }): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.handleGenerateWorkflow>("handleGenerateWorkflow");
    if (override) return override(msg);

    const description = [msg.description, msg.refine].filter((s) => String(s ?? "").trim()).join("\n\nFeedback: ");
    if (!description.trim()) {
      this.postWorkflowGenerator({
        status: "error",
        requestId: "generate",
        error: "Describe how you want this workflow to run.",
      });
      return;
    }
    const previous = this.generatorStore();
    if (previous.roleSession) {
      previous.cancelled = true;
      void previous.roleSession.client?.cancel("a new generation started");
    }
    const requestId = `wg_${this.deps.getAgentRuns().newRunId()}`;
    const store = this.generatorStore();
    store.requestId = requestId;
    store.cancelled = false;
    store.submitted = undefined;
    store.scope = msg.scope;
    store.state = makeGeneratorState(description, {
      reuseRoles: msg.reuseRoles !== false,
      newRoles: msg.newRoles === "files" ? "files" : "inline",
      allowWrite: msg.allowWrite !== false,
      maxStages: msg.maxStages,
    });
    const caller = this.deps.getFocused() ?? [...this.deps.getPool()][0];
    if (!caller) {
      this.postWorkflowGenerator({ status: "error", requestId, error: "Open a project first." });
      return;
    }
    store.caller = caller;
    const usable = this.deps.providerOps.usableProviders();
    const storedTarget = this.deps.providerOps.companionsSetting<{ provider?: string; model?: string; effort?: string }>(
      "workflows.generator.target",
      {},
    );
    const requestedProvider = msg.provider || (storedTarget?.provider as AcpProvider | undefined);
    const provider = (requestedProvider && usable.includes(requestedProvider) ? requestedProvider : usable[0])
      ?? caller.provider;
    if (!msg.model && storedTarget?.model) msg.model = storedTarget.model;
    if (!msg.effort && storedTarget?.effort) msg.effort = storedTarget.effort;
    store.compiler = {
      provider,
      ...(msg.model ? { model: msg.model } : {}),
      sourcePrompt: msg.description.trim(),
      generatedAt: new Date().toISOString(),
    };
    this.postWorkflowGenerator({ status: "running", requestId, progress: "Starting the generator…" });
    const role: AgentRole = {
      name: "workflow-generator",
      provider,
      ...(msg.model ? { model: msg.model } : {}),
      ...(msg.effort ? { effort: msg.effort } : {}),
      mode: "agent",
      whenToUse: "Design a workflow from a description.",
      source: "builtin",
      permissions: [{ action: "deny", kind: "edit", pathGlob: "**" }],
    };
    const brief = {
      task: generatorMetaPrompt({ description, options: store.state.options }),
      goal: description,
    };
    try {
      const outcome = await this.runAgentRole(role, brief, "workflow-stage", caller, {
        runId: requestId,
        step: 1,
        generator: { requestId },
      });
      if (store.cancelled || store.requestId !== requestId) return;
      const accepted = store.submitted
        ?? (outcome.rawReply ? acceptSubmission(
          extractCompanionsWorkflow(outcome.rawReply) ?? {},
          this.workflowValidateContext({
            generated: true,
            allowWrite: store.state.options.allowWrite,
            maxStages: store.state.options.maxStages,
          }),
          store.compiler,
        ) : undefined);
      if (accepted && accepted.ok) {
        this.postWorkflowGenerator({
          status: "preview",
          requestId,
          draft: workflowToDraft(accepted.workflow),
          mermaid: workflowToMermaid(accepted.workflow),
          validation: accepted.validation,
          compiler: store.compiler,
        });
        return;
      }
      this.postWorkflowGenerator({
        status: "error",
        requestId,
        error: accepted && !accepted.ok
          ? accepted.error
          : "The generator finished without a valid workflow. Try again, refine, or open the JSON editor.",
        ...(accepted && !accepted.ok && accepted.validation ? { validation: accepted.validation } : {}),
        ...(store.state.lastDraft ? { draft: draftFromUnknown(store.state.lastDraft) } : {}),
      });
    } catch (error) {
      if (store.cancelled || store.requestId !== requestId) return;
      this.postWorkflowGenerator({
        status: "error",
        requestId,
        error: (error as Error).message,
      });
    }
  }

  public cancelWorkflowGenerate(): void {
    const override = this.deps.getOverride?.<typeof this.cancelWorkflowGenerate>("cancelWorkflowGenerate");
    if (override) return override();

    const store = this.generatorStore();
    store.cancelled = true;
    void store.roleSession?.client?.cancel("the user cancelled generation");
    this.postWorkflowGenerator({ status: "idle", requestId: store.requestId || "generate" });
  }

  public handleDeleteCompanionFile(scope: RoleScope, kind: "agents" | "crews", rawName: string): void {
    const override = this.deps.getOverride?.<typeof this.handleDeleteCompanionFile>("handleDeleteCompanionFile");
    if (override) return override(scope, kind, rawName);

    const name = String(rawName ?? "").trim().toLowerCase();
    if (!isValidRoleName(name)) {
      this.refuseAgentRoles(undefined, "That is not a name this can delete.");
      return;
    }
    const root = this.deps.companionOps.companionsRoot(scope, this.deps.sessionOps.sessionCwd());
    if (!root) {
      this.refuseAgentRoles(undefined, "There is no project open, so there is no project file to remove.");
      return;
    }
    try {
      fs.rmSync(path.join(root, kind, `${name}.md`), { force: true });
    } catch (error) {
      this.refuseAgentRoles(undefined, `Could not remove ${name}.md — ${(error as Error).message}`);
      return;
    }
    this.agentRolesError = undefined;
    this.postAgentRoles();
  }

  public generatorStore(): NonNullable<AgentAuthoring["generatorState"]> {
    const override = this.deps.getOverride?.<typeof this.generatorStore>("generatorStore");
    if (override) return override();

    if (!this.generatorState) {
      this.generatorState = {
        requestId: "",
        cancelled: false,
        state: makeGeneratorState(""),
        scope: "project",
        lastProgressAt: 0,
      };
    }
    return this.generatorState;
  }

  public postWorkflowGenerator(view: WorkflowGeneratorView): void {
    const override = this.deps.getOverride?.<typeof this.postWorkflowGenerator>("postWorkflowGenerator");
    if (override) return override(view);

    const message = { type: "workflowGenerator" as const, ...view };
    this.deps.uiOps.postLocal(message);
    this.deps.uiOps.postToSettingsEditor(message);
  }

  public handleGeneratorTool(session: Session, call: CompanionsCall): void {
    const override = this.deps.getOverride?.<typeof this.handleGeneratorTool>("handleGeneratorTool");
    if (override) return override(session, call);

    const hidden = session.pendingHiddenChild?.hiddenReason
      ?? this.deps.sessionOps.sessionTypeMetaFor(session)?.hiddenReason;
    if (hidden !== "workflow-generator") {
      call.fail("This tool is only available while generating a workflow.");
      return;
    }
    const store = this.generatorStore();
    const ctx = this.workflowValidateContext({
      generated: true,
      allowWrite: store.state.options.allowWrite,
      maxStages: store.state.options.maxStages,
    });
    switch (call.tool) {
      case COMPANIONS_WORKFLOW_SCHEMA_TOOL:
        call.resolve({ guide: WORKFLOW_AUTHORING_GUIDE });
        return;
      case COMPANIONS_LIST_ROLES_TOOL:
        call.resolve({
          roles: this.deps.companionOps.agentRoleSet(this.deps.sessionOps.sessionCwd()).roles.map((role) => ({
            name: role.name,
            whenToUse: role.whenToUse,
            provider: role.source === "builtin" ? undefined : role.provider,
            ...(role.model ? { model: role.model } : {}),
            source: role.source,
          })),
        });
        return;
      case COMPANIONS_LIST_TOOL:
        call.resolve(this.deps.sessionOps.companionsList(session, normalizeListArguments(call.args)));
        return;
      case COMPANIONS_LIST_WORKFLOWS_TOOL:
        call.resolve({
          workflows: this.deps.companionOps.crewPresetSet(this.deps.sessionOps.sessionCwd()).presets.map((preset) => ({
            name: preset.name,
            title: preset.title || preset.name,
            whenToUse: preset.whenToUse || "",
            source: preset.source,
          })),
        });
        return;
      case COMPANIONS_VALIDATE_WORKFLOW_TOOL: {
        const raw = workflowArg(call.args);
        const validation = validateWorkflowRaw(raw, ctx);
        store.state = recordValidation(store.state, raw, validation);
        call.resolve(validation);
        return;
      }
      case COMPANIONS_SUBMIT_WORKFLOW_TOOL: {
        const raw = workflowArg(call.args);
        const accepted = acceptSubmission(raw, ctx, store.compiler);
        store.submitted = accepted;
        if (accepted.ok) {
          call.resolve({ ok: true, name: accepted.workflow.name, warnings: accepted.validation.warnings });
        } else {
          call.resolve({
            ok: false,
            error: accepted.error,
            ...(accepted.validation
              ? { errors: accepted.validation.errors, warnings: accepted.validation.warnings }
              : {}),
          });
        }
        return;
      }
      default:
        call.fail(`Unknown tool: ${call.tool}`);
    }
  }
}

export function createAgentAuthoring(deps: AgentAuthoringDeps): AgentAuthoring {
  return new AgentAuthoring(deps);
}
