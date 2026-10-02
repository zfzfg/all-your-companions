/**
 * WorkflowStageRunner: GrokSidebar collaborator for crew-session workflow runs,
 * stage execution, gates, and /crew command handling (W-15 Schritt D4).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AcpProvider } from "./acp-backend";
import {
  type AgentRole,
  type AgentRoleSet,
  findAgentRole,
} from "./agent-roles";
import { type AgentRunStore, type AgentRunTrigger } from "./agent-run";
import {
  type BriefingInput,
  makeBriefing,
  renderBriefing,
} from "./briefing";
import { CheckpointStore } from "./checkpoint-store";
import { mergeCheckpoints, planRestoreDetailed, restoreActions } from "./checkpoints";
import { stageChildStatus } from "./child-status";
import { NUDGE_TEXT, stallWarningText } from "./child-watch";
import { subagentPermissionOverlay } from "./companion-subagents";
import {
  assignStepRole,
  applyStepOutcome,
  cancelCrewRun,
  crewProgress,
  insertCrewStep,
  makeCrewRun,
  setCrewStatus,
  startCrewStep,
  stepsFromPlan,
  type CrewStep,
} from "./crew";
import { assignStep } from "./crew-assign";
import { briefingForCrewStep, fixerTitle, verifyInsertsFixer } from "./crew-run";
import { crewApplyFiles, type CrewApplyOutcome, IntegrationQueue, normalizeCrewApplyOutcome } from "./crew-apply";
import { checkBudget, countUnreapable, HostSlotLedger, parallelSlotCap, repeatedFailingTool } from "./crew-budget";
import { diagnosisLine } from "./crew-diagnosis";
import { decideFailover } from "./crew-failover";
import { nextIndependentSteps, unmetDependencies } from "./crew-parallel";
import {
  findCrewPreset,
  presetRoles,
  presetToStageGraph,
  type CrewPresetSet,
} from "./crew-preset";
import { FileClaimStore } from "./file-claims";
import { runGit } from "./git-run";
import { type Host, type HostContext } from "./host";
import { classifyLimitError } from "./limit-errors";
import { providerDisplayName } from "./provider-ui";
import { type ProviderSetup } from "./provider-setup";
import type {
  CrewStartOptions,
  HostMsg,
  WebviewMsg,
  WorkflowLineupView,
  WorkflowPickerItem,
  WorkflowRunView,
} from "./protocol";
import { type PersistedState } from "./persisted-state";
import { Session } from "./session";
import { defaultFs, resolveGrokHome } from "./sessions";
import { parseCrewCommand } from "./slash-filter";
import { isEffortLevel, listEligibleTargets, resolveTarget, type EligibilityInput } from "./target-eligibility";
import {
  applyMaxFixerPasses,
  findStage,
  IDEA_TO_DONE,
  isReservedTarget,
  isWriteProfile,
  stageContinues,
  stageRunMode,
  type WorkflowDefinition,
  type WorkflowStage,
  workflowSnapshotHash,
} from "./workflow";
import {
  briefingFromContract,
  buildHandoffPacket,
  capHandoffPacket,
  resolveStageScope,
  type HandoffPacket,
  type HandoffPlanStep,
  type HandoffStatus,
  type StageScope,
} from "./workflow-handoff";
import { createForkGroup, joinDecision, markBranch, noteJoined, type ForkGroup } from "./workflow-fork";
import {
  formatDurationShort,
  formatTokenCount,
  renderRunReport,
  runTableRows,
  runTotalsLine,
  targetText,
} from "./workflow-report";
import {
  anotherRoundLabel,
  appendGateNotes,
  applyGateAction,
  applySnapshotDrift,
  applyStaleness,
  applyStageOutcome,
  autonomyFromSettings,
  bindStageSession,
  makeWorkflowRun,
  markExhausted,
  observedFilesHash,
  parseGateMessage,
  resumeStaleness,
  sanitizePlanEdit,
  snapshotDrift,
  startStage as startWorkflowStage,
  toWorkflowView,
  type Autonomy,
  type GateAction,
  type RunLineupEntry,
  type WorkflowRun,
  WorkflowRunStore,
} from "./workflow-run";
import {
  compareLabel,
  preselectGateTarget,
  proposeLineup,
  suggestVerifyCommands,
  type RoleTemplateInfo,
} from "./workflow-target";
import { mergeReviewPackets, panelTargets } from "./workflow-panel";
import { gitRootForPath } from "./worktree";
import { type WorktreeHost } from "./worktree-host";

export interface WorkflowStageUiOps {
emit(session: Session, msg: HostMsg): void;
agentNotice(session: Session, level: "info" | "warning" | "error", text: string): void;
confirmInChat(session: Session, opts: { title: string; body?: string; confirmLabel: string; danger?: boolean }): Promise<boolean>;
showQuestion(session: Session, question: any, handlers: any): void;
}
export interface WorkflowStageRunnerDeps {
  readonly host: Host;
  readonly context: HostContext;
  readonly state: PersistedState;
  readonly agentRuns: AgentRunStore;
  readonly checkpointStore?: CheckpointStore;
  readonly worktreeHost: WorktreeHost;
  readonly providerSetup: ProviderSetup;
  readonly pool: Set<Session>;
  readonly focused: Session;
  sessionCwd(session?: Session): string;
  newFocusedSession(): Promise<Session>;
  setStatus(session: Session, status: Session["status"]): void;
  runAgentRole(role: AgentRole, brief: BriefingInput, trigger: AgentRunTrigger, caller: Session, coords?: any): Promise<any>;
  resolveRoleProvider(role: AgentRole, session: Session): { provider: AcpProvider } | { error: string };
  agentRoleSet(cwd: string): AgentRoleSet;
  crewPresetSet(cwd: string): CrewPresetSet;
  crewEligibilityInput(session: Session): EligibilityInput;
  steerSend(text: string, session: Session): Promise<void>;
  emitReviewCenter(session: Session): void;
  persistSessionType(session: Session): void;
  childWaitsForYou(child: Session | undefined): boolean;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;

  readonly ui: WorkflowStageUiOps;
}

export class WorkflowStageRunner {
  workflowState?: {
    store: WorkflowRunStore;
    packets: Map<string, HandoffPacket>;
    defs: Map<string, WorkflowDefinition>;
  };
  readonly stageStepProgress = new Map<string, string>();
  fileClaims?: FileClaimStore;
  crewVerifyRunner?: (command: string, cwd: string) => Promise<{ code: number; output: string }>;
  crewWorktreeCreate?: (sourcePath: string, label: string) => Promise<{ path: string; label: string; sourceGitRoot: string } | { error: string }>;
  crewWorktreeApply?: (wt: { path: string; label: string; sourceGitRoot: string }) => Promise<void>;

  private static readonly LINEUP_KEY = "companions.crew.lineups";
  private static readonly MAX_LIVE_SESSIONS = 5;
  private readonly slotLedger = new HostSlotLedger(() => parallelSlotCap({
    maxLive: WorkflowStageRunner.MAX_LIVE_SESSIONS,
    unreapable: this.crewUnreapableCount(),
  }));
  private readonly integrationQueue = new IntegrationQueue();
  private readonly inflightGeneration = new Map<string, number>();
  private diagnosisSeq = 0;

  constructor(private readonly deps: WorkflowStageRunnerDeps) {}

  private get host(): Host { return this.deps.host; }
  private get context(): HostContext { return this.deps.context; }
  private get state(): PersistedState { return this.deps.state; }
  private get agentRuns(): AgentRunStore { return this.deps.agentRuns; }
  private get checkpointStore(): CheckpointStore | undefined { return this.deps.checkpointStore; }
  private get worktreeHost(): WorktreeHost { return this.deps.worktreeHost; }
  private get providerSetup(): ProviderSetup { return this.deps.providerSetup; }
  private get pool(): Set<Session> { return this.deps.pool; }
  private get focused(): Session { return this.deps.focused; }

  private sessionCwd(session?: Session): string { return this.deps.sessionCwd(session); }
  private emit(session: Session, msg: HostMsg): void { this.deps.ui.emit(session, msg); }
  private agentNotice(session: Session, level: "info" | "warning" | "error", text: string): void { this.deps.ui.agentNotice(session, level, text); }
  private confirmInChat(session: Session, opts: { title: string; body?: string; confirmLabel: string; danger?: boolean }): Promise<boolean> {
    return this.deps.ui.confirmInChat(session, opts);
  }
  private showQuestion(session: Session, question: any, handlers: any): void { this.deps.ui.showQuestion(session, question, handlers); }
  private newFocusedSession(): Promise<Session> { return this.deps.newFocusedSession(); }
  private setStatus(session: Session, status: Session["status"]): void { this.deps.setStatus(session, status); }
  private runAgentRole(role: AgentRole, brief: BriefingInput, trigger: AgentRunTrigger, caller: Session, coords?: any): Promise<any> {
    return this.deps.runAgentRole(role, brief, trigger, caller, coords);
  }
  private resolveRoleProvider(role: AgentRole, session: Session): { provider: AcpProvider } | { error: string } {
    return this.deps.resolveRoleProvider(role, session);
  }
  private agentRoleSet(cwd: string): AgentRoleSet { return this.deps.agentRoleSet(cwd); }
  crewPresetSet(cwd: string): CrewPresetSet {
    const override = this.deps.getOverride?.<typeof this.crewPresetSet>("crewPresetSet");
    if (override) return override(cwd);
    return this.deps.crewPresetSet(cwd);
  }
  crewEligibilityInput(session: Session): EligibilityInput { return this.deps.crewEligibilityInput(session); }
  private steerSend(text: string, session: Session): Promise<void> { return this.deps.steerSend(text, session); }
  private emitReviewCenter(session: Session): void { this.deps.emitReviewCenter(session); }
  private persistSessionType(session: Session): void { this.deps.persistSessionType(session); }
  private childWaitsForYou(child: Session | undefined): boolean { return this.deps.childWaitsForYou(child); }

  usableProviders(): AcpProvider[] {
    const override = this.deps.getOverride?.<() => AcpProvider[]>("usableProviders");
    if (override) return override();
    return this.deps.providerSetup.usableProviders();
  }

  private companionsSetting<T>(key: string, fallback: T): T {
    try {
      return this.host.getConfiguration("companions").get<T>(key, fallback) ?? fallback;
    } catch {
      return fallback;
    }
  }

  workflowStore(): NonNullable<WorkflowStageRunner["workflowState"]> {
    if (!this.workflowState) {
      this.workflowState = {
        store: new WorkflowRunStore({
          root: path.join(this.context.globalStorageUri.fsPath, "runs"),
          fs: {
            mkdirSync: (dir, options) => { fs.mkdirSync(dir, options); },
            writeFileSync: (file, data) => fs.writeFileSync(file, data, "utf8"),
            readFileSync: (file, encoding) => fs.readFileSync(file, encoding),
            renameSync: (from, to) => fs.renameSync(from, to),
            existsSync: (target) => fs.existsSync(target),
          },
          join: (...parts) => path.join(...parts),
        }),
        packets: new Map(),
        defs: new Map(),
      };
    }
    return this.workflowState;
  }

  workflowRuns(): WorkflowRunStore { return this.workflowStore().store; }

  inThreadCrewCommand(): boolean {
    try {
      return this.host.getConfiguration("companions").get<boolean>("crew.inThreadCommand", false) === true;
    } catch {
      return false;
    }
  }

  defaultWorkflowName(): string {
    try {
      const name = this.host.getConfiguration("companions").get<string>("crew.defaultWorkflow", "idea-to-done");
      return (name ?? "idea-to-done").trim() || "idea-to-done";
    } catch {
      return "idea-to-done";
    }
  }

  autoStartNextStage(): boolean {
    try {
      return this.host.getConfiguration("companions").get<boolean>("crew.autoStartNextStage", false) === true;
    } catch {
      return false;
    }
  }

  maxFixerPasses(): number {
    try {
      const n = this.host.getConfiguration("companions").get<number>("crew.maxFixerPasses", 2);
      return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 2;
    } catch {
      return 2;
    }
  }

  resolveWorkflow(session: Session, name?: string): WorkflowDefinition {
    const cwd = this.sessionCwd(session);
    const presets = this.crewPresetSet(cwd);
    const wanted = (name ?? this.defaultWorkflowName()).trim() || this.defaultWorkflowName();
    const preset = findCrewPreset(presets, wanted);
    if (preset.name === "idea-to-done" && !preset.stages && wanted === "idea-to-done") {
      return applyMaxFixerPasses(IDEA_TO_DONE, this.maxFixerPasses());
    }
    const named = presets.presets.find((p) => p.name === wanted) ?? preset;
    return applyMaxFixerPasses(presetToStageGraph(named), this.maxFixerPasses());
  }

  postWorkflowList(session: Session, preferred?: string): void {
    try {
      let cwd = session.cwd || "";
      try {
        if (!cwd) cwd = this.sessionCwd(session);
      } catch {
        cwd = "";
      }
      const presets = this.crewPresetSet(cwd);
      const defaultName = preferred || this.defaultWorkflowName();
      const workflows = presets.presets.map((preset) => {
        let extra: Partial<WorkflowPickerItem> = {};
        try {
          const def = this.resolveWorkflow(session, preset.name);
          const capped = def.stages.find((s) => s.maxVisits);
          extra = {
            stages: def.stages.filter((s) => s.enabled).map((s) => s.title),
            lineup: this.lineupForRun(session, undefined, def),
            ...(findStage(def, "implement") && def.stages.some((s) => s.role === "fixer") ? { hasFix: true } : {}),
            ...(capped?.maxVisits ? { maxFixRounds: capped.maxVisits } : {}),
          };
        } catch { /* a broken workflow still lists; the start path reports it */ }
        return {
          name: preset.name,
          title: preset.title || preset.name,
          whenToUse: preset.whenToUse || "",
          source: preset.source,
          ...(preset.stages === undefined && preset.name !== "idea-to-done" ? { defaultGraph: true } : {}),
          ...extra,
        };
      });
      this.emit(session, {
        type: "workflowList",
        workflows,
        defaultWorkflow: defaultName,
        verifySuggestions: this.verifySuggestions(cwd),
        defaultAutonomy: this.workflowAutonomy({ } as WorkflowRun),
      });
    } catch (error) {
      this.emit(session, {
        type: "workflowList",
        workflows: [{
          name: IDEA_TO_DONE.name,
          title: IDEA_TO_DONE.title,
          whenToUse: IDEA_TO_DONE.whenToUse,
          source: "builtin",
        }],
        defaultWorkflow: "idea-to-done",
      });
      this.host.appendLine?.(`[workflow] could not list workflows: ${(error as Error).message}`);
    }
  }

  emitWorkflowRun(session: Session, extra?: { staleDetails?: string[]; missing?: string[] }): void {
    const run = session.workflowRun;
    if (!run) {
      session.workflowView = undefined;
      this.emit(session, { type: "workflowRun", run: null });
      return;
    }
    const def = this.workflowStore().defs.get(run.runId) ?? this.resolveWorkflow(session, run.workflowName);
    this.workflowStore().defs.set(run.runId, def);
    const packets = this.packetsFor(run.runId);
    const last = [...packets].sort((a, b) => b.stageOrdinal - a.stageOrdinal)[0];
    const listing = listEligibleTargets(this.crewEligibilityInput(session), { includeIneligible: true, expand: "all" });
    const view = toWorkflowView({
      run,
      def,
      lastPacket: last,
      listing: {
        targets: listing.targets.map((t) => ({
          provider: t.provider,
          displayName: t.displayName,
          ...(t.defaultModel ? { defaultModel: t.defaultModel } : {}),
          ...(t.defaultEffort ? { defaultEffort: t.defaultEffort } : {}),
          ...(t.models ? { models: t.models } : {}),
        })),
        ineligible: listing.ineligible.map((row) => ({ provider: row.provider, message: row.message })),
      },
      ...(extra?.staleDetails ? { staleDetails: extra.staleDetails } : {}),
      ...(extra?.missing ? { missing: extra.missing } : {}),
      waitingForYou: (session.crewLive ?? []).some((live) => this.childWaitsForYou(live.roleSession)),
      scope: this.nextStageScope(run, def),
    });
    session.workflowView = this.decorateWorkflowView(session, view, run, def, packets, last);
    this.emit(session, { type: "workflowRun", run: session.workflowView });
  }

  private decorateWorkflowView(
    session: Session,
    view: WorkflowRunView,
    run: WorkflowRun,
    def: WorkflowDefinition,
    packets: HandoffPacket[],
    last: HandoffPacket | undefined,
  ): WorkflowRunView {
    const rows = runTableRows(run, def, packets);
    const reverted = new Set(run.reverted ?? []);
    const table = rows.map((row) => {
      const stage = findStage(def, row.stageId);
      return {
        ordinal: row.ordinal,
        stageId: row.stageId,
        title: row.title,
        role: row.role,
        target: row.target,
        status: reverted.has(row.ordinal) ? "reverted" : row.status,
        ...(row.durationMs ? { duration: formatDurationShort(row.durationMs) } : {}),
        ...(typeof row.tokens === "number" ? { tokens: formatTokenCount(row.tokens) } : {}),
        files: row.files,
        ...(row.sessionId ? { sessionId: row.sessionId } : {}),
        ...(stage && isWriteProfile(stage.profile) && row.status === "done" && row.sessionId && !reverted.has(row.ordinal)
          ? { revertible: true }
          : {}),
      };
    });
    const metaFor = (stageId: string): string | undefined => {
      const row = [...rows].reverse().find((r) => r.stageId === stageId);
      if (!row) return undefined;
      return [row.target, formatDurationShort(row.durationMs), typeof row.tokens === "number" ? `${formatTokenCount(row.tokens)} tokens` : ""]
        .filter(Boolean).join(" · ") || undefined;
    };
    const live = this.runningStageSession(session);
    const stalled = live?.stalled && run.current && live.lastChildActivityAt
      ? { stageId: run.current.stageId, text: stallWarningText(Date.now() - live.lastChildActivityAt) }
      : undefined;
    const reportPath = this.workflowReportPath(run.runId);
    const out: WorkflowRunView = {
      ...view,
      stages: view.stages.map((s) => {
        const meta = metaFor(s.id);
        const runningHere = run.current?.stageId === s.id;
        const status = runningHere && stalled && s.status !== "needs-you" ? "stalled" : s.status;
        return {
          ...s,
          childStatus: stageChildStatus(status),
          ...(meta ? { meta } : {}),
          ...(runningHere && run.current?.sessionId && !s.sessionId ? { sessionId: run.current.sessionId } : {}),
          ...(runningHere && stalled ? { status: s.status === "needs-you" ? s.status : "stalled" } : {}),
          ...(runningHere && this.stageStepProgress.get(run.runId) ? { substep: this.stageStepProgress.get(run.runId) } : {}),
        };
      }),
      ...(rows.length ? { totals: runTotalsLine(rows) } : {}),
      table,
      autonomy: this.workflowAutonomy(run),
      ...(run.pauseAfterCurrent ? { pauseAfterCurrent: true } : {}),
      ...(stalled ? { stalled } : {}),
      ...(run.acknowledged ? { acknowledged: true } : {}),
      ...(reportPath && fs.existsSync(reportPath) ? { reportAvailable: true } : {}),
      ...(run.verify ? { verify: run.verify } : {}),
    };
    if (!view.gate || !run.gate) return out;
    const gate = { ...view.gate };
    const nextId = run.gate.nextStageId ?? run.gate.proposedNext[0];
    const nextStage = nextId && !isReservedTarget(nextId) ? findStage(def, nextId) : undefined;
    if (last && run.gate.kind !== "gate-0") {
      const meta = [targetText(last.target), formatDurationShort(last.durationMs), typeof last.tokens === "number" ? `${formatTokenCount(last.tokens)} tokens` : ""]
        .filter(Boolean).join(" · ");
      if (meta) gate.headerMeta = meta;
    }
    if (run.gate.preselectedTarget) {
      gate.preselected = {
        provider: run.gate.preselectedTarget.provider,
        ...(run.gate.preselectedTarget.model ? { model: run.gate.preselectedTarget.model } : {}),
        ...(run.gate.preselectedTarget.effort ? { effort: run.gate.preselectedTarget.effort } : {}),
      };
    }
    if (run.gate.compare) {
      gate.compare = compareLabel(run.gate.compare);
      gate.compareSame = run.gate.compare.same;
    }
    if (nextStage) {
      const who = gate.preselected ? providerDisplayName(gate.preselected.provider) : "";
      gate.primaryLabel = `Start ${nextStage.title}${who ? ` on ${who}` : ""}`;
    }
    if (run.gate.kind === "fixer-limit") gate.anotherRoundLabel = anotherRoundLabel(run, def);
    if (gate.findings?.length) {
      const ignored = new Set(run.ignoredFindings ?? []);
      gate.findings = gate.findings.map((f) => ({ ...f, selected: !ignored.has(f.id) }));
      gate.panelSize = last?.panel?.length;
    }
    if (last?.planSteps?.length && nextStage && last.stageId === run.executed[run.executed.length - 1]?.stageId) {
      gate.planSteps = last.planSteps.map((s) => ({ ...s, ...(s.files ? { files: [...s.files] } : {}) }));
      if (last.editedByUser) gate.planEdited = true;
    }
    if (last?.questions?.length && nextStage) gate.questions = [...last.questions];
    if (run.gate.kind === "limit" && run.gate.limitProvider) {
      const exhausted = new Set(run.exhausted);
      gate.limit = {
        provider: run.gate.limitProvider,
        providerName: providerDisplayName(run.gate.limitProvider),
        alternatives: (view.gate.eligible ?? [])
          .filter((t) => t.provider !== run.gate!.limitProvider && !exhausted.has(t.provider))
          .map((t) => ({ provider: t.provider, displayName: t.displayName })),
      };
    }
    if (run.gate.switchedFrom) gate.switchedFrom = providerDisplayName(run.gate.switchedFrom);
    if (gate.kind === "gate-0") {
      out.lineup = this.lineupForRun(session, run, def);
      out.verifySuggestions = this.verifySuggestions(run.cwd);
    }
    out.gate = gate;
    return out;
  }

  workflowAutonomy(run: WorkflowRun): Autonomy {
    if (run.autonomy) return run.autonomy;
    const configured = this.companionsSetting<string>("crew.defaultAutonomy", "step");
    const legacy = this.autoStartNextStage();
    return configured === "step" && legacy ? "stop-on-problems" : autonomyFromSettings(configured, legacy);
  }

  workflowReportPath(runId: string): string | undefined {
    try {
      return path.join(this.workflowRuns().runDir(runId), "run-report.md");
    } catch {
      return undefined;
    }
  }

  lineupForRun(session: Session, run: WorkflowRun | undefined, def: WorkflowDefinition): WorkflowLineupView[] {
    const input = this.crewEligibilityInput(session);
    const eligible = listEligibleTargets(input, {}).targets.map((t) => t.provider);
    const roles = this.agentRoleSet(this.sessionCwd(session));
    const roleInfo: Record<string, RoleTemplateInfo | undefined> = {};
    for (const [key, ref] of Object.entries(def.roles)) {
      const named = "ref" in ref ? ref.ref : key;
      const role = findAgentRole(roles, named);
      roleInfo[key] = role
        ? {
            provider: role.provider,
            ...(role.model ? { model: role.model } : {}),
            ...(role.effort ? { effort: role.effort } : {}),
            builtin: role.source === "builtin",
            ...(role.preferDifferentProvider ? { preferDifferentProvider: true } : {}),
          }
        : undefined;
    }
    const remembered = run?.lineup ?? this.rememberedLineup(this.sessionCwd(session), def.name);
    return proposeLineup({ def, eligible, remembered, roles: roleInfo }).map((entry) => ({
      ...entry,
      providerName: providerDisplayName(entry.provider),
    }));
  }

  rememberedLineup(cwd: string, workflow: string): Record<string, RunLineupEntry> | undefined {
    const all = this.state.get<Record<string, Record<string, RunLineupEntry>>>(WorkflowStageRunner.LINEUP_KEY, {});
    return all[`${cwd}::${workflow}`];
  }

  async rememberLineup(cwd: string, workflow: string, lineup: Record<string, RunLineupEntry>): Promise<void> {
    const all = { ...this.state.get<Record<string, Record<string, RunLineupEntry>>>(WorkflowStageRunner.LINEUP_KEY, {}) };
    all[`${cwd}::${workflow}`] = lineup;
    await this.state.update(WorkflowStageRunner.LINEUP_KEY, all);
  }

  verifySuggestions(cwd: string): string[] {
    try {
      const read = (name: string) => {
        try { return fs.readFileSync(path.join(cwd, name), "utf8"); } catch { return undefined; }
      };
      const pkgText = read("package.json");
      let packageJson: { scripts?: Record<string, unknown> } | undefined;
      try { packageJson = pkgText ? JSON.parse(pkgText) : undefined; } catch { packageJson = undefined; }
      const packageManager = fs.existsSync(path.join(cwd, "pnpm-lock.yaml")) ? "pnpm" as const
        : fs.existsSync(path.join(cwd, "yarn.lock")) ? "yarn" as const : "npm" as const;
      return suggestVerifyCommands({
        packageJson,
        packageManager,
        hasCargo: fs.existsSync(path.join(cwd, "Cargo.toml")),
        hasPyproject: fs.existsSync(path.join(cwd, "pyproject.toml")),
        hasGoMod: fs.existsSync(path.join(cwd, "go.mod")),
      });
    } catch {
      return [];
    }
  }

  withGatePreselection(session: Session, run: WorkflowRun, def: WorkflowDefinition): WorkflowRun {
    if (!run.gate) return run;
    const nextId = run.gate.nextStageId ?? run.gate.proposedNext[0];
    const stage = nextId && !isReservedTarget(nextId) ? findStage(def, nextId) : undefined;
    if (!stage) return run;
    const input = this.crewEligibilityInput(session);
    const eligible = listEligibleTargets(input, {}).targets.map((t) => t.provider);
    const roleRef = def.roles[stage.role];
    const named = roleRef && "ref" in roleRef ? roleRef.ref : stage.role;
    const role = findAgentRole(this.agentRoleSet(this.sessionCwd(session)), named);
    const packets = this.packetMap(run.runId);
    const lastPacket = this.packetsFor(run.runId).slice(-1)[0];
    const lineup = run.lineup?.[stage.id];
    const pick = preselectGateTarget({
      stage,
      def,
      eligible,
      packets,
      ...(lineup ? { lineup: { provider: lineup.provider, ...(lineup.model ? { model: lineup.model } : {}), ...(lineup.effort ? { effort: lineup.effort } : {}) } } : {}),
      ...(role
        ? {
            role: {
              provider: role.provider,
              ...(role.model ? { model: role.model } : {}),
              ...(role.effort ? { effort: role.effort } : {}),
              builtin: role.source === "builtin",
              ...(role.preferDifferentProvider ? { preferDifferentProvider: true } : {}),
            },
          }
        : {}),
      ...(lastPacket ? { lastProvider: lastPacket.target.provider } : {}),
    });
    if (!pick.target) return run;
    return {
      ...run,
      gate: {
        ...run.gate,
        preselectedTarget: {
          provider: pick.target.provider,
          ...(pick.target.model ? { model: pick.target.model } : {}),
          ...(pick.target.effort && isEffortLevel(pick.target.effort) ? { effort: pick.target.effort } : {}),
        },
        ...(pick.compare ? { compare: { stageTitle: pick.compare.stageTitle, same: pick.compare.same } } : {}),
      },
    };
  }

  nextStageScope(run: WorkflowRun, def: WorkflowDefinition): { globs: string[]; note?: string } | undefined {
    if (!run.gate) return undefined;
    const id = run.gate.nextStageId ?? run.gate.proposedNext[0];
    const stage = id && !isReservedTarget(id) ? findStage(def, id) : undefined;
    if (!stage || stage.profile !== "scoped-edit") return undefined;
    const scope = resolveStageScope(stage, this.packetMap(run.runId), run.attachedFiles);
    return scope.empty
      ? { globs: [], note: `The plan names no files — ${stage.title} will ask before editing anything.` }
      : { globs: scope.globs };
  }

  persistWorkflowRun(session: Session): void {
    const run = session.workflowRun;
    if (!run) return;
    try {
      this.workflowRuns().writeRun(run);
    } catch (error) {
      this.host.appendLine(`[workflow] could not write run.json: ${(error as Error).message}`);
    }
    this.persistSessionType(session);
  }

  async restoreWorkflowRun(session: Session, runId: string): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.restoreWorkflowRun>("restoreWorkflowRun");
    if (override) return override(session, runId);
    const run = this.workflowRuns().readRun(runId);
    if (!run) return;
    session.workflowRun = run;
    const snap = this.workflowRuns().readSnapshot(runId);
    if (snap) {
      try {
        const parsed = JSON.parse(snap);
        const fromSnap = presetToStageGraph({
          name: run.workflowName,
          roles: [],
          body: "",
          source: "builtin",
          stages: parsed,
        });
        this.workflowStore().defs.set(runId, fromSnap);
      } catch {
        this.workflowStore().defs.set(runId, this.resolveWorkflow(session, run.workflowName));
      }
    } else {
      this.workflowStore().defs.set(runId, this.resolveWorkflow(session, run.workflowName));
    }
    const missing = this.loadWorkflowPackets(run);
    const liveHash = workflowSnapshotHash(this.resolveWorkflow(session, run.workflowName));
    let next = run;
    const stale = resumeStaleness(run.pausedAt, await this.currentWorkspaceStamp(run));
    if (session.workflowRun !== run) return;
    if (!stale.ok) next = applyStaleness(next, stale);
    if (snapshotDrift(next, liveHash)) next = applySnapshotDrift(next);
    session.workflowRun = next;
    this.emitWorkflowRun(session, {
      ...(!stale.ok && stale.code === "stale" ? { staleDetails: stale.details } : {}),
      ...(missing.length ? { missing } : {}),
    });
  }

  loadWorkflowPackets(run: WorkflowRun): string[] {
    const missing: string[] = [];
    const def = this.workflowStore().defs.get(run.runId);
    for (const entry of run.executed) {
      if (entry.status === "skipped") continue;
      const key = `${run.runId}:${entry.ordinal}`;
      if (this.workflowStore().packets.has(key)) continue;
      const packet = this.workflowRuns().readUserEdit(run.runId, entry.ordinal)
        ?? this.workflowRuns().readHandoffAt(entry.packetPath)
        ?? this.workflowRuns().readHandoff(run.runId, entry.ordinal);
      if (packet) {
        this.workflowStore().packets.set(key, packet);
        continue;
      }
      const title = def ? findStage(def, entry.stageId)?.title ?? entry.stageId : entry.stageId;
      missing.push(`Stage ${entry.ordinal} (${title}) result is missing on disk.`);
    }
    return missing;
  }

  async currentWorkspaceStamp(run: WorkflowRun): Promise<{
    gitHead?: string;
    observedHash?: string;
    worktreeExists?: boolean;
    worktree?: string;
  }> {
    const cwd = run.worktree || run.cwd;
    let gitHead: string | undefined;
    try {
      if (fs.existsSync(path.join(cwd, ".git"))) {
        const head = await runGit(cwd, ["rev-parse", "HEAD"], { timeoutMs: 5000 });
        if (head.ok) gitHead = head.stdout.trim() || undefined;
      }
    } catch { /* not a git checkout, or git missing */ }
    const packets = [...this.workflowStore().packets.values()].filter((p) => p.runId === run.runId);
    const files = [...new Set(packets.flatMap((p) => p.filesObserved))];
    const hashed = await Promise.all(files.map(async (file) => {
      const abs = path.isAbsolute(file) ? file : path.join(cwd, file);
      try {
        const buf = await fs.promises.readFile(abs);
        let h = 0x811c9dc5;
        for (let i = 0; i < buf.length; i += 1) {
          h ^= buf[i]!;
          h = Math.imul(h, 0x01000193);
        }
        return { path: file, hash: (h >>> 0).toString(16) };
      } catch {
        return { path: file, hash: "missing" };
      }
    }));
    return {
      ...(gitHead ? { gitHead } : {}),
      ...(hashed.length ? { observedHash: observedFilesHash(hashed) } : {}),
      ...(run.worktree ? { worktree: run.worktree, worktreeExists: fs.existsSync(run.worktree) } : {}),
    };
  }

  async startWorkflowRun(
    session: Session,
    idea: string,
    workflowName: string,
    options?: CrewStartOptions,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.startWorkflowRun>("startWorkflowRun");
    if (override) return override(session, idea, workflowName, options);

    if (session.sessionTypeLockedAt === undefined) {
      session.sessionTypeLockedAt = Date.now();
      this.persistSessionType(session);
    }
    const cleanIdea = idea.trim();
    if (!cleanIdea) {
      this.agentNotice(session, "warning", "Idea required.");
      return;
    }
    if (session.workflowRun && session.workflowRun.status === "running") {
      this.agentNotice(session, "warning", "A workflow is already running in this conversation. Stop it first.");
      return;
    }
    const cwd = this.sessionCwd(session);
    let def: WorkflowDefinition;
    try {
      def = this.resolveWorkflow(session, workflowName);
    } catch (error) {
      this.agentNotice(session, "warning", `Could not resolve workflow "${workflowName}": ${(error as Error).message}`);
      return;
    }
    const runId = this.agentRuns.newRunId();
    let worktreePath: string | undefined;
    if (options?.worktree) {
      const created = await this.createCrewWorktree(cwd, `crew-${runId}`);
      if ("error" in created) {
        this.agentNotice(session, "warning", created.error);
      } else {
        worktreePath = created.path;
      }
    }
    const lineup = options?.lineup;
    if (lineup && Object.keys(lineup).length) {
      await this.rememberLineup(cwd, def.name, lineup);
    }
    const _stamp = await this.currentWorkspaceStamp({ runId, cwd, worktree: worktreePath } as WorkflowRun);
    void _stamp;
    const run = makeWorkflowRun({
      runId,
      sessionId: session.activeSessionId ?? "",
      workflow: def,
      idea: cleanIdea,
      cwd,
      ...(worktreePath ? { worktree: worktreePath } : {}),
      ...(options?.verify ? { verify: options.verify } : {}),
      checkpointTurnId: String(session.userMessageCount),
      ...(options?.firstTarget ? { firstTarget: options.firstTarget as any } : {}),
    });
    this.workflowStore().defs.set(runId, def);
    try {
      this.workflowRuns().writeSnapshot(runId, JSON.stringify(def.stages));
    } catch (error) {
      this.host.appendLine(`[workflow] could not write stages.json: ${(error as Error).message}`);
    }
    session.workflowRun = this.withGatePreselection(session, run, def);
    this.persistWorkflowRun(session);
    this.emit(session, { type: "userMessage", text: cleanIdea, chips: [] });
    this.emitWorkflowRun(session);
    const first = options?.firstTarget ?? (options?.startNow ? session.workflowRun.gate?.preselectedTarget : undefined);
    if (first) {
      await this.handleWorkflowGateAction(session, {
        type: "start",
        nextStageId: session.workflowRun.gate?.nextStageId,
        target: first as never,
      });
    }
  }

  async handleWorkflowGateAction(
    session: Session,
    action: GateAction,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.handleWorkflowGateAction>("handleWorkflowGateAction");
    if (override) return override(session, action);

    const run = session.workflowRun;
    if (!run) return;
    const def = this.workflowStore().defs.get(run.runId) ?? this.resolveWorkflow(session, run.workflowName);
    if (action.type === "revertAll") {
      await this.revertWorkflowRun(session);
      return;
    }
    if (action.type === "keepChanges") {
      session.workflowRun = run.status === "done"
        ? applyGateAction(run, def, action, Date.now())
        : applyGateAction(run, def, { type: "cancel", reason: "Cancelled, changes kept." }, Date.now());
      this.persistWorkflowRun(session);
      this.emitWorkflowRun(session);
      return;
    }
    if (action.type === "changeWorkflow") {
      this.postWorkflowList(session);
      return;
    }
    if (action.type === "pause") {
      const stamp = await this.currentWorkspaceStamp(run);
      session.workflowRun = applyGateAction(run, def, {
        type: "pause",
        at: Date.now(),
        ...(stamp.gitHead ? { gitHead: stamp.gitHead } : {}),
        ...(stamp.observedHash ? { observedHash: stamp.observedHash } : {}),
        ...(stamp.worktree ? { worktree: stamp.worktree } : {}),
      }, Date.now());
      this.persistWorkflowRun(session);
      this.emitWorkflowRun(session);
      return;
    }
    if (action.type === "setAutonomy" || action.type === "pauseAfterStage" || action.type === "selectFindings") {
      session.workflowRun = applyGateAction(run, def, action, Date.now());
      this.persistWorkflowRun(session);
      this.emitWorkflowRun(session);
      return;
    }
    if (action.type === "start" || action.type === "restart" || action.type === "rerun" || action.type === "anotherRound") {
      const target = action.target ?? run.gate?.preselectedTarget;
      const next = applyGateAction(run, def, target ? { ...action, target } as GateAction : action, Date.now());
      session.workflowRun = next;
      this.persistWorkflowRun(session);
      this.emitWorkflowRun(session);
      if (next.status === "running" && next.current) {
        await this.executeWorkflowStage(session, def, next, target);
      } else if (next.status === "done") {
        this.finishWorkflowRun(session, def);
      }
      return;
    }
    session.workflowRun = applyGateAction(run, def, action, Date.now());
    this.persistWorkflowRun(session);
    this.emitWorkflowRun(session);
    if (session.workflowRun.status === "done") this.finishWorkflowRun(session, def);
  }

  applyWorkflowPlanEdit(
    session: Session,
    msg: { runId: string; steps: Array<{ id: string; title: string; acceptance?: string; files?: string[] }> },
  ): void {
    const run = session.workflowRun;
    if (!run || run.runId !== msg.runId || run.status === "running") return;
    const planPacket = [...this.packetsFor(run.runId)].reverse().find((p) => p.planSteps?.length);
    if (!planPacket) return;
    const steps = sanitizePlanEdit(msg.steps);
    const edited: HandoffPacket = { ...planPacket, planSteps: steps, editedByUser: true };
    try {
      this.workflowRuns().writeUserEdit(run.runId, planPacket.stageOrdinal, edited);
    } catch (error) {
      this.host.appendLine(`[workflow] could not write the plan edit: ${(error as Error).message}`);
    }
    this.workflowStore().packets.set(`${run.runId}:${planPacket.stageOrdinal}`, edited);
    this.emitWorkflowRun(session);
  }

  finishWorkflowRun(session: Session, def: WorkflowDefinition): void {
    this.emitReviewCenter(session);
    this.writeWorkflowReport(session, def);
    this.emitWorkflowRun(session);
  }

  writeWorkflowReport(session: Session, def: WorkflowDefinition): string | undefined {
    const run = session.workflowRun;
    const target = run ? this.workflowReportPath(run.runId) : undefined;
    if (!run || !target) return undefined;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, renderRunReport({ run, def, packets: this.packetsFor(run.runId), ignoredFindings: run.ignoredFindings }), "utf8");
      return target;
    } catch (error) {
      this.host.appendLine(`[workflow] could not write the run report: ${(error as Error).message}`);
      return undefined;
    }
  }

  async handleHostGateAction(
    session: Session,
    msg: Extract<WebviewMsg, { type: "workflowGateAction" }>,
  ): Promise<boolean> {
    const override = this.deps.getOverride?.<typeof this.handleHostGateAction>("handleHostGateAction");
    if (override) return override(session, msg);

    const run = session.workflowRun;
    if (!run || msg.runId !== run.runId) return false;
    const def = this.workflowStore().defs.get(run.runId) ?? this.resolveWorkflow(session, run.workflowName);
    switch (msg.action) {
      case "revise": {
        const message = String(msg.message ?? "").trim();
        const lastEntry = run.executed[run.executed.length - 1];
        if (!message || !lastEntry || run.status === "running") return true;
        await this.reviseWorkflowStage(session, def, lastEntry.stageId, lastEntry.sessionId, message);
        return true;
      }
      case "revertStage": {
        await this.revertWorkflowStage(session, def, Number(msg.ordinal));
        return true;
      }
      case "waitRetry": {
        const provider = run.gate?.limitProvider;
        const stageId = run.gate?.nextStageId ?? run.gate?.proposedNext[0];
        if (!provider || !stageId) return true;
        session.workflowRun = { ...run, exhausted: run.exhausted.filter((p) => p !== provider) };
        await this.handleWorkflowGateAction(session, { type: "start", nextStageId: stageId, target: { provider } });
        return true;
      }
      case "nudge": {
        const child = this.runningStageSession(session);
        if (!child) return true;
        this.agentNotice(session, "info", "→ nudged the running stage");
        child.lastChildActivityAt = Date.now();
        child.stalled = false;
        this.emitWorkflowRun(session);
        await this.steerSend(NUDGE_TEXT, child);
        return true;
      }
      case "stopStage": {
        for (const live of session.crewLive ?? []) {
          live.cancelled = true;
          void live.roleSession.client?.cancel("user stopped the crew stage");
        }
        return true;
      }
      case "openReport":
      case "copyReport": {
        const file = this.writeWorkflowReport(session, def);
        if (!file) return true;
        if (msg.action === "openReport") void this.host.openResource(file);
        else {
          try {
            await this.host.writeClipboard?.(fs.readFileSync(file, "utf8"));
            this.agentNotice(session, "info", "Run report copied as Markdown.");
          } catch (error) {
            this.agentNotice(session, "warning", `Could not copy the report: ${(error as Error).message}`);
          }
        }
        this.emitWorkflowRun(session);
        return true;
      }
      default:
        return false;
    }
  }

  async reviseWorkflowStage(
    session: Session,
    def: WorkflowDefinition,
    stageId: string,
    stageSessionId: string | undefined,
    message: string,
  ): Promise<void> {
    const run = session.workflowRun;
    if (!run) return;
    const next = startWorkflowStage(run, stageId, Date.now(), {});
    session.workflowRun = next;
    this.persistWorkflowRun(session);
    this.emit(session, { type: "userMessage", text: message, chips: [] });
    this.emitWorkflowRun(session);
    await this.executeWorkflowStage(session, def, next, undefined, {
      continue: stageSessionId ? { sessionId: stageSessionId, message: `Revise your result with this feedback, then give the result block again.\n\n${message}` } : undefined,
    });
  }

  poolSessionById(sessionId: string | undefined): Session | undefined {
    if (!sessionId) return undefined;
    return [...this.pool].find((s) => s.activeSessionId === sessionId);
  }

  async executeWorkflowStage(
    session: Session,
    def: WorkflowDefinition,
    run: WorkflowRun,
    targetHint?: { provider: AcpProvider; model?: string; effort?: string },
    opts?: { continue?: { sessionId: string; message: string } },
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.executeWorkflowStage>("executeWorkflowStage");
    if (override) return override(session, def, run, targetHint, opts);

    const current = run.current;
    if (!current) return;
    this.inflightGeneration.set(run.runId, run.generation ?? 0);
    const stage = findStage(def, current.stageId);
    if (!stage) return;
    const hint = targetHint ?? current.target;
    if (!opts?.continue && stage.fork) {
      await this.executeForkStage(session, def, run, stage, hint);
      return;
    }
    if (!opts?.continue && stage.fanOut && stage.fanOut.count > 1 && stage.profile === "read-only") {
      await this.executePanelStage(session, def, run, stage, hint);
      return;
    }
    if (!opts?.continue && stage.strategy === "per-plan-step" && this.planStepsFor(run).length) {
      await this.executePerPlanStepStage(session, def, run, stage, hint);
      return;
    }
    const prepared = this.prepareStageRun(session, def, run, stage, hint);
    if ("error" in prepared) {
      this.emit(session, { type: "hostNotice", level: "warning", text: prepared.error });
      await this.finishWorkflowStage(session, def, buildHandoffPacket({
        runId: run.runId,
        stageId: stage.id,
        stageOrdinal: current.ordinal,
        visit: current.visit,
        role: stage.role,
        target: { provider: prepared.provider, modelVerified: false },
        status: "failed",
        rawReply: prepared.error,
        durationMs: 0,
        resultPath: this.deps.agentRuns.resultPath(run.runId, current.ordinal, "stage"),
        contract: def.contracts[stage.contract],
      }));
      return;
    }
    // C-08: a stage that continues another stage's session (or the run's
    // "fix in the implementer's session" choice) sends its brief as a turn.
    const continuesId = stageContinues(stage) ?? (stage.role === "fixer" && run.fixInSession ? run.fixInSession : undefined);
    const continueSession = opts?.continue
      ? this.poolSessionById(opts.continue.sessionId)
      : continuesId
        ? this.poolSessionById(run.executed.filter((e) => e.stageId === continuesId).slice(-1)[0]?.sessionId)
        : undefined;
    const continueMessage = opts?.continue?.message
      ?? (continueSession ? renderBriefing(makeBriefing({ ...prepared.brief, runId: run.runId, step: current.ordinal }), prepared.role) : undefined);
    if ((opts?.continue || continuesId) && !continueSession) {
      this.host.appendLine(`[workflow] ${stage.id}: the session to continue is gone; starting a fresh one`);
    }
    this.setStatus(session, "working");
    const started = Date.now();
    let role = prepared.role;
    let switchedFrom: AcpProvider | undefined;
    let outcome = await this.runStageRole(session, run, stage, current, role, prepared, continueSession, continueMessage);
    // C-16 / F-08: a usage limit never switches silently.
    const limitKind = outcome.outcome === "failed" ? classifyLimitError(role.provider, outcome.detail || "") : null;
    if (limitKind === "quota" || limitKind === "rate") {
      const exhaustedRun = markExhausted(session.workflowRun ?? run, role.provider);
      session.workflowRun = { ...exhaustedRun, exhaustedAt: { ...(exhaustedRun.exhaustedAt ?? {}), [role.provider]: Date.now() } };
      const onLimit = this.companionsSetting<string>("crew.onLimit", "ask") === "switch" ? "switch" : "ask";
      const decision = decideFailover({
        kind: limitKind,
        policy: onLimit,
        attempt: 1,
        maxAttempts: 3,
        exhausted: session.workflowRun.exhausted,
        usable: this.usableProviders(),
      });
      if (decision.action === "switch") {
        const next = decision.provider as AcpProvider;
        const text = `${stage.title} ran on ${providerDisplayName(next)} after ${providerDisplayName(role.provider)} hit its usage limit.`;
        this.emit(session, { type: "hostNotice", level: "warning", text });
        switchedFrom = role.provider;
        role = { ...role, provider: next, model: undefined, effort: role.effort };
        outcome = await this.runStageRole(session, run, stage, current, role, prepared, undefined, undefined);
      } else if (decision.action === "wait") {
        const sleep = this.deps.getOverride?.<(ms: number) => Promise<void>>("crewSlotSleep")
          ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.host.appendLine(diagnosisLine({
          runId: run.runId,
          seq: ++this.diagnosisSeq,
          reason: `${decision.reason} (${decision.waitMs}ms)`,
        }));
        await sleep(decision.waitMs);
        outcome = await this.runStageRole(session, run, stage, current, role, prepared, undefined, undefined);
        if (outcome.outcome === "failed") {
          await this.stopAtLimitGate(session, def, run, stage, current, role.provider, outcome);
          return;
        }
      } else {
        await this.stopAtLimitGate(session, def, run, stage, current, role.provider, outcome);
        return;
      }
    }
    const live = session.workflowRun ?? run;
    if (outcome.sessionId) session.workflowRun = bindStageSession(live, outcome.sessionId);
    let verify: { command: string; exitCode: number; output: string } | undefined;
    if (run.verify && isWriteProfile(stage.profile) && outcome.outcome === "completed") {
      const result = await this.runCrewVerify(run.verify, run.worktree ?? run.cwd);
      verify = { command: run.verify, exitCode: result.code, output: result.output };
    }
    const status: HandoffStatus = outcome.outcome === "cancelled" ? "interrupted" as const
      : outcome.outcome === "failed" ? "failed" as const
        : "done" as const;
    const packet = buildHandoffPacket({
      runId: run.runId,
      stageId: stage.id,
      stageOrdinal: current.ordinal,
      visit: current.visit,
      role: stage.role,
      target: {
        provider: role.provider,
        ...(role.model ? { model: role.model } : {}),
        ...(role.effort ? { effort: role.effort } : {}),
        modelVerified: switchedFrom ? false : prepared.modelVerified,
      },
      status,
      rawReply: (outcome as any).rawReply ?? (outcome as any).summary ?? "",
      filesReported: (outcome as any).filesReported,
      filesObserved: (outcome as any).filesObserved,
      reconciliation: (outcome as any).reconciliation,
      ...(verify ? { verify } : {}),
      userNotes: (outcome as any).userNotes,
      tokens: (outcome as any).tokens ?? (outcome as any).totalTokens,
      durationMs: outcome.durationMs || (Date.now() - started),
      resultPath: this.deps.agentRuns.resultPath(run.runId, current.ordinal, "stage"),
      contract: def.contracts[stage.contract],
    });
    await this.finishWorkflowStage(session, def, switchedFrom ? { ...packet, switchedFrom } : packet);
  }

  prepareStageRun(
    session: Session,
    def: WorkflowDefinition,
    run: WorkflowRun,
    stage: WorkflowStage,
    hint: { provider: AcpProvider; model?: string; effort?: string } | undefined,
    overrides?: { scopeGlobs?: string[]; task?: string; title?: string },
  ): { role: AgentRole; brief: BriefingInput; scope: StageScope; modelVerified: boolean } | { error: string; provider: AcpProvider } {
    const current = run.current!;
    const roles = this.agentRoleSet(this.sessionCwd(session));
    const roleRef = def.roles[stage.role];
    const named = roleRef && "ref" in roleRef ? roleRef.ref : stage.role;
    const inline = roleRef && "inline" in roleRef ? roleRef.inline : undefined;
    const template = findAgentRole(roles, named);
    const lineup = run.lineup?.[stage.id];
    const requested = {
      provider: hint?.provider ?? stage.target?.provider ?? lineup?.provider ?? template?.provider ?? session.provider,
      ...(hint?.model || stage.target?.model || lineup?.model || template?.model
        ? { model: hint?.model ?? stage.target?.model ?? lineup?.model ?? template?.model }
        : {}),
      ...(hint?.effort || stage.target?.effort || lineup?.effort || template?.effort
        ? { effort: (hint?.effort ?? stage.target?.effort ?? lineup?.effort ?? template?.effort) as never }
        : {}),
      profile: stage.profile,
      runMode: stageRunMode(stage),
    };
    const verdict = resolveTarget(requested, this.crewEligibilityInput(session));
    if (!verdict.ok) return { error: verdict.message, provider: requested.provider };
    const role: AgentRole = {
      ...(template ?? {
        name: stage.role,
        whenToUse: inline?.whenToUse ?? stage.title,
        ...(inline?.systemPreamble ? { systemPreamble: inline.systemPreamble } : {}),
        source: "builtin" as const,
      }),
      name: stage.role,
      provider: verdict.target.provider,
      ...(verdict.target.model ? { model: verdict.target.model } : {}),
      ...(verdict.target.effort ? { effort: verdict.target.effort } : {}),
      mode: stageRunMode(stage),
    };
    const packets = this.packetMap(run.runId);
    const resolved = resolveStageScope(stage, packets, run.attachedFiles);
    const scope: StageScope = overrides?.scopeGlobs
      ? { globs: overrides.scopeGlobs, sources: ["plan step"], empty: overrides.scopeGlobs.length === 0 }
      : resolved;
    const overlay = stage.profile === "scoped-edit" && current.allowAnywhere
      ? []
      : subagentPermissionOverlay(stage.profile, scope.globs, this.companionsSetting<string[]>("subagents.readOnlyCommandAllowList", []));
    role.permissions = [...(role.permissions ?? []), ...overlay];
    if (stage.profile === "scoped-edit") {
      this.host.appendLine(
        `[workflow] ${stage.id}: scope ${current.allowAnywhere ? "anywhere (allowed at the gate)" : scope.globs.length ? scope.globs.join(", ") : "empty — every edit asks"}`,
      );
    }
    const brief = briefingFromContract({
      runId: run.runId,
      step: current.ordinal,
      idea: run.idea,
      stage,
      def,
      packets,
      userNotes: current.userNotes,
      attachedFiles: run.attachedFiles,
      verifyCommand: run.verify,
      ignoredFindings: run.ignoredFindings,
    });
    const finalBrief: BriefingInput = overrides?.task
      ? { ...brief, task: `${overrides.task}\n\n${brief.task}`, ...(overrides.scopeGlobs ? { files: [...new Set([...overrides.scopeGlobs, ...(brief.files ?? [])])] } : {}) }
      : brief;
    return { role, brief: finalBrief, scope, modelVerified: verdict.modelVerified };
  }

  runStageRole(
    session: Session,
    run: WorkflowRun,
    stage: WorkflowStage,
    current: NonNullable<WorkflowRun["current"]>,
    role: AgentRole,
    prepared: { scope: StageScope; brief: BriefingInput },
    continueSession: Session | undefined,
    continueMessage: string | undefined,
    sub?: { step: number; cwd?: string },
  ): ReturnType<WorkflowStageRunner["runAgentRole"]> {
    return this.runAgentRole(role, prepared.brief, "workflow-stage", session, {
      runId: run.runId,
      step: sub?.step ?? current.ordinal,
      cwd: sub?.cwd ?? run.worktree ?? run.cwd,
      stage: {
        stageId: stage.id,
        allowSubagents: stage.allowSubagents === true,
        ...(stage.profile === "scoped-edit" && !current.allowAnywhere ? { scope: prepared.scope.globs } : {}),
        ...(sub ? { subStep: true } : {}),
      },
      ...(continueSession && continueMessage ? { continueSession, continueMessage } : {}),
    });
  }

  async finishWorkflowStage(session: Session, def: WorkflowDefinition, packet: HandoffPacket): Promise<void> {
    const live = session.workflowRun;
    if (!live) return;
    const startedGeneration = this.inflightGeneration.get(live.runId);
    if (startedGeneration !== undefined && startedGeneration !== (live.generation ?? 0)) {
      this.host.appendLine(diagnosisLine({
        runId: live.runId,
        seq: ++this.diagnosisSeq,
        reason: `ignoring stale result for ${packet.stageId}`,
      }));
      return;
    }
    if (live.status === "cancelled") {
      this.host.appendLine(diagnosisLine({
        runId: live.runId,
        seq: ++this.diagnosisSeq,
        reason: `ignoring result for ${packet.stageId} after cancel`,
      }));
      return;
    }
    try {
      this.workflowRuns().writeHandoff(live.runId, packet.stageOrdinal, packet);
    } catch (error) {
      const message = (error as Error).message;
      this.host.appendLine(`[workflow] could not write handoff: ${message}`);
      const stopped: WorkflowRun = {
        ...live,
        status: "at-gate",
        gate: {
          proposedNext: [packet.stageId, "$pause", "$cancel"],
          nextStageId: packet.stageId,
          reason: `The stage result could not be saved (${message}). It is not treated as done.`,
          kind: "interrupted",
          forcedManual: ["handoff-unpersisted"],
        },
      };
      delete stopped.current;
      session.workflowRun = stopped;
      this.persistWorkflowRun(session);
      this.emitWorkflowRun(session);
      return;
    }
    this.workflowStore().packets.set(`${live.runId}:${packet.stageOrdinal}`, packet);
    this.stageStepProgress.delete(live.runId);
    const after = applyStageOutcome(live, def, packet, this.packetsFor(live.runId), {
      autoStartNextStage: false,
      autonomy: this.workflowAutonomy(live),
    });
    session.workflowRun = this.withGatePreselection(session, after, def);
    this.persistWorkflowRun(session);
    this.emitWorkflowRun(session);
    if (session.workflowRun.status === "done") this.finishWorkflowRun(session, def);
    const gate = session.workflowRun.gate;
    if (gate?.autoProceed && session.workflowRun.status === "at-gate" && gate.nextStageId && !isReservedTarget(gate.nextStageId)) {
      await this.handleWorkflowGateAction(session, {
        type: "start",
        nextStageId: gate.nextStageId,
        ...(gate.preselectedTarget ? { target: gate.preselectedTarget } : {}),
      });
    }
  }

  async stopAtLimitGate(
    session: Session,
    def: WorkflowDefinition,
    run: WorkflowRun,
    stage: WorkflowStage,
    current: NonNullable<WorkflowRun["current"]>,
    provider: AcpProvider,
    outcome: Awaited<ReturnType<WorkflowStageRunner["runAgentRole"]>>,
  ): Promise<void> {
    const live = session.workflowRun ?? run;
    const next: WorkflowRun = {
      ...live,
      status: "at-gate",
      gate: {
        proposedNext: [stage.id, "$pause", "$cancel"],
        nextStageId: stage.id,
        reason: `${providerDisplayName(provider)} hit its usage limit during ${stage.title}.`,
        kind: "limit",
        forcedManual: ["limit"],
        limitProvider: provider,
      },
    };
    delete next.current;
    this.host.appendLine(`[workflow] ${stage.id} stopped at the limit gate (${provider}): ${outcome.detail ?? ""}`);
    session.workflowRun = this.withGatePreselection(session, next, def);
    this.persistWorkflowRun(session);
    this.emitWorkflowRun(session);
    void current;
  }

  planStepsFor(run: WorkflowRun): HandoffPlanStep[] {
    const withSteps = this.packetsFor(run.runId).filter((p) => p.planSteps?.length);
    return withSteps.length ? withSteps[withSteps.length - 1]!.planSteps! : [];
  }

  async executePerPlanStepStage(
    session: Session,
    def: WorkflowDefinition,
    run: WorkflowRun,
    stage: WorkflowStage,
    hint: { provider: AcpProvider; model?: string; effort?: string } | undefined,
  ): Promise<void> {
    const current = run.current!;
    const steps = this.planStepsFor(run);
    const started = Date.now();
    let walker = makeCrewRun({
      runId: run.runId,
      goal: run.idea,
      cwd: run.worktree ?? run.cwd,
      steps: steps.map((s, i) => ({
        index: i + 1,
        title: s.title,
        planEntryHint: s.id,
        role: stage.role,
        status: "pending" as const,
        filesReported: [...(s.files ?? [])],
        filesObserved: [],
        ...(s.dependsOn?.length ? { dependsOn: [...s.dependsOn] } : {}),
        ...(s.reads?.length ? { reads: [...s.reads] } : {}),
        ...(s.writes?.length ? { writes: [...s.writes] } : {}),
        ...(stage.profile === "read-only" ? { readOnly: true } : {}),
      })),
      parallel: stage.parallel === true,
    });
    walker = setCrewStatus(walker, "running");
    const results: Array<{ step: HandoffPlanStep; outcome: Awaited<ReturnType<WorkflowStageRunner["runAgentRole"]>>; verify?: { command: string; exitCode: number; output: string } }> = [];
    let failed = false;
    let role: AgentRole | undefined;
    let modelVerified = false;
    let parallelVerified = false;
    while (walker.status === "running") {
      const pending = walker.steps.some((s) => s.status === "pending" || s.status === "assigned");
      const granted = this.slotLedger.tryAcquire(pending ? WorkflowStageRunner.MAX_LIVE_SESSIONS : 0);
      let wave: CrewStep[] = [];
      try {
        wave = nextIndependentSteps(walker, { parallel: stage.parallel === true, cap: granted });
        if (granted > wave.length) this.slotLedger.release(granted - wave.length);
        if (!wave.length) {
          const unmet = unmetDependencies(walker);
          if (granted <= 0 && pending) {
            this.stageStepProgress.set(run.runId, "waiting for a free session");
            this.emitWorkflowRun(session);
            const waited = await this.waitForCrewSlot(session);
            if (waited === "stopped") failed = true;
            if (waited === "stopped") break;
            continue;
          }
          if (unmet.length) {
            failed = true;
            this.host.appendLine(diagnosisLine({
              runId: run.runId,
              seq: ++this.diagnosisSeq,
              reason: `steps still waiting: ${unmet.map((step) => step.index).join(", ")}`,
            }));
          }
          break;
        }
      } catch (error) {
        this.slotLedger.release(granted);
        throw error;
      }
      const doneCount = walker.steps.filter((s) => s.status === "done").length;
      this.stageStepProgress.set(run.runId, `step ${doneCount + 1}/${steps.length}`);
      this.emitWorkflowRun(session);
      const parallelWave = stage.parallel === true && wave.length > 1;
      const runOne = async (crewStep: CrewStep) => {
        const planStep = steps[crewStep.index - 1]!;
        try {
          const prepared = this.prepareStageRun(session, def, run, stage, hint, {
            scopeGlobs: planStep.files ?? [],
            task: `Do ONLY plan step ${planStep.id}: ${planStep.title}.${planStep.acceptance ? ` Done when: ${planStep.acceptance}.` : ""} `
              + "The whole plan is below for context; the other steps are someone else's.",
          });
          if ("error" in prepared) return { crewStep, planStep, error: prepared.error };
          role = prepared.role;
          modelVerified = prepared.modelVerified;
          let stepCwd = run.worktree ?? run.cwd;
          let wt: { path: string; label: string; sourceGitRoot: string } | undefined;
          if (parallelWave) {
            const made = await this.createCrewWorktree(stepCwd, `crew-${run.runId.slice(-8)}-${current.ordinal}-${crewStep.index}`);
            if ("error" in made) {
              this.host.appendLine(diagnosisLine({
                runId: run.runId,
                seq: ++this.diagnosisSeq,
                reason: `worktree for step ${crewStep.index} failed: ${made.error}`,
              }));
              return { crewStep, planStep, isolationError: made.error };
            }
            wt = made;
            stepCwd = made.path;
          }
          const outcome = await this.runStageRole(session, run, stage, current, prepared.role, prepared, undefined, undefined, {
            step: current.ordinal * 100 + crewStep.index,
            cwd: stepCwd,
          });
          let verify: { command: string; exitCode: number; output: string } | undefined;
          if (run.verify && stage.verifyEach && outcome.outcome === "completed") {
            const where = parallelWave ? stepCwd : (run.worktree ?? run.cwd);
            const checked = await this.runCrewVerify(run.verify, where);
            verify = { command: run.verify, exitCode: checked.code, output: checked.output };
          }
          return { crewStep, planStep, outcome, verify, wt };
        } catch (error) {
          return { crewStep, planStep, thrown: (error as Error).message };
        }
      };
      for (const s of wave) walker = startCrewStep(walker, s.index);
      let settled: Array<Awaited<ReturnType<typeof runOne>>> = [];
      try {
        settled = await Promise.all(wave.map(runOne));
      } finally {
        this.slotLedger.release(wave.length);
      }
      const ready: Array<{ crewStep: CrewStep; planStep: HandoffPlanStep; outcome: Awaited<ReturnType<WorkflowStageRunner["runAgentRole"]>>; verify?: { command: string; exitCode: number; output: string }; wt?: { path: string; label: string; sourceGitRoot: string } }> = [];
      for (const item of settled) {
        if ("isolationError" in item && item.isolationError) {
          walker = applyStepOutcome(walker, item.crewStep.index, { status: "failed", detail: item.isolationError });
          failed = true;
          continue;
        }
        if ("thrown" in item && item.thrown) {
          walker = applyStepOutcome(walker, item.crewStep.index, { status: "failed", detail: item.thrown });
          failed = true;
          continue;
        }
        if ("error" in item && item.error) {
          walker = applyStepOutcome(walker, item.crewStep.index, { status: "failed", detail: item.error });
          failed = true;
          continue;
        }
        const outcome = item.outcome;
        if (!outcome) {
          walker = applyStepOutcome(walker, item.crewStep.index, { status: "failed", detail: "the step returned no outcome" });
          failed = true;
          continue;
        }
        const verify = item.verify;
        const ok = outcome.outcome === "completed" && (!verify || verify.exitCode === 0);
        if (!ok || !item.wt) {
          results.push({ step: item.planStep, outcome, ...(verify ? { verify } : {}) });
          walker = applyStepOutcome(walker, item.crewStep.index, {
            status: ok ? "done" : outcome.outcome === "cancelled" ? "cancelled" : "failed",
            filesReported: outcome.filesReported,
            filesObserved: outcome.filesObserved,
            durationMs: outcome.durationMs,
            ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
            ...(!ok && item.wt ? { detail: `worktree kept at ${item.wt.path}` } : {}),
          });
          if (!ok) failed = true;
          continue;
        }
        ready.push({ crewStep: item.crewStep, planStep: item.planStep, outcome, ...(verify ? { verify } : {}), wt: item.wt });
      }
      for (const item of ready) {
        const applied = await this.applyCrewWorktree(session, item.wt!);
        const integrated = applied.kind === "applied" || applied.kind === "unchanged";
        results.push({ step: item.planStep, outcome: item.outcome, ...(item.verify ? { verify: item.verify } : {}) });
        walker = applyStepOutcome(walker, item.crewStep.index, {
          status: integrated ? "done" : "failed",
          filesReported: item.outcome.filesReported,
          filesObserved: integrated ? crewApplyFiles(applied) : item.outcome.filesObserved,
          durationMs: item.outcome.durationMs,
          ...(item.outcome.sessionId ? { sessionId: item.outcome.sessionId } : {}),
          ...(!integrated ? { detail: `integration ${applied.kind}` } : {}),
        });
        if (!integrated) {
          failed = true;
          this.host.appendLine(diagnosisLine({
            runId: run.runId,
            seq: ++this.diagnosisSeq,
            reason: `integration ${applied.kind} for step ${item.crewStep.index}`,
          }));
          break;
        }
      }
      if (parallelWave) parallelVerified = true;
      if (failed) break;
    }
    const lastVerify = [...results].reverse().find((r) => r.verify)?.verify;
    let finalVerify = parallelVerified ? undefined : lastVerify;
    if (!failed && run.verify && (!stage.verifyEach || parallelVerified)) {
      const r = await this.runCrewVerify(run.verify, run.worktree ?? run.cwd);
      finalVerify = { command: run.verify, exitCode: r.code, output: r.output };
      if (r.code !== 0) failed = true;
    }
    const cancelled = results.some((r) => r.outcome.outcome === "cancelled");
    const union = (pick: (o: Awaited<ReturnType<WorkflowStageRunner["runAgentRole"]>>) => readonly string[]) =>
      [...new Set(results.flatMap((r) => pick(r.outcome)))];
    const doneSteps = walker.steps.filter((s) => s.status === "done").length;
    const summary = [
      `${doneSteps}/${steps.length} plan steps done${failed ? `; stopped at step ${walker.steps.find((s) => s.status === "failed")?.index ?? "?"}` : ""}.`,
      ...results.map((r) => `- ${r.step.id} ${r.step.title}: ${(r.outcome as any).summary || r.outcome.outcome}`),
    ].join("\n");
    const tokens = results.every((r) => typeof (r.outcome as any).totalTokens === "number" || typeof (r.outcome as any).tokens === "number")
      ? results.reduce((sum, r) => sum + ((r.outcome as any).totalTokens ?? (r.outcome as any).tokens ?? 0), 0)
      : undefined;
    const reconciliation = {
      touched: union((o) => (o as any).reconciliation?.touched ?? []),
      unreported: union((o) => (o as any).reconciliation?.unreported ?? []),
      claimedOnly: union((o) => (o as any).reconciliation?.claimedOnly ?? []),
    };
    const packet = buildHandoffPacket({
      runId: run.runId,
      stageId: stage.id,
      stageOrdinal: current.ordinal,
      visit: current.visit,
      role: stage.role,
      target: {
        provider: role?.provider ?? hint?.provider ?? session.provider,
        ...(role?.model ? { model: role.model } : {}),
        ...(role?.effort ? { effort: role.effort } : {}),
        modelVerified,
      },
      status: cancelled ? "interrupted" : failed ? "failed" : "done",
      rawReply: [
        summary,
        "```companions-result",
        JSON.stringify({ summary, filesChanged: union((o) => o.filesReported) }),
        "```",
      ].join("\n"),
      filesReported: union((o) => o.filesReported),
      filesObserved: union((o) => o.filesObserved),
      reconciliation,
      ...(finalVerify ? { verify: finalVerify } : {}),
      userNotes: current.userNotes,
      ...(typeof tokens === "number" ? { tokens } : {}),
      durationMs: Date.now() - started,
      resultPath: this.deps.agentRuns.resultPath(run.runId, current.ordinal, "stage"),
      contract: def.contracts[stage.contract],
    });
    const stepsRecord = walker.steps.map((s) => ({
      id: steps[s.index - 1]?.id ?? String(s.index),
      title: s.title,
      status: (s.status === "done" ? "done" : s.status === "failed" ? "failed" : "skipped") as HandoffPacket["status"],
      files: [...s.filesObserved],
    }));
    try {
      this.deps.agentRuns.writeResult(run.runId, current.ordinal, `${summary}\n`, "stage");
    } catch { /* the per-step results are on disk; the summary is a convenience */ }
    await this.finishWorkflowStage(session, def, { ...packet, steps: stepsRecord });
  }

  async executePanelStage(
    session: Session,
    def: WorkflowDefinition,
    run: WorkflowRun,
    stage: WorkflowStage,
    hint: { provider: AcpProvider; model?: string; effort?: string } | undefined,
  ): Promise<void> {
    const current = run.current!;
    const fan = stage.fanOut!;
    const first = this.prepareStageRun(session, def, run, stage, hint);
    if ("error" in first) {
      this.emit(session, { type: "hostNotice", level: "warning", text: first.error });
      await this.finishWorkflowStage(session, def, buildHandoffPacket({
        runId: run.runId,
        stageId: stage.id,
        stageOrdinal: current.ordinal,
        visit: current.visit,
        role: stage.role,
        target: { provider: first.provider, modelVerified: false },
        status: "failed",
        rawReply: first.error,
        durationMs: 0,
        resultPath: this.deps.agentRuns.resultPath(run.runId, current.ordinal, "stage"),
      }));
      return;
    }
    const eligible = listEligibleTargets(this.crewEligibilityInput(session), {}).targets.map((t) => ({ provider: t.provider }));
    const cap = this.slotLedger.tryAcquire(fan.count);
    if (cap <= 0) {
      this.agentNotice(session, "warning", `${stage.title} is waiting for a free session and was not started.`);
      await this.finishWorkflowStage(session, def, buildHandoffPacket({
        runId: run.runId,
        stageId: stage.id,
        stageOrdinal: current.ordinal,
        visit: current.visit,
        role: stage.role,
        target: { provider: first.role.provider, modelVerified: first.modelVerified },
        status: "interrupted",
        rawReply: "No free session slot. The panel did not start.",
        durationMs: 0,
        resultPath: this.deps.agentRuns.resultPath(run.runId, current.ordinal, "stage"),
      }));
      return;
    }
    const targets = panelTargets({ provider: first.role.provider }, eligible, Math.min(fan.count, cap), fan.distinctProviders);
    if (cap > targets.length) this.slotLedger.release(cap - targets.length);
    if (targets.length < fan.count) {
      this.agentNotice(session, "info", `${stage.title}: ${targets.length} of ${fan.count} reviewers can run (companions or free sessions are short).`);
    }
    this.setStatus(session, "working");
    const started = Date.now();
    let members: Array<{ role: AgentRole; outcome: Awaited<ReturnType<WorkflowStageRunner["runAgentRole"]>>; modelVerified: boolean } | undefined>;
    try {
      members = await Promise.all(targets.map(async (target, i) => {
        const prepared = i === 0 ? first : this.prepareStageRun(session, def, run, stage, target);
        if ("error" in prepared) return undefined;
        const outcome = await this.runStageRole(session, run, stage, current, prepared.role, prepared, undefined, undefined, {
          step: current.ordinal * 100 + i + 1,
        });
        return { role: prepared.role, outcome, modelVerified: prepared.modelVerified };
      }));
    } finally {
      this.slotLedger.release(targets.length);
    }
    const ran = members.filter((m): m is NonNullable<typeof m> => !!m);
    const packets = ran.map((m, i) => buildHandoffPacket({
      runId: run.runId,
      stageId: stage.id,
      stageOrdinal: current.ordinal,
      visit: current.visit,
      role: stage.role,
      target: {
        provider: m.role.provider,
        ...(m.role.model ? { model: m.role.model } : {}),
        ...(m.role.effort ? { effort: m.role.effort } : {}),
        modelVerified: m.modelVerified,
      },
      status: m.outcome.outcome === "cancelled" ? "interrupted" : m.outcome.outcome === "failed" ? "failed" : "done",
      rawReply: m.outcome.rawReply ?? m.outcome.summary,
      filesReported: m.outcome.filesReported,
      filesObserved: m.outcome.filesObserved,
      reconciliation: m.outcome.reconciliation,
      userNotes: current.userNotes,
      tokens: m.outcome.totalTokens,
      durationMs: m.outcome.durationMs,
      resultPath: this.deps.agentRuns.resultPath(run.runId, current.ordinal * 100 + i + 1, "step"),
      contract: def.contracts[stage.contract],
    }));
    if (!packets.length) {
      await this.finishWorkflowStage(session, def, buildHandoffPacket({
        runId: run.runId,
        stageId: stage.id,
        stageOrdinal: current.ordinal,
        visit: current.visit,
        role: stage.role,
        target: { provider: first.role.provider, modelVerified: false },
        status: "failed",
        rawReply: "No reviewer could run.",
        durationMs: Date.now() - started,
        resultPath: this.deps.agentRuns.resultPath(run.runId, current.ordinal, "stage"),
      }));
      return;
    }
    const reviewers = ran.map((m) => `${providerDisplayName(m.role.provider)}${m.role.model ? ` ${m.role.model}` : ""}`);
    const merged = mergeReviewPackets(packets, reviewers);
    const packet = capHandoffPacket({ ...merged, resultPath: this.deps.agentRuns.resultPath(run.runId, current.ordinal, "stage") });
    try {
      this.deps.agentRuns.writeResult(run.runId, current.ordinal, `${packet.summary}\n`, "stage");
    } catch { /* members' results are on disk */ }
    await this.finishWorkflowStage(session, def, packet);
  }

  packetMap(runId: string): Map<string, HandoffPacket> {
    const map = new Map<string, HandoffPacket>();
    for (const packet of this.packetsFor(runId)) map.set(packet.stageId, packet);
    return map;
  }

  packetsFor(runId: string): HandoffPacket[] {
    return [...this.workflowStore().packets.values()]
      .filter((p) => p.runId === runId)
      .sort((a, b) => a.stageOrdinal - b.stageOrdinal);
  }

  async revertWorkflowRun(session: Session): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.revertWorkflowRun>("revertWorkflowRun");
    if (override) return override(session);

    const run = session.workflowRun;
    if (!run) return;
    const def = this.workflowStore().defs.get(run.runId) ?? IDEA_TO_DONE;
    const writing = [...run.executed]
      .filter((e) => {
        const stage = findStage(def, e.stageId);
        return stage && isWriteProfile(stage.profile) && e.sessionId && !(run.reverted ?? []).includes(e.ordinal);
      })
      .sort((a, b) => b.ordinal - a.ordinal);
    const reverted: number[] = [];
    for (const entry of writing) {
      const ok = await this.revertStageCheckpoints(session, entry.sessionId!, run.worktree ?? run.cwd,
        `${findStage(def, entry.stageId)?.title ?? entry.stageId} (stage ${entry.ordinal})`);
      if (ok === "cancelled") break;
      if (ok === "reverted") reverted.push(entry.ordinal);
    }
    const base = session.workflowRun ?? run;
    session.workflowRun = applyGateAction(
      { ...base, reverted: [...new Set([...(base.reverted ?? []), ...reverted])] },
      def,
      { type: "cancel", reason: "Cancelled; changes reverted." },
      Date.now(),
    );
    this.persistWorkflowRun(session);
    this.emitWorkflowRun(session);
  }

  async revertWorkflowStage(session: Session, def: WorkflowDefinition, ordinal: number): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.revertWorkflowStage>("revertWorkflowStage");
    if (override) return override(session, def, ordinal);

    const run = session.workflowRun;
    if (!run || run.status === "running") return;
    const entry = run.executed.find((e) => e.ordinal === ordinal);
    const stage = entry ? findStage(def, entry.stageId) : undefined;
    if (!entry || !stage || !entry.sessionId || !isWriteProfile(stage.profile)) {
      this.agentNotice(session, "warning", "That stage changed no files that can be reverted.");
      return;
    }
    const later = run.executed.filter((e) => e.ordinal > ordinal && e.sessionId && !(run.reverted ?? []).includes(e.ordinal))
      .filter((e) => { const s = findStage(def, e.stageId); return s && isWriteProfile(s.profile); });
    if (later.length) {
      const ok = await this.confirmInChat(session, {
        title: `Revert ${stage.title}?`,
        body: `${later.length} later stage(s) also changed files and may build on it. Their files are only restored where they did not change since — anything else is asked about.`,
        confirmLabel: `Revert ${stage.title}`,
        danger: true,
      });
      if (!ok) return;
    }
    const result = await this.revertStageCheckpoints(session, entry.sessionId, run.worktree ?? run.cwd, `${stage.title} (stage ${ordinal})`);
    if (result !== "reverted") return;
    const base = session.workflowRun ?? run;
    session.workflowRun = {
      ...base,
      reverted: [...new Set([...(base.reverted ?? []), ordinal])],
      status: base.status === "done" ? "at-gate" : base.status,
      gate: {
        proposedNext: [stage.id, "$done", "$cancel"],
        nextStageId: stage.id,
        reason: `${stage.title} was reverted. Rerun it, finish, or cancel.`,
        kind: "normal",
      },
    };
    session.workflowRun = this.withGatePreselection(session, session.workflowRun, def);
    this.persistWorkflowRun(session);
    this.emitWorkflowRun(session);
  }

  async revertStageCheckpoints(
    ui: Session,
    sessionId: string,
    cwd: string,
    label: string,
  ): Promise<"reverted" | "nothing" | "cancelled" | "failed"> {
    const override = this.deps.getOverride?.<typeof this.revertStageCheckpoints>("revertStageCheckpoints");
    if (override) return override(ui, sessionId, cwd, label);

    if (!this.checkpointStore) {
      this.agentNotice(ui, "warning", `Can't revert ${label} — checkpoints are unavailable.`);
      return "failed";
    }
    const checkpoints = this.checkpointStore.loadFrom(sessionId, 0);
    if (!checkpoints.length) {
      this.agentNotice(ui, "warning", `Can't revert ${label} — there is no checkpoint for it.`);
      return "failed";
    }
    const merged = mergeCheckpoints(checkpoints);
    const current = new Map<string, string | null>();
    for (const file of merged.files) {
      try {
        current.set(file.relPath, fs.readFileSync(path.join(cwd, file.relPath), "utf8"));
      } catch {
        current.set(file.relPath, null);
      }
    }
    const restore = planRestoreDetailed(merged, current);
    const wouldTouch = restore.writes.length + restore.deletes.length + restore.conflicts.length;
    if (wouldTouch === 0) {
      this.agentNotice(ui, "info", `Nothing to revert for ${label} — files already match.`);
      return "nothing";
    }
    let overwrite = false;
    if (restore.conflicts.length) {
      const ok = await this.confirmInChat(ui, {
        title: "Files changed since this stage",
        body: `${label}: these files were modified after the stage wrote them. Overwrite them?\n${restore.conflicts.map((f) => `• ${f}`).join("\n")}`,
        confirmLabel: "Overwrite",
        danger: true,
      });
      if (!ok) return "cancelled";
      overwrite = true;
    }
    const actions = restoreActions(restore, overwrite, merged);
    const failed: string[] = [];
    let restored = 0;
    for (const w of actions.writes) {
      try {
        const abs = path.join(cwd, w.relPath);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.from(w.blob, "utf8"));
        restored += 1;
      } catch (e) {
        failed.push(`${w.relPath}: ${(e as Error).message}`);
      }
    }
    for (const rel of actions.deletes) {
      try {
        fs.unlinkSync(path.join(cwd, rel));
        restored += 1;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") failed.push(`${rel}: ${(e as Error).message}`);
      }
    }
    const live = this.poolSessionById(sessionId);
    if (live && !failed.length) {
      live.reviewBlocks = [];
      this.emitReviewCenter(live);
    }
    if (failed.length) {
      this.agentNotice(ui, "warning", `Reverted ${label} partly; ${failed.length} file(s) could not be restored:\n${failed.join("\n")}`);
      return "failed";
    }
    this.agentNotice(ui, "info", `Reverted ${label}: ${restored} file(s) restored.`);
    return "reverted";
  }

  async handleCrewSessionInput(text: string, session: Session): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.handleCrewSessionInput>("handleCrewSessionInput");
    if (override) return override(text, session);

    const run = session.workflowRun;
    if (!run || run.status === "done" || run.status === "cancelled" || run.status === "failed") {
      const name = this.defaultWorkflowName();
      await this.startWorkflowRun(session, text, name);
      return;
    }
    if (run.status === "running") {
      await this.sendToRunningStage(session, text, "steer");
      return;
    }
    const parsed = parseGateMessage(text);
    if (parsed.kind === "command") {
      const map: Record<string, GateAction> = {
        pause: { type: "pause", at: Date.now() },
        cancel: { type: "cancel" },
        skip: { type: "skip" },
        rerun: { type: "rerun" },
        restart: { type: "restart" },
        continueAnyway: { type: "continueAnyway" },
        start: { type: "start" },
      };
      const action = map[parsed.command];
      if (action) await this.handleWorkflowGateAction(session, action);
      return;
    }
    session.workflowRun = appendGateNotes(run, parsed.text);
    this.persistWorkflowRun(session);
    this.emitWorkflowRun(session);
  }

  gateActionFromMsg(msg: {
    action: string;
    nextStageId?: string;
    target?: { provider: AcpProvider; model?: string; effort?: string };
    notes?: string;
    allowAnywhere?: boolean;
    autonomy?: string;
    value?: boolean;
    findings?: string[];
  }): GateAction | undefined {
    if (msg.action === "pause") return { type: "pause", at: Date.now() };
    if (msg.action === "cancel") return { type: "cancel" };
    if (msg.action === "skip") return { type: "skip", ...(msg.notes ? { notes: msg.notes } : {}) };
    if (msg.action === "rerun") return { type: "rerun", ...(msg.target ? { target: msg.target as never } : {}) };
    if (msg.action === "restart") return { type: "restart", ...(msg.target ? { target: msg.target as never } : {}) };
    if (msg.action === "finish") return { type: "finish" };
    if (msg.action === "continueAnyway") return { type: "continueAnyway" };
    if (msg.action === "acceptAsIs") return { type: "acceptAsIs" };
    if (msg.action === "anotherRound") return { type: "anotherRound", ...(msg.target ? { target: msg.target as never } : {}) };
    if (msg.action === "changeWorkflow") return { type: "changeWorkflow" };
    if (msg.action === "revertAll") return { type: "revertAll" };
    if (msg.action === "keepChanges") return { type: "keepChanges" };
    if (msg.action === "setAutonomy" && (msg.autonomy === "step" || msg.autonomy === "stop-on-problems" || msg.autonomy === "autopilot")) {
      return { type: "setAutonomy", autonomy: msg.autonomy };
    }
    if (msg.action === "pauseAfterStage") return { type: "pauseAfterStage", value: msg.value !== false };
    if (msg.action === "selectFindings") return { type: "selectFindings", keep: Array.isArray(msg.findings) ? msg.findings.map(String) : [] };
    if (msg.action === "start") {
      return {
        type: "start",
        ...(msg.nextStageId ? { nextStageId: msg.nextStageId } : {}),
        ...(msg.target ? { target: msg.target as never } : {}),
        ...(msg.notes ? { notes: msg.notes } : {}),
        ...(msg.allowAnywhere === true ? { allowAnywhere: true } : {}),
      };
    }
    return undefined;
  }

  async openNewCrewSession(
    idea: string,
    workflowName: string,
    options?: CrewStartOptions,
  ): Promise<void> {
    const override = this.deps.getOverride?.<typeof this.openNewCrewSession>("openNewCrewSession");
    if (override) return override(idea, workflowName, options);

    const session = await this.newFocusedSession();
    session.sessionType = "crew";
    this.persistSessionType(session);
    this.postWorkflowList(session, workflowName);
    if (idea.trim()) {
      await this.startWorkflowRun(session, idea, workflowName, options);
    }
  }

  private runningRoleName(session: Session): string | undefined {
    return session.agentRun?.roleName ?? session.crewLive?.[0]?.roleName;
  }

  private lastUserMessageText(session: Session): string {
    for (let i = session.buffer.length - 1; i >= 0; i -= 1) {
      const msg = session.buffer[i];
      if (msg.type === "userMessage") return String(msg.text ?? "").trim();
    }
    return "";
  }

  async handleCrewCommand(text: string, session: Session): Promise<boolean> {
    const override = this.deps.getOverride?.<typeof this.handleCrewCommand>("handleCrewCommand");
    if (override) return override(text, session);

    const parsed = parseCrewCommand(text);
    if (parsed.kind === "none") return false;
    if (parsed.kind === "error") {
      this.agentNotice(session, "warning", parsed.message);
      return true;
    }
    if (session.sessionType === "crew") {
      this.agentNotice(session, "warning", "This is already a Crew session. Describe the idea in the composer, or use the gate.");
      return true;
    }
    if (!this.inThreadCrewCommand()) {
      const goal = parsed.kind === "run" ? parsed.goal : undefined;
      this.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: "Crew runs live in their own session.",
        action: {
          id: "openCrewWithGoal",
          label: "Open a new Crew session with this goal",
          ...(goal ? { goal } : {}),
        },
      });
      return true;
    }
    if (session.crewRun && (session.crewRun.status === "running" || session.crewRun.status === "assigning" || session.crewRun.status === "planning")) {
      this.agentNotice(session, "warning", "A crew is already running in this conversation. Stop it first.");
      return true;
    }
    if (this.runningRoleName(session)) {
      this.agentNotice(session, "warning", "A role is already running in this conversation.");
      return true;
    }

    this.emit(session, { type: "userMessage", text, chips: [] });

    const cwd = this.sessionCwd(session);
    const presets = this.crewPresetSet(cwd);
    const preset = findCrewPreset(presets, parsed.preset);
    const roles = this.agentRoleSet(cwd);
    const goal = parsed.goal || this.lastUserMessageText(session) || "Carry out the current plan.";

    let entries = session.planEntries.filter((e) => e.content.trim());
    if (!entries.length) {
      const planner = findAgentRole(roles, "planner");
      if (!planner) {
        this.agentNotice(session, "warning", "No `planner` role is loaded, so a crew cannot invent a step list.");
        return true;
      }
      const resolved = this.resolveRoleProvider(planner, session);
      if ("error" in resolved) {
        this.agentNotice(session, "warning", resolved.error);
        return true;
      }
      const runId = this.agentRuns.newRunId();
      session.crewRun = makeCrewRun({ runId, goal, cwd, steps: [], preset: preset.name, verify: preset.verify });
      session.crewRun = setCrewStatus(session.crewRun, "planning");
      this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
      const planned = await this.runAgentRole(
        { ...planner, provider: resolved.provider },
        {
          goal,
          task: "Produce an ordered checklist of concrete steps for this goal. Do not edit any file.",
          acceptance: "A structured step list the host can walk, one step per item.",
          files: [],
          decisions: [],
          forbidden: ["Do not edit any file."],
          provenance: [`Crew ${runId} asked the planner for a step list.`],
        },
        "crew-step",
        session,
        { runId, step: 1 },
      );
      entries = planned.planEntries.filter((e: any) => e.content.trim());
      if (!entries.length) {
        this.agentNotice(session, "warning", "The planner did not report a step list, so the crew did not start.");
        session.crewRun = setCrewStatus(session.crewRun, "failed", "planner produced no steps");
        this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
        return true;
      }
    }

    const steps = stepsFromPlan(entries);
    const runId = session.crewRun?.runId ?? this.agentRuns.newRunId();
    let run = makeCrewRun({
      runId,
      goal,
      cwd,
      steps,
      preset: preset.name,
      verify: preset.verify,
      checkpointTurnId: String(session.userMessageCount),
      ...(preset.parallel ? { parallel: true } : {}),
    });
    try {
      this.agentRuns.appendLog({
        at: Date.now(),
        runId,
        step: 0,
        role: "crew",
        provider: session.provider,
        event: "started",
        detail: `preset=${preset.name} steps=${steps.length}`,
      });
    } catch { /* ignore */ }

    const pool = presetRoles(preset, roles);
    for (const problem of pool.problems) this.agentNotice(session, "warning", problem.message);

    for (const step of run.steps) {
      const assignment = assignStep({ title: step.title, files: [] }, pool.roles);
      if (assignment.kind === "assigned") {
        run = assignStepRole(run, step.index, assignment.role, assignment.why);
        try {
          this.agentRuns.appendLog({
            at: Date.now(), runId, step: step.index, role: assignment.role,
            provider: session.provider, event: "briefed", detail: assignment.why,
          });
        } catch { /* ignore */ }
      }
    }

    session.crewRun = setCrewStatus(run, "running");
    this.emit(session, { type: "crewRun", run: session.crewRun ?? null });

    const worktrees: Array<{ path: string; label: string; sourceGitRoot: string; step: number }> = [];
    while (session.crewRun && session.crewRun.status === "running") {
      const currentRun = session.crewRun;
      const nextUnassigned = currentRun.steps.find((s) => s.status === "pending" && !s.role);
      if (nextUnassigned) {
        session.crewRun = setCrewStatus(currentRun, "assigning");
        this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
        const picked = await this.askCrewAssignment(
          session,
          nextUnassigned.title,
          pool.roles.map((r) => r.name),
          "Choose an agent to work on this step.",
        );
        if (!picked) {
          session.crewRun = cancelCrewRun(session.crewRun, "Assignment cancelled.");
          this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
          break;
        }
        session.crewRun = assignStepRole(session.crewRun, nextUnassigned.index, picked, "assigned by user");
        session.crewRun = setCrewStatus(session.crewRun, "running");
        this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
        continue;
      }

      const pending = session.crewRun.steps.some((step) => step.status === "pending" || step.status === "assigned");
      const granted = this.slotLedger.tryAcquire(pending ? WorkflowStageRunner.MAX_LIVE_SESSIONS : 0);
      const nextSteps = nextIndependentSteps(session.crewRun, { parallel: preset.parallel === true, cap: granted });
      if (granted > nextSteps.length) this.slotLedger.release(granted - nextSteps.length);
      if (!nextSteps.length) {
        const unmet = unmetDependencies(session.crewRun);
        if (granted <= 0 && pending) {
          const waited = await this.waitForCrewSlot(session);
          if (waited === "stopped") {
            session.crewRun = cancelCrewRun(session.crewRun, "Stopped while waiting for a free session.");
            this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
          }
          if (waited === "stopped") break;
          continue;
        }
        if (unmet.length) {
          session.crewRun = setCrewStatus(session.crewRun, "failed", `Steps still waiting: ${unmet.map((step) => step.index).join(", ")}`);
        } else {
          session.crewRun = setCrewStatus(session.crewRun, "review");
        }
        this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
        break;
      }

      const prepared: Array<{
        step: CrewStep;
        role: AgentRole;
        brief: ReturnType<typeof briefingForCrewStep>;
        stepCwd: string;
      }> = [];

      for (const step of nextSteps) {
        const role = findAgentRole(roles, step.role!);
        if (!role) {
          this.agentNotice(session, "warning", `Role "${step.role}" not found.`);
          session.crewRun = applyStepOutcome(session.crewRun, step.index, { status: "failed", detail: `role ${step.role} not found` });
          this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
          continue;
        }
        let stepCwd = cwd;
        if (preset.parallel && nextSteps.length > 1) {
          const created = await this.createCrewWorktree(cwd, `crew-${step.index}`);
          if ("error" in created) {
            this.agentNotice(session, "warning", `Could not create worktree for step ${step.index}: ${created.error}`);
            session.crewRun = applyStepOutcome(session.crewRun, step.index, { status: "failed", detail: created.error });
            this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
            continue;
          }
          worktrees.push({ ...created, step: step.index });
          stepCwd = created.path;
        }
        const brief = briefingForCrewStep({
          run: session.crewRun,
          step,
          previous: undefined,
        });
        prepared.push({ step, role, brief, stepCwd });
      }

      if (!prepared.length) break;

      const runOne = async (p: typeof prepared[0]) => {
        const result = await this.executeCrewRole(p, session, runId, false);
        await this.settleCrewStep({
          session,
          roles,
          runId,
          cwd: p.stepCwd,
          step: p.step,
          role: p.role,
          result,
        });
      };

      try {
        if (preset.parallel && prepared.length > 1) {
          await Promise.all(prepared.map(runOne));
        } else {
          for (const p of prepared) {
            await runOne(p);
            if (session.crewRun?.status !== "running") break;
          }
        }
      } finally {
        this.slotLedger.release(nextSteps.length);
      }
    }

    for (const wt of worktrees) {
      const step = session.crewRun?.steps.find((item) => item.index === wt.step);
      if (step && step.status !== "done") {
        this.host.appendLine(diagnosisLine({
          runId,
          seq: ++this.diagnosisSeq,
          reason: `keeping worktree for step ${wt.step} at ${wt.path}`,
        }));
        continue;
      }
      const applied = await this.applyCrewWorktree(session, wt);
      if (applied.kind === "conflict" || applied.kind === "declined" || applied.kind === "failed") {
        if (session.crewRun) {
          session.crewRun = setCrewStatus(session.crewRun, "failed", `integration ${applied.kind}`);
          this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
        }
        break;
      }
    }
    if (preset.parallel) {
      this.emit(session, { type: "setBusy", value: false });
      if (session.status === "working") this.setStatus(session, "done");
    }

    if (session.crewRun && session.crewRun.status === "review") {
      this.emitReviewCenter(session);
      session.crewRun = setCrewStatus(session.crewRun, "done");
      this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
      const progress = crewProgress(session.crewRun);
      this.agentNotice(
        session,
        "info",
        `Crew ${session.crewRun.runId} finished: ${progress.done}/${progress.total} steps`
        + ". Review the combined diffs in the Review panel.",
      );
    }
    try { this.crewFileClaims().releaseRun(runId); } catch { /* claims are a lock */ }
    return true;
  }

  async executeCrewRole(
    prepared: { step: CrewStep; role: AgentRole; brief: ReturnType<typeof briefingForCrewStep>; stepCwd: string },
    session: Session,
    runId: string,
    live: boolean,
  ) {
    const { step, role, brief, stepCwd } = prepared;
    const coords = { runId, step: step.index, cwd: stepCwd, ...(live ? { live: true as const } : {}) };
    const exhausted: AcpProvider[] = [];
    let provider: AcpProvider = role.provider;
    let result = await this.runAgentRole({ ...role, provider }, brief, "crew-step", session, coords);
    let attempt = 1;
    while (result.outcome === "failed" && session.crewRun && attempt < 3) {
      const kind = classifyLimitError(provider, result.detail || "");
      if (kind !== "quota" && kind !== "rate") break;
      const decision = decideFailover({
        kind,
        policy: this.companionsSetting<string>("crew.onLimit", "ask") === "switch" ? "switch" : "ask",
        legacyAutoSwitch: true,
        attempt,
        maxAttempts: 3,
        exhausted,
        usable: this.usableProviders(),
      });
      if (decision.action === "stop") break;
      if (decision.action === "wait") {
        const sleep = this.deps.getOverride?.<(ms: number) => Promise<void>>("crewSlotSleep")
          ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
        await sleep(decision.waitMs);
        attempt += 1;
        result = await this.runAgentRole({ ...role, provider }, brief, "crew-step", session, coords);
        continue;
      }
      exhausted.push(provider);
      const next = decision.provider as AcpProvider;
      if (!next) break;
      try {
        this.agentRuns.appendLog({
          at: Date.now(), runId, step: step.index, role: role.name, provider: next,
          event: "started", detail: `failover from ${provider} (limit)`,
        });
      } catch { /* ignore */ }
      provider = next;
      result = await this.runAgentRole({ ...role, provider }, brief, "crew-step", session, coords);
    }
    return result;
  }

  async settleCrewStep(opts: {
    session: Session;
    roles: AgentRoleSet;
    runId: string;
    cwd: string;
    step: CrewStep;
    role: AgentRole;
    result: Awaited<ReturnType<WorkflowStageRunner["executeCrewRole"]>>;
  }): Promise<{ previous?: { summary: string; filesReported: string[]; filesObserved: string[]; verify?: string } }> {
    const { session, roles, runId, cwd, step, role, result } = opts;
    if (!session.crewRun) return {};
    for (const file of result.filesObserved) {
      const claim = this.crewFileClaims().tryClaim({
        path: file, runId, step: step.index, role: role.name, at: Date.now(),
      });
      if (!claim.ok && claim.reason !== "held") {
        session.crewRun = applyStepOutcome(session.crewRun, step.index, {
          status: "failed",
          detail: `claim store failed for ${file}: ${claim.message}`,
          filesObserved: result.filesObserved,
        });
        this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
        return {};
      }
      if (!claim.ok) {
        const keep = await this.confirmInChat(session, {
          title: "File already claimed",
          body: `${file} is held by ${claim.heldBy.role} (step ${claim.heldBy.step}). Overwrite anyway?`,
          confirmLabel: "Overwrite",
          danger: true,
        });
        if (!keep) {
          session.crewRun = applyStepOutcome(session.crewRun, step.index, {
            status: "failed",
            detail: `${file} is claimed by ${claim.heldBy.role}`,
            filesObserved: result.filesObserved,
          });
          this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
          return {};
        }
      }
    }
    if (session.crewRun.status !== "running") return {};

    const budget = checkBudget(
      { toolCalls: 0, tokens: result.totalTokens ?? 0, usdTicks: result.costUsdTicks ?? 0 },
      role.budget,
    );
    if (!budget.ok) {
      const keep = await this.confirmInChat(session, {
        title: "Budget reached",
        body: `${role.name} hit its ${budget.limit} cap (${budget.used} / ${budget.cap}). Continue, or stop the crew?`,
        confirmLabel: "Continue",
      });
      if (!keep) {
        session.crewRun = cancelCrewRun(session.crewRun, `${role.name} hit ${budget.limit}`);
        this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
        return {};
      }
    }

    const failCalls = result.filesReported.length
      ? []
      : (result.detail ? [{ tool: result.detail, ok: false as const }] : []);
    if (repeatedFailingTool(failCalls)) {
      const keep = await this.confirmInChat(session, {
        title: "Repeated failing tool",
        body: `${role.name} retried the same failing call. Continue, or stop the crew?`,
        confirmLabel: "Continue",
      });
      if (!keep) {
        session.crewRun = cancelCrewRun(session.crewRun, `${role.name} repeated a failing tool`);
        this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
        return {};
      }
    }

    session.crewRun = applyStepOutcome(session.crewRun, step.index, {
      status: result.outcome === "completed" ? "done" : result.outcome === "cancelled" ? "cancelled" : "failed",
      filesReported: result.filesReported,
      filesObserved: result.filesObserved,
      costUsdTicks: result.costUsdTicks,
      durationMs: result.durationMs,
      sessionId: result.sessionId,
      detail: result.detail,
    });
    this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
    if (result.outcome !== "completed") return {};

    const previous: { summary: string; filesReported: string[]; filesObserved: string[]; verify?: string } = {
      summary: result.summary,
      filesReported: result.filesReported,
      filesObserved: result.filesObserved,
    };
    if (session.crewRun.verify && role.name !== "reviewer" && role.name !== "planner") {
      const verify = await this.runCrewVerify(session.crewRun.verify, cwd);
      previous.verify = verify.code === 0
        ? `\`${session.crewRun.verify}\` passed.`
        : `\`${session.crewRun.verify}\` failed (exit ${verify.code}).`;
      if (verifyInsertsFixer(verify)) {
        const fixer = findAgentRole(roles, "fixer");
        if (fixer) {
          session.crewRun = insertCrewStep(session.crewRun, step.index, {
            title: fixerTitle({ command: session.crewRun.verify, output: verify.output }),
            role: "fixer",
            assignWhy: `verify \`${session.crewRun.verify}\` exited ${verify.code}`,
          });
          this.emit(session, { type: "crewRun", run: session.crewRun ?? null });
        }
      }
    }
    return { previous };
  }

  async askCrewAssignment(
    session: Session,
    title: string,
    candidates: string[],
    why: string,
  ): Promise<string | undefined> {
    const override = this.deps.getOverride?.<typeof this.askCrewAssignment>("askCrewAssignment");
    if (override) return override(session, title, candidates, why);

    const options = candidates.map((name) => ({ label: name }));
    if (!options.length) return undefined;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      this.showQuestion(session, {
        id: `crew-assign-${Date.now()}`,
        sessionId: session.activeSessionId || "crew",
        questions: [{
          question: `Which role should handle: ${title}?\n${why}`,
          options,
        }],
      }, {
        answer: (answers: Record<string, string>) => {
          const first = Object.values(answers)[0];
          finish(typeof first === "string" && candidates.includes(first) ? first : candidates[0]);
          return true;
        },
        cancel: () => { finish(undefined); return true; },
        abandon: () => { finish(undefined); },
      });
    });
  }

  async runCrewVerify(command: string, cwd: string): Promise<{ code: number; output: string }> {
    const override = this.deps.getOverride?.<(command: string, cwd: string) => Promise<{ code: number; output: string }>>("runCrewVerify")
      ?? this.deps.getOverride?.<(command: string, cwd: string) => Promise<{ code: number; output: string }>>("crewVerifyRunner");
    if (override) return override(command, cwd);
    if (this.crewVerifyRunner) return this.crewVerifyRunner(command, cwd);
    return { code: 0, output: "" };
  }

  uniqueCrewPaths(paths: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const p of paths) {
      const n = String(p ?? "").replace(/\\/g, "/");
      if (!n || seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
    return out;
  }

  async createCrewWorktree(
    sourcePath: string,
    label: string,
  ): Promise<{ path: string; label: string; sourceGitRoot: string } | { error: string }> {
    const override = this.deps.getOverride?.<(sourcePath: string, label: string) => Promise<any>>("createCrewWorktree")
      ?? this.deps.getOverride?.<(sourcePath: string, label: string) => Promise<any>>("crewWorktreeCreate");
    if (override) return override(sourcePath, label);
    if (this.crewWorktreeCreate) return this.crewWorktreeCreate(sourcePath, label);
    const sourceGitRoot = gitRootForPath(sourcePath, defaultFs) || sourcePath;
    const root = path.join(resolveGrokHome(), "worktrees");
    const created = await this.worktreeHost.worktreeLocal().create({ sourcePath, label, root });
    if ("error" in created) return created;
    const local = this.worktreeHost.worktreeLocal() as { readStartBasis?: (path: string) => Promise<{ commit: string } | { error: string }> };
    if (local.readStartBasis) {
      const basis = await local.readStartBasis(created.sourceGitRoot || sourceGitRoot);
      if (!("error" in basis)) {
        this.host.appendLine(`[worktree] start basis ${basis.commit}; uncommitted files in the source checkout are not copied into the worktree`);
      }
    }
    return {
      path: created.worktreePath,
      label: label || path.basename(created.worktreePath),
      sourceGitRoot: created.sourceGitRoot || sourceGitRoot,
    };
  }

  async applyCrewWorktree(
    session: Session,
    wt: { path: string; label: string; sourceGitRoot: string },
  ): Promise<CrewApplyOutcome> {
    return this.integrationQueue.run(wt.sourceGitRoot || wt.path, async () => {
      const override = this.deps.getOverride?.<any>("applyCrewWorktree")
        ?? this.deps.getOverride?.<any>("crewWorktreeApply");
      if (override) {
        const result = await (override.length > 1 ? override(session, wt) : override(wt));
        return normalizeCrewApplyOutcome(result);
      }
      if (this.crewWorktreeApply) return normalizeCrewApplyOutcome(await this.crewWorktreeApply(wt));
      return this.worktreeHost.applyWorktreeViaLocalGit(session, wt.path, wt.sourceGitRoot, wt.label);
    });
  }

  /** Poll until a slot frees or the run is cancelled. Does not start a worker. */
  private async waitForCrewSlot(session: Session): Promise<"ready" | "stopped"> {
    const sleep = this.deps.getOverride?.<(ms: number) => Promise<void>>("crewSlotSleep")
      ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (;;) {
      const crew = session.crewRun?.status;
      const workflow = session.workflowRun?.status;
      if (crew === "cancelled" || crew === "failed" || workflow === "cancelled" || workflow === "failed") return "stopped";
      if (parallelSlotCap({ maxLive: WorkflowStageRunner.MAX_LIVE_SESSIONS, unreapable: this.crewUnreapableCount() }) > 0) {
        return "ready";
      }
      await sleep(200);
    }
  }

  /**
   * Run a schema-2 fork group. Branches run together when the stage is
   * parallel, each writer in a worktree. Join `all` runs once. Required
   * failures stop the stage. Successful worktrees integrate one at a time.
   */
  private async executeForkStage(
    session: Session,
    def: WorkflowDefinition,
    run: WorkflowRun,
    stage: WorkflowStage,
    hint: { provider: AcpProvider; model?: string; effort?: string } | undefined,
  ): Promise<void> {
    const current = run.current!;
    const fork = stage.fork!;
    let group: ForkGroup = createForkGroup({
      runId: run.runId,
      groupId: fork.id,
      iteration: current.visit,
      branches: fork.branches,
    });
    const started = Date.now();
    const branchResults: Array<{ id: string; summary: string; status: HandoffPacket["status"]; files: string[] }> = [];
    const worktrees: Array<{ id: string; path: string; label: string; sourceGitRoot: string; ok: boolean }> = [];
    const runBranch = async (branch: ForkGroup["branches"][number]) => {
      const child = findStage(def, branch.stageId);
      if (!child) {
        group = markBranch(group, branch.id, "failed", current.visit);
        branchResults.push({ id: branch.id, summary: `unknown stage ${branch.stageId}`, status: "failed", files: [] });
        return;
      }
      group = markBranch(group, branch.id, "running", current.visit);
      const prepared = this.prepareStageRun(session, def, run, child, hint);
      if ("error" in prepared) {
        group = markBranch(group, branch.id, "failed", current.visit);
        branchResults.push({ id: branch.id, summary: prepared.error, status: "failed", files: [] });
        return;
      }
      let cwd = run.worktree ?? run.cwd;
      let wt: { path: string; label: string; sourceGitRoot: string } | undefined;
      if (stage.parallel && isWriteProfile(child.profile)) {
        const made = await this.createCrewWorktree(cwd, `fork-${fork.id}-${branch.id}`);
        if ("error" in made) {
          group = markBranch(group, branch.id, "failed", current.visit);
          branchResults.push({ id: branch.id, summary: made.error, status: "failed", files: [] });
          return;
        }
        wt = made;
        cwd = made.path;
      }
      try {
        const outcome = await this.runStageRole(session, run, child, current, prepared.role, prepared, undefined, undefined, {
          step: current.ordinal * 100 + branchResults.length + 1,
          cwd,
        });
        const ok = outcome.outcome === "completed";
        group = markBranch(group, branch.id, ok ? "succeeded" : outcome.outcome === "cancelled" ? "cancelled" : "failed", current.visit);
        if (wt) worktrees.push({ id: branch.id, ...wt, ok });
        branchResults.push({
          id: branch.id,
          summary: outcome.summary || outcome.outcome,
          status: ok ? "done" : "failed",
          files: [...outcome.filesObserved],
        });
      } catch (error) {
        group = markBranch(group, branch.id, "failed", current.visit);
        branchResults.push({ id: branch.id, summary: (error as Error).message, status: "failed", files: [] });
      }
    };
    if (stage.parallel) await Promise.all(group.branches.map((branch) => runBranch(branch)));
    else for (const branch of [...group.branches]) await runBranch(branch);
    const decision = joinDecision(group);
    group = noteJoined(group);
    let failed = !decision.ok;
    if (decision.ok) {
      for (const wt of worktrees) {
        if (!wt.ok) continue;
        const applied = await this.applyCrewWorktree(session, wt);
        if (applied.kind !== "applied" && applied.kind !== "unchanged") {
          failed = true;
          branchResults.push({ id: wt.id, summary: `integration ${applied.kind}`, status: "failed", files: crewApplyFiles(applied) });
          break;
        }
      }
    }
    const summary = [
      decision.reason,
      ...branchResults.map((row) => `- ${row.id}: ${row.summary}`),
    ].join("\n");
    await this.finishWorkflowStage(session, def, buildHandoffPacket({
      runId: run.runId,
      stageId: stage.id,
      stageOrdinal: current.ordinal,
      visit: current.visit,
      role: stage.role,
      target: { provider: hint?.provider ?? session.provider, modelVerified: false },
      status: failed ? "failed" : "done",
      rawReply: ["```companions-result", JSON.stringify({ summary }), "```"].join("\n"),
      durationMs: Date.now() - started,
      resultPath: this.deps.agentRuns.resultPath(run.runId, current.ordinal, "stage"),
      contract: def.contracts[stage.contract],
    }));
    void group;
  }

  crewUnreapableCount(): number {
    try {
      return countUnreapable(this.pool, this.focused);
    } catch {
      return 1;
    }
  }

  crewFileClaims(): FileClaimStore {
    return this.fileClaims ?? (this.fileClaims = new FileClaimStore({
      dir: path.join(this.context.globalStorageUri.fsPath, "file-claims").replace(/\\/g, "/"),
      fs: {
        mkdirSync: (p, o) => fs.mkdirSync(p, o),
        writeFileSync: (p, data, o) => fs.writeFileSync(p, data, o),
        readFileSync: (p, enc) => fs.readFileSync(p, enc),
        readdirSync: (p) => fs.readdirSync(p),
        existsSync: (p) => fs.existsSync(p),
        unlinkSync: (p) => fs.unlinkSync(p),
        rmSync: (p, o) => fs.rmSync(p, o),
      },
      now: () => Date.now(),
    }));
  }

  runningStageSession(parent: Session): Session | undefined {
    return (parent.crewLive ?? []).find((live) => !live.cancelled)?.roleSession;
  }

  async sendToRunningStage(parent: Session, text: string, mode: "steer" | "note"): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const run = parent.workflowRun;
    const child = this.runningStageSession(parent);
    const def = run ? this.workflowStore().defs.get(run.runId) : undefined;
    const title = run?.current && def ? findStage(def, run.current.stageId)?.title ?? run.current.stageId : "the stage";
    if (mode === "note" || !child) {
      if (run) {
        parent.workflowRun = { ...run, pendingNotes: [run.pendingNotes, body].filter(Boolean).join("\n") };
        this.persistWorkflowRun(parent);
      }
      this.emit(parent, { type: "userMessage", text: body, chips: [] });
      this.agentNotice(parent, "info", `→ noted for the next stage`);
      return;
    }
    this.emit(parent, { type: "userMessage", text: body, chips: [] });
    this.agentNotice(parent, "info", `→ sent to ${title}`);
    if (mode === "steer") {
      await this.steerSend(body, child);
    }
  }
}
