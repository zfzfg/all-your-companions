/**
 * SubagentHost: GrokSidebar collaborator for companion subagents, delegation,
 * child relay, turn-hold, child-watch, and directives (W-15 Schritt D3).
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type EffortLevel, type PermissionRequest } from "./acp";
import { type AcpProvider, ACP_PROVIDERS, isAcpProvider } from "./acp-backend";
import { type AgentRole, type AgentRoleSet, findAgentRole } from "./agent-roles";
import { type AgentRunStore, type AgentRunTrigger, stepSlug } from "./agent-run";
import { type BriefingInput } from "./briefing";
import {
  type ActivityOwner,
  ACTIVITY_FLUSH_MS,
  activityItemFromHostMsg,
  coalesceActivity,
  activityLastLine,
} from "./child-activity";
import {
  ChildRelayTable,
  type ChildKind,
  type RelayKind,
  type RelayOrigin,
  childNeedsYouNotice,
  childScopedSuggestions,
  relayOriginLabel,
  relayScopeWord,
} from "./child-relay";
import {
  type ChildStatus,
  subagentChildStatus,
} from "./child-status";
import {
  PausableDeadline,
  normalizeStallWarningSec,
  stageStallState,
} from "./child-watch";
import {
  type SubagentRecord,
  SUBAGENT_MAX_DEPTH_CAP,
  SUBAGENT_RUN_MODE,
  SubagentRegistry,
  carveChildLimits,
  decideCompanionsMcp,
  deriveSubagentLabel,
  isTerminalSubagentStatus,
  profileBadge,
  resolveMaxDepth,
  shouldAnnounceCompanionsSkip,
  subagentForbidden,
  subagentPermissionOverlay,
  subagentReturnFormat,
  uncollectedFollowUpText,
  type CompanionsSkipReason,
  companionsSkipNotice,
} from "./companion-subagents";
import {
  COMPANIONS_SERVER_NAME,
  COMPANIONS_LIST_TOOL,
  COMPANIONS_SPAWN_TOOL,
  COMPANIONS_AWAIT_TOOL,
  COMPANIONS_REVIEW_HINT,
  capInlineText,
  normalizeListArguments,
  normalizeSpawnArguments,
  normalizeAwaitArguments,
  refusalPayload,
  type ListArguments,
  type SpawnArguments,
  type AwaitArguments,
} from "./companions-protocol";
import { CompanionsHostServer, type CompanionsCall } from "./companions-server";
import { FileClaimStore } from "./file-claims";
import { type Host, type HostContext } from "./host";
import { type HostPipeMux } from "./host-pipe-mux";
import { type AcpMcpStdioServer, normalizeMcpName } from "./mcp-connectors";
import { extractPermissionFacts, pathMatchesGlob } from "./permission-rules";
import { type PersistedState } from "./persisted-state";
import { providerCapability } from "./provider-capabilities";
import { providerDisplayName, type ProviderModelCache } from "./provider-ui";
import {
  type HostMsg,
  type WebviewMsg,
} from "./protocol";
import { Session, turnIsInFlight } from "./session";
import {
  promoteHiddenChild,
  promotedSessionName,
  type HiddenReason,
} from "./session-type";
import { type SessionMetaOverrides } from "./sessions";
import {
  type SubagentDirective,
  parseSubagentMentions,
  renderDirectiveBlock,
  unfollowedDirectives,
} from "./subagent-directives";
import {
  isEffortLevel,
  listEligibleTargets,
  resolveTarget,
  PERMISSION_PROFILES,
  type EligibilityInput,
  type EligibilityResult,
  type RefusalCode,
  type RosterEntry,
  type SpawnLimits,
} from "./target-eligibility";
import { findStage, type WorkflowDefinition } from "./workflow";
import { isGeneratorOnlyTool } from "./workflow-generator";
import { bindStageSession } from "./workflow-run";
import { SESSION_META_KEY } from "./worktree-host";

export const SUBAGENT_INDEX_KEY = "companions.subagents.index";
export const PROVIDER_MODEL_CACHE_KEY = "grok.providerModelCache";

export interface SubagentMcpOps {
  hostPipe(): HostPipeMux;
  reservedMcpIdentityFor(session: Session): { names: string[] };
}

export interface SubagentWorktreeOps {
  createCrewWorktree(cwd: string, branch: string): Promise<{ path: string; label: string; sourceGitRoot: string } | { error: string }>;
  applyCrewWorktree(session: Session, wt: { path: string; label: string; sourceGitRoot: string }): Promise<void>;
  worktreeLocal(): { remove(opts: { worktreePath: string; force?: boolean }): Promise<any> };
}

export interface SubagentLifecycleOps {
  emitWorkflowRun(session: Session): void;
  persistWorkflowRun(session: Session): void;
  getWorkflowDefs?(): Map<string, WorkflowDefinition> | undefined;
  getWorkflowStore?(): any;
  handleGeneratorTool?(session: Session, call: CompanionsCall): void;
  turnEndFields(session: Session, status: any): Record<string, unknown>;
  noteLiveTurnEnded(session: Session): void;
  noteSessionActivity?(session: Session): void;
  setProviderNeedsLogin(provider: AcpProvider, needed: boolean): void;
  maybeGenerateTitle(session: Session): void;
  postSessionName(session: Session): void;
  postSessionsList(): void;
  sessionCacheDelete(id: string): void;
}

export interface SubagentHostDeps {
  readonly host: Host;
  readonly context: HostContext;
  readonly state: PersistedState;
  readonly agentRuns: AgentRunStore;
  readonly pool: Set<Session>;
  getFocused(): Session | undefined;
  focusSession(session: Session): void;
  sessionCwd(session?: Session): string;
  emit(session: Session, msg: HostMsg): void;
  post(msg: HostMsg): void;
  setStatus(session: Session, status: Session["status"]): void;
  sessionTypeMetaFor(session: Session): SessionMetaOverrides[string] | undefined;
  agentNotice(session: Session, level: "info" | "warning" | "error", text: string): void;
  confirmInChat(session: Session, opts: { title: string; body?: string; confirmLabel: string; danger?: boolean }): Promise<boolean | void>;
  runAgentRole(role: AgentRole, brief: BriefingInput, trigger: AgentRunTrigger, caller: Session, coords?: any): Promise<any>;
  usableProviders(): AcpProvider[];
  companionsSetting<T>(key: string, fallback: T): T;
  agentRoleSet(cwd: string): AgentRoleSet;
  sessionDisplayName(session: Session): string;
  steerSend(text: string, session: Session): Promise<void>;
  crewFileClaims(): FileClaimStore;
  readonly mcpOps: SubagentMcpOps;
  readonly worktreeOps: SubagentWorktreeOps;
  readonly lifecycleOps: SubagentLifecycleOps;
  getOverride?<T extends (...args: any[]) => any>(name: string): T | undefined;
}

export interface SubagentState {
  registry: SubagentRegistry;
  reports: Map<string, string>;
  waiters: Map<string, Array<() => void>>;
  outcomes: Map<string, any>;
}

export class SubagentHost {
  public companionsChannel?: CompanionsHostServer;
  private maxDepthClampReported = false;
  public childRelayTable?: ChildRelayTable<Session>;
  private stallWatch?: ReturnType<typeof setInterval>;
  private runningChildrenTimer?: ReturnType<typeof setTimeout>;
  private pendingSubagentApprovals?: Map<string, (answer: { approved: boolean; adjusted?: Record<string, unknown> }) => void>;
  public subagentDeadlines?: Map<string, PausableDeadline>;
  private subagentTimers?: Map<string, ReturnType<typeof setTimeout>>;

  public state?: SubagentState;

  constructor(public readonly deps: SubagentHostDeps) {}

  public dispose(): void {
    if (this.stallWatch) {
      clearInterval(this.stallWatch);
      this.stallWatch = undefined;
    }
    if (this.runningChildrenTimer) {
      clearTimeout(this.runningChildrenTimer);
      this.runningChildrenTimer = undefined;
    }
    if (this.subagentTimers) {
      for (const timer of this.subagentTimers.values()) {
        clearTimeout(timer);
      }
      this.subagentTimers.clear();
    }
    this.companionsChannel?.dispose();
    this.companionsChannel = undefined;
  }

  private getOverride<T extends (...args: any[]) => any>(name: string): T | undefined {
    return this.deps.getOverride?.(name);
  }

  public get subagents(): SubagentRegistry {
    const override = this.getOverride<any>("subagents");
    if (override !== undefined) {
      return typeof override === "function" ? override() : override;
    }
    return this.subagentStore().registry;
  }
  public get reports(): Map<string, string> {
    const override = this.getOverride<any>("subagentReports");
    if (override !== undefined) return typeof override === "function" ? override() : override;
    return this.subagentStore().reports;
  }
  public get waiters(): Map<string, Array<() => void>> {
    const override = this.getOverride<any>("subagentWaiters");
    if (override !== undefined) return typeof override === "function" ? override() : override;
    return this.subagentStore().waiters;
  }
  public get outcomes(): Map<string, any> {
    const override = this.getOverride<any>("subagentOutcomes");
    if (override !== undefined) return typeof override === "function" ? override() : override;
    return this.subagentStore().outcomes;
  }

  public subagentStore(): SubagentState {
    if (!this.state) {
      this.state = {
        registry: new SubagentRegistry(),
        reports: new Map(),
        waiters: new Map(),
        outcomes: new Map(),
      };
    }
    return this.state;
  }

  public relayTable(): ChildRelayTable<Session> {
    if (!this.childRelayTable) this.childRelayTable = new ChildRelayTable<Session>();
    return this.childRelayTable;
  }

  public hiddenReasonOf(session: Session): HiddenReason | undefined {
    return session.pendingHiddenChild?.hiddenReason ?? this.deps.sessionTypeMetaFor(session)?.hiddenReason;
  }

  public poolSessionById(sessionId: string | undefined): Session | undefined {
    if (!sessionId) return undefined;
    for (const session of (this.deps.pool ?? [])) {
      if (session.activeSessionId === sessionId) return session;
    }
    return undefined;
  }

  public parentSessionOf(session: Session): Session | undefined {
    const parentId = session.pendingHiddenChild?.parentSessionId
      ?? this.deps.sessionTypeMetaFor(session)?.parentSessionId;
    if (!parentId) return undefined;
    return this.poolSessionById(parentId);
  }

  public visibleAncestorOf(session: Session): Session {
    let current = session;
    for (let hops = 0; hops < SUBAGENT_MAX_DEPTH_CAP + 1; hops += 1) {
      const hidden = current.pendingHiddenChild?.hiddenReason
        ?? this.deps.sessionTypeMetaFor(current)?.hiddenReason;
      if (!hidden) return current;
      const parent = this.parentSessionOf(current);
      if (!parent) return current;
      current = parent;
    }
    return current;
  }

  public relayOriginFor(child: Session, route: string): RelayOrigin {
    const reason = this.hiddenReasonOf(child);
    const id = child.pendingHiddenChild?.subagentId ?? this.deps.sessionTypeMetaFor(child)?.subagentId ?? "";
    const kind: ChildKind = reason === "crew-stage" ? "stage" : "subagent";
    let name: string;
    if (reason === "crew-stage") {
      const stageId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
      const runId = id.includes(":") ? id.slice(0, id.indexOf(":")) : "";
      const def = runId ? this.deps.lifecycleOps.getWorkflowDefs?.()?.get(runId) : undefined;
      name = (def && findStage(def, stageId)?.title) || stageId || "Stage";
    } else if (reason === "workflow-generator") {
      name = "Workflow generator";
    } else {
      name = this.subagents.get(id)?.label ?? "Subagent";
    }
    return {
      kind,
      route,
      scopeWord: relayScopeWord(kind),
      label: relayOriginLabel({
        kind,
        name,
        providerName: providerDisplayName(child.provider),
        ...(child.client?.currentModelId ? { model: child.client.currentModelId } : {}),
      }),
    };
  }

  public relayFromChild(child: Session, message: HostMsg): void {
    const override = this.getOverride<typeof this.relayFromChild>("relayFromChild");
    if (override) return override(child, message);

    if (message.type === "hostNotice" && message.level === "warning" && /^Denied by /.test(message.text)) {
      if (!this.hiddenReasonOf(child)) return;
      const ancestor = this.visibleAncestorOf(child);
      if (ancestor === child) return;
      const origin = this.relayOriginFor(child, "");
      this.deps.emit(ancestor, { type: "hostNotice", level: "warning", text: `${origin.label}: ${message.text}` });
      return;
    }
    if (
      message.type !== "permissionRequest" && message.type !== "questionRequest" && message.type !== "exitPlanRequest"
      && message.type !== "permissionOptions" && message.type !== "permissionResolved"
      && message.type !== "planResolved" && message.type !== "questionResolved"
    ) return;
    if (!this.hiddenReasonOf(child)) return;
    const table = this.relayTable();
    if (message.type === "permissionRequest" || message.type === "questionRequest" || message.type === "exitPlanRequest") {
      const ancestor = this.visibleAncestorOf(child);
      if (ancestor === child) return;
      const kind: RelayKind = message.type;
      const route = table.open(child, ancestor, message.req.id, kind);
      const origin = this.relayOriginFor(child, route);
      if (message.type === "permissionRequest") {
        const outOfScope = this.outsideStageScope(child, message.req);
        this.deps.emit(ancestor, {
          ...message,
          req: { ...message.req, id: route },
          origin: outOfScope ? { ...origin, outOfScope: true } : origin,
          ...(message.ruleSuggestions ? { ruleSuggestions: childScopedSuggestions(message.ruleSuggestions) } : {}),
        });
      } else if (message.type === "questionRequest") {
        this.deps.emit(ancestor, { ...message, req: { ...message.req, id: route }, origin });
      } else {
        this.deps.emit(ancestor, { ...message, req: { ...message.req, id: route }, origin });
      }
      if (ancestor.status !== "needs-you") {
        ancestor.statusBeforeChildAsk = ancestor.status;
        this.deps.setStatus(ancestor, "needs-you");
      }
      this.childNeedsYouChanged(child, true);
      this.notifyChildNeedsYou(ancestor, origin, kind);
      return;
    }
    const route = table.routeFor(child, message.requestId);
    if (!route) return;
    const entry = table.resolve(route)!;
    this.deps.emit(entry.ancestor, { ...message, requestId: route } as HostMsg);
    if (message.type === "permissionOptions") return;
    table.close(route);
    this.afterRelayClosed(entry.ancestor, child);
  }

  public activityOwnerOf(child: Session): ActivityOwner | undefined {
    const reason = this.hiddenReasonOf(child);
    const id = child.pendingHiddenChild?.subagentId ?? this.deps.sessionTypeMetaFor(child)?.subagentId ?? "";
    if (!id) return undefined;
    if (reason === "crew-stage") return { kind: "stage", id };
    if (reason === "companion-subagent") return { kind: "subagent", id };
    return undefined;
  }

  public tapChildActivity(child: Session, message: HostMsg): void {
    const override = this.getOverride<typeof this.tapChildActivity>("tapChildActivity");
    if (override) return override(child, message);

    const item = activityItemFromHostMsg(message);
    if (!item) return;
    const owner = this.activityOwnerOf(child);
    if (!owner) return;
    child.lastChildActivityAt = Date.now();
    if (child.stalled) {
      child.stalled = false;
      const parent = this.parentSessionOf(child);
      if (parent?.workflowRun) this.deps.lifecycleOps.emitWorkflowRun(parent);
    }
    (child.childActivityQueue ??= []).push(item);
    if (child.childActivityTimer) return;
    const timer = setTimeout(() => this.flushChildActivity(child), ACTIVITY_FLUSH_MS);
    (timer as { unref?: () => void }).unref?.();
    child.childActivityTimer = timer;
  }

  public flushChildActivity(child: Session): void {
    child.childActivityTimer = undefined;
    const queued = child.childActivityQueue ?? [];
    child.childActivityQueue = [];
    const owner = this.activityOwnerOf(child);
    if (!owner || !queued.length) return;
    const ancestor = this.visibleAncestorOf(child);
    if (ancestor === child) return;
    const items = coalesceActivity(queued);
    this.deps.emit(ancestor, { type: "childActivity", owner, items, lastLine: activityLastLine(items) });
  }

  public noteChildStarted(caller: Session, child: Session, subagentId?: string): void {
    const override = this.getOverride<typeof this.noteChildStarted>("noteChildStarted");
    if (override) return override(caller, child, subagentId);

    this.postRunningChildren();
    const now = Date.now();
    child.childStartedAt = now;
    child.lastChildActivityAt = now;
    child.stalled = false;
    const sessionId = child.activeSessionId;
    if (subagentId && sessionId) {
      this.subagents.update(subagentId, { childSessionId: sessionId }, now);
      this.postSubagentCard(caller, subagentId);
    }
    if (this.hiddenReasonOf(child) === "crew-stage" && caller.workflowRun?.current && sessionId) {
      caller.workflowRun = bindStageSession(caller.workflowRun, sessionId);
      this.deps.lifecycleOps.persistWorkflowRun(caller);
      this.deps.lifecycleOps.emitWorkflowRun(caller);
      this.ensureStallWatch();
    }
  }

  public ensureStallWatch(): void {
    if (this.stallWatch) return;
    const t = setInterval(() => this.checkStalls(), 15_000);
    (t as { unref?: () => void }).unref?.();
    this.stallWatch = t;
  }

  public checkStalls(now = Date.now()): void {
    const override = this.getOverride<typeof this.checkStalls>("checkStalls");
    if (override) return override(now);

    const warnMs = normalizeStallWarningSec(this.deps.companionsSetting<number>("crew.stallWarningSec", 300)) * 1000;
    let any = false;
    const pool = this.deps.pool && typeof (this.deps.pool as any)[Symbol.iterator] === "function" ? this.deps.pool : [];
    for (const parent of pool) {
      for (const live of parent.crewLive ?? []) {
        any = true;
        const child = live.roleSession;
        if (!child.lastChildActivityAt) continue;
        const state = stageStallState({
          lastActivityAt: child.lastChildActivityAt,
          now,
          warnAfterMs: warnMs,
          needsYou: this.childWaitsForYou(child),
        });
        const stalled = state === "stalled";
        if (stalled !== !!child.stalled) {
          child.stalled = stalled;
          if (parent.workflowRun) this.deps.lifecycleOps.emitWorkflowRun(parent);
          this.postRunningChildren();
        }
      }
    }
    if (!any && this.stallWatch) {
      clearInterval(this.stallWatch);
      this.stallWatch = undefined;
    }
  }

  public noteNativeChild(session: Session, update: unknown): void {
    const override = this.getOverride<typeof this.noteNativeChild>("noteNativeChild");
    if (override) return override(session, update);

    const u = update as { sessionUpdate?: string; subagent_id?: string; subagentId?: string; description?: string; task?: string; name?: string };
    const id = String(u.subagent_id ?? u.subagentId ?? "");
    if (!id) return;
    if (!session.nativeChildren) session.nativeChildren = new Map();
    if (u.sessionUpdate === "subagent_spawned") {
      session.nativeChildren.set(id, { label: String(u.description ?? u.name ?? u.task ?? "Grok subagent").slice(0, 80), startedAt: Date.now() });
    } else {
      session.nativeChildren.delete(id);
    }
    this.postRunningChildren();
  }

  public postRunningChildren(): void {
    const override = this.getOverride<typeof this.postRunningChildren>("postRunningChildren");
    if (override) return override();

    if (this.runningChildrenTimer) return;
    const t = setTimeout(() => {
      this.runningChildrenTimer = undefined;
      this.deps.post({ type: "runningChildren", ...this.runningChildrenSnapshot() });
    }, 300);
    (t as { unref?: () => void }).unref?.();
    this.runningChildrenTimer = t;
  }

  public runningChildrenSnapshot(now = Date.now()): Omit<Extract<HostMsg, { type: "runningChildren" }>, "type"> {
    const override = this.getOverride<typeof this.runningChildrenSnapshot>("runningChildrenSnapshot");
    if (override) return override(now);

    type Row = { kind: "stage" | "subagent" | "native"; id: string; label: string; target: string; status: ChildStatus; startedAt: number; tokens?: number; sessionId?: string };
    const groups: Array<{ parentSessionId: string; parentName: string; children: Row[] }> = [];
    let needYou = 0;
    const pool = this.deps.pool && typeof (this.deps.pool as any)[Symbol.iterator] === "function" ? this.deps.pool : [];
    for (const parent of pool) {
      if (this.hiddenReasonOf(parent)) continue;
      const children: Row[] = [];
      for (const live of parent.crewLive ?? []) {
        const child = live.roleSession;
        const waiting = this.childWaitsForYou(child);
        if (waiting) needYou += 1;
        const run = parent.workflowRun;
        const def = run ? this.deps.lifecycleOps.getWorkflowDefs?.()?.get(run.runId) : undefined;
        const stageId = run?.current?.stageId ?? "";
        children.push({
          kind: "stage",
          id: `${run?.runId ?? live.runId}:${stageId}`,
          label: (def && findStage(def, stageId)?.title) || live.roleName,
          target: [providerDisplayName(child.provider), child.client?.currentModelId].filter(Boolean).join(" · "),
          status: waiting ? "needs-you" : child.stalled ? "stalled" : "running",
          startedAt: child.childStartedAt ?? now,
          ...(child.activeSessionId ? { sessionId: child.activeSessionId } : {}),
        });
      }
      for (const handle of parent.subagentLive ?? []) {
        const record = this.subagents.get(handle.subagentId);
        if (!record) continue;
        const waiting = this.childWaitsForYou(handle.roleSession);
        if (waiting) needYou += 1;
        children.push({
          kind: "subagent",
          id: record.subagentId,
          label: record.label,
          target: [providerDisplayName(record.target.provider), record.target.model].filter(Boolean).join(" · "),
          status: subagentChildStatus(record.status, { needsYou: waiting }),
          startedAt: record.startedAt,
          ...(typeof record.tokens === "number" ? { tokens: record.tokens } : {}),
          ...(record.childSessionId ? { sessionId: record.childSessionId } : {}),
        });
      }
      for (const [id, native] of parent.nativeChildren ?? []) {
        children.push({ kind: "native", id, label: native.label, target: "Grok · built-in", status: "running", startedAt: native.startedAt });
      }
      if (children.length) {
        groups.push({
          parentSessionId: parent.activeSessionId ?? "",
          parentName: this.deps.sessionDisplayName(parent) || "This conversation",
          children,
        });
      }
    }
    return { groups, needYou };
  }

  public jumpToWaitingApproval(): boolean {
    const entry = this.relayTable().all()[0];
    const pool = this.deps.pool && typeof (this.deps.pool as any)[Symbol.iterator] === "function" ? this.deps.pool : [];
    const holder = entry?.ancestor
      ?? [...pool].find((s) => s.status === "needs-you" && !this.hiddenReasonOf(s));
    if (!holder) return false;
    const focused = this.deps.getFocused();
    if (holder !== focused && this.deps.pool.has(holder)) this.deps.focusSession(holder);
    void this.deps.host.revealChatView?.();
    this.deps.post({ type: "scrollToWaiting" });
    return true;
  }

  public async childOverviewAction(msg: { action: string; kind?: string; id?: string; parentSessionId?: string; sessionId?: string }): Promise<void> {
    const override = this.getOverride<typeof this.childOverviewAction>("childOverviewAction");
    if (override) return override(msg);

    const parent = this.poolSessionById(msg.parentSessionId);
    if (msg.action === "jump") {
      if (!this.jumpToWaitingApproval()) this.deps.host.appendLine("[companions] nothing is waiting for you");
      return;
    }
    if (msg.action === "open") {
      const live = this.poolSessionById(msg.sessionId);
      if (live) this.deps.focusSession(live);
      else if (parent) this.deps.focusSession(parent);
      return;
    }
    if (msg.action === "stop" && parent) {
      if (msg.kind === "stage") {
        for (const live of parent.crewLive ?? []) {
          live.cancelled = true;
          void live.roleSession.client?.cancel("stopped from the running-children overview");
        }
      } else if (msg.kind === "subagent" && msg.id) {
        this.cancelSubagent(msg.id, "the user stopped it from the running-children overview");
        this.postSubagentCard(parent, msg.id);
        this.postSubagentTray(parent);
      }
      this.postRunningChildren();
    }
  }

  public runningStageSession(parent: Session): Session | undefined {
    return (parent.crewLive ?? []).find((live) => !live.cancelled)?.roleSession;
  }

  public async sendToRunningStage(parent: Session, text: string, mode: "steer" | "note"): Promise<void> {
    const override = this.getOverride<typeof this.sendToRunningStage>("sendToRunningStage");
    if (override) return override(parent, text, mode);

    const body = text.trim();
    if (!body) return;
    const run = parent.workflowRun;
    const child = this.runningStageSession(parent);
    const def = run ? this.deps.lifecycleOps.getWorkflowDefs?.()?.get(run.runId) : undefined;
    const title = run?.current && def ? findStage(def, run.current.stageId)?.title ?? run.current.stageId : "the stage";
    if (mode === "note" || !child) {
      if (run) {
        parent.workflowRun = { ...run, pendingNotes: [run.pendingNotes, body].filter(Boolean).join("\n") };
        this.deps.lifecycleOps.persistWorkflowRun(parent);
      }
      this.deps.emit(parent, { type: "userMessage", text: body, chips: [] });
      this.deps.agentNotice(parent, "info", `→ noted for the next stage`);
      return;
    }
    this.deps.emit(parent, { type: "userMessage", text: body, chips: [] });
    this.deps.agentNotice(parent, "info", `→ sent to ${title}`);
    await this.deps.steerSend(body, child);
  }

  public postChildContext(session: Session): void {
    const override = this.getOverride<typeof this.postChildContext>("postChildContext");
    if (override) return override(session);

    const reason = this.hiddenReasonOf(session);
    if (!reason || reason === "workflow-generator") {
      this.deps.emit(session, { type: "childContext", context: null });
      return;
    }
    const parentId = session.pendingHiddenChild?.parentSessionId ?? this.deps.sessionTypeMetaFor(session)?.parentSessionId ?? "";
    const origin = this.relayOriginFor(session, "");
    const running = session.status === "working" || session.status === "needs-you";
    this.deps.emit(session, {
      type: "childContext",
      context: {
        kind: origin.kind,
        label: origin.label,
        parentSessionId: parentId,
        running,
        canSteer: providerCapability(session.provider, "steer").state !== "no",
      },
    });
  }

  public outsideStageScope(child: Session, req: PermissionRequest): boolean {
    const globs = child.stageScope;
    if (!globs) return false;
    const facts = extractPermissionFacts(req.toolCall);
    if (facts.kind !== "edit" || facts.paths.length === 0) return false;
    const root = this.deps.sessionCwd(child);
    return !facts.paths.every((p: string) => globs.some((g: string) => pathMatchesGlob(g, p, root)));
  }

  public afterRelayClosed(ancestor: Session, child: Session): void {
    const table = this.relayTable();
    if (table.pendingIn(ancestor).length === 0 && ancestor.status === "needs-you") {
      const before = ancestor.statusBeforeChildAsk;
      ancestor.statusBeforeChildAsk = undefined;
      if (ancestor.pendingPermissions.size === 0 && ancestor.pendingQuestions.size === 0) {
        this.deps.setStatus(ancestor, before && before !== "needs-you" ? before : "working");
      }
    }
    if (table.pendingFor(child) === 0) this.childNeedsYouChanged(child, false);
  }

  public closeChildRelays(child: Session): void {
    const override = this.getOverride<typeof this.closeChildRelays>("closeChildRelays");
    if (override) return override(child);

    for (const entry of this.relayTable().closeChild(child)) {
      if (entry.kind === "questionRequest") {
        this.deps.emit(entry.ancestor, { type: "questionResolved", requestId: entry.route, outcome: "closed" });
      } else if (entry.kind === "exitPlanRequest") {
        this.deps.emit(entry.ancestor, { type: "planResolved", requestId: entry.route, verdict: "abandoned" });
      } else {
        this.deps.emit(entry.ancestor, { type: "permissionResolved", requestId: entry.route, optionId: "" });
      }
      this.afterRelayClosed(entry.ancestor, child);
    }
  }

  public childNeedsYouChanged(child: Session, needsYou: boolean): void {
    this.postRunningChildren();
    const reason = this.hiddenReasonOf(child);
    const id = child.pendingHiddenChild?.subagentId ?? this.deps.sessionTypeMetaFor(child)?.subagentId ?? "";
    const parent = this.parentSessionOf(child);
    if (reason === "companion-subagent") {
      const deadline = this.subagentDeadlines?.get(id);
      if (deadline) {
        if (needsYou) deadline.pause(Date.now());
        else deadline.resume(Date.now());
        this.rearmSubagentTimer(id);
      }
      if (parent) this.postSubagentCard(parent, id);
    } else if (reason === "crew-stage" && parent?.workflowRun) {
      this.deps.lifecycleOps.emitWorkflowRun(parent);
    }
  }

  public childWaitsForYou(child: Session | undefined): boolean {
    return !!child && this.relayTable().pendingFor(child) > 0;
  }

  public notifyChildNeedsYou(ancestor: Session, origin: RelayOrigin, kind: RelayKind): void {
    if (this.deps.host.isWindowFocused?.() !== false) return;
    if (this.deps.companionsSetting<boolean>("notifications.childNeedsYou", true) === false) return;
    const name = origin.label.replace(/^(Stage|Subagent) "/, "").replace(/".*$/, "");
    void this.deps.host.showInformationMessage(childNeedsYouNotice(origin.kind, name, kind), "Show").then((pick) => {
      if (pick !== "Show") return;
      const focused = this.deps.getFocused();
      if (ancestor !== focused && this.deps.pool.has(ancestor)) this.deps.focusSession(ancestor);
      void this.deps.host.revealChatView?.();
    });
  }

  public resolveRelayedAnswer(msg: WebviewMsg): { session: Session; msg: WebviewMsg } | undefined {
    const override = this.getOverride<typeof this.resolveRelayedAnswer>("resolveRelayedAnswer");
    if (override) return override(msg);

    if (
      msg.type !== "permissionAnswer" && msg.type !== "exitPlanAnswer" && msg.type !== "questionAnswer"
      && msg.type !== "questionCancel" && msg.type !== "questionDraft"
    ) return undefined;
    const entry = this.childRelayTable?.resolve(msg.requestId);
    if (!entry) return undefined;
    return { session: entry.child, msg: { ...msg, requestId: entry.requestId } as WebviewMsg };
  }

  public companions(): CompanionsHostServer {
    const override = this.getOverride<typeof this.companions>("companions");
    if (override) return override();
    if (!this.companionsChannel) {
      this.companionsChannel = new CompanionsHostServer({
        mux: this.deps.mcpOps.hostPipe(),
        scriptPath: path.join(this.deps.context?.extensionUri?.fsPath ?? "", "resources", "mcp", "companions-server.cjs"),
        log: (message) => this.deps.host.appendLine(message),
        onCall: (token, call) => {
          const session = this.sessionForCompanionsToken(token);
          if (!session) {
            call.fail("This session's delegation channel has ended. Continue alone and tell the user why.");
            return;
          }
          void this.handleCompanionsCall(session, call);
        },
        onAbandon: (token, id) => {
          const session = this.sessionForCompanionsToken(token);
          if (!session) return;
          this.deps.host.appendLine(`[companions] call ${id} was abandoned; cancelling its subagents`);
          this.cancelSubagentsOf(session, "the parent session ended");
        },
      });
    }
    return this.companionsChannel;
  }

  public sessionForCompanionsToken(token: string): Session | undefined {
    for (const session of (this.deps.pool ?? [])) {
      if (session.companionsToken === token) return session;
    }
    return undefined;
  }

  public revokeCompanionsToken(session: Session): void {
    if (!session.companionsToken) return;
    this.companionsChannel?.revoke(session.companionsToken);
    session.companionsToken = undefined;
  }

  public async companionsMcpServer(session: Session): Promise<AcpMcpStdioServer | undefined> {
    const override = this.getOverride<typeof this.companionsMcpServer>("companionsMcpServer");
    if (override) return override(session);
    const hidden = session.pendingHiddenChild?.hiddenReason
      ?? this.deps.sessionTypeMetaFor(session)?.hiddenReason;
    const stored = this.deps.sessionTypeMetaFor(session)?.subagentsEnabled;
    const decision = decideCompanionsMcp({
      ...(hidden ? { hiddenReason: hidden } : {}),
      sessionType: session.sessionType ?? "agent",
      subagentsEnabled: stored ?? this.subagentsEnabledGlobally(),
      stageMayDelegate: this.stageMayDelegate(session),
      depth: session.pendingHiddenChild?.depth
        ?? this.deps.sessionTypeMetaFor(session)?.depth
        ?? 0,
      maxDepth: this.subagentMaxDepth(),
    });
    if (decision.kind === "skip") {
      this.noteCompanionsSkip(session, decision.reason);
      return undefined;
    }
    return this.spawnCompanionsServer(session, decision.mode);
  }

  public noteCompanionsSkip(session: Session, reason: CompanionsSkipReason): void {
    session.companionsMcpInjected = false;
    session.companionsSkipReason = reason;
    this.deps.host.appendLine(`[companions] not offering delegation: ${reason}`);
    const hidden = session.pendingHiddenChild?.hiddenReason
      ?? this.deps.sessionTypeMetaFor(session)?.hiddenReason;
    if (!shouldAnnounceCompanionsSkip(reason, hidden) || session.companionsSkipAnnounced) return;
    session.companionsSkipAnnounced = true;
    this.deps.emit(session, {
      type: "hostNotice",
      level: "warning",
      text: companionsSkipNotice(reason),
    });
  }

  public subagentMaxDepth(): 1 | 2 {
    const override = this.getOverride<typeof this.subagentMaxDepth>("subagentMaxDepth");
    if (override) return override();
    const { depth, clamped } = resolveMaxDepth(
      this.deps.companionsSetting<number>("subagents.maxDepth", 1),
    );
    if (clamped && !this.maxDepthClampReported) {
      this.maxDepthClampReported = true;
      this.deps.host.appendLine(
        `[companions] companions.subagents.maxDepth is out of range; using ${depth}. `
        + "Delegation is capped at two levels by design.",
      );
    }
    return depth;
  }

  public stageMayDelegate(session: Session): boolean {
    const override = this.getOverride<typeof this.stageMayDelegate>("stageMayDelegate");
    if (override) return override(session);
    if (!this.deps.companionsSetting<boolean>("crew.stagesMayUseSubagents", false)) return false;
    return session.stageAllowsSubagents === true;
  }

  public async spawnCompanionsServer(
    session: Session,
    mode: "delegate" | "generator",
  ): Promise<AcpMcpStdioServer | undefined> {
    const override = this.getOverride<typeof this.spawnCompanionsServer>("spawnCompanionsServer");
    if (override) return override(session, mode);
    if (providerCapability(session.provider, "hostMcp").state !== "yes") {
      this.noteCompanionsSkip(session, "host-mcp-unproven");
      return undefined;
    }
    const reserved = this.deps.mcpOps.reservedMcpIdentityFor(session);
    if (reserved.names.some((name) => normalizeMcpName(name) === COMPANIONS_SERVER_NAME)) {
      this.noteCompanionsSkip(session, "name-collision");
      return undefined;
    }
    const channel = this.companions();
    if (!(await channel.listen())) {
      this.noteCompanionsSkip(session, "pipe-failed");
      return undefined;
    }
    this.revokeCompanionsToken(session);
    session.companionsToken = channel.register(mode);
    const spec = channel.spawnSpec(session.companionsToken);
    if (!spec) {
      this.noteCompanionsSkip(session, "pipe-failed");
      return undefined;
    }
    session.companionsMcpInjected = true;
    session.companionsSkipReason = undefined;
    return spec;
  }

  public subagentsCouldBeUsedIn(session: Session): boolean {
    if (session.sessionType !== "agent") return false;
    if (session.delegationOverride) return session.delegationOverride.enabled;
    const stored = this.deps.sessionTypeMetaFor(session)?.subagentsEnabled;
    return stored ?? this.subagentsEnabledGlobally();
  }

  public subagentsEnabledGlobally(): boolean {
    try {
      return this.deps.host.getConfiguration("companions").get<boolean>("subagents.enabled", true) !== false;
    } catch {
      return true;
    }
  }

  public subagentRoster(): Partial<Record<AcpProvider, RosterEntry>> {
    const raw = this.deps.companionsSetting<Record<string, unknown>>("subagents.roster", {});
    const roster: Partial<Record<AcpProvider, RosterEntry>> = {};
    for (const provider of ACP_PROVIDERS) {
      const entry = (raw?.[provider] ?? {}) as Record<string, unknown>;
      const str = (value: unknown): string | undefined => {
        const text = typeof value === "string" ? value.trim() : "";
        return text || undefined;
      };
      const candidateDefaultEffort = isEffortLevel(entry.defaultEffort) ? entry.defaultEffort : undefined;
      const candidateMaxEffort = isEffortLevel(entry.maxEffort) ? entry.maxEffort : undefined;
      roster[provider] = {
        enabled: entry.enabled !== false,
        allowedModels: Array.isArray(entry.allowedModels)
          ? entry.allowedModels.filter((id): id is string => typeof id === "string" && !id.trim())
          : [],
        ...(str(entry.defaultModel) ? { defaultModel: str(entry.defaultModel) } : {}),
        ...(candidateDefaultEffort ? { defaultEffort: candidateDefaultEffort } : {}),
        ...(candidateMaxEffort ? { maxEffort: candidateMaxEffort } : {}),
        ...(str(entry.notes) ? { notes: str(entry.notes) } : {}),
        allowWrite: entry.allowWrite !== false,
      };
    }
    return roster;
  }

  public subagentLimits(session: Session, turnId: string): SpawnLimits {
    const configured = (key: string, fallback: number) =>
      Math.max(1, Number(this.deps.companionsSetting(`subagents.limits.${key}`, fallback)) || fallback);
    const counts = this.subagents.counts(session.activeSessionId ?? "", turnId);
    const own: SpawnLimits = {
      ...counts,
      maxConcurrent: configured("maxConcurrent", 3),
      maxPerTurn: configured("maxPerTurn", 4),
      maxPerSession: configured("maxPerSession", 20),
      poolHeadroom: Math.max(0, 16 - this.deps.pool.size),
    };
    const depth = this.deps.sessionTypeMetaFor(session)?.depth ?? 0;
    if (depth <= 0) return own;
    const parent = this.parentSessionOf(session);
    const parentCounts = parent
      ? this.subagents.counts(parent.activeSessionId ?? "", this.currentTurnId(parent))
      : { running: 0, thisTurn: 0, thisSession: 0 };
    const carved = carveChildLimits({ ...own, ...parentCounts });
    return { ...carved, ...counts };
  }

  public chainLabelFor(session: Session): string | undefined {
    const pending = session.pendingHiddenChild;
    const meta = this.deps.sessionTypeMetaFor(session);
    const reason = pending?.hiddenReason ?? meta?.hiddenReason;
    const id = pending?.subagentId ?? meta?.subagentId ?? "";
    if (reason === "crew-stage") {
      const stageId = id.includes(":") ? id.slice(id.indexOf(":") + 1) : id;
      return stageId ? `Stage: ${stageId}` : "A crew stage";
    }
    if (reason === "companion-subagent") {
      return this.subagents.get(id)?.label ?? "A subagent";
    }
    return undefined;
  }

  public eligibilityInput(session: Session, turnId: string): EligibilityInput {
    const cache = this.deps.state.get<ProviderModelCache>(PROVIDER_MODEL_CACHE_KEY, {});
    return {
      purpose: "subagent",
      usable: this.deps.usableProviders(),
      roster: this.subagentRoster(),
      capabilities: (provider) => ({
        companionSubagentTarget: providerCapability(provider, "companionSubagentTarget"),
        hostMcp: providerCapability(provider, "hostMcp"),
      }),
      models: (provider) => {
        const entry = cache[provider];
        return {
          checked: !!entry && Array.isArray(entry.models),
          models: (entry?.models ?? []).map((model) => ({
            id: model.modelId,
            ...(model.name ? { label: model.name } : {}),
            ...(model.reasoningEfforts?.length
              ? { efforts: model.reasoningEfforts.filter(isEffortLevel) }
              : {}),
            ...(typeof model.totalContextTokens === "number"
              ? { contextWindow: model.totalContextTokens }
              : {}),
            ...(entry?.currentModelId === model.modelId ? { isDefault: true } : {}),
          })),
        };
      },
      parent: {
        provider: session.provider,
        maxProfile: session.planActive ? "read-only" : "inherit",
        planMode: session.planActive,
      },
      limits: this.subagentLimits(session, turnId),
      exhausted: new Set<AcpProvider>(),
      displayName: providerDisplayName,
      effortDefaults: {
        ...(this.deps.sessionTypeMetaFor(session)?.subagentEffortOverride
          ? { sessionOverride: this.deps.sessionTypeMetaFor(session)!.subagentEffortOverride }
          : {}),
        global: (() => {
          const configured = this.deps.companionsSetting<string>("subagents.defaultEffort", "inherit");
          return configured === "inherit" || isEffortLevel(configured) ? (configured as EffortLevel | "inherit") : "inherit";
        })(),
        providerDefault: (provider: AcpProvider) => {
          const byProvider = this.deps.companionsSetting<Record<string, string>>("defaultEffortByProvider", {});
          const candidate = byProvider?.[provider] ?? this.deps.companionsSetting<string>("defaultEffort", "");
          return isEffortLevel(candidate) ? candidate : undefined;
        },
      },
      subagentsEnabled: this.subagentsCouldBeUsedIn(session),
      forbiddenThisTurn: session.subagentsForbiddenThisTurn === true,
    };
  }

  public currentTurnId(session: Session): string {
    const override = this.getOverride<typeof this.currentTurnId>("currentTurnId");
    if (override) return override(session);
    return String(session.userMessageCount);
  }

  public async handleCompanionsCall(session: Session, call: CompanionsCall): Promise<void> {
    try {
      const hidden = session.pendingHiddenChild?.hiddenReason
        ?? this.deps.sessionTypeMetaFor(session)?.hiddenReason;
      if (hidden === "workflow-generator" || isGeneratorOnlyTool(call.tool)) {
        if (this.deps.lifecycleOps.handleGeneratorTool) {
          this.deps.lifecycleOps.handleGeneratorTool(session, call);
          return;
        }
        call.fail("This tool is only available while generating a workflow.");
        return;
      }
      switch (call.tool) {
        case COMPANIONS_LIST_TOOL:
          call.resolve(this.companionsList(session, normalizeListArguments(call.args)));
          return;
        case COMPANIONS_SPAWN_TOOL: {
          const parsed = normalizeSpawnArguments(call.args);
          if (!parsed.ok) { call.fail(parsed.error); return; }
          await this.companionsSpawn(session, parsed.value, call);
          return;
        }
        case COMPANIONS_AWAIT_TOOL: {
          const parsed = normalizeAwaitArguments(call.args);
          if (!parsed.ok) { call.fail(parsed.error); return; }
          await this.companionsAwait(session, parsed.value, call);
          return;
        }
        default:
          call.fail(`Unknown tool: ${call.tool}`);
      }
    } catch (error) {
      this.deps.host.appendLine(`[companions] ${call.tool} failed: ${(error as Error).message}`);
      call.fail(`${call.tool} failed: ${(error as Error).message}`);
    }
  }

  public companionsList(session: Session, args: ListArguments): unknown {
    const input = this.eligibilityInput(session, this.currentTurnId(session));
    const listing = listEligibleTargets(input, args);
    return {
      targets: listing.targets,
      ...(args.includeIneligible
        ? { ineligible: listing.ineligible.map((entry) => ({ provider: entry.provider, reason: entry.reason })) }
        : {}),
      limits: {
        ...listing.limits,
        foregroundWaitSec: this.deps.companionsSetting("subagents.limits.foregroundWaitSec", 40),
        resultInlineChars: this.deps.companionsSetting("subagents.limits.resultInlineChars", 4000),
      },
      ...(listing.parent
        ? {
            parent: {
              ...listing.parent,
              ...(session.client?.currentModelId ? { model: session.client.currentModelId } : {}),
            },
          }
        : {}),
    };
  }

  public async companionsSpawn(
    session: Session,
    args: SpawnArguments,
    call: CompanionsCall,
  ): Promise<void> {
    const turnId = this.currentTurnId(session);
    const parentSessionId = session.activeSessionId ?? "";
    const directive = this.directiveForSpawn(session, args);
    const roleName = args.role ?? directive?.role;
    const roleTemplate = roleName
      ? findAgentRole(this.deps.agentRoleSet(this.deps.sessionCwd(session)), roleName)
      : undefined;
    let verdict = resolveTarget(
      {
        ...(args.provider ?? directive?.provider ? { provider: args.provider ?? directive?.provider } : {}),
        ...(args.model ?? directive?.model ? { model: args.model ?? directive?.model } : {}),
        ...(args.effort ?? directive?.effort ? { effort: args.effort ?? directive?.effort } : {}),
        ...(args.profile ?? directive?.profile ? { profile: args.profile ?? directive?.profile } : {}),
        ...(roleTemplate
          ? {
              role: {
                ...(roleTemplate.source !== "builtin" ? { provider: roleTemplate.provider } : {}),
                ...(roleTemplate.model ? { model: roleTemplate.model } : {}),
                ...(roleTemplate.effort && isEffortLevel(roleTemplate.effort) ? { effort: roleTemplate.effort } : {}),
                ...(roleTemplate.preferDifferentProvider ? { preferDifferentProvider: true } : {}),
              },
            }
          : {}),
      },
      this.eligibilityInput(session, turnId),
    );

    if (!verdict.ok) {
      const subagentId = `sa_${this.deps.agentRuns.newRunId()}`;
      this.subagents.add({
        subagentId,
        parentSessionId,
        runId: "",
        step: 0,
        label: args.label ?? deriveSubagentLabel(args.task),
        target: { provider: args.provider ?? session.provider },
        profile: args.profile ?? "read-only",
        status: "refused",
        startedAt: Date.now(),
        endedAt: Date.now(),
        background: args.wait === "none",
        spawnedInTurn: turnId,
        errorCode: verdict.code,
        refusalMessage: verdict.message,
        refusalAlternatives: verdict.alternatives.map((t) =>
          [providerDisplayName(t.provider), t.model, t.effort ? `effort ${t.effort}` : ""].filter(Boolean).join(" · ")),
      });
      this.postSubagentCard(session, subagentId);
      call.resolve({
        subagentId,
        ...refusalPayload(verdict.code, verdict.message, verdict.alternatives),
      });
      return;
    }

    const policy = this.sessionSpawnPolicy(session);
    const needsApproval = policy === "ask"
      || (policy === "auto-read-only" && verdict.profile !== "read-only");
    let adjustedByUser: Record<string, unknown> | undefined;
    if (needsApproval) {
      const answer = await this.askSubagentApproval(session, args, verdict);
      if (!answer.approved) {
        call.resolve({
          subagentId: `sa_${this.deps.agentRuns.newRunId()}`,
          ...refusalPayload("denied-by-user", "The user did not approve this subagent.", []),
        });
        return;
      }
      if (answer.adjusted) {
        adjustedByUser = answer.adjusted;
        args = {
          ...args,
          ...(typeof answer.adjusted.task === "string" ? { task: answer.adjusted.task } : {}),
          ...(isAcpProvider(answer.adjusted.provider) ? { provider: answer.adjusted.provider } : {}),
          ...(typeof answer.adjusted.model === "string" ? { model: answer.adjusted.model || undefined } : {}),
          ...(isEffortLevel(answer.adjusted.effort) ? { effort: answer.adjusted.effort } : {}),
          ...(answer.adjusted.profile === "read-only" || answer.adjusted.profile === "scoped-edit" || answer.adjusted.profile === "inherit"
            ? { profile: answer.adjusted.profile }
            : {}),
        };
        const again = resolveTarget(
          {
            ...(args.provider ? { provider: args.provider } : {}),
            ...(args.model ? { model: args.model } : {}),
            ...(args.effort ? { effort: args.effort } : {}),
            ...(args.profile ? { profile: args.profile } : {}),
          },
          this.eligibilityInput(session, turnId),
        );
        if (!again.ok) {
          call.resolve({ subagentId: `sa_${this.deps.agentRuns.newRunId()}`, ...refusalPayload(again.code, again.message, again.alternatives) });
          return;
        }
        verdict = again;
      }
    }

    const label = args.label ?? deriveSubagentLabel(args.task);
    const runId = this.deps.agentRuns.newRunId();
    const subagentId = `sa_${runId}`;
    const startedAt = Date.now();
    if (verdict.profile !== "read-only") {
      const conflict = this.preClaimSubagentFiles(runId, label, [...(args.files ?? []), ...(args.scope ?? [])]);
      if (conflict) {
        call.resolve({
          subagentId,
          ...refusalPayload("file-claimed", conflict, []),
        });
        return;
      }
    }
    this.subagents.add({
      subagentId,
      parentSessionId,
      runId,
      step: 1,
      label,
      target: verdict.target,
      profile: verdict.profile,
      status: "running",
      startedAt,
      background: args.wait === "none",
      spawnedInTurn: turnId,
      ...(directive ? { directiveId: directive.id } : {}),
      ...(roleName ? { roleName } : {}),
      modelVerified: verdict.modelVerified,
      sameProviderAsParent: verdict.sameProviderAsParent,
      ...(verdict.effortClamped ? { effortClamped: verdict.effortClamped } : {}),
      ...(verdict.profileDowngraded ? { profileDowngraded: verdict.profileDowngraded } : {}),
      ...(adjustedByUser ? { adjustedByUser } : {}),
    });
    this.rememberSubagentRun(session, runId);
    this.postSubagentCard(session, subagentId);

    const running = this.runCompanionSubagent(session, subagentId, args, verdict, roleTemplate);

    if (args.wait === "none") {
      call.resolve({
        subagentId,
        status: "running",
        target: this.targetPayload(verdict),
        profile: verdict.profile,
        ...(adjustedByUser ? { adjustedByUser } : {}),
      });
      void running;
      return;
    }

    const waitSec = Math.max(1, Number(this.deps.companionsSetting("subagents.limits.foregroundWaitSec", 40)));
    const finished = await this.raceSubagent(subagentId, waitSec * 1000);
    if (!finished) {
      call.resolve({
        subagentId,
        status: "running",
        target: this.targetPayload(verdict),
        profile: verdict.profile,
        ...(adjustedByUser ? { adjustedByUser } : {}),
      });
      return;
    }
    const payload = this.subagentResultPayload(subagentId, { markCollected: true }) as Record<string, unknown>;
    call.resolve(adjustedByUser ? { ...payload, adjustedByUser } : payload);
  }

  public async companionsAwait(
    session: Session,
    args: AwaitArguments,
    call: CompanionsCall,
  ): Promise<void> {
    const parentSessionId = session.activeSessionId ?? "";
    const mine = args.ids.filter((id: string) => this.subagents.get(id)?.parentSessionId === parentSessionId);
    const unknown = args.ids.filter((id: string) => !mine.includes(id));

    if (args.action === "cancel") {
      const status: Record<string, string> = {};
      for (const id of mine) {
        this.cancelSubagent(id, args.reason ?? "the main agent cancelled it");
        status[id] = this.subagents.get(id)?.status ?? "unknown";
      }
      for (const id of unknown) status[id] = "unknown";
      call.resolve({ status });
      return;
    }

    if (args.action === "continue") {
      const id = mine[0];
      if (!id) {
        call.resolve({ unknown });
        return;
      }
      const started = await this.continueSubagent(session, id, args.message ?? "");
      if (!started.ok) {
        call.resolve({ subagentId: id, ...refusalPayload(started.code, started.message, []) });
        return;
      }
      const cap = Math.max(1, Number(this.deps.companionsSetting("subagents.limits.foregroundWaitSec", 40)));
      const done = await this.raceSubagent(id, cap * 1000);
      call.resolve(done
        ? this.subagentResultPayload(id, { markCollected: true })
        : { subagentId: id, status: "running" });
      return;
    }

    if (args.action === "read") {
      const id = mine[0];
      const text = (id && (this.reports.get(id) ?? this.readSubagentReport(id))) ?? "";
      const offset = Math.max(0, args.offset ?? 0);
      const length = Math.max(1, args.length ?? 8000);
      const slice = text.slice(offset, offset + length);
      call.resolve({
        text: slice,
        offset,
        nextOffset: offset + slice.length,
        totalLength: text.length,
        ...(unknown.length ? { unknown } : {}),
      });
      return;
    }

    const cap = Math.max(1, Number(this.deps.companionsSetting("subagents.limits.foregroundWaitSec", 40)));
    const requested = args.maxWaitSec === undefined ? cap : args.maxWaitSec;
    const waitMs = Math.min(cap, Math.max(0, requested)) * 1000;
    if (waitMs > 0) await this.raceSubagents(mine, waitMs, args.mode);

    const completed: unknown[] = [];
    const running: string[] = [];
    for (const id of mine) {
      const record = this.subagents.get(id);
      if (record && isTerminalSubagentStatus(record.status)) {
        completed.push(this.subagentResultPayload(id, { markCollected: true }));
      } else {
        running.push(id);
      }
    }
    call.resolve({ completed, running, unknown });
  }

  public async runCompanionSubagent(
    session: Session,
    subagentId: string,
    args: SpawnArguments,
    verdict: Extract<EligibilityResult, { ok: true }>,
    roleTemplate: AgentRole | undefined,
  ): Promise<void> {
    const record = this.subagents.get(subagentId)!;
    const provider = verdict.target.provider;
    const role: AgentRole = {
      ...(roleTemplate ?? {
        name: "subagent",
        whenToUse: "A companion subagent started by the main agent.",
        source: "builtin" as const,
      }),
      name: roleTemplate?.name ?? "subagent",
      provider,
      ...(verdict.target.model ? { model: verdict.target.model } : {}),
      ...(verdict.target.effort ? { effort: verdict.target.effort } : {}),
      mode: SUBAGENT_RUN_MODE,
      ...(args.scope?.length ? { scope: args.scope } : roleTemplate?.scope ? { scope: roleTemplate.scope } : {}),
      permissions: subagentPermissionOverlay(
        verdict.profile,
        args.scope ?? roleTemplate?.scope ?? [],
        this.deps.companionsSetting<string[]>("subagents.readOnlyCommandAllowList", []),
      ),
      source: roleTemplate?.source ?? "builtin",
    };

    const timeoutSec = Math.max(
      30,
      args.timeoutSec ?? Number(this.deps.companionsSetting("subagents.limits.timeoutSec", 900)),
    );
    if (!this.subagentDeadlines) this.subagentDeadlines = new Map();
    this.subagentDeadlines.set(subagentId, new PausableDeadline(timeoutSec * 1000, Date.now()));
    this.rearmSubagentTimer(subagentId);
    const timer = { clear: () => this.clearSubagentDeadline(subagentId) };

    let childCwd: string | undefined;
    if (verdict.profile !== "read-only" && this.deps.companionsSetting<string>("subagents.writeIsolation", "shared") === "worktree") {
      const wt = await this.deps.worktreeOps.createCrewWorktree(this.deps.sessionCwd(session), `sa-${record.runId.slice(-12)}`);
      if ("error" in wt) {
        this.deps.host.appendLine(`[companions] ${subagentId}: no worktree (${wt.error}); running in the shared tree`);
      } else {
        childCwd = wt.path;
        this.subagents.update(subagentId, { worktree: { ...wt, state: "pending" } }, Date.now());
      }
    }
    try {
      const outcome = await this.deps.runAgentRole(
        role,
        {
          goal: session.firstUserMessageForTitle?.split("\n")[0] ?? "",
          task: args.task,
          ...(args.context ? { decisions: [args.context] } : {}),
          ...(args.files?.length ? { files: args.files } : {}),
          ...(args.acceptance ? { acceptance: args.acceptance } : {}),
          returnFormat: subagentReturnFormat(args.deliverable),
          forbidden: subagentForbidden(verdict.profile),
          provenance: [
            `Delegated by ${providerDisplayName(session.provider)}`
            + `${session.client?.currentModelId ? ` (${session.client.currentModelId})` : ""}`
            + ` in session ${session.activeSessionId ?? "?"}; this subagent sees only this brief.`,
          ],
        },
        "subagent",
        session,
        {
          runId: record.runId,
          step: 1,
          ...(childCwd ? { cwd: childCwd } : {}),
          subagent: { subagentId, label: record.label, profile: verdict.profile },
        },
      );
      timer.clear();
      if (outcome.rawReply !== undefined) this.writeSubagentRaw(record.runId, 1, outcome.rawReply);
      if (outcome.rawReply !== undefined) this.reports.set(subagentId, outcome.rawReply);
      if (verdict.profile !== "read-only") {
        await this.claimSubagentFiles(session, record, outcome.filesObserved);
      }
      this.subagents.update(
        subagentId,
        {
          status: outcome.outcome === "completed"
            ? "completed"
            : outcome.outcome === "cancelled" ? "cancelled" : "failed",
          ...(outcome.sessionId ? { childSessionId: outcome.sessionId } : {}),
          ...(outcome.totalTokens !== undefined ? { tokens: outcome.totalTokens } : {}),
          ...(this.poolSessionById(outcome.sessionId)?.client?.currentModelId
            ? { ranModel: this.poolSessionById(outcome.sessionId)!.client!.currentModelId }
            : {}),
        },
        Date.now(),
      );
      this.outcomes.set(subagentId, outcome);
    } catch (error) {
      timer.clear();
      this.deps.host.appendLine(`[companions] ${subagentId} crashed: ${(error as Error).message}`);
      this.subagents.update(subagentId, { status: "failed", errorCode: "child-crashed" }, Date.now());
    } finally {
      try { this.deps.crewFileClaims().releaseRun(record.runId); } catch { /* claims are a lock, not the run */ }
      this.persistSubagentRecord(subagentId);
      this.postSubagentCard(session, subagentId);
      this.releaseSubagentWaiters(subagentId);
      this.maybeFinishSubagentTurn(session);
    }
  }

  public preClaimSubagentFiles(runId: string, label: string, entries: readonly string[]): string | undefined {
    const concrete = [...new Set(entries.map((e) => String(e ?? "").trim().replace(/\\/g, "/")).filter((e) => e && !/[*?[\]{}]/.test(e)))];
    for (const file of concrete) {
      let claim;
      try {
        claim = this.deps.crewFileClaims().tryClaim({ path: file, runId, step: 1, role: label, at: Date.now() });
      } catch (error) {
        this.deps.host.appendLine(`[companions] could not claim ${file}: ${(error as Error).message}`);
        continue;
      }
      if (!claim.ok) {
        try { this.deps.crewFileClaims().releaseRun(runId); } catch { /* */ }
        return `${file} is being edited by ${claim.heldBy.role} (run ${claim.heldBy.runId}). Wait for it to finish, or give this subagent other files.`;
      }
    }
    return undefined;
  }

  public childWriteClaimWarning(session: Session, req: PermissionRequest): string | undefined {
    const override = this.getOverride<typeof this.childWriteClaimWarning>("childWriteClaimWarning");
    if (override) return override(session, req);

    if (this.hiddenReasonOf(session) !== "companion-subagent") return undefined;
    const id = session.pendingHiddenChild?.subagentId ?? this.deps.sessionTypeMetaFor(session)?.subagentId ?? "";
    const record = this.subagents.get(id);
    if (!record || record.profile === "read-only") return undefined;
    const facts = extractPermissionFacts(req.toolCall);
    if (facts.kind !== "edit" || !facts.paths.length) return undefined;
    const root = this.deps.sessionCwd(session);
    for (const p of facts.paths) {
      const relative = path.relative(root, p);
      const rel = (relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : p).replace(/\\/g, "/");
      let claim;
      try {
        claim = this.deps.crewFileClaims().tryClaim({ path: rel, runId: record.runId, step: record.step, role: record.label, at: Date.now() });
      } catch {
        continue;
      }
      if (!claim.ok && claim.heldBy.runId !== record.runId) {
        return `${rel} is being edited by ${claim.heldBy.role}.`;
      }
    }
    return undefined;
  }

  public sessionSpawnPolicy(session: Session): string {
    return session.delegationOverride?.spawnPolicy
      ?? this.deps.sessionTypeMetaFor(session)?.spawnPolicy
      ?? this.deps.companionsSetting<string>("subagents.spawnPolicy", "auto");
  }

  public askSubagentApproval(
    session: Session,
    args: SpawnArguments,
    verdict: Extract<EligibilityResult, { ok: true }>,
  ): Promise<{ approved: boolean; adjusted?: Record<string, unknown> }> {
    if (!this.pendingSubagentApprovals) this.pendingSubagentApprovals = new Map();
    const id = `sa-approval-${randomUUID()}`;
    const listing = listEligibleTargets(this.eligibilityInput(session, this.currentTurnId(session)), { expand: "all" });
    const profiles = PERMISSION_PROFILES.slice(0, PERMISSION_PROFILES.indexOf(verdict.profile) + 1);
    return new Promise((resolve) => {
      this.pendingSubagentApprovals!.set(id, (answer) => {
        this.pendingSubagentApprovals!.delete(id);
        this.deps.emit(session, { type: "subagentApprovalResolved", id, approved: answer.approved });
        resolve(answer);
      });
      this.deps.emit(session, {
        type: "subagentApproval",
        id,
        label: args.label ?? deriveSubagentLabel(args.task),
        task: args.task,
        provider: verdict.target.provider,
        ...(verdict.target.model ? { model: verdict.target.model } : {}),
        ...(verdict.target.effort ? { effort: verdict.target.effort } : {}),
        profile: verdict.profile,
        profiles: [...profiles],
        targets: listing.targets.map((t) => ({
          provider: t.provider,
          displayName: t.displayName,
          ...(t.models ? { models: t.models.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}), ...(m.efforts ? { efforts: m.efforts } : {}) })) } : {}),
        })),
      });
      this.deps.setStatus(session, "needs-you");
    });
  }

  public answerSubagentApproval(
    session: Session,
    msg: { id: string; approved: boolean; task?: string; provider?: string; model?: string; effort?: string; profile?: string },
  ): void {
    const override = this.getOverride<typeof this.answerSubagentApproval>("answerSubagentApproval");
    if (override) return override(session, msg);

    const resolve = this.pendingSubagentApprovals?.get(msg.id);
    if (!resolve) return;
    if (session.status === "needs-you") this.deps.setStatus(session, "working");
    if (!msg.approved) {
      resolve({ approved: false });
      return;
    }
    const adjusted: Record<string, unknown> = {};
    for (const key of ["task", "provider", "model", "effort", "profile"] as const) {
      if (typeof msg[key] === "string") adjusted[key] = msg[key];
    }
    resolve({ approved: true, ...(Object.keys(adjusted).length ? { adjusted } : {}) });
  }

  public async continueSubagent(
    parent: Session,
    subagentId: string,
    message: string,
  ): Promise<{ ok: true } | { ok: false; code: RefusalCode; message: string }> {
    const record = this.subagents.get(subagentId);
    if (!record) return { ok: false, code: "session-gone", message: "No such subagent." };
    if (!isTerminalSubagentStatus(record.status)) {
      return { ok: false, code: "still-running", message: "This subagent is still running; await it first." };
    }
    const child = this.poolSessionById(record.childSessionId);
    if (!child?.client) {
      return { ok: false, code: "session-gone", message: "This subagent's session is no longer live. Spawn a new one with a self-contained task." };
    }
    const reopened = this.subagents.reopen(subagentId);
    if (!reopened) return { ok: false, code: "session-gone", message: "This subagent cannot take a follow-up." };
    this.postSubagentCard(parent, subagentId);
    this.postSubagentTray(parent);
    const role: AgentRole = {
      name: reopened.roleName ?? "subagent",
      provider: child.provider,
      whenToUse: "A companion subagent's follow-up.",
      source: "builtin",
      mode: SUBAGENT_RUN_MODE,
    };
    const run = async () => {
      try {
        const outcome = await this.deps.runAgentRole(
          role,
          { goal: "", task: message, returnFormat: subagentReturnFormat() },
          "subagent",
          parent,
          {
            runId: reopened.runId,
            step: reopened.step,
            subagent: { subagentId, label: reopened.label, profile: reopened.profile },
            continueSession: child,
            continueMessage: message,
          },
        );
        if (outcome.rawReply !== undefined) {
          this.reports.set(subagentId, outcome.rawReply);
          this.writeSubagentRaw(reopened.runId, reopened.step, outcome.rawReply);
        }
        this.subagents.update(subagentId, {
          status: outcome.outcome === "completed" ? "completed" : outcome.outcome === "cancelled" ? "cancelled" : "failed",
          ...(outcome.totalTokens !== undefined ? { tokens: (reopened.tokens ?? 0) + outcome.totalTokens } : {}),
        }, Date.now());
        this.outcomes.set(subagentId, outcome);
      } catch (error) {
        this.subagents.update(subagentId, { status: "failed", errorCode: "child-crashed" }, Date.now());
        this.deps.host.appendLine(`[companions] follow-up for ${subagentId} failed: ${(error as Error).message}`);
      } finally {
        this.persistSubagentRecord(subagentId);
        this.postSubagentCard(parent, subagentId);
        this.releaseSubagentWaiters(subagentId);
        this.postSubagentTray(parent);
        this.maybeFinishSubagentTurn(parent);
      }
    };
    void run();
    return { ok: true };
  }

  public writeSubagentRaw(runId: string, step: number, raw: string): void {
    try {
      const dir = this.deps.agentRuns.runDir(runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${stepSlug(step)}.raw.md`), raw, "utf8");
    } catch (error) {
      this.deps.host.appendLine(`[companions] could not write the raw report: ${(error as Error).message}`);
    }
  }

  public readSubagentReport(subagentId: string): string | undefined {
    const record = this.subagents.get(subagentId);
    if (!record?.runId) return undefined;
    for (const name of [`${stepSlug(record.step)}.raw.md`, `${stepSlug(1)}.raw.md`]) {
      try {
        const text = fs.readFileSync(path.join(this.deps.agentRuns.runDir(record.runId), name), "utf8");
        this.reports.set(subagentId, text);
        return text;
      } catch { /* try the next */ }
    }
    try {
      return fs.readFileSync(this.deps.agentRuns.resultPath(record.runId, record.step), "utf8");
    } catch {
      return undefined;
    }
  }

  public rememberSubagentRun(parent: Session, runId: string): void {
    const parentId = parent.activeSessionId;
    if (!parentId) return;
    const index = { ...this.deps.state.get<Record<string, string[]>>(SUBAGENT_INDEX_KEY, {}) };
    const runs = [...(index[parentId] ?? []), runId].slice(-50);
    index[parentId] = runs;
    const keys = Object.keys(index);
    if (keys.length > 200) delete index[keys[0]!];
    void this.deps.state.update(SUBAGENT_INDEX_KEY, index);
  }

  public persistSubagentRecord(subagentId: string): void {
    const record = this.subagents.get(subagentId);
    if (!record?.runId) return;
    const outcome = this.outcomes.get(subagentId);
    try {
      const dir = this.deps.agentRuns.runDir(record.runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "subagent.json"), `${JSON.stringify({
        record,
        ...(outcome ? {
          outcome: {
            summary: outcome.summary,
            filesReported: outcome.filesReported,
            filesObserved: outcome.filesObserved,
            unreported: outcome.reconciliation?.unreported ?? [],
            claimedOnly: outcome.reconciliation?.claimedOnly ?? [],
            durationMs: outcome.durationMs,
            ...(typeof outcome.totalTokens === "number" ? { totalTokens: outcome.totalTokens } : {}),
          },
        } : {}),
      }, null, 2)}\n`, "utf8");
    } catch (error) {
      this.deps.host.appendLine(`[companions] could not persist ${subagentId}: ${(error as Error).message}`);
    }
  }

  public restoreSubagentCards(parent: Session): void {
    const override = this.getOverride<typeof this.restoreSubagentCards>("restoreSubagentCards");
    if (override) return override(parent);

    const parentId = parent.activeSessionId;
    if (!parentId) return;
    const runs = this.deps.state.get<Record<string, string[]>>(SUBAGENT_INDEX_KEY, {})[parentId] ?? [];
    for (const runId of runs) {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.deps.agentRuns.runDir(runId), "subagent.json"), "utf8")) as {
          record: SubagentRecord;
          outcome?: { summary: string; filesReported: string[]; filesObserved: string[]; unreported: string[]; claimedOnly: string[]; durationMs: number; totalTokens?: number };
        };
        const record = raw.record;
        if (!record?.subagentId || this.subagents.get(record.subagentId)) continue;
        const status = isTerminalSubagentStatus(record.status) ? record.status : "cancelled";
        this.subagents.add({ ...record, status, ...(record.endedAt ? {} : { endedAt: record.startedAt }) });
        if (raw.outcome) {
          this.outcomes.set(record.subagentId, {
            outcome: status === "completed" ? "completed" : status === "failed" ? "failed" : "cancelled",
            filesReported: raw.outcome.filesReported,
            filesObserved: raw.outcome.filesObserved,
            durationMs: raw.outcome.durationMs,
            ...(typeof raw.outcome.totalTokens === "number" ? { totalTokens: raw.outcome.totalTokens } : {}),
            summary: raw.outcome.summary,
            planEntries: [],
            reconciliation: { touched: [], unreported: raw.outcome.unreported, claimedOnly: raw.outcome.claimedOnly },
          });
        }
        this.postSubagentCard(parent, record.subagentId);
      } catch { /* a run without a record stays history-only */ }
    }
  }

  public async settleSubagentWorktree(session: Session, subagentId: string, apply: boolean): Promise<void> {
    const override = this.getOverride<typeof this.settleSubagentWorktree>("settleSubagentWorktree");
    if (override) return override(session, subagentId, apply);

    const record = this.subagents.get(subagentId);
    const wt = record?.worktree;
    if (!record || !wt || wt.state !== "pending") return;
    if (!isTerminalSubagentStatus(record.status)) {
      this.deps.agentNotice(session, "warning", "This subagent is still running.");
      return;
    }
    if (apply) {
      await this.deps.worktreeOps.applyCrewWorktree(session, wt);
    } else {
      try {
        const removed = await this.deps.worktreeOps.worktreeLocal().remove({ worktreePath: wt.path, force: true });
        if (removed && "error" in removed && removed.error) this.deps.host.appendLine(`[companions] discard worktree: ${removed.error}`);
      } catch (error) {
        this.deps.host.appendLine(`[companions] discard worktree failed: ${(error as Error).message}`);
      }
    }
    this.subagents.update(subagentId, { worktree: { ...wt, state: apply ? "applied" : "discarded" } }, Date.now());
    this.persistSubagentRecord(subagentId);
    this.postSubagentCard(session, subagentId);
  }

  public rearmSubagentTimer(subagentId: string): void {
    const deadline = this.subagentDeadlines?.get(subagentId);
    if (!this.subagentTimers) this.subagentTimers = new Map();
    const old = this.subagentTimers.get(subagentId);
    if (old) clearTimeout(old);
    this.subagentTimers.delete(subagentId);
    if (!deadline || deadline.paused) return;
    const t = setTimeout(() => {
      this.subagentTimers?.delete(subagentId);
      const d = this.subagentDeadlines?.get(subagentId);
      if (!d || d.paused) return;
      if (!d.expired(Date.now())) {
        this.rearmSubagentTimer(subagentId);
        return;
      }
      this.cancelSubagent(subagentId, "it ran past its time limit", "timeout");
    }, Math.max(10, deadline.remainingMs(Date.now())));
    (t as { unref?: () => void }).unref?.();
    this.subagentTimers.set(subagentId, t);
  }

  public clearSubagentDeadline(subagentId: string): void {
    const t = this.subagentTimers?.get(subagentId);
    if (t) clearTimeout(t);
    this.subagentTimers?.delete(subagentId);
    this.subagentDeadlines?.delete(subagentId);
  }

  public async claimSubagentFiles(
    session: Session,
    record: { runId: string; step: number; label: string },
    files: readonly string[],
  ): Promise<void> {
    for (const file of files) {
      let claim;
      try {
        claim = this.deps.crewFileClaims().tryClaim({
          path: file,
          runId: record.runId,
          step: record.step,
          role: record.label,
          at: Date.now(),
        });
      } catch (error) {
        this.deps.host.appendLine(`[companions] could not claim ${file}: ${(error as Error).message}`);
        continue;
      }
      if (claim.ok) continue;
      await this.deps.confirmInChat(session, {
        title: "File already claimed",
        body: `${file} is held by ${claim.heldBy.role} (step ${claim.heldBy.step}). `
          + `The subagent has already changed it — review the diff before keeping it.`,
        confirmLabel: "Understood",
      });
    }
  }

  public holdTurnForSubagents(session: Session, meta?: unknown): boolean {
    const override = this.getOverride<typeof this.holdTurnForSubagents>("holdTurnForSubagents");
    if (override) return override(session, meta);

    const parentSessionId = session.activeSessionId ?? "";
    const turnId = this.currentTurnId(session);
    if (!this.subagents.turnHasLiveChildren(parentSessionId, turnId)) return false;
    session.subagentTurnHold = { turnId, meta };
    this.deps.setStatus(session, "working");
    this.postSubagentTray(session);
    this.deps.host.appendLine(
      `[companions] holding turn ${turnId}: `
      + `${this.subagents.running(parentSessionId).length} subagent(s) still running`,
    );
    return true;
  }

  public postSubagentTray(session: Session): void {
    const override = this.getOverride<typeof this.postSubagentTray>("postSubagentTray");
    if (override) return override(session);

    const parentId = session.activeSessionId ?? "";
    const running = this.subagents.running(parentId);
    const turnId = this.currentTurnId(session);
    const finished = running.length
      ? this.subagents.forParent(parentId).filter((record) =>
          record.spawnedInTurn === turnId && isTerminalSubagentStatus(record.status)
          && record.status !== "refused" && !record.childSessionId && !record.promoted)
      : [];
    const row = (record: SubagentRecord) => {
      const live = (session.subagentLive ?? []).find((h) => h.subagentId === record.subagentId)?.roleSession;
      return {
        subagentId: record.subagentId,
        label: record.label,
        provider: record.target.provider,
        providerName: providerDisplayName(record.target.provider),
        ...(record.target.model ? { model: record.target.model } : {}),
        startedAt: record.startedAt,
        ...(isTerminalSubagentStatus(record.status) ? { status: record.status, promotable: true } : {}),
        ...(this.childWaitsForYou(live) ? { needsYou: true } : {}),
      };
    };
    this.deps.emit(this.visibleAncestorOf(session), {
      type: "subagentTray",
      subagents: [...running, ...finished].map(row),
    });
  }

  public releaseTurnHold(session: Session): void {
    const override = this.getOverride<typeof this.releaseTurnHold>("releaseTurnHold");
    if (override) return override(session);

    const hold = session.subagentTurnHold;
    if (!hold) return;
    session.subagentTurnHold = undefined;
    this.postSubagentTray(session);
    if (turnIsInFlight(session)) return;
    this.deps.emit(session, {
      type: "agentEnd",
      ...(hold.meta ? { meta: hold.meta as never } : {}),
      ...this.deps.lifecycleOps.turnEndFields(session, "completed"),
    });
    this.deps.lifecycleOps.noteLiveTurnEnded(session);
    this.deps.setStatus(session, "done");
    this.deps.lifecycleOps.noteSessionActivity?.(session);
    session.authRecoveryTried = false;
    this.deps.lifecycleOps.setProviderNeedsLogin(session.provider, false);
    this.deps.lifecycleOps.maybeGenerateTitle(session);
    this.deps.lifecycleOps.postSessionName(session);
  }

  public applyTurnDirectives(session: Session, text: string): { text: string; block: string } {
    const override = this.getOverride<typeof this.applyTurnDirectives>("applyTurnDirectives");
    if (override) return override(session, text);

    const parsed = parseSubagentMentions(text);
    session.subagentDirectives = parsed.directives.length ? parsed.directives : undefined;
    session.subagentsForbiddenThisTurn = parsed.directives.some((d) => d.strength === "forbid");
    const block = renderDirectiveBlock(parsed.directives);
    if (parsed.directives.length) {
      this.deps.host.appendLine(
        `[companions] ${parsed.directives.length} directive(s) on this turn: `
        + parsed.directives.map((d) => `${d.id}=${d.strength}${d.provider ? `:${d.provider}` : ""}${d.role ? `:${d.role}` : ""}`).join(", "),
      );
    }
    return { text: parsed.text || text, block };
  }

  public directiveForSpawn(session: Session, args: SpawnArguments): SubagentDirective | undefined {
    const directives = session.subagentDirectives ?? [];
    if (!directives.length) return undefined;
    if (args.provider || args.role) {
      return directives.find(
        (directive) =>
          (args.provider && directive.provider === args.provider)
          || (args.role && directive.role === args.role),
      );
    }
    return directives.find((directive) => directive.strength === "must");
  }

  public reportUnfollowedDirectives(session: Session, turnId: string): void {
    const override = this.getOverride<typeof this.reportUnfollowedDirectives>("reportUnfollowedDirectives");
    if (override) return override(session, turnId);

    const directives = session.subagentDirectives ?? [];
    if (!directives.length) return;
    const spawned = this.subagents
      .all()
      .filter(
        (record) =>
          record.parentSessionId === (session.activeSessionId ?? "")
          && record.spawnedInTurn === turnId
          && record.status !== "refused",
      )
      .map((record) => ({
        provider: record.target.provider,
        ...(record.target.model ? { model: record.target.model } : {}),
        ...(record.roleName ? { role: record.roleName } : {}),
      }));
    for (const directive of unfollowedDirectives(directives, spawned)) {
      this.deps.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: `Directive ${directive.id} was not followed.`,
      });
    }
  }

  public markHiddenChildSession(
    child: Session,
    parent: Session,
    subagentId: string,
    hiddenReason: HiddenReason = "companion-subagent",
  ): void {
    child.sessionType = "agent";
    child.sessionTypeLockedAt = Date.now();
    child.pendingHiddenChild = {
      parentSessionId: parent.activeSessionId ?? "",
      subagentId,
      hiddenReason,
      depth: (this.deps.sessionTypeMetaFor(parent)?.depth ?? 0) + 1,
    };
  }

  public async promoteSubagentSession(session: Session, subagentId: string): Promise<void> {
    const override = this.getOverride<typeof this.promoteSubagentSession>("promoteSubagentSession");
    if (override) return override(session, subagentId);

    const record = this.subagents.get(subagentId);
    if (!record) return;
    if (!isTerminalSubagentStatus(record.status)) {
      this.deps.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: "This subagent is still running. Wait for it to finish, or cancel it first.",
      });
      return;
    }
    const childId = record.childSessionId;
    if (!childId) {
      this.deps.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: "This subagent never started a session, so there is nothing to keep.",
      });
      return;
    }
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const promotion = promoteHiddenChild(overrides[childId]);
    if (!promotion.ok) {
      this.deps.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: promotion.reason === "generator"
          ? "A workflow generator run cannot be kept as a session."
          : "This is already a session of its own.",
      });
      return;
    }
    const name = promotedSessionName(record.label, this.deps.sessionDisplayName(session));
    await this.deps.state.update(SESSION_META_KEY, {
      ...overrides,
      [childId]: { ...promotion.meta, customName: name },
    });
    this.deps.lifecycleOps.sessionCacheDelete(childId);
    const pool = this.deps.pool && typeof (this.deps.pool as any)[Symbol.iterator] === "function" ? this.deps.pool : [];
    const live = [...pool].find((candidate) => candidate.activeSessionId === childId);
    if (live) live.pendingHiddenChild = undefined;
    this.subagents.update(subagentId, { promoted: true }, Date.now());
    this.postSubagentCard(session, subagentId);
    this.deps.host.appendLine(`[companions] promoted ${subagentId} (${childId}) to "${name}"`);
    this.deps.lifecycleOps.postSessionsList();
    this.deps.emit(session, {
      type: "hostNotice",
      level: "info",
      text: `Kept as a session: ${name}`,
    });
  }

  public flushHiddenChildMeta(session: Session): void {
    const override = this.getOverride<typeof this.flushHiddenChildMeta>("flushHiddenChildMeta");
    if (override) return override(session);

    const pending = session.pendingHiddenChild;
    const id = session.activeSessionId;
    if (!pending || !id) return;
    session.pendingHiddenChild = undefined;
    const overrides = this.deps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    void this.deps.state.update(SESSION_META_KEY, {
      ...overrides,
      [id]: { ...(overrides[id] ?? {}), ...pending },
    });
    this.deps.lifecycleOps.sessionCacheDelete(id);
  }

  public targetPayload(verdict: Extract<EligibilityResult, { ok: true }>): unknown {
    return {
      provider: verdict.target.provider,
      ...(verdict.target.model ? { model: verdict.target.model } : {}),
      ...(verdict.target.effort ? { effort: verdict.target.effort } : {}),
      effortClamped: verdict.effortClamped ?? null,
      modelVerified: verdict.modelVerified,
      sameProviderAsParent: verdict.sameProviderAsParent,
    };
  }

  public subagentResultPayload(subagentId: string, opts: { markCollected?: boolean } = {}): unknown {
    const record = this.subagents.get(subagentId);
    if (!record) return { subagentId, status: "unknown" };
    if (opts.markCollected) this.subagents.update(subagentId, { collected: true }, Date.now());
    const outcome = this.outcomes.get(subagentId);
    const base = {
      subagentId,
      status: record.status,
      target: {
        provider: record.target.provider,
        ...(record.target.model ? { model: record.target.model } : {}),
        ...(record.target.effort ? { effort: record.target.effort } : {}),
        effortClamped: record.effortClamped ?? null,
        modelVerified: record.modelVerified ?? false,
        sameProviderAsParent: record.sameProviderAsParent ?? false,
      },
      profile: record.profile,
      ...(record.profileDowngraded ? { profileDowngraded: record.profileDowngraded } : {}),
      durationMs: (record.endedAt ?? Date.now()) - record.startedAt,
      ...(record.tokens !== undefined ? { usage: { tokens: record.tokens } } : {}),
    };
    if (record.status !== "completed" || !outcome) {
      return { ...base, refusal: record.errorCode ? { code: record.errorCode } : null };
    }
    const cap = Math.max(200, Number(this.deps.companionsSetting("subagents.limits.resultInlineChars", 4000)));
    const summary = capInlineText(outcome.parsed?.summary ?? outcome.summary ?? "", cap);
    return {
      ...base,
      result: {
        summary: summary.text,
        findings: outcome.parsed?.open ?? [],
        filesReported: outcome.filesReported,
        filesObserved: outcome.filesObserved,
        unreported: outcome.reconciliation?.unreported ?? [],
        claimedOnly: outcome.reconciliation?.claimedOnly ?? [],
        openQuestions: outcome.parsed?.open ?? [],
        truncated: summary.truncated,
        fullLength: (this.reports.get(subagentId) ?? "").length,
        resultRef: subagentId,
      },
      review: COMPANIONS_REVIEW_HINT,
      refusal: null,
    };
  }

  public postSubagentCard(session: Session, subagentId: string): void {
    const override = this.getOverride<typeof this.postSubagentCard>("postSubagentCard");
    if (override) return override(session, subagentId);

    const record = this.subagents.get(subagentId);
    if (!record) return;
    const outcome = this.outcomes.get(subagentId);
    const visible = this.visibleAncestorOf(session);
    const startedBy = visible === session ? undefined : this.chainLabelFor(session);
    const liveChild = (session.subagentLive ?? []).find((h) => h.subagentId === subagentId)?.roleSession;
    this.deps.emit(visible, {
      type: "companionSubagent",
      ...(startedBy ? { startedBy } : {}),
      ...(this.childWaitsForYou(liveChild) ? { needsYou: true } : {}),
      childStatus: subagentChildStatus(record.status, { needsYou: this.childWaitsForYou(liveChild) }),
      subagentId,
      label: record.label,
      provider: record.target.provider,
      providerName: providerDisplayName(record.target.provider),
      ...(record.target.model ? { model: record.target.model } : {}),
      ...(record.target.effort ? { effort: record.target.effort } : {}),
      profile: record.profile,
      profileLabel: profileBadge(record.profile),
      status: record.status,
      startedAt: record.startedAt,
      ...(record.endedAt ? { endedAt: record.endedAt } : {}),
      modelVerified: record.modelVerified ?? false,
      sameProviderAsParent: record.sameProviderAsParent ?? false,
      ...(record.effortClamped ? { effortClamped: record.effortClamped } : {}),
      ...(record.profileDowngraded ? { profileDowngraded: record.profileDowngraded } : {}),
      ...(record.errorCode ? { errorCode: record.errorCode } : {}),
      ...(record.refusalMessage ? { refusalMessage: record.refusalMessage } : {}),
      ...(typeof record.tokens === "number" ? { tokens: record.tokens } : {}),
      ...(record.worktree ? { worktree: record.worktree.state } : {}),
      ...(record.adjustedByUser ? { adjustedByUser: true } : {}),
      ...(isTerminalSubagentStatus(record.status) && record.status !== "refused" && this.poolSessionById(record.childSessionId)?.client
        ? { canFollowUp: true }
        : {}),
      ...(record.ranModel && record.ranModel !== record.target.model ? { ranModel: record.ranModel } : {}),
      ...(record.refusalAlternatives?.length ? { refusalAlternatives: record.refusalAlternatives } : {}),
      ...(record.childSessionId ? { sessionId: record.childSessionId } : {}),
      ...(record.childSessionId && isTerminalSubagentStatus(record.status) && !record.promoted
        ? { promotable: true }
        : {}),
      ...(outcome?.summary ? { summary: outcome.summary } : {}),
      ...(outcome?.filesReported?.length ? { filesReported: outcome.filesReported } : {}),
      ...(outcome?.filesObserved?.length ? { filesObserved: outcome.filesObserved } : {}),
      ...(outcome?.reconciliation?.unreported?.length
        ? { unreported: outcome.reconciliation.unreported }
        : {}),
      ...(outcome?.reconciliation?.claimedOnly?.length
        ? { claimedOnly: outcome.reconciliation.claimedOnly }
        : {}),
    });
  }

  public raceSubagent(subagentId: string, ms: number): Promise<boolean> {
    const record = this.subagents.get(subagentId);
    if (!record || isTerminalSubagentStatus(record.status)) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const timer = setTimeout(() => done(false), ms);
      timer.unref?.();
      const currentWaiters = this.waiters.get(subagentId) ?? [];
      currentWaiters.push(() => { clearTimeout(timer); done(true); });
      this.waiters.set(subagentId, currentWaiters);
    });
  }

  public async raceSubagents(ids: readonly string[], ms: number, mode: "all" | "any"): Promise<void> {
    if (!ids.length) return;
    const races = ids.map((id) => this.raceSubagent(id, ms));
    if (mode === "any") await Promise.race(races);
    else await Promise.all(races);
  }

  public releaseSubagentWaiters(subagentId: string): void {
    for (const waiter of this.waiters.get(subagentId) ?? []) waiter();
    this.waiters.delete(subagentId);
  }

  public cancelSubagent(subagentId: string, reason: string, code?: RefusalCode): void {
    const override = this.getOverride<typeof this.cancelSubagent>("cancelSubagent");
    if (override) return override(subagentId, reason, code);

    const record = this.subagents.get(subagentId);
    if (!record || isTerminalSubagentStatus(record.status)) return;
    this.deps.host.appendLine(`[companions] cancelling ${subagentId}: ${reason}`);
    const pool = this.deps.pool && typeof (this.deps.pool as any)[Symbol.iterator] === "function" ? this.deps.pool : [];
    for (const session of pool) {
      const handle = session.subagentLive?.find((entry) => entry.subagentId === subagentId);
      if (!handle) continue;
      handle.cancelled = true;
      void handle.roleSession.client?.cancel("companion subagent cancelled");
      break;
    }
    this.subagents.update(
      subagentId,
      { status: "cancelled", ...(code ? { errorCode: code } : {}) },
      Date.now(),
    );
    this.releaseSubagentWaiters(subagentId);
  }

  public cancelSubagentsOf(session: Session, reason: string): void {
    for (const record of this.subagents.running(session.activeSessionId ?? "")) {
      this.cancelSubagent(record.subagentId, reason);
    }
  }

  public maybeFinishSubagentTurn(session: Session): void {
    const override = this.getOverride<typeof this.maybeFinishSubagentTurn>("maybeFinishSubagentTurn");
    if (override) return override(session);

    const parentSessionId = session.activeSessionId ?? "";
    const turnId = this.currentTurnId(session);
    this.postSubagentTray(session);
    if (this.subagents.turnHasLiveChildren(parentSessionId, turnId)) return;
    this.reportUnfollowedDirectives(session, turnId);
    const uncollected = this.subagents.uncollectedFinished(parentSessionId, turnId);
    if (uncollected.length) {
      this.deps.emit(session, {
        type: "hostNotice",
        level: "info",
        text: uncollectedFollowUpText(uncollected),
      });
      for (const record of uncollected) {
        this.subagents.update(record.subagentId, { collected: true }, Date.now());
      }
    }
    this.releaseTurnHold(session);
  }
}

export function createSubagentHost(deps: SubagentHostDeps): SubagentHost {
  return new SubagentHost(deps);
}
