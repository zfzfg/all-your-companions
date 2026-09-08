// The agent's own step checklist, normalized (AP-02).
//
// ACP's `plan` session update is one notification carrying TWO unrelated
// shapes, and the split is by provider, not by version:
//
//   Claude / Codex / Gemini  { sessionUpdate: "plan", entries: [ {content, status, priority}, … ] }
//   grok / Antigravity       { sessionUpdate: "plan", plan: "…markdown…" }
//
// Only the first is a checklist. The second is prose the model wrote for a
// human to read, and this module deliberately makes NO attempt to mine steps
// out of it: a regex over free text fakes a protocol parity that does not
// exist and breaks silently the first time a model changes its formatting
// (decision §10.5 of the feature plan, confirmed by the maintainer 2026-09-07).
// `parsePlanEntries` returning null is how that "there is no list here" is
// said, and the caller keeps its existing plan-TEXT behaviour unchanged.
//
// Pure logic module per Recipe R7: no vscode imports, no filesystem, no clock.

export type PlanEntryStatus = "pending" | "in_progress" | "completed";

export type PlanEntryPriority = "high" | "medium" | "low";

export interface PlanEntry {
  /** Stable across updates so the rail can repaint a row instead of replacing
   *  it. Taken from the agent when it names one, otherwise derived from the
   *  entry's position and text — which is stable exactly as long as the step
   *  keeps its place and wording, and that is the case the rail cares about. */
  id: string;
  content: string;
  status: PlanEntryStatus;
  priority?: PlanEntryPriority;
}

const STATUSES: readonly PlanEntryStatus[] = ["pending", "in_progress", "completed"];
const PRIORITIES: readonly PlanEntryPriority[] = ["high", "medium", "low"];

/** Longest slug taken from an entry's text for a derived id. Long enough to
 *  separate neighbouring steps, short enough that the id stays an id. */
const DERIVED_ID_SLUG_MAX = 40;

/**
 * Fold spelling variants of one status onto the wire value.
 *
 * Three agents write this field and they do not agree on separators or case
 * (`in_progress`, `in-progress`, `inProgress` have all been observed in ACP
 * implementations). Everything else — including a missing field and a status
 * a future spec adds — reads as `pending`: a step we cannot classify has
 * demonstrably not been reported finished, and showing it as outstanding is
 * the reading that cannot overstate progress.
 */
function normalizeStatus(raw: unknown): PlanEntryStatus {
  if (typeof raw !== "string") return "pending";
  const key = raw.toLowerCase().replace(/[^a-z]/g, "");
  if (key === "inprogress" || key === "active" || key === "running") return "in_progress";
  if (key === "completed" || key === "complete" || key === "done") return "completed";
  return "pending";
}

function normalizePriority(raw: unknown): PlanEntryPriority | undefined {
  if (typeof raw !== "string") return undefined;
  const key = raw.toLowerCase().trim();
  return (PRIORITIES as readonly string[]).includes(key) ? (key as PlanEntryPriority) : undefined;
}

/**
 * The step's text, from either shape ACP allows.
 *
 * `content` is a plain string in the plan schema, but the same key is a content
 * BLOCK everywhere else in ACP, and an agent reusing its block serializer here
 * is a cheap thing to survive.
 */
function normalizeContent(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object" && typeof (raw as { text?: unknown }).text === "string") {
    return (raw as { text: string }).text.trim();
  }
  return "";
}

function derivedId(index: number, content: string): string {
  const slug = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, DERIVED_ID_SLUG_MAX)
    .replace(/-+$/, "");
  return `plan-${index}-${slug || "step"}`;
}

/**
 * Normalize one ACP `plan` update into the session's checklist.
 *
 * Returns `null` when the update carries no entry LIST at all — a plan-text
 * update, a malformed payload, anything that is not an array. That null is
 * load-bearing: it is the caller's signal to leave every existing plan-text
 * behaviour alone and show no rail.
 *
 * An `entries` array that is present but yields nothing usable returns the
 * EMPTY list, not null. The distinction is deliberate: the agent did send a
 * checklist update, so the checklist it replaces must go — a rail left standing
 * from an earlier update would be claiming steps the agent has stopped
 * reporting.
 */
export function parsePlanEntries(update: unknown): PlanEntry[] | null {
  if (!update || typeof update !== "object") return null;
  const raw = (update as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return null;

  const entries: PlanEntry[] = [];
  const seen = new Map<string, number>();
  raw.forEach((item, index) => {
    if (!item || typeof item !== "object") return;
    const content = normalizeContent((item as { content?: unknown }).content);
    // A step with no text is not a step. Dropping it keeps the counter honest:
    // it would otherwise count toward `total` while showing an empty row.
    if (!content) return;
    const given = (item as { id?: unknown }).id;
    const base = typeof given === "string" && given.trim() ? given.trim() : derivedId(index, content);
    // Ids must be unique or the rail repaints one row twice and drops another.
    // Duplicates are the agent's, not ours, so they are disambiguated rather
    // than discarded — both steps were sent and both are real.
    const collisions = seen.get(base) ?? 0;
    seen.set(base, collisions + 1);
    entries.push({
      id: collisions ? `${base}#${collisions + 1}` : base,
      content,
      status: normalizeStatus((item as { status?: unknown }).status),
      ...(normalizePriority((item as { priority?: unknown }).priority)
        ? { priority: normalizePriority((item as { priority?: unknown }).priority)! }
        : {}),
    });
  });
  return entries;
}

/** Progress for the rail head and the history row: how many steps are done, and
 *  which one the agent says it is on. `active` is the FIRST in-progress entry —
 *  agents occasionally mark several, and the rail highlights one. */
export function planProgress(
  entries: readonly PlanEntry[],
): { done: number; total: number; active?: PlanEntry } {
  const list = Array.isArray(entries) ? entries : [];
  const done = list.filter((e) => e && e.status === "completed").length;
  const active = list.find((e) => e && e.status === "in_progress");
  return { done, total: list.length, ...(active ? { active } : {}) };
}

/** Exported for the contract test that pins the webview's copy of the status
 *  vocabulary to this one (media/webview-helpers.js cannot import TypeScript). */
export const PLAN_ENTRY_STATUSES = STATUSES;
