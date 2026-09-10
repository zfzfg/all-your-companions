/**
 * Crew-session orchestrator (AP-17).
 *
 * `WorkflowRun` owns the stage graph, gates, pause/resume, snapshot identity
 * and quota state. `CrewRun` stays the inner step-walker for
 * `strategy: "per-plan-step"` and the legacy `/crew` path — do not copy gate,
 * staleness or snapshot logic into `crew.ts` (§7.1).
 *
 * Immutable, like `crew.ts`: every status change returns a new object. Pure
 * (recipe R7): no vscode, no fs, no clock. The host supplies `now`, git HEAD,
 * file hashes and whether the worktree still exists.
 */

import type { AcpProvider } from "./acp-backend";
import type { Target } from "./target-eligibility";
import type { WorkflowRunView } from "./protocol";
import {
  type HandoffPacket,
  type HandoffStatus,
  highestFindingSeverity,
  lastWritingPacket,
  verdictUnreadable,
  verifyForTransitions,
  verifyStatus,
} from "./workflow-handoff";
import {
  estimatedStageCount,
  findStage,
  firstEnabledStart,
  isAutoGate,
  isReservedTarget,
  type ReservedTarget,
  type WorkflowDefinition,
  type WorkflowStage,
  type WorkflowTransition,
} from "./workflow";

export const WORKFLOW_RUN_VERSION = 1 as const;

export type WorkflowRunStatus =
  | "running"
  | "at-gate"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type GateKind =
  | "gate-0"
  | "normal"
  | "unreadable-verdict"
  | "fixer-limit"
  | "interrupted"
  | "failed"
  | "stale"
  | "snapshot-drift"
  | "unresumable";

export interface ExecutedStage {
  stageId: string;
  ordinal: number;
  visit: number;
  packetPath: string;
  status: HandoffStatus;
  sessionId?: string;
}

export interface WorkflowGate {
  proposedNext: string[];
  reason: string;
  kind: GateKind;
  forcedManual?: string[];
  /** When true the host may start `proposedNext[0]` without showing the gate. */
  autoProceed?: boolean;
  preselectedTarget?: Target;
  userNotes?: string;
  nextStageId?: string;
}

export interface PauseSnapshot {
  at: number;
  gitHead?: string;
  observedHash?: string;
  worktree?: string;
}

export interface WorkflowRun {
  version: 1;
  runId: string;
  sessionId: string;
  workflowName: string;
  workflowSnapshotHash: string;
  idea: string;
  cwd: string;
  worktree?: string;
  verify?: string;
  status: WorkflowRunStatus;
  checkpointTurnId?: string;
  executed: ExecutedStage[];
  current?: { stageId: string; ordinal: number; visit: number; sessionId?: string; startedAt: number; target?: Target };
  gate?: WorkflowGate;
  pausedAt?: PauseSnapshot;
  exhausted: AcpProvider[];
  attachedFiles?: string[];
  stoppedReason?: string;
}

export type GateAction =
  | { type: "start"; nextStageId?: string; target?: Target; notes?: string }
  | { type: "pause"; at: number; gitHead?: string; observedHash?: string; worktree?: string }
  | { type: "cancel"; reason?: string }
  | { type: "skip"; notes?: string }
  | { type: "rerun"; target?: Target }
  | { type: "restart"; target?: Target }
  | { type: "finish" }
  | { type: "continueAnyway" }
  | { type: "acceptAsIs" }
  | { type: "anotherRound"; target?: Target }
  | { type: "changeWorkflow" }
  | { type: "revertAll" }
  | { type: "keepChanges" };

export interface GateProposal {
  proposedNext: string[];
  reason: string;
  kind: GateKind;
  forcedManual: string[];
  matched?: WorkflowTransition;
}

export function copyRun(run: WorkflowRun): WorkflowRun {
  return {
    ...run,
    executed: run.executed.map((entry) => ({ ...entry })),
    ...(run.current ? { current: { ...run.current } } : {}),
    ...(run.gate
      ? {
          gate: {
            ...run.gate,
            proposedNext: [...run.gate.proposedNext],
            ...(run.gate.forcedManual ? { forcedManual: [...run.gate.forcedManual] } : {}),
            ...(run.gate.preselectedTarget ? { preselectedTarget: { ...run.gate.preselectedTarget } } : {}),
          },
        }
      : {}),
    ...(run.pausedAt ? { pausedAt: { ...run.pausedAt } } : {}),
    exhausted: [...run.exhausted],
    ...(run.attachedFiles ? { attachedFiles: [...run.attachedFiles] } : {}),
  };
}

export function visitCount(run: WorkflowRun, stageId: string): number {
  return run.executed.filter((entry) => entry.stageId === stageId).length
    + (run.current?.stageId === stageId ? 1 : 0);
}

export function nextOrdinal(run: WorkflowRun): number {
  return run.executed.length + 1;
}

export function makeWorkflowRun(input: {
  runId: string;
  sessionId: string;
  workflow: WorkflowDefinition;
  idea: string;
  cwd: string;
  worktree?: string;
  verify?: string;
  checkpointTurnId?: string;
  attachedFiles?: readonly string[];
  firstTarget?: Target;
}): WorkflowRun {
  const start = firstEnabledStart(input.workflow) ?? input.workflow.stages[0]?.id ?? "plan";
  const stage = findStage(input.workflow, start);
  return {
    version: 1,
    runId: input.runId,
    sessionId: input.sessionId,
    workflowName: input.workflow.name,
    workflowSnapshotHash: "",
    idea: input.idea,
    cwd: input.cwd,
    ...(input.worktree ? { worktree: input.worktree } : {}),
    ...(input.verify ? { verify: input.verify } : {}),
    status: "at-gate",
    ...(input.checkpointTurnId ? { checkpointTurnId: input.checkpointTurnId } : {}),
    executed: [],
    gate: {
      proposedNext: [start],
      nextStageId: start,
      reason: `Next stage: ${stage?.title ?? start}`,
      kind: "gate-0",
      ...(input.firstTarget ? { preselectedTarget: input.firstTarget } : {}),
    },
    exhausted: [],
    ...(input.attachedFiles?.length ? { attachedFiles: [...input.attachedFiles] } : {}),
  };
}

export function withSnapshotHash(run: WorkflowRun, hash: string): WorkflowRun {
  const next = copyRun(run);
  next.workflowSnapshotHash = hash;
  return next;
}

export function markExhausted(run: WorkflowRun, provider: AcpProvider): WorkflowRun {
  if (run.exhausted.includes(provider)) return run;
  const next = copyRun(run);
  next.exhausted = [...next.exhausted, provider];
  return next;
}

/**
 * Reasons a gate must be shown even when the workflow (or the setting) says
 * `auto`. A failed stage, a red verify, an unreadable verdict, unreported
 * edits or a quota error always stop (D6).
 */
export function forcedManualReasons(
  packet: HandoffPacket,
  def: WorkflowDefinition,
  packets: Iterable<HandoffPacket>,
): string[] {
  const reasons: string[] = [];
  if (packet.status === "failed") reasons.push("stage-failed");
  if (packet.status === "cancelled") reasons.push("stage-cancelled");
  if (packet.status === "interrupted") reasons.push("stage-interrupted");
  const verify = verifyForTransitions(def, packet, packets);
  if (verify && verify.exitCode !== 0) reasons.push("verify-failed");
  const stage = findStage(def, packet.stageId);
  const contract = stage ? def.contracts[stage.contract] : undefined;
  if (verdictUnreadable(packet, contract)) reasons.push("unreadable-verdict");
  if (packet.unreported.length) reasons.push("unreported-edits");
  return reasons;
}

function severityRank(value: string | undefined): number {
  if (value === "blocker") return 4;
  if (value === "major") return 3;
  if (value === "minor") return 2;
  if (value === "nit") return 1;
  return 0;
}

function whenMatches(
  transition: WorkflowTransition,
  packet: HandoffPacket,
  def: WorkflowDefinition,
  packets: Iterable<HandoffPacket>,
): boolean {
  const when = transition.when;
  if (!when) return true;
  if (when.verdict && (!packet.verdict || !when.verdict.includes(packet.verdict))) return false;
  if (when.verify) {
    const status = verifyStatus(verifyForTransitions(def, packet, packets));
    if (!when.verify.includes(status)) return false;
  }
  if (when.findingsAtLeast) {
    const highest = highestFindingSeverity(packet.findings);
    if (severityRank(highest) < severityRank(when.findingsAtLeast)) return false;
  }
  if (when.status) {
    const mapped = packet.status === "done" ? "done" : "failed";
    if (!when.status.includes(mapped)) return false;
  }
  if (when.unreported !== undefined) {
    const has = packet.unreported.length > 0;
    if (when.unreported !== has) return false;
  }
  return true;
}

/**
 * Transitions are evaluated in order; the first match wins; a transition
 * without `when` always matches. No match → every declared `to` plus `$done`
 * and `$pause`, and the gate says no rule matched (§8.3).
 */
export function nextFromTransitions(
  def: WorkflowDefinition,
  run: WorkflowRun,
  packet: HandoffPacket,
  packets: Iterable<HandoffPacket>,
): GateProposal {
  const stage = findStage(def, packet.stageId);
  const forced = forcedManualReasons(packet, def, packets);
  if (packet.status === "interrupted") {
    return {
      proposedNext: [packet.stageId],
      reason: "The stage was interrupted. Restart it, skip it, or cancel the run.",
      kind: "interrupted",
      forcedManual: forced.length ? forced : ["stage-interrupted"],
    };
  }
  if (packet.status === "failed") {
    return {
      proposedNext: [packet.stageId, "$cancel"],
      reason: packet.summary || "The stage failed.",
      kind: "failed",
      forcedManual: forced,
    };
  }
  if (!stage) {
    return {
      proposedNext: ["$done", "$pause"],
      reason: `Unknown stage '${packet.stageId}'.`,
      kind: "failed",
      forcedManual: ["stage-failed"],
    };
  }
  const contract = def.contracts[stage.contract];
  if (verdictUnreadable(packet, contract)) {
    const declared = stage.next.map((t) => t.to);
    return {
      proposedNext: uniqueTargets([...declared, "$done", "$pause"]),
      reason: "Could not read the reviewer's verdict. Choose the next stage.",
      kind: "unreadable-verdict",
      forcedManual: forced,
    };
  }
  for (const transition of stage.next) {
    if (!whenMatches(transition, packet, def, packets)) continue;
    const dest = isReservedTarget(transition.to) ? undefined : findStage(def, transition.to);
    // Bound the loop on the DESTINATION: the third review that still wants
    // Fix is what produces "after N fix rounds", not the Fix stage ending.
    if (dest?.maxVisits && run.executed.filter((entry) => entry.stageId === dest.id).length >= dest.maxVisits) {
      const to = dest.onMaxVisits || "$pause";
      return {
        proposedNext: [to, "$done", "$cancel"],
        reason: `Review still requests changes after ${dest.maxVisits} fix rounds.`,
        kind: "fixer-limit",
        forcedManual: ["max-visits"],
      };
    }
    return {
      proposedNext: [transition.to],
      reason: transition.reason
        || transitionReason(stage, transition, packet),
      kind: "normal",
      forcedManual: forced,
      matched: transition,
    };
  }
  const declared = stage.next.map((t) => t.to);
  return {
    proposedNext: uniqueTargets([...declared, "$done", "$pause"]),
    reason: "No transition matched. Choose the next stage.",
    kind: "normal",
    forcedManual: forced.length ? forced : ["no-match"],
  };
}

function transitionReason(stage: WorkflowStage, transition: WorkflowTransition, packet: HandoffPacket): string {
  if (packet.verdict) return `${stage.title} verdict: ${packet.verdict} → ${labelOf(transition.to)}`;
  return `Next stage: ${labelOf(transition.to)}`;
}

function labelOf(to: string): string {
  if (to === "$done") return "Done";
  if (to === "$pause") return "Paused";
  if (to === "$cancel") return "Cancel";
  return to;
}

function uniqueTargets(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

export function startStage(
  run: WorkflowRun,
  stageId: string,
  now: number,
  opts?: { sessionId?: string; target?: Target },
): WorkflowRun {
  const next = copyRun(run);
  const visit = visitCount(run, stageId) + (run.current?.stageId === stageId ? 0 : 1);
  const ordinal = run.current?.stageId === stageId ? run.current.ordinal : nextOrdinal(run);
  next.status = "running";
  next.current = {
    stageId,
    ordinal,
    visit,
    startedAt: now,
    ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
    ...(opts?.target ? { target: opts.target } : {}),
  };
  delete next.gate;
  delete next.pausedAt;
  delete next.stoppedReason;
  return next;
}

export function bindStageSession(run: WorkflowRun, sessionId: string): WorkflowRun {
  if (!run.current) return run;
  const next = copyRun(run);
  next.current = { ...next.current!, sessionId };
  return next;
}

export function applyStageOutcome(
  run: WorkflowRun,
  def: WorkflowDefinition,
  packet: HandoffPacket,
  packets: Iterable<HandoffPacket>,
  opts: { autoStartNextStage: boolean },
): WorkflowRun {
  const next = copyRun(run);
  const current = next.current;
  next.executed.push({
    stageId: packet.stageId,
    ordinal: packet.stageOrdinal,
    visit: packet.visit,
    packetPath: packet.resultPath.replace(/\.result\.md$/i, ".handoff.json"),
    status: packet.status,
    ...(current?.sessionId ? { sessionId: current.sessionId } : {}),
  });
  delete next.current;
  const proposal = nextFromTransitions(def, next, packet, packets);
  const finished = findStage(def, packet.stageId);
  const auto = finished
    ? isAutoGate(finished, def, opts.autoStartNextStage) && proposal.forcedManual.length === 0
    : false;
  const first = proposal.proposedNext[0];
  if (auto && first === "$done") {
    next.status = "done";
    next.gate = {
      proposedNext: ["$done"],
      nextStageId: "$done",
      reason: proposal.reason,
      kind: proposal.kind,
      autoProceed: true,
    };
    return next;
  }
  if (auto && first && !isReservedTarget(first) && findStage(def, first)) {
    next.status = "at-gate";
    next.gate = {
      proposedNext: proposal.proposedNext,
      nextStageId: first,
      reason: proposal.reason,
      kind: proposal.kind,
      autoProceed: true,
    };
    return next;
  }
  next.status = first === "$done" && proposal.kind === "normal" && proposal.forcedManual.length === 0
    ? "at-gate"
    : "at-gate";
  next.gate = {
    proposedNext: proposal.proposedNext,
    nextStageId: first,
    reason: proposal.reason,
    kind: proposal.kind,
    ...(proposal.forcedManual.length ? { forcedManual: proposal.forcedManual } : {}),
  };
  if (proposal.kind === "fixer-limit") {
    next.status = "paused";
    next.stoppedReason = proposal.reason;
  }
  return next;
}

export function applyGateAction(
  run: WorkflowRun,
  def: WorkflowDefinition,
  action: GateAction,
  now: number,
): WorkflowRun {
  if (action.type === "cancel") {
    const next = copyRun(run);
    next.status = "cancelled";
    next.stoppedReason = action.reason || "Cancelled.";
    delete next.current;
    delete next.gate;
    return next;
  }
  if (action.type === "pause") {
    const next = copyRun(run);
    next.status = "paused";
    next.pausedAt = {
      at: action.at,
      ...(action.gitHead ? { gitHead: action.gitHead } : {}),
      ...(action.observedHash ? { observedHash: action.observedHash } : {}),
      ...(action.worktree ? { worktree: action.worktree } : {}),
    };
    if (next.gate) {
      const stageId = next.gate.nextStageId ?? next.gate.proposedNext[0];
      const stage = stageId && !isReservedTarget(stageId) ? findStage(def, stageId) : undefined;
      next.stoppedReason = `Paused before ${stage?.title ?? stageId ?? "next stage"}`;
    }
    return next;
  }
  if (action.type === "finish" || action.type === "acceptAsIs") {
    const next = copyRun(run);
    next.status = "done";
    delete next.gate;
    delete next.current;
    return next;
  }
  if (action.type === "continueAnyway") {
    const next = copyRun(run);
    if (next.gate?.kind === "stale" || next.gate?.kind === "snapshot-drift") {
      next.gate = { ...next.gate, kind: "normal" };
      next.status = "at-gate";
      delete next.pausedAt;
    }
    return next;
  }
  if (action.type === "changeWorkflow") {
    return run;
  }
  if (action.type === "skip") {
    return skipProposed(run, def, action.notes);
  }
  if (action.type === "rerun" || action.type === "restart") {
    const stageId = lastExecuted(run)?.stageId ?? run.current?.stageId;
    if (!stageId) return run;
    return startStage(run, stageId, now, { target: action.target });
  }
  if (action.type === "anotherRound") {
    const stageId = run.gate?.proposedNext.find((id) => id === "fix") ?? "fix";
    const next = copyRun(run);
    const stage = findStage(def, stageId);
    if (stage?.maxVisits) {
      next.executed = next.executed.map((entry) =>
        entry.stageId === stageId ? entry : entry,
      );
      // An explicit extra round: lift the cap by treating this as a fresh
      // visit the user asked for, rather than silently raising maxVisits on
      // the snapshot (which would rewrite a paused run's meaning).
    }
    return startStage(next, stageId, now, { target: action.target });
  }
  if (action.type === "start") {
    const requested = action.nextStageId
      ?? run.gate?.nextStageId
      ?? run.gate?.proposedNext[0];
    if (!requested) return run;
    if (requested === "$done") {
      const next = copyRun(run);
      next.status = "done";
      delete next.gate;
      return next;
    }
    if (requested === "$pause") {
      return applyGateAction(run, def, { type: "pause", at: now }, now);
    }
    if (requested === "$cancel") {
      return applyGateAction(run, def, { type: "cancel" }, now);
    }
    if (!findStage(def, requested)) return run;
    const next = action.notes?.trim()
      ? withGateNotes(run, action.notes.trim())
      : run;
    return startStage(next, requested, now, { target: action.target });
  }
  return run;
}

function withGateNotes(run: WorkflowRun, notes: string): WorkflowRun {
  const next = copyRun(run);
  if (!next.gate) return next;
  next.gate = { ...next.gate, userNotes: notes };
  return next;
}

function lastExecuted(run: WorkflowRun): ExecutedStage | undefined {
  return run.executed[run.executed.length - 1];
}

/**
 * Skip the proposed next stage and advance to the stage after it.
 *
 * Skipping Plan is allowed only when the user pasted a plan into the notes
 * (it becomes the plan packet). The host enforces that; this function still
 * records the skip so a later gate cannot pretend Plan ran.
 */
export function skipProposed(run: WorkflowRun, def: WorkflowDefinition, notes?: string): WorkflowRun {
  const next = copyRun(run);
  const proposed = next.gate?.nextStageId ?? next.gate?.proposedNext[0];
  if (!proposed || isReservedTarget(proposed)) return run;
  const stage = findStage(def, proposed);
  const ordinal = nextOrdinal(next);
  next.executed.push({
    stageId: proposed,
    ordinal,
    visit: visitCount(next, proposed) + 1,
    packetPath: "",
    status: "skipped",
  });
  const after = stage?.next[0]?.to;
  if (!after || after === "$done") {
    next.status = "at-gate";
    next.gate = {
      proposedNext: ["$done"],
      nextStageId: "$done",
      reason: notes?.trim() || `Skipped ${stage?.title ?? proposed}.`,
      kind: "normal",
    };
    return next;
  }
  const following = findStage(def, after);
  next.status = "at-gate";
  next.gate = {
    proposedNext: [after],
    nextStageId: after,
    reason: `Skipped ${stage?.title ?? proposed}. Next stage: ${following?.title ?? after}`,
    kind: "normal",
    ...(notes?.trim() ? { userNotes: notes.trim() } : {}),
  };
  return next;
}

export function appendGateNotes(run: WorkflowRun, text: string): WorkflowRun {
  const note = text.trim();
  if (!note || !run.gate) return run;
  const next = copyRun(run);
  const previous = next.gate!.userNotes?.trim();
  next.gate = {
    ...next.gate!,
    userNotes: previous ? `${previous}\n${note}` : note,
  };
  return next;
}

export type Staleness =
  | { ok: true }
  | { ok: false; code: "worktree-gone"; details: string[] }
  | { ok: false; code: "stale"; details: string[] };

/**
 * Resume is possible only at a stage boundary. A deleted worktree makes the
 * run unresumable. A changed HEAD or an edited observed file requires an
 * explicit "Continue anyway".
 */
export function resumeStaleness(
  paused: PauseSnapshot | undefined,
  current: { gitHead?: string; observedHash?: string; worktreeExists?: boolean; worktree?: string },
): Staleness {
  if (paused?.worktree || current.worktree) {
    if (current.worktreeExists === false) {
      return {
        ok: false,
        code: "worktree-gone",
        details: ["The worktree this run used no longer exists."],
      };
    }
  }
  const details: string[] = [];
  if (paused?.gitHead && current.gitHead && paused.gitHead !== current.gitHead) {
    details.push(`HEAD moved from ${paused.gitHead.slice(0, 8)} to ${current.gitHead.slice(0, 8)}.`);
  }
  if (paused?.observedHash && current.observedHash && paused.observedHash !== current.observedHash) {
    details.push("An observed file changed on disk.");
  }
  if (details.length) return { ok: false, code: "stale", details };
  return { ok: true };
}

export function applyStaleness(run: WorkflowRun, staleness: Staleness): WorkflowRun {
  if (staleness.ok) return run;
  const next = copyRun(run);
  next.status = staleness.code === "worktree-gone" ? "failed" : "at-gate";
  next.gate = {
    proposedNext: next.gate?.proposedNext ?? ["$pause"],
    nextStageId: next.gate?.nextStageId,
    reason: staleness.code === "worktree-gone"
      ? "The worktree this run used no longer exists. The run cannot be resumed."
      : "The workspace changed since this run paused.",
    kind: staleness.code === "worktree-gone" ? "unresumable" : "stale",
    forcedManual: [staleness.code],
  };
  if (staleness.code === "worktree-gone") next.stoppedReason = next.gate.reason;
  return next;
}

export function snapshotDrift(run: WorkflowRun, liveHash: string): boolean {
  return !!run.workflowSnapshotHash && run.workflowSnapshotHash !== liveHash;
}

export function applySnapshotDrift(run: WorkflowRun): WorkflowRun {
  const next = copyRun(run);
  if (!next.gate) return next;
  next.gate = {
    ...next.gate,
    kind: "snapshot-drift",
    reason: next.gate.reason,
    forcedManual: [...(next.gate.forcedManual ?? []), "snapshot-drift"],
  };
  return next;
}

/** Copy-deck history subtitle. */
export function historySubtitle(run: WorkflowRun, def: WorkflowDefinition): string {
  const total = estimatedStageCount(def);
  const done = run.executed.filter((e) => e.status === "done" || e.status === "skipped").length;
  if (run.status === "done") return `Done · ${run.executed.length} stages`;
  if (run.status === "cancelled") return `Cancelled (${done}/${total})`;
  if (run.status === "failed") return `Failed (${done}/${total})`;
  const nextId = run.current?.stageId ?? run.gate?.nextStageId ?? run.gate?.proposedNext[0];
  const stage = nextId && !isReservedTarget(nextId) ? findStage(def, nextId) : undefined;
  const name = stage?.title ?? nextId ?? "next stage";
  if (run.status === "running") return `Running ${name} (${done}/${total})`;
  return `Crew · paused before ${name} (${done}/${total})`;
}

export function gateTitle(run: WorkflowRun, def: WorkflowDefinition): string {
  if (run.gate?.kind === "gate-0") {
    const id = run.gate.nextStageId ?? run.gate.proposedNext[0];
    const stage = id ? findStage(def, id) : undefined;
    return `Next stage: ${stage?.title ?? id ?? "Plan"}`;
  }
  const last = lastExecuted(run);
  const stage = last ? findStage(def, last.stageId) : undefined;
  const total = estimatedStageCount(def);
  const n = last?.ordinal ?? run.executed.length;
  return `Stage ${n} of ~${total} done: ${stage?.title ?? last?.stageId ?? ""}`;
}

export function parseGateMessage(text: string): { kind: "command"; command: GateAction["type"] } | { kind: "notes"; text: string } {
  const raw = String(text ?? "").trim();
  const lower = raw.toLowerCase();
  if (lower === "/pause" || lower === "stop" || lower === "stop & resume later") {
    return { kind: "command", command: "pause" };
  }
  if (lower === "/resume" || lower === "continue anyway") {
    return { kind: "command", command: "continueAnyway" };
  }
  if (lower === "/cancel" || lower === "cancel" || lower === "cancel run") {
    return { kind: "command", command: "cancel" };
  }
  if (lower === "/skip" || lower === "skip" || lower === "skip this stage") {
    return { kind: "command", command: "skip" };
  }
  if (lower === "/rerun" || lower === "rerun last" || lower === "rerun") {
    return { kind: "command", command: "rerun" };
  }
  if (lower === "/restart" || lower === "restart stage") {
    return { kind: "command", command: "restart" };
  }
  return { kind: "notes", text: raw };
}

export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

export function observedFilesHash(files: ReadonlyArray<{ path: string; hash: string }>): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  let acc = "";
  for (const file of sorted) acc += `${file.path}:${file.hash}\n`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < acc.length; i += 1) {
    hash ^= acc.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function serializeWorkflowRun(run: WorkflowRun): string {
  return `${JSON.stringify(run, null, 2)}\n`;
}

export function parseWorkflowRun(text: string): WorkflowRun | undefined {
  try {
    const raw = JSON.parse(text) as WorkflowRun;
    if (!raw || raw.version !== 1 || typeof raw.runId !== "string") return undefined;
    if (!Array.isArray(raw.executed)) return undefined;
    return raw;
  } catch {
    return undefined;
  }
}

/** Temp + rename. The caller injects fs so this stays testable. */
export function writeAtomic(
  fs: { writeFileSync: (path: string, data: string) => void; renameSync: (from: string, to: string) => void },
  target: string,
  contents: string,
): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, target);
}

export interface WorkflowRunFs {
  mkdirSync(path: string, options: { recursive: true }): void;
  writeFileSync(path: string, data: string): void;
  readFileSync?(path: string, encoding: "utf8"): string;
  renameSync(from: string, to: string): void;
  existsSync(path: string): boolean;
}

export class WorkflowRunStore {
  constructor(
    private readonly options: {
      root: string;
      fs: WorkflowRunFs;
      join?: (...parts: string[]) => string;
    },
  ) {}

  private join(...parts: string[]): string {
    return (this.options.join ?? ((...p: string[]) => p.join("/").replace(/\/{2,}/g, "/")))(
      ...parts,
    );
  }

  runDir(runId: string): string {
    return this.join(this.options.root, runId);
  }

  runPath(runId: string): string {
    return this.join(this.runDir(runId), "run.json");
  }

  snapshotPath(runId: string): string {
    return this.join(this.runDir(runId), "workflow.snapshot.json");
  }

  handoffPath(runId: string, ordinal: number): string {
    const n = Number.isFinite(ordinal) && ordinal > 0 ? Math.floor(ordinal) : 1;
    return this.join(this.runDir(runId), `stage-${String(n).padStart(2, "0")}.handoff.json`);
  }

  writeRun(run: WorkflowRun): string {
    const dir = this.runDir(run.runId);
    this.options.fs.mkdirSync(dir, { recursive: true });
    const target = this.runPath(run.runId);
    writeAtomic(this.options.fs, target, serializeWorkflowRun(run));
    return target;
  }

  writeSnapshot(runId: string, snapshotJson: string): string {
    const dir = this.runDir(runId);
    this.options.fs.mkdirSync(dir, { recursive: true });
    const target = this.snapshotPath(runId);
    writeAtomic(this.options.fs, target, snapshotJson.endsWith("\n") ? snapshotJson : `${snapshotJson}\n`);
    return target;
  }

  writeHandoff(runId: string, ordinal: number, packet: HandoffPacket): string {
    const dir = this.runDir(runId);
    this.options.fs.mkdirSync(dir, { recursive: true });
    const target = this.handoffPath(runId, ordinal);
    writeAtomic(this.options.fs, target, `${JSON.stringify(packet, null, 2)}\n`);
    return target;
  }

  readRun(runId: string): WorkflowRun | undefined {
    const read = this.options.fs.readFileSync;
    if (!read || !this.options.fs.existsSync(this.runPath(runId))) return undefined;
    try {
      return parseWorkflowRun(read(this.runPath(runId), "utf8"));
    } catch {
      return undefined;
    }
  }

  readSnapshot(runId: string): string | undefined {
    const read = this.options.fs.readFileSync;
    if (!read || !this.options.fs.existsSync(this.snapshotPath(runId))) return undefined;
    try {
      return read(this.snapshotPath(runId), "utf8");
    } catch {
      return undefined;
    }
  }
}

export type { ReservedTarget };

export function toWorkflowView(opts: {
  run: WorkflowRun;
  def: WorkflowDefinition;
  lastPacket?: HandoffPacket;
  listing?: {
    targets: Array<{
      provider: AcpProvider;
      displayName: string;
      defaultModel?: string;
      defaultEffort?: string;
      models?: Array<{ id: string; label?: string; efforts?: string[] }>;
    }>;
    ineligible: Array<{ provider: AcpProvider; message: string }>;
  };
  staleDetails?: string[];
}): WorkflowRunView {
  const { run, def, lastPacket, listing, staleDetails } = opts;
  const nextId = run.current?.stageId ?? run.gate?.nextStageId ?? run.gate?.proposedNext[0];
  const stages = def.stages.filter((s) => s.enabled).map((stage) => {
    const last = [...run.executed].reverse().find((e) => e.stageId === stage.id);
    const status = run.current?.stageId === stage.id
      ? "running"
      : last?.status ?? "pending";
    return {
      id: stage.id,
      title: stage.title,
      status,
      ...(last?.ordinal ? { ordinal: last.ordinal } : {}),
      ...(last?.sessionId ? { sessionId: last.sessionId } : {}),
    };
  });
  const gate = run.gate
    ? {
        kind: run.gate.kind,
        title: gateTitle(run, def),
        reason: run.gate.reason,
        ...(lastPacket?.summary ? { summary: lastPacket.summary } : {}),
        ...(lastPacket?.filesObserved?.length ? { filesObserved: lastPacket.filesObserved } : {}),
        ...(lastPacket?.unreported?.length ? { unreported: lastPacket.unreported } : {}),
        ...(lastPacket?.claimedOnly?.length ? { claimedOnly: lastPacket.claimedOnly } : {}),
        ...(lastPacket?.verify ? { verify: lastPacket.verify } : {}),
        ...(lastPacket?.verdict ? { verdict: lastPacket.verdict } : {}),
        ...(lastPacket?.findings?.length ? { findings: lastPacket.findings } : {}),
        ...(lastPacket?.openQuestions?.length ? { openQuestions: lastPacket.openQuestions } : {}),
        proposedNext: run.gate.proposedNext.map((id) => ({
          id,
          title: isReservedTarget(id)
            ? labelOf(id)
            : (findStage(def, id)?.title ?? id),
        })),
        ...(run.gate.nextStageId ? { nextStageId: run.gate.nextStageId } : {}),
        ...(run.gate.userNotes ? { userNotes: run.gate.userNotes } : {}),
        ...(run.gate.forcedManual ? { forcedManual: run.gate.forcedManual } : {}),
        ...(staleDetails?.length ? { staleDetails } : {}),
        ...(lastPacket?.durationMs ? { durationMs: lastPacket.durationMs } : {}),
        ...(lastPacket
          ? {
              targetLabel: [lastPacket.target.provider, lastPacket.target.model, lastPacket.target.effort]
                .filter(Boolean)
                .join(" · "),
            }
          : {}),
        eligible: (listing?.targets ?? []).map((t) => ({
          provider: t.provider,
          displayName: t.displayName,
          ...(t.defaultModel ? { defaultModel: t.defaultModel } : {}),
          ...(t.defaultEffort ? { defaultEffort: t.defaultEffort } : {}),
          ...(t.models ? { models: t.models } : {}),
        })),
        ineligible: (listing?.ineligible ?? []).map((row) => ({
          provider: row.provider,
          message: row.message,
        })),
        ...(run.gate.preselectedTarget
          ? {
              preselected: {
                provider: run.gate.preselectedTarget.provider,
                ...(run.gate.preselectedTarget.model ? { model: run.gate.preselectedTarget.model } : {}),
                ...(run.gate.preselectedTarget.effort ? { effort: run.gate.preselectedTarget.effort } : {}),
              },
            }
          : {}),
      }
    : undefined;
  return {
    runId: run.runId,
    idea: run.idea,
    workflowName: run.workflowName,
    workflowTitle: def.title,
    status: run.status,
    subtitle: historySubtitle(run, def),
    stages,
    ...(nextId && !isReservedTarget(nextId) ? { currentStageId: nextId } : {}),
    ...(gate ? { gate } : {}),
  };
}
