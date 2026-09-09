/**
 * Deriving a briefing from a live thread (AP-11, crew stage 2).
 *
 * AP-10 proved the briefing format against a task the USER typed. This module
 * is the other half of that proof: the host writing the task itself, out of
 * what it already knows about the conversation. AP-12's chain does nothing but
 * this, once per step — so a weakness here is a weakness there, multiplied and
 * invisible.
 *
 * The rule that shapes everything below is the one from feature plan §5.4:
 * **no transcript copying.** A handoff that pasted the conversation would
 * rebuild exactly the context bloat a briefing exists to avoid, and the fresh
 * session would be fresh in name only. So the inputs are structures the host
 * already holds — the AP-02 plan entries, the AP-09 diff blocks, the context
 * chips — plus exactly ONE line of the user's own prose: their last message.
 * That single message is the goal in the user's words, which no structure
 * carries; everything past it is transcript, and stays behind.
 *
 * Two consequences are worth stating because they are easy to undo later:
 *
 * 1. **An empty source is a fact, and its REASON is a different fact.** Grok
 *    and Antigravity send plan text and no entries at all, so "no steps" there
 *    means "this companion has no step protocol", not "the plan is empty". The
 *    AP-02 work already learned that lesson one level down; {@link provenance}
 *    carries it up into the briefing, because a role told only "no steps" will
 *    reasonably assume there was nothing to do.
 * 2. **Refusing is a result.** A second opinion with nothing to look at is not
 *    a cheap second opinion, it is a paid turn in which a model invents one.
 *    {@link deriveBriefing} returns `refused` rather than an empty task.
 *
 * Pure module (recipe R7): no `vscode`, no `fs`, no `Date.now()`.
 */
import type { PlanEntry } from "./plan-entries";
import { BASE_FORBIDDEN, normalizeResultPath } from "./briefing";

export type HandoffKind = "handoff" | "second-opinion";

/**
 * Everything the derivation is allowed to see: a plain snapshot of the CALLING
 * session, with no Session object, no client and no clock behind it. Taking a
 * snapshot rather than the session itself is what keeps this module pure — and
 * what stops a later change from quietly reaching for the transcript because
 * it happened to be within reach.
 */
export interface ThreadContext {
  kind: HandoffKind;
  /** The user's own words: EXACTLY their last message, never the transcript. */
  lastUserText: string;
  /** AP-02 entries. Empty for grok/Antigravity — see {@link ThreadContext.structuredPlan}. */
  planEntries: readonly PlanEntry[];
  /**
   * Whether this companion reports structured plan entries at all (AP-01).
   *
   * Three states, not two, because `gemini` is one provider id over two CLIs
   * that differ: Gemini CLI sends a step list, Antigravity sends prose. A
   * boolean would have to pick one of them to lie about, and the lie would be
   * written into every derived briefing as though it were a fact.
   */
  structuredPlan: "yes" | "no" | "unknown";
  /** AP-09 snapshot paths — paths, never diffs. Turn scope for a second
   *  opinion (what just happened), session scope for a handoff (where the work
   *  stands). */
  changedFiles: readonly string[];
  /** Visible file chips on the caller's composer. */
  chipPaths: readonly string[];
  /** `Claude · claude-opus-5` — who did the work being handed over. */
  callerLabel: string;
}

export interface DerivedBriefing {
  goal: string;
  task: string;
  acceptance: string;
  files: string[];
  decisions: string[];
  forbidden: string[];
  /** Which sources contributed, and for every empty one WHY it was empty. */
  provenance: string[];
}

export type Derivation =
  | { kind: "ok"; briefing: DerivedBriefing }
  | { kind: "refused"; reason: string };

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** De-duplicate while keeping the caller's order. Sorting would silently
 *  reorder a planner's step list, and the order of steps is information. */
function dedupe(values: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const text = clean(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/** Paths through the same normalisation `reconcileFiles` uses, so a file named
 *  by a chip and the same file seen as a diff never appear twice. */
function dedupePaths(values: Iterable<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = normalizeResultPath(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function entriesWithStatus(
  entries: readonly PlanEntry[],
  statuses: readonly PlanEntry["status"][],
): string[] {
  return dedupe(entries.filter((e) => statuses.includes(e.status)).map((e) => clean(e.content)));
}

/**
 * The provenance block: one line per source, naming what it gave and — when it
 * gave nothing — why.
 *
 * Order is fixed rather than derived, for the same reason `renderBriefing`
 * fixes its section order: a briefing that reorders itself between two runs is
 * not diffable. The distinction that earns this block its tokens is the plan
 * line: "none reported" invites the role to fill the gap, "no step protocol"
 * tells it the gap is structural and not its to close.
 */
function buildProvenance(ctx: ThreadContext, files: readonly string[], goalKnown: boolean): string[] {
  const lines: string[] = [];

  lines.push(goalKnown
    ? "Goal: the last thing the user asked for in that conversation, in their words."
    : "Goal: not available — the conversation had no user message to quote.");

  const open = entriesWithStatus(ctx.planEntries, ["pending", "in_progress"]).length;
  const done = entriesWithStatus(ctx.planEntries, ["completed"]).length;
  if (open || done) {
    lines.push(`Plan steps: ${done} completed, ${open} still open, as reported by the companion.`);
  } else if (ctx.structuredPlan === "no") {
    lines.push(
      "Plan steps: none — this companion does not report a structured step list at all, so there "
      + "is no checklist to inherit. That says nothing about how much work is left.",
    );
  } else if (ctx.structuredPlan === "yes") {
    lines.push("Plan steps: none — this companion does report step lists, and reported none here.");
  } else {
    lines.push(
      "Plan steps: none arrived, and it is not known whether this companion reports them at all. "
      + "Do not read the absence either way.",
    );
  }

  lines.push(files.length
    ? `Files: ${files.length} path${files.length === 1 ? "" : "s"} the host observed being edited, `
      + "plus anything the user had attached."
    : "Files: none — the host recorded no edits and nothing was attached.");

  lines.push(
    "Not included: the conversation itself. You are seeing what was written down about it, not what "
    + "was said in it.",
  );
  return lines;
}

/**
 * Turn a live thread into a briefing.
 *
 * Deterministic: same context, same output. No clock, no randomness, no
 * iteration over object keys — the same discipline `renderBriefing` keeps, and
 * for the same reason (a briefing that changes between two identical runs
 * cannot be reviewed).
 */
export function deriveBriefing(ctx: ThreadContext): Derivation {
  const goalText = clean(ctx.lastUserText);
  const changed = dedupePaths(ctx.changedFiles);
  const chips = dedupePaths(ctx.chipPaths);
  const openSteps = entriesWithStatus(ctx.planEntries, ["pending", "in_progress"]);
  const doneSteps = entriesWithStatus(ctx.planEntries, ["completed"]);

  if (ctx.kind === "second-opinion") {
    // Nothing observed and nothing planned means there is no work to look at.
    // Running anyway buys a turn in which the model reasons from the goal
    // sentence alone and calls it a review — §5.10's quality illusion, paid for.
    if (!changed.length && !doneSteps.length) {
      return {
        kind: "refused",
        reason:
          "There is nothing to review in this turn — no file changes were recorded and no steps were "
          + "reported finished. A second opinion needs something to look at.",
      };
    }
    const files = dedupePaths([...changed, ...chips]);
    return {
      kind: "ok",
      briefing: {
        goal: goalText || "(the conversation did not state a goal in the user's own words)",
        task:
          "Review the changes listed under \"Files in scope\" against the goal above. Read the files "
          + "as they now stand in the working tree; that is the work you are judging.",
        acceptance:
          "Every finding names a file and a line. Findings are judged against the goal above, not "
          + "against personal preference. No file has been changed by you.",
        files,
        decisions: dedupe([
          ...(doneSteps.length
            ? [`The work under review was carried out as these steps: ${doneSteps.join("; ")}.`]
            : []),
          `The work under review was done on ${clean(ctx.callerLabel) || "another companion"}.`,
          "You are not in that conversation and cannot see it. Everything you were told is in this briefing.",
        ]),
        forbidden: [
          "Do not edit, create or delete any file — this is a review, not a repair.",
          ...BASE_FORBIDDEN,
        ],
        provenance: buildProvenance(ctx, files, Boolean(goalText)),
      },
    };
  }

  // Handoff. Unlike a review, this one is worth running with nothing recorded:
  // "carry on from here" against a stated goal is a real instruction. It is
  // only worthless with no goal AND no steps AND no files, which is an empty
  // conversation.
  if (!goalText && !openSteps.length && !doneSteps.length && !changed.length && !chips.length) {
    return {
      kind: "refused",
      reason:
        "There is nothing to hand over — this conversation has no user message, no reported steps and "
        + "no recorded changes.",
    };
  }

  const files = dedupePaths([...changed, ...chips]);
  const task = openSteps.length
    ? `Carry on with the steps that are still open:\n${openSteps.map((s) => `  - ${s}`).join("\n")}`
    : "Carry on from the state described below and take the goal above to completion. "
      + "No step list was handed over, so decide the next step yourself and say which one you took.";

  return {
    kind: "ok",
    briefing: {
      goal: goalText || "(the conversation did not state a goal in the user's own words)",
      task,
      acceptance: openSteps.length
        ? "The open steps listed above are done, or the reason one could not be done is stated in the "
          + "result. Nothing outside them has been changed."
        : "The goal above is met, or the reason it could not be met is stated in the result. Nothing "
          + "outside the goal has been changed.",
      files,
      decisions: dedupe([
        ...(doneSteps.length
          ? [`Already done, do not repeat: ${doneSteps.join("; ")}.`]
          : []),
        `The work so far was done on ${clean(ctx.callerLabel) || "another companion"}, in a conversation `
        + "you are not in and cannot see. Everything you were told is in this briefing.",
      ]),
      forbidden: [
        ...BASE_FORBIDDEN,
        ...(doneSteps.length
          ? ["Do not redo the completed steps listed under \"Already decided\" — they are finished."]
          : []),
      ],
      provenance: buildProvenance(ctx, files, Boolean(goalText)),
    },
  };
}

/**
 * The default role each action reaches for when the user named none.
 *
 * A button carries no role name, so one has to be chosen — and it is named on
 * the confirmation before anything runs. `reviewer` also carries
 * `preferDifferentProvider`, which is the whole point of a second opinion.
 */
export function defaultRoleFor(kind: HandoffKind): string {
  return kind === "second-opinion" ? "reviewer" : "implementer";
}

/** Card and log wording for one kind, in one place so the two never drift. */
export function handoffLabel(kind: HandoffKind): string {
  return kind === "second-opinion" ? "Second opinion" : "Handoff";
}
