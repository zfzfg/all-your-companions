/**
 * Crew-run state machine (AP-12, crew stage 3).
 *
 * A run is a list of steps. The default walk is **sequential**. Parallelism
 * is AP-13 and opt-in (`parallel: true` on the preset): independent writers
 * may share a wave, each in its own worktree. A failure still pauses the
 * chain rather than spreading.
 *
 * `PlanEntry.id` is a HINT (`planEntryHint`), never the key. AP-02 already
 * learned that an id is stable only while the model keeps the wording; a
 * rephrase would drop a role assignment that lived on the id. The assignment
 * lives on the step so it survives that.
 *
 * Pure (recipe R7): no vscode, no fs, no clock. Status changes return a new
 * object — the same immutability as `plan-gate.ts`.
 */

import type { PlanEntry } from "./plan-entries";

export type CrewStepStatus = "pending" | "assigned" | "running" | "done" | "failed" | "skipped";

export interface CrewStep {
  /** 1-based, and the `step-NN` on disk. */
  index: number;
  /** From PlanEntry.content. */
  title: string;
  /** AP-02 id — a hint to re-recognise, NEVER the key. */
  planEntryHint?: string;
  role?: string;
  assignWhy?: string;
  status: CrewStepStatus;
  sessionId?: string;
  filesReported: string[];
  filesObserved: string[];
  costUsdTicks?: number;
  durationMs?: number;
  detail?: string;
}

export type CrewRunStatus =
  | "planning"
  | "assigning"
  | "running"
  | "paused"
  | "review"
  | "done"
  | "failed"
  | "cancelled";

export interface CrewRun {
  runId: string;
  goal: string;
  cwd: string;
  status: CrewRunStatus;
  steps: CrewStep[];
  /** AP-08 anchor for the WHOLE run, so it is restorable in one go. */
  checkpointTurnId?: string;
  stoppedReason?: string;
  /** Preset name, when the run was started from `/crew <preset>`. */
  preset?: string;
  /** Optional verify command from the preset, run after each writing step. */
  verify?: string;
  /** Opt-in: independent steps may share a wave (AP-13). Sequential is the default. */
  parallel?: boolean;
}

export interface StepOutcome {
  status: "done" | "failed" | "skipped" | "cancelled";
  filesReported?: readonly string[];
  filesObserved?: readonly string[];
  costUsdTicks?: number;
  durationMs?: number;
  detail?: string;
  sessionId?: string;
}

export function stepsFromPlan(entries: readonly PlanEntry[]): CrewStep[] {
  const out: CrewStep[] = [];
  for (const entry of entries) {
    const title = String(entry.content ?? "").trim();
    if (!title) continue;
    out.push({
      index: out.length + 1,
      title,
      ...(entry.id ? { planEntryHint: entry.id } : {}),
      status: "pending",
      filesReported: [],
      filesObserved: [],
    });
  }
  return out;
}

export function makeCrewRun(input: {
  runId: string;
  goal: string;
  cwd: string;
  steps: CrewStep[];
  preset?: string;
  verify?: string;
  checkpointTurnId?: string;
  parallel?: boolean;
}): CrewRun {
  return {
    runId: input.runId,
    goal: input.goal,
    cwd: input.cwd,
    status: input.steps.length ? "assigning" : "planning",
    steps: input.steps.map((s, i) => ({ ...s, index: i + 1, filesReported: [...s.filesReported], filesObserved: [...s.filesObserved] })),
    ...(input.preset ? { preset: input.preset } : {}),
    ...(input.verify ? { verify: input.verify } : {}),
    ...(input.checkpointTurnId ? { checkpointTurnId: input.checkpointTurnId } : {}),
    ...(input.parallel ? { parallel: true } : {}),
  };
}

/** First step that can still run. Sequential: a live `running` step blocks the rest. */
export function nextRunnableStep(run: CrewRun): CrewStep | undefined {
  if (run.status === "paused" || run.status === "failed" || run.status === "cancelled" || run.status === "done" || run.status === "review") {
    return undefined;
  }
  if (run.steps.some((s) => s.status === "running")) return undefined;
  return run.steps.find((s) => s.status === "pending" || s.status === "assigned");
}

export function crewProgress(run: CrewRun): { done: number; total: number; failed: number } {
  const total = run.steps.length;
  let done = 0;
  let failed = 0;
  for (const s of run.steps) {
    if (s.status === "done" || s.status === "skipped") done += 1;
    if (s.status === "failed") failed += 1;
  }
  return { done, total, failed };
}

export function crewCostTicks(run: CrewRun): number {
  let sum = 0;
  for (const s of run.steps) {
    if (typeof s.costUsdTicks === "number") sum += s.costUsdTicks;
  }
  return sum;
}

function copyRun(run: CrewRun): CrewRun {
  return {
    ...run,
    steps: run.steps.map((s) => ({
      ...s,
      filesReported: [...s.filesReported],
      filesObserved: [...s.filesObserved],
    })),
  };
}

export function setCrewStatus(run: CrewRun, status: CrewRunStatus, reason?: string): CrewRun {
  const next = copyRun(run);
  next.status = status;
  if (reason) next.stoppedReason = reason;
  else delete next.stoppedReason;
  return next;
}

export function assignStepRole(run: CrewRun, index: number, role: string, why: string): CrewRun {
  const next = copyRun(run);
  const step = next.steps.find((s) => s.index === index);
  if (!step) return next;
  step.role = role;
  step.assignWhy = why;
  if (step.status === "pending") step.status = "assigned";
  return next;
}

export function startCrewStep(run: CrewRun, index: number, sessionId?: string): CrewRun {
  const next = copyRun(run);
  next.status = "running";
  const step = next.steps.find((s) => s.index === index);
  if (!step) return next;
  // A step must not run twice — the previous outcome stays if it already finished.
  if (step.status === "done" || step.status === "failed" || step.status === "skipped") return run;
  step.status = "running";
  if (sessionId) step.sessionId = sessionId;
  return next;
}

export function applyStepOutcome(run: CrewRun, index: number, outcome: StepOutcome): CrewRun {
  const next = copyRun(run);
  const step = next.steps.find((s) => s.index === index);
  if (!step) return next;
  if (step.status === "done" || step.status === "failed" || step.status === "skipped") {
    return run;
  }
  step.status = outcome.status === "cancelled" ? "failed" : outcome.status;
  step.filesReported = [...(outcome.filesReported ?? [])];
  step.filesObserved = [...(outcome.filesObserved ?? [])];
  if (outcome.costUsdTicks !== undefined) step.costUsdTicks = outcome.costUsdTicks;
  if (outcome.durationMs !== undefined) step.durationMs = outcome.durationMs;
  if (outcome.detail) step.detail = outcome.detail;
  if (outcome.sessionId) step.sessionId = outcome.sessionId;

  if (outcome.status === "cancelled") {
    next.status = "cancelled";
    next.stoppedReason = outcome.detail || "Stopped.";
    return next;
  }
  if (outcome.status === "failed") {
    // Pause rather than continue: a chain that walks past a failure spreads it.
    next.status = "paused";
    next.stoppedReason = outcome.detail || `Step ${index} failed.`;
    return next;
  }
  const live = next.steps.some((s) => s.status === "running");
  const more = next.steps.some((s) => s.status === "pending" || s.status === "assigned");
  // A sibling still running (AP-13 wave) must not flip the run to `review`.
  next.status = live || more ? "running" : "review";
  return next;
}

/**
 * Insert a step after `afterIndex` (1-based). Used by the verify loop to
 * splice in `fixer` when a check is red. Existing later steps are re-indexed.
 */
export function insertCrewStep(
  run: CrewRun,
  afterIndex: number,
  draft: Omit<CrewStep, "index" | "filesReported" | "filesObserved" | "status"> & { status?: CrewStepStatus },
): CrewRun {
  const next = copyRun(run);
  const at = next.steps.findIndex((s) => s.index === afterIndex);
  const step: CrewStep = {
    index: afterIndex + 1,
    title: draft.title,
    status: draft.status ?? "assigned",
    filesReported: [],
    filesObserved: [],
    ...(draft.planEntryHint ? { planEntryHint: draft.planEntryHint } : {}),
    ...(draft.role ? { role: draft.role } : {}),
    ...(draft.assignWhy ? { assignWhy: draft.assignWhy } : {}),
  };
  if (at < 0) next.steps.push(step);
  else next.steps.splice(at + 1, 0, step);
  next.steps.forEach((s, i) => { s.index = i + 1; });
  return next;
}

export function cancelCrewRun(run: CrewRun, reason: string): CrewRun {
  const next = copyRun(run);
  next.status = "cancelled";
  next.stoppedReason = reason;
  for (const s of next.steps) {
    if (s.status === "running") s.status = "failed";
    if (s.status === "pending" || s.status === "assigned") s.status = "skipped";
  }
  return next;
}
