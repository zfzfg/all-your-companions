/**
 * The review panel (C-13): N reviewers, one packet.
 *
 * Several read-only sessions review the same briefing in parallel; this folds
 * their packets into one, deterministically:
 *
 * - verdict: the strictest (`blocked` > `changes_requested` > `pass`); an
 *   unreadable verdict from any reviewer makes the merged one unreadable, so
 *   the gate still stops (D6).
 * - findings: de-duplicated by file + line + similar text; each keeps the
 *   reviewers that reported it ("2/2 reviewers") and the highest severity.
 * - summary: one line per reviewer.
 *
 * Pure: no vscode, no fs, no clock.
 */

import type { FindingSeverity, HandoffFinding, HandoffPacket, HandoffStatus } from "./workflow-handoff";

const VERDICT_RANK: Record<string, number> = { pass: 1, changes_requested: 2, blocked: 3 };
const SEVERITY_RANK: Record<FindingSeverity, number> = { nit: 1, minor: 2, major: 3, blocker: 4 };

export function strictestVerdict(verdicts: readonly (string | undefined)[]): string | undefined {
  let best: string | undefined;
  for (const v of verdicts) {
    if (!v) return undefined;
    if (!(v in VERDICT_RANK)) return v;
    if (!best || VERDICT_RANK[v]! > (VERDICT_RANK[best] ?? 0)) best = v;
  }
  return best;
}

function normText(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Word-overlap similarity (Jaccard). Deterministic, no model involved. */
export function textSimilarity(a: string, b: string): number {
  const wa = new Set(normText(a));
  const wb = new Set(normText(b));
  if (!wa.size || !wb.size) return 0;
  let common = 0;
  for (const w of wa) if (wb.has(w)) common += 1;
  return common / (wa.size + wb.size - common);
}

export function sameFinding(a: HandoffFinding, b: HandoffFinding): boolean {
  if ((a.file ?? "") !== (b.file ?? "")) return false;
  if (a.line != null && b.line != null && Math.abs(a.line - b.line) > 3) return false;
  return textSimilarity(a.text, b.text) >= 0.5 || a.text.trim().toLowerCase() === b.text.trim().toLowerCase();
}

export function mergeReviewPackets(
  packets: readonly HandoffPacket[],
  reviewers: readonly string[],
): HandoffPacket {
  const first = packets[0]!;
  const statuses = packets.map((p) => p.status);
  const status: HandoffStatus = statuses.includes("failed")
    ? "failed"
    : statuses.includes("interrupted") || statuses.includes("cancelled") ? "interrupted" : "done";
  const merged: HandoffFinding[] = [];
  packets.forEach((packet, i) => {
    const who = reviewers[i] ?? `reviewer ${i + 1}`;
    for (const finding of packet.findings ?? []) {
      const same = merged.find((m) => sameFinding(m, finding));
      if (same) {
        if (!same.reporters?.includes(who)) same.reporters = [...(same.reporters ?? []), who];
        if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[same.severity]) same.severity = finding.severity;
        continue;
      }
      merged.push({ ...finding, id: `F${merged.length + 1}`, reporters: [who] });
    }
  });
  merged.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || (b.reporters?.length ?? 0) - (a.reporters?.length ?? 0));
  merged.forEach((f, i) => { f.id = `F${i + 1}`; });
  const verdict = strictestVerdict(packets.map((p) => p.verdict));
  const union = (pick: (p: HandoffPacket) => readonly string[]) => [...new Set(packets.flatMap(pick))];
  const tokens = packets.every((p) => typeof p.tokens === "number")
    ? packets.reduce((sum, p) => sum + (p.tokens ?? 0), 0)
    : undefined;
  return {
    ...first,
    status,
    summary: packets.map((p, i) => `${reviewers[i] ?? `Reviewer ${i + 1}`}: ${p.summary || "(no summary)"}`).join("\n"),
    ...(verdict ? { verdict } : { verdict: undefined }),
    findings: merged,
    openQuestions: union((p) => p.openQuestions ?? []),
    filesReported: union((p) => p.filesReported),
    filesObserved: union((p) => p.filesObserved),
    unreported: union((p) => p.unreported),
    claimedOnly: union((p) => p.claimedOnly),
    ...(typeof tokens === "number" ? { tokens } : {}),
    durationMs: Math.max(...packets.map((p) => p.durationMs)),
    panel: packets.map((p, i) => ({
      reviewer: reviewers[i] ?? `reviewer ${i + 1}`,
      target: p.target,
      ...(p.verdict ? { verdict: p.verdict } : {}),
      findings: p.findings?.length ?? 0,
    })),
  };
}

/** "2/2 reviewers" for a merged finding. */
export function consensusLabel(finding: HandoffFinding, panelSize: number): string {
  const n = finding.reporters?.length ?? 1;
  return `${n}/${panelSize} reviewer${panelSize === 1 ? "" : "s"}`;
}

/**
 * Targets for a panel of `count`: the preselected one first, then other
 * eligible providers (distinct when asked), never more than are eligible.
 */
export function panelTargets<T extends { provider: string }>(
  first: T,
  eligible: readonly T[],
  count: number,
  distinctProviders: boolean,
): T[] {
  const out: T[] = [first];
  for (const t of eligible) {
    if (out.length >= count) break;
    if (distinctProviders && out.some((o) => o.provider === t.provider)) continue;
    out.push(t);
  }
  while (!distinctProviders && out.length < count) out.push(first);
  return out;
}
