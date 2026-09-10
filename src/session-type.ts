// Session types (AP-15): every session is an **Agent** session or a **Crew**
// session, chosen before the first message and locked the moment one is sent.
//
// Pure logic module adhering to Recipe R7: no vscode imports, no filesystem
// I/O, no clock. The caller supplies "has this conversation started" and the
// timestamp to stamp; this module only decides.
//
// Naming warning (§3): the composer's permission-mode picker (Agent / Plan /
// Auto accept, wire values `agent` / `plan` / `yolo`) is a DIFFERENT axis and
// keeps its own vocabulary (`mode` / `runMode`). This module owns `sessionType`
// and nothing else. The removed prototype axis was called `sessionMode`; that
// name must not come back.

import type { AcpProvider } from "./acp-backend";
import type { EffortLevel } from "./acp";

export type SessionType = "agent" | "crew";

export const SESSION_TYPES: readonly SessionType[] = ["agent", "crew"] as const;

/** The type a session falls back to when nothing was ever written (ST-3). */
export const DEFAULT_SESSION_TYPE: SessionType = "agent";

/**
 * Why a companion-managed session is kept out of the history list. Every value
 * means "this session belongs to another one"; the parent is the only row.
 */
export type HiddenReason = "companion-subagent" | "crew-stage" | "workflow-generator";

/**
 * The AP-15/AP-16/AP-17 additions to a session's metadata record (§5.5).
 *
 * Stored inside the existing `grok.sessionMeta` map. That key is an existing
 * persistence key and is deliberately NOT renamed (D-list: "Rename
 * grok.sessionMeta? No."); only new *settings* take the `companions.` prefix.
 */
export interface SessionTypeMeta {
  /** Absent means `"agent"` — see {@link effectiveSessionType}. */
  sessionType?: SessionType;
  /** Written exactly once, at the first submitted content (ST-2). */
  sessionTypeLockedAt?: number;
  /** Crew sessions only: the active or last workflow run. */
  crewRunId?: string;
  /** Companion subagent sessions only: who owns this child. */
  parentSessionId?: string;
  /** Companion subagent sessions only. */
  subagentId?: string;
  /** Set on every host-managed child session; hides it from history. */
  hiddenReason?: HiddenReason;
  /** Agent sessions: snapshot of the global switch at creation and at lock. */
  subagentsEnabled?: boolean;
  /** Session-gear override, per provider or `*` for all. */
  subagentEffortOverride?: Partial<Record<AcpProvider | "*", EffortLevel | "inherit">>;
  /** Crew sessions: the selected workflow. */
  workflowName?: string;
  /** 0 for user sessions, 1..maxDepth for children. */
  depth?: number;
  /** Companion subagent ids this session started, newest first, capped. */
  subagents?: string[];
}

/** Ceiling for {@link SessionTypeMeta.subagents} (§6.6 point 5). */
export const SUBAGENT_ID_HISTORY_MAX = 100;

export function isSessionType(value: unknown): value is SessionType {
  return value === "agent" || value === "crew";
}

/**
 * The type of a session, defaulting for every session created before AP-15.
 *
 * ST-3: a missing `sessionType` is not a missing answer, it is "agent". No
 * migration write is needed anywhere — the reader supplies the default.
 */
export function effectiveSessionType(meta: SessionTypeMeta | undefined): SessionType {
  const stored = meta?.sessionType;
  return isSessionType(stored) ? stored : DEFAULT_SESSION_TYPE;
}

/**
 * Whether the type can no longer be changed.
 *
 * Two independent reasons, and the second is what makes ST-3 work without a
 * migration: an explicit `sessionTypeLockedAt`, or a session that already has
 * history. A legacy session has history and no stamp, and is therefore locked
 * exactly as it should be.
 *
 * Rewind does not unlock (ST-4 / D2): the stamp records that the conversation
 * started, not what is currently visible.
 */
export function isSessionTypeLocked(meta: SessionTypeMeta | undefined, hasHistory: boolean): boolean {
  if (typeof meta?.sessionTypeLockedAt === "number") return true;
  return hasHistory;
}

/** The inverse of {@link isSessionTypeLocked}, for readability at call sites. */
export function canSwitchSessionType(meta: SessionTypeMeta | undefined, hasHistory: boolean): boolean {
  return !isSessionTypeLocked(meta, hasHistory);
}

/**
 * Resolve the type a *new* session should start as.
 *
 * The setting is `companions.sessionType.default`. An unreadable or unknown
 * value falls back rather than throwing: a bad setting must not stop a session
 * from being created.
 */
export function defaultSessionTypeFromSetting(configured: unknown): SessionType {
  return isSessionType(configured) ? configured : DEFAULT_SESSION_TYPE;
}

export type SessionTypeSwitch =
  | { ok: true; meta: SessionTypeMeta }
  | { ok: false; reason: "locked" | "unknown-type"; sessionType: SessionType };

/**
 * Apply a pre-lock type switch (ST-1), or refuse it.
 *
 * The refusal is the host's own answer, not a webview courtesy: §5.6 requires
 * a forged `setSessionType` to be rejected by the host even though the webview
 * hides the control. Returns a new object; the input is never mutated.
 */
export function applySessionTypeSwitch(
  meta: SessionTypeMeta | undefined,
  next: unknown,
  hasHistory: boolean,
): SessionTypeSwitch {
  const current = effectiveSessionType(meta);
  if (!isSessionType(next)) return { ok: false, reason: "unknown-type", sessionType: current };
  if (isSessionTypeLocked(meta, hasHistory)) {
    return { ok: false, reason: "locked", sessionType: current };
  }
  return { ok: true, meta: { ...(meta ?? {}), sessionType: next } };
}

/**
 * Stamp the lock (ST-2), once.
 *
 * Idempotent on purpose: the lock triggers are a list of first-content events
 * (text, voice, chips/images only, Start workflow) and more than one of them
 * can fire for a single send. The first stamp is the true one.
 */
export function lockSessionType(meta: SessionTypeMeta | undefined, now: number): SessionTypeMeta {
  const base = meta ?? {};
  if (typeof base.sessionTypeLockedAt === "number") return base;
  return { ...base, sessionType: effectiveSessionType(base), sessionTypeLockedAt: now };
}

/**
 * Whether this session is one the host manages on behalf of another session.
 *
 * Companion subagents, crew stages and generator sessions are all real sessions
 * for their provider but never user sessions: hidden from history, never swept,
 * deleted with their parent (D3, D5).
 */
export function isHostManagedChild(meta: SessionTypeMeta | undefined): boolean {
  return typeof meta?.hiddenReason === "string";
}

/** The metadata a forked session inherits (§5.4): the type, and the lock. */
export function forkedSessionTypeMeta(source: SessionTypeMeta | undefined, now: number): SessionTypeMeta {
  return lockSessionType({ sessionType: effectiveSessionType(source) }, now);
}

/** Why a host-managed child could not be promoted to a session of its own. */
export type PromotionRefusal = "not-a-child" | "generator";

export type PromotionResult =
  | { ok: true; meta: SessionTypeMeta }
  | { ok: false; reason: PromotionRefusal };

/**
 * Promote a hidden child to an ordinary session (§6.6 point 8, P6).
 *
 * The child was always a real session for its provider — it was only ever
 * hidden by OUR metadata (§6.6 points 1-3). So promoting it is a deletion, not
 * a construction: drop the four fields that made it belong to someone else, and
 * the history filter and the empty-session sweep start treating it like any
 * other conversation on their next pass. Nothing about the transcript, the run
 * directory or the provider's own store changes.
 *
 * `depth` goes with them. A promoted session is the user's, so it starts its own
 * delegation budget at zero rather than inheriting a place in someone else's
 * chain — which is also what stops a promoted grandchild from being permanently
 * barred from delegating.
 *
 * A **generator** session is refused: it is a transient the host drives through
 * a validate-and-submit loop with a tool set no user session should carry, and
 * it has no transcript worth keeping once it has submitted (§8.6).
 */
export function promoteHiddenChild(meta: SessionTypeMeta | undefined): PromotionResult {
  if (!isHostManagedChild(meta)) return { ok: false, reason: "not-a-child" };
  if (meta?.hiddenReason === "workflow-generator") return { ok: false, reason: "generator" };
  const {
    hiddenReason: _hiddenReason,
    parentSessionId: _parentSessionId,
    subagentId: _subagentId,
    depth: _depth,
    ...rest
  } = meta ?? {};
  return { ok: true, meta: rest };
}

/**
 * The name a promoted child is given (§6.6 point 8).
 *
 * `<label> (from <parent name>)`, because a promoted subagent in the history
 * list is otherwise a conversation nobody remembers starting — the parent is
 * the only thing that explains where it came from. Idempotent, so promoting
 * something that already carries the suffix does not stack a second one.
 */
export function promotedSessionName(label: string, parentName: string): string {
  const clean = (label ?? "").trim() || "Subagent";
  const parent = (parentName ?? "").trim();
  if (!parent) return clean;
  const suffix = ` (from ${parent})`;
  return clean.endsWith(suffix) ? clean : `${clean}${suffix}`;
}
