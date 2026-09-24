/**
 * One vocabulary for the state of every child (E-02).
 *
 * Crew stages, companion subagents and Grok's own subagents used to each
 * speak their own words (`RUN_STATUS_WORDS`, `COMPANION_STATUS_WORDS`,
 * `STEP_STATUS`). The protocol now carries this enum for all of them; the
 * webview maps it to words and colours in one table.
 *
 * Pure.
 */

export type ChildStatus =
  | "queued"
  | "running"
  | "needs-you"
  | "stalled"
  | "completed"
  | "failed"
  | "cancelled"
  | "refused";

export const CHILD_STATUSES: readonly ChildStatus[] = [
  "queued", "running", "needs-you", "stalled", "completed", "failed", "cancelled", "refused",
];

/** The words and tone each status is shown with — the single source. */
export const CHILD_STATUS_VIEW: Record<ChildStatus, { word: string; tone: "muted" | "info" | "warn" | "ok" | "danger" }> = {
  queued: { word: "Queued", tone: "muted" },
  running: { word: "Running", tone: "info" },
  "needs-you": { word: "Needs you", tone: "warn" },
  stalled: { word: "Stalled", tone: "warn" },
  completed: { word: "Done", tone: "ok" },
  failed: { word: "Failed", tone: "danger" },
  cancelled: { word: "Cancelled", tone: "muted" },
  refused: { word: "Refused", tone: "danger" },
};

/** A companion subagent's record status, plus whether it waits for the person. */
export function subagentChildStatus(status: string, opts: { needsYou?: boolean; stalled?: boolean } = {}): ChildStatus {
  if (status === "running") return opts.needsYou ? "needs-you" : opts.stalled ? "stalled" : "running";
  if (status === "pending-approval") return "needs-you";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "refused") return "refused";
  if (status === "cancelled") return "cancelled";
  return "queued";
}

/** A crew stage row's status (the run view's words) as a child status. */
export function stageChildStatus(status: string): ChildStatus {
  switch (status) {
    case "running": return "running";
    case "needs-you": return "needs-you";
    case "stalled": return "stalled";
    case "done":
    case "skipped": return "completed";
    case "failed": return "failed";
    case "interrupted":
    case "cancelled":
    case "reverted": return "cancelled";
    default: return "queued";
  }
}

/** Grok's native subagent card state. */
export function nativeSubagentChildStatus(state: { finished?: boolean; failed?: boolean; cancelled?: boolean }): ChildStatus {
  if (state.cancelled) return "cancelled";
  if (state.failed) return "failed";
  if (state.finished) return "completed";
  return "running";
}
