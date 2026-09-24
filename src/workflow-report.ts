/**
 * The Crew run report (C-17) and the run table's rows.
 *
 * One Markdown file per run, `run-report.md` in the run folder: the idea, the
 * lineup, every stage with its short result, verdict, accepted and ignored
 * findings, the files that changed, verify results, total time and tokens.
 * Honest numbers only — no money (D18), no invented zeros: a figure the run
 * did not record is left out.
 *
 * Pure: no vscode, no fs, no clock. Deterministic for identical inputs.
 */

import type { HandoffPacket } from "./workflow-handoff";
import type { WorkflowDefinition } from "./workflow";
import { findStage } from "./workflow";
import type { WorkflowRun } from "./workflow-run";

export interface RunTableRow {
  ordinal: number;
  stageId: string;
  title: string;
  role: string;
  target: string;
  status: string;
  durationMs?: number;
  tokens?: number;
  files: number;
  sessionId?: string;
}

/** "3m 12s" / "45s" / "1h 02m". */
export function formatDurationShort(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "84k" / "1.2M" / "950". */
export function formatTokenCount(n: number | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(Math.round(n));
}

export function targetText(target: HandoffPacket["target"] | undefined): string {
  if (!target) return "";
  return [target.provider, target.model, target.effort ? `effort ${target.effort}` : ""].filter(Boolean).join(" · ");
}

export function runTableRows(
  run: WorkflowRun,
  def: WorkflowDefinition,
  packets: readonly HandoffPacket[],
): RunTableRow[] {
  return run.executed.map((entry) => {
    const packet = packets.find((p) => p.stageOrdinal === entry.ordinal);
    const stage = findStage(def, entry.stageId);
    return {
      ordinal: entry.ordinal,
      stageId: entry.stageId,
      title: stage?.title ?? entry.stageId,
      role: packet?.role ?? stage?.role ?? "",
      target: targetText(packet?.target),
      status: entry.status,
      ...(packet?.durationMs ? { durationMs: packet.durationMs } : {}),
      ...(typeof packet?.tokens === "number" ? { tokens: packet.tokens } : {}),
      files: packet?.filesObserved.length ?? 0,
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
    };
  });
}

/** "4 stages · 11m · 210k tokens" — only the parts that were measured. */
export function runTotalsLine(rows: readonly RunTableRow[]): string {
  const ms = rows.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
  const withTokens = rows.filter((r) => typeof r.tokens === "number");
  const tokens = withTokens.reduce((sum, r) => sum + (r.tokens ?? 0), 0);
  const parts = [`${rows.length} ${rows.length === 1 ? "stage" : "stages"}`];
  if (ms > 0) parts.push(formatDurationShort(ms));
  if (withTokens.length) parts.push(`${formatTokenCount(tokens)} tokens`);
  return parts.join(" · ");
}

export function renderRunReport(input: {
  run: WorkflowRun;
  def: WorkflowDefinition;
  packets: readonly HandoffPacket[];
  /** Findings the person chose not to fix (C-09), by id. */
  ignoredFindings?: readonly string[];
}): string {
  const { run, def, packets } = input;
  const rows = runTableRows(run, def, packets);
  const lines: string[] = [];
  lines.push(`# Crew run ${run.runId}`, "");
  lines.push(`**Workflow:** ${def.title} (\`${run.workflowName}\`)  `);
  lines.push(`**Status:** ${run.status}${run.stoppedReason ? ` — ${run.stoppedReason}` : ""}  `);
  lines.push(`**Totals:** ${runTotalsLine(rows)}`, "");
  lines.push("## Idea", "", run.idea.trim() || "(none)", "");
  if (run.lineup && Object.keys(run.lineup).length) {
    lines.push("## Lineup", "");
    for (const stage of def.stages.filter((s) => s.enabled)) {
      const t = run.lineup[stage.id];
      if (!t) continue;
      lines.push(`- ${stage.title}: ${[t.provider, t.model, t.effort ? `effort ${t.effort}` : ""].filter(Boolean).join(" · ")}`);
    }
    lines.push("");
  }
  lines.push("## Stages", "");
  if (!rows.length) lines.push("No stage ran.", "");
  for (const row of rows) {
    const packet = packets.find((p) => p.stageOrdinal === row.ordinal);
    const meta = [row.target, formatDurationShort(row.durationMs), typeof row.tokens === "number" ? `${formatTokenCount(row.tokens)} tokens` : ""]
      .filter(Boolean).join(" · ");
    lines.push(`### ${row.ordinal}. ${row.title} — ${row.status}`, "");
    if (meta) lines.push(`_${meta}_`, "");
    if (packet?.summary) lines.push(packet.summary.trim(), "");
    if (packet?.verdict) lines.push(`**Verdict:** ${packet.verdict}`, "");
    if (packet?.findings?.length) {
      const ignored = new Set(input.ignoredFindings ?? []);
      lines.push("**Findings:**", "");
      for (const f of packet.findings) {
        const where = f.file ? ` (${f.file}${f.line != null ? `:${f.line}` : ""})` : "";
        lines.push(`- [${f.severity}] ${f.id}${where}: ${f.text}${ignored.has(f.id) ? " — _accepted as is_" : ""}`);
      }
      lines.push("");
    }
    if (packet?.filesObserved.length) {
      lines.push("**Files changed:** " + packet.filesObserved.map((f) => `\`${f}\``).join(", "), "");
    }
    if (packet?.unreported.length) {
      lines.push("**Changed but not reported:** " + packet.unreported.map((f) => `\`${f}\``).join(", "), "");
    }
    if (packet?.verify) {
      lines.push(`**Verify:** \`${packet.verify.command}\` → ${packet.verify.exitCode === 0 ? "passed" : `exit ${packet.verify.exitCode}`}`, "");
    }
  }
  const allFiles = [...new Set(packets.flatMap((p) => p.filesObserved))];
  if (allFiles.length) {
    lines.push("## All files changed", "");
    for (const f of allFiles) lines.push(`- \`${f}\``);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
