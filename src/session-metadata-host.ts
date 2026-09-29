import { listEligibleTargets, type EligibilityInput } from "./target-eligibility";
import {
  applySessionTypeSwitch,
  defaultSessionTypeFromSetting,
  effectiveSessionType,
  lockSessionType,
  type HiddenReason,
  type SessionType,
  type SessionTypeMeta
} from "./session-type";
import { SessionListEntry, SessionMetaOverrides } from "./sessions";
import { HostMsg } from "./protocol";
import { type AgentRoleSet } from "./agent-roles";
import { Session } from "./session";
import { PersistedState } from "./persisted-state";
import { providerDisplayName } from "./provider-ui";
import type { AcpProvider } from "./acp-backend";
import type { Host } from "./host";
import { SESSION_META_KEY } from "./worktree-host";
export interface SessionMetadataHostSidebarOps {
  readonly host: Host;
  readonly state: PersistedState;
  emit: (session: Session, message: HostMsg) => void;
  sessionTypeIsLocked: (session: Session) => boolean;
  readonly sessionCache: Map<string, { mtimeMs: number; entry: SessionListEntry; }>;
  postWorkflowList: (session: Session, preferred?: string) => void;
  restoreSubagentCards: (parent: Session) => void;
  restoreWorkflowRun: (session: Session, runId: string) => Promise<void>;
  sessionHasStarted: (session: Session) => boolean;
  hiddenReasonOf: (session: Session) => HiddenReason | undefined;
  subagentsEnabledGlobally: () => boolean;
  companionsSetting: <T>(key: string, fallback: T) => T;
  eligibilityInput: (session: Session, turnId: string) => EligibilityInput;
  currentTurnId: (session: Session) => string;
  agentRoleSet: (cwd: string) => AgentRoleSet;
  sessionCwd: (session?: Session) => string;
}

export interface SessionMetadataHostDeps {
  readonly sidebarOps: SessionMetadataHostSidebarOps;
  readonly getOverride?: <T extends (...args: any[]) => any>(name: string) => T | undefined;
}
export class SessionMetadataHost {
  constructor(private readonly deps: SessionMetadataHostDeps) { }

  // ---------------------------------------------------------------- AP-15 --
  // Session type (Agent | Crew). The pure decisions live in `session-type.ts`;
  // everything here is the plumbing that pure module deliberately refuses to
  // own — the setting, the metadata record, the webview message.

  /**
   * What a brand-new session starts as (`companions.sessionType.default`).
   *
   * Guarded, and the guard is the same claim the pure fallback makes: a
   * setting must never be able to stop a session from being created. A host
   * that cannot answer (a harness, a configuration provider that throws) gets
   * the default rather than an exception on the `+` button.
   */
  public configuredDefaultSessionType(): SessionType {
    const testOverride = this.deps.getOverride?.<typeof this.configuredDefaultSessionType>("configuredDefaultSessionType");
    if (testOverride) return testOverride();

    try {
      return defaultSessionTypeFromSetting(
        this.deps.sidebarOps.host.getConfiguration("companions").get<string>("sessionType.default", "agent"),
      );
    } catch {
      return "agent";
    }
  }

  /** The stored AP-15 metadata for a session, or undefined before it has an id. */
  public sessionTypeMetaFor(session: Session): SessionTypeMeta | undefined {
    const testOverride = this.deps.getOverride?.<typeof this.sessionTypeMetaFor>("sessionTypeMetaFor");
    if (testOverride) return testOverride(session);

    const id = session.activeSessionId;
    if (!id) return undefined;
    return this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {})[id];
  }

  /** Tell the webview which control to draw. */
  public postSessionType(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.postSessionType>("postSessionType");
    if (testOverride) return testOverride(session);

    this.deps.sidebarOps.emit(session, {
      type: "sessionType",
      sessionId: session.activeSessionId ?? "",
      sessionType: session.sessionType,
      locked: this.deps.sidebarOps.sessionTypeIsLocked(session)
    });
    this.postSessionDelegation(session);
  }

  /**
     * Write the type into `grok.sessionMeta`.
     *
     * A no-op before the CLI has named the session: the record is keyed by the
     * provider's session id, so there is nothing to key against yet. The runtime
     * field on `Session` is the store until then, and this runs again the moment
     * an id exists (ST-1).
     */
  public persistSessionType(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.persistSessionType>("persistSessionType");
    if (testOverride) return testOverride(session);

    const id = session.activeSessionId;
    if (!id) return;
    const overrides = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
    const current = overrides[id] ?? {};
    const crewRunId = session.workflowRun?.runId;
    const workflowName = session.workflowRun?.workflowName;
    if (
      current.sessionType === session.sessionType
      && current.sessionTypeLockedAt === session.sessionTypeLockedAt
      && current.crewRunId === crewRunId
      && current.workflowName === workflowName
    ) {
      return;
    }
    void this.deps.sidebarOps.state.update(SESSION_META_KEY, {
      ...overrides,
      [id]: {
        ...current,
        sessionType: session.sessionType,
        ...(session.sessionTypeLockedAt !== undefined
          ? { sessionTypeLockedAt: session.sessionTypeLockedAt }
          : {}),
        ...(crewRunId ? { crewRunId } : {}),
        ...(workflowName ? { workflowName } : {})
      }
    });
    this.deps.sidebarOps.sessionCache.delete(id);
  }

  /**
     * Read the type back for a session restored from history (ST-3).
     *
     * A record with no `sessionType` is a session created before AP-15: it reads
     * as a locked Agent session, and nothing is written to make that true.
     */
  public restoreSessionType(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.restoreSessionType>("restoreSessionType");
    if (testOverride) return testOverride(session);

    const meta = this.sessionTypeMetaFor(session);
    session.sessionType = effectiveSessionType(meta);
    if (typeof meta?.sessionTypeLockedAt === "number") {
      session.sessionTypeLockedAt = meta.sessionTypeLockedAt;
    }
    this.postSessionType(session);
    if (session.sessionType === "crew") this.deps.sidebarOps.postWorkflowList(session);
    // S-05: this session's subagent cards come back from their run folders.
    this.deps.sidebarOps.restoreSubagentCards(session);
    if (meta?.crewRunId && !session.workflowRun) {
      const runId = meta.crewRunId;
      void this.deps.sidebarOps.restoreWorkflowRun(session, runId).catch((error) => {
        this.deps.sidebarOps.host.appendLine?.(`[workflow] could not restore run ${runId}: ${(error as Error).message}`);
      });
    }
  }

  /**
     * ST-2 — the lock, at the first submitted content.
     *
     * Idempotent, because more than one trigger can fire for a single send
     * (text plus chips, a voice utterance that also carries an image).
     */
  public lockSessionTypeNow(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.lockSessionTypeNow>("lockSessionTypeNow");
    if (testOverride) return testOverride(session);

    if (session.sessionTypeLockedAt !== undefined) {
      this.persistSessionType(session);
      return;
    }
    const locked = lockSessionType(
      { sessionType: session.sessionType, sessionTypeLockedAt: session.sessionTypeLockedAt },
      Date.now(),
    );
    session.sessionType = locked.sessionType ?? "agent";
    session.sessionTypeLockedAt = locked.sessionTypeLockedAt;
    this.persistSessionType(session);
    this.postSessionType(session);
  }

  /**
     * ST-1 — a pre-lock switch, or the host's refusal.
     *
     * The refusal is the point: §5.6 requires a forged `setSessionType` to be
     * rejected HERE, not merely hidden in the webview, so a remote or a tampered
     * frame cannot re-type a conversation that has already started.
     */
  public setSessionType(session: Session, next: unknown): void {
    const testOverride = this.deps.getOverride?.<typeof this.setSessionType>("setSessionType");
    if (testOverride) return testOverride(session, next);

    const result = applySessionTypeSwitch(
      { sessionType: session.sessionType, sessionTypeLockedAt: session.sessionTypeLockedAt },
      next,
      this.deps.sidebarOps.sessionHasStarted(session),
    );
    if (!result.ok) {
      this.deps.sidebarOps.emit(session, {
        type: "hostNotice",
        level: "warning",
        text: result.reason === "locked"
          ? session.sessionType === "crew"
            ? "This session is locked to Crew mode. Start a new session to use Agent."
            : "This session is locked to Agent mode. Start a new session to use Crew."
          : "Unknown session type."
      });
      // Re-assert the truth so a webview that drew the wrong control corrects.
      this.postSessionType(session);
      return;
    }
    session.sessionType = result.meta.sessionType ?? "agent";
    this.persistSessionType(session);
    this.postSessionType(session);
    if (session.sessionType === "crew") this.deps.sidebarOps.postWorkflowList(session);
  }

  /** S-03: the composer's delegation switch, and the targets `@subagent:` offers. */
  public postSessionDelegation(session: Session): void {
    const testOverride = this.deps.getOverride?.<typeof this.postSessionDelegation>("postSessionDelegation");
    if (testOverride) return testOverride(session);

    if (session.sessionType !== "agent" || this.deps.sidebarOps.hiddenReasonOf(session)) {
      this.deps.sidebarOps.emit(session, { type: "sessionDelegation", value: null });
      return;
    }
    const meta = this.sessionTypeMetaFor(session);
    const enabled = session.delegationOverride?.enabled ?? meta?.subagentsEnabled ?? this.deps.sidebarOps.subagentsEnabledGlobally();
    const policy = session.delegationOverride?.spawnPolicy ?? meta?.spawnPolicy ?? this.deps.sidebarOps.companionsSetting<string>("subagents.spawnPolicy", "auto");
    const value = !enabled ? "off" : policy === "ask" ? "ask" : policy === "auto-read-only" ? "read-only-auto" : "auto";
    let targets: Array<{ provider: AcpProvider; name: string; eligible: boolean; reason?: string; models?: Array<{ id: string; efforts?: string[] }> }> = [];
    let roles: Array<{ name: string; whenToUse: string }> = [];
    try {
      const listing = listEligibleTargets(this.deps.sidebarOps.eligibilityInput(session, this.deps.sidebarOps.currentTurnId(session)), { includeIneligible: true, expand: "all" });
      targets = [
        ...listing.targets.map((t) => ({
          provider: t.provider,
          name: t.displayName,
          eligible: true,
          ...(t.models ? { models: t.models.map((m) => ({ id: m.id, ...(m.efforts ? { efforts: m.efforts } : {}) })) } : {})
        })),
        ...listing.ineligible.map((row) => ({ provider: row.provider, name: providerDisplayName(row.provider), eligible: false, reason: row.message })),
      ];
      roles = this.deps.sidebarOps.agentRoleSet(this.deps.sidebarOps.sessionCwd(session)).roles.map((r) => ({ name: r.name, whenToUse: r.whenToUse }));
    } catch { /* the switch still works without suggestions */ }
    this.deps.sidebarOps.emit(session, {
      type: "sessionDelegation",
      value,
      ...(enabled && session.client && session.companionsMcpInjected === false ? { needsRestart: true } : {}),
      targets,
      roles
    });
  }

  /** S-03: set this session's delegation from the composer. */
  public setSessionDelegation(session: Session, value: string): void {
    const testOverride = this.deps.getOverride?.<typeof this.setSessionDelegation>("setSessionDelegation");
    if (testOverride) return testOverride(session, value);

    const enabled = value !== "off";
    const spawnPolicy = value === "ask" ? "ask" as const : value === "read-only-auto" ? "auto-read-only" as const : "auto" as const;
    session.delegationOverride = { enabled, spawnPolicy };
    const id = session.activeSessionId;
    if (id) {
      const overrides = this.deps.sidebarOps.state.get<SessionMetaOverrides>(SESSION_META_KEY, {});
      void this.deps.sidebarOps.state.update(SESSION_META_KEY, {
        ...overrides,
        [id]: { ...(overrides[id] ?? {}), subagentsEnabled: enabled, spawnPolicy }
      });
      this.deps.sidebarOps.sessionCache.delete(id);
    }
    this.postSessionDelegation(session);
  }
}
