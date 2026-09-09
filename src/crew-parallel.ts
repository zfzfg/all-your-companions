/**
 * Which pending crew steps may run at the same time (AP-13).
 *
 * Parallelism is opt-in (`parallel: true` on a preset). Sequential remains
 * the default, and this file is how the host asks "up to `cap` independent
 * steps" without inventing a second state machine. `cap` is derived from
 * the live-session pool (`parallelSlotCap`) — a crew that would overbook
 * waits rather than reaping its own running roles.
 *
 * Independence is conservative: two steps share a wave only when both name
 * files and those files do not overlap. Unknown file sets stay sequential.
 * `planner` / `reviewer` / `fixer` never share a wave — they depend on
 * finished work, not on a guess that they don't.
 *
 * Pure (recipe R7).
 */

import { nextRunnableStep, type CrewRun, type CrewStep } from "./crew";

const SERIAL_ROLES = new Set(["planner", "reviewer", "fixer"]);

/** Path-like tokens in a step title (`src/a.ts`, `pkg/foo/bar`). */
export function filesHint(title: string): string[] {
  const out: string[] = [];
  const re = /(?:[\w.-]+\/)+[\w.-]+|\b[\w.-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g;
  const text = String(title ?? "");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = m[0].replace(/\\/g, "/");
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function pathsOverlap(a: string, b: string): boolean {
  const na = a.replace(/\\/g, "/").toLowerCase();
  const nb = b.replace(/\\/g, "/").toLowerCase();
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

function stepFiles(step: CrewStep): string[] {
  if (step.filesObserved.length) return step.filesObserved;
  if (step.filesReported.length) return step.filesReported;
  return filesHint(step.title);
}

/** True when two steps cannot safely share a worktree wave. */
export function stepsConflict(a: CrewStep, b: CrewStep): boolean {
  if (a.index === b.index) return true;
  const fa = stepFiles(a);
  const fb = stepFiles(b);
  if (!fa.length || !fb.length) return true;
  return fa.some((x) => fb.some((y) => pathsOverlap(x, y)));
}

export function isSerialRole(role: string | undefined): boolean {
  return !!role && SERIAL_ROLES.has(role);
}

export function nextIndependentSteps(
  run: CrewRun,
  opts: { parallel?: boolean; cap: number },
): CrewStep[] {
  const cap = Number.isFinite(opts.cap) ? Math.max(1, Math.floor(opts.cap)) : 1;
  if (!opts.parallel) {
    const one = nextRunnableStep(run);
    return one ? [one] : [];
  }
  if (
    run.status === "paused"
    || run.status === "failed"
    || run.status === "cancelled"
    || run.status === "done"
    || run.status === "review"
  ) {
    return [];
  }
  const running = run.steps.filter((s) => s.status === "running");
  if (running.some((s) => isSerialRole(s.role))) return [];

  const picked: CrewStep[] = [];
  for (const step of run.steps) {
    if (picked.length >= cap) break;
    if (step.status !== "pending" && step.status !== "assigned") continue;
    if (isSerialRole(step.role)) {
      const blocked = run.steps.some(
        (s) => s.index < step.index && s.status !== "done" && s.status !== "skipped",
      );
      if (blocked || running.length || picked.length) continue;
      picked.push(step);
      break;
    }
    const earlierSerial = run.steps.find(
      (s) => s.index < step.index && isSerialRole(s.role) && s.status !== "done" && s.status !== "skipped",
    );
    if (earlierSerial) continue;
    if (running.some((r) => stepsConflict(r, step))) continue;
    if (picked.some((p) => stepsConflict(p, step))) continue;
    picked.push(step);
  }
  return picked;
}
