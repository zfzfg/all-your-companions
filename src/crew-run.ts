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
import type { CrewRun, CrewStep } from "./crew";

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
