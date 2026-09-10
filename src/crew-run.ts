/**
 * Pure helpers for walking a crew chain (AP-12).
 *
 * The sequential loop itself lives in the host — it has to call `runAgentRole`,
 * raise question cards, and take a checkpoint. What this file owns is the
 * part that must not depend on any of that: the next briefing, and whether
 * a verify failure inserts `fixer`.
 *
 * Between steps, {@link reconcileFiles} feeds the NEXT briefing with the
 * *observed* files, not just the ones the previous role named. A chain that
 * briefed N+1 from N's self-report would silently spread N's gaps.
 */

import { reconcileFiles, type BriefingInput } from "./briefing";
import { insertCrewStep, type CrewRun, type CrewStep } from "./crew";

export function briefingForCrewStep(opts: {
  run: CrewRun;
  step: CrewStep;
  previous?: {
    summary: string;
    filesReported: readonly string[];
    filesObserved: readonly string[];
    verify?: string;
  };
}): BriefingInput {
  const recon = opts.previous
    ? reconcileFiles(opts.previous.filesReported, opts.previous.filesObserved)
    : { touched: [] as string[], unreported: [] as string[], claimedOnly: [] as string[] };
  const files = unique([
    ...recon.touched,
    ...recon.unreported,
    ...opts.step.filesObserved,
  ]);
  const decisions: string[] = [];
  if (opts.previous?.summary) decisions.push(`Previous step: ${opts.previous.summary}`);
  if (recon.unreported.length) {
    decisions.push(`The host observed edits the previous role did not report: ${recon.unreported.join(", ")}`);
  }
  if (opts.previous?.verify) decisions.push(`Verify: ${opts.previous.verify}`);
  const done = opts.run.steps.filter((s) => s.status === "done").map((s) => s.title);
  if (done.length) decisions.push(`Already completed: ${done.join("; ")}`);
  return {
    goal: opts.run.goal,
    task: opts.step.title,
    acceptance: `This step is done when "${opts.step.title}" holds, and nothing adjacent has been started.`,
    files,
    decisions,
    forbidden: [],
    provenance: [
      `Goal: the crew run ${opts.run.runId}.`,
      opts.previous
        ? `Files: observed ${recon.touched.length}, unreported ${recon.unreported.length} (host diffs, not the previous role's list).`
        : "Files: none yet — this is the first step.",
      opts.run.verify ? `Verify command after writing steps: \`${opts.run.verify}\`.` : "No verify command configured.",
    ],
  };
}

/**
 * Splice a review step after every `every` working steps (`review_every:`).
 *
 * Like `roles:`, this field was parsed and then never read, so a flow that
 * asked to be reviewed every two steps was reviewed only at the end — the
 * failure mode being that a wrong decision in step 2 is found after step 9 has
 * built on it.
 *
 * Steps ALREADY assigned to the review role do not count towards the cadence
 * and never earn a review of their own; neither does a `planner`, which writes
 * nothing there is anything to review. A trailing review is not added, because
 * the run's own `review` state already ends every crew with the combined diff.
 *
 * Pure, and built on `insertCrewStep` so re-indexing stays in one place. Walks
 * from the back so the indexes it inserts at are still the ones it measured.
 */
export function applyReviewCadence(run: CrewRun, every: number, reviewRole: string): CrewRun {
  const cadence = Number.isFinite(every) ? Math.floor(every) : 0;
  if (cadence < 1 || !reviewRole) return run;
  const counts = (step: CrewStep) => step.role !== reviewRole && step.role !== "planner";
  const boundaries: number[] = [];
  let since = 0;
  for (const step of run.steps) {
    if (!counts(step)) continue;
    since += 1;
    if (since === cadence) {
      boundaries.push(step.index);
      since = 0;
    }
  }
  // Never a review as the very last step: the run already ends in `review`.
  const last = run.steps[run.steps.length - 1]?.index;
  let next = run;
  for (const at of [...boundaries].reverse()) {
    if (at === last) continue;
    next = insertCrewStep(next, at, {
      title: `[${reviewRole}] Review the work of the previous ${cadence} step${cadence === 1 ? "" : "s"}.`,
      role: reviewRole,
      assignWhy: `review cadence — every ${cadence} step${cadence === 1 ? "" : "s"}`,
    });
  }
  return next;
}

export function verifyInsertsFixer(verify: { code: number; output: string } | undefined): boolean {
  if (!verify) return false;
  return verify.code !== 0;
}

export function fixerTitle(verify: { command: string; output: string }): string {
  const clip = verify.output.trim().split(/\r?\n/).slice(-20).join("\n");
  return `Make \`${verify.command}\` pass.\n\nLast output:\n${clip || "(no output)"}`;
}

function unique(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    const n = p.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
