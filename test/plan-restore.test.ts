// Unit tests for the pure plan-restore state machine — the bit that decides:
//
//   (a) what the per-session "saved plans" log looks like after a new verdict
//       (`appendPlanEntry`), and
//   (b) whether a restored session should come back in Plan mode or Agent mode
//       (`decideRestoreState`), based on the last verdict the user gave.
//
// These are the bugs that surfaced in manual testing and would re-surface
// silently if regressed:
//   - "Rejected plan disappeared on restore" → log was overwritten, not appended.
//   - "Plan text empty in restored card" → the snapshot of plan text was wiped
//     before persist (covered by sidebar wiring; here we just verify the log
//     append preserves whatever text it was given).
//   - "Cancelled session restored into Plan mode" → restore decision was
//     defaulting to Plan when last verdict was unknown / abandoned / approved.
import { describe, it, expect } from "vitest";
import {
  PlanEntry,
  appendPlanEntry,
  countsAsUserBubble,
  decideRestoreState,
  isInterjectionText as isHostInterjectionText,
  planRestoreSource,
  truncateResolvedAfter,
} from "../src/plan-restore";
import {
  isInterjectionText as isWebviewInterjectionText,
  stripInterjectionEnvelope,
} from "../media/webview-helpers.js";

describe("countsAsUserBubble (host↔webview replay-count parity)", () => {
  // The host's replay counter must count exactly what chat.js appendUserChunk
  // bubbles — an asymmetry inflates every post-restore verdict position and
  // the plan/permission cards land at the END of the conversation on the next
  // restore (the accredia stress session's "2 messages at the end").
  it("counts real user messages, including verdicts WITH comments", () => {
    expect(countsAsUserBubble("Show me a plan")).toBe(true);
    expect(countsAsUserBubble("[Plan approved] I don't know what to do.")).toBe(true);
    expect(countsAsUserBubble("[Plan rejected] use sqlite")).toBe(true);
    expect(countsAsUserBubble('<vscode-context note="x">\nfile.ts\n</vscode-context>\n\nRevert that change')).toBe(true);
  });

  it("does NOT count what the webview never bubbles", () => {
    expect(countsAsUserBubble("[Plan cancelled]")).toBe(false);
    expect(countsAsUserBubble("  [Plan approved]  ")).toBe(false);
    expect(countsAsUserBubble("[Plan rejected]\n")).toBe(false);
    expect(countsAsUserBubble("<system-reminder>\n[Request interrupted by user]\n</system-reminder>")).toBe(false);
    expect(countsAsUserBubble("  <system-reminder> Plan mode still active </system-reminder>")).toBe(false);
  });

  it("does not count replayed interjections and keeps the TS/JS classifiers in sync", () => {
    const cases = [
      "The user sent a message while you were working:\nrevise the plan",
      "  The user sent a message while you were working:  \r\napprove with tests",
      "The user sent a message while you were working: not an envelope",
      "ordinary user message",
    ];
    for (const text of cases) {
      expect(isHostInterjectionText(text)).toBe(isWebviewInterjectionText(text));
    }
    expect(countsAsUserBubble(cases[0])).toBe(false);
    expect(countsAsUserBubble(cases[1])).toBe(false);
    expect(countsAsUserBubble(cases[2])).toBe(true);
  });

  it("strips the replay envelope and optional user_query wrapper for display", () => {
    expect(stripInterjectionEnvelope(
      "The user sent a message while you were working:\n<user_query>\nalso use tabs\n</user_query>",
    )).toBe("also use tabs");
    expect(stripInterjectionEnvelope(
      "The user sent a message while you were working:\r\nplain steer",
    )).toBe("plain steer");
    expect(stripInterjectionEnvelope("ordinary user text")).toBe("ordinary user text");
  });
});

describe("appendPlanEntry", () => {
  it("creates a new list when none exists (undefined → [entry])", () => {
    const entry: PlanEntry = { text: "P1", verdict: "rejected", afterUserMessage: 1 };
    expect(appendPlanEntry(undefined, entry)).toEqual([entry]);
  });

  it("appends to the existing list in chronological order", () => {
    const existing: PlanEntry[] = [
      { text: "P1", verdict: "rejected", afterUserMessage: 1 },
      { text: "P2", verdict: "approved", afterUserMessage: 3 },
    ];
    const next: PlanEntry = { text: "P3", verdict: "abandoned", afterUserMessage: 5 };
    expect(appendPlanEntry(existing, next)).toEqual([...existing, next]);
  });

  it("does not mutate the caller's array (pure)", () => {
    const existing: PlanEntry[] = [{ text: "P1", verdict: "rejected", afterUserMessage: 1 }];
    const frozen = JSON.stringify(existing);
    appendPlanEntry(existing, { text: "P2", verdict: "approved", afterUserMessage: 2 });
    expect(JSON.stringify(existing)).toBe(frozen);
  });

  it("preserves the exact text the caller hands in (regression: lastPlanText was being wiped)", () => {
    const entry: PlanEntry = {
      text: "# TEST PLAN\n\nSimple content for rejection testing.",
      verdict: "rejected",
      afterUserMessage: 2,
    };
    const result = appendPlanEntry([], entry);
    expect(result[0].text).toBe(entry.text);
  });

  it("tolerates entries without afterUserMessage (legacy compat)", () => {
    const entry: PlanEntry = { text: "P1", verdict: "rejected" };
    const result = appendPlanEntry(undefined, entry);
    expect(result[0].afterUserMessage).toBeUndefined();
  });
});

describe("decideRestoreState", () => {
  it("no saved plans → no plan mode, CLI in act mode", () => {
    expect(decideRestoreState([])).toEqual({ planActive: false, cliMode: "default" });
  });

  it("undefined input (legacy session, never persisted) → no plan mode", () => {
    expect(decideRestoreState(undefined)).toEqual({ planActive: false, cliMode: "default" });
  });

  it("last verdict 'rejected' → restore Plan mode (user was mid-planning)", () => {
    expect(decideRestoreState([
      { text: "P1", verdict: "rejected", afterUserMessage: 1 },
    ])).toEqual({ planActive: true, cliMode: "plan" });
  });

  it("last verdict 'approved' → do NOT restore Plan mode (user said go)", () => {
    expect(decideRestoreState([
      { text: "P1", verdict: "approved", afterUserMessage: 1 },
    ])).toEqual({ planActive: false, cliMode: "default" });
  });

  it("last verdict 'abandoned' → do NOT restore Plan mode (this was the Cancel regression)", () => {
    expect(decideRestoreState([
      { text: "P1", verdict: "abandoned", afterUserMessage: 1 },
    ])).toEqual({ planActive: false, cliMode: "default" });
  });

  it("only the LAST verdict matters — earlier ones are ignored", () => {
    // Reject, reject, then approve: user was planning then went ahead.
    expect(decideRestoreState([
      { text: "P1", verdict: "rejected",  afterUserMessage: 1 },
      { text: "P2", verdict: "rejected",  afterUserMessage: 2 },
      { text: "P3", verdict: "approved",  afterUserMessage: 3 },
    ])).toEqual({ planActive: false, cliMode: "default" });

    // Approve, then reject: user re-opened planning after approving an earlier plan.
    expect(decideRestoreState([
      { text: "P1", verdict: "approved", afterUserMessage: 1 },
      { text: "P2", verdict: "rejected", afterUserMessage: 4 },
    ])).toEqual({ planActive: true, cliMode: "plan" });

    // Abandon, then reject: same as above for the gate.
    expect(decideRestoreState([
      { text: "P1", verdict: "abandoned", afterUserMessage: 1 },
      { text: "P2", verdict: "rejected",  afterUserMessage: 2 },
    ])).toEqual({ planActive: true, cliMode: "plan" });
  });
});

describe("appendPlanEntry + decideRestoreState (full lifecycle scenarios)", () => {
  // These are scenario tests that walk the exact state-machine paths the user
  // can produce in the UI. They lock in the high-level invariant: "what the
  // user clicked last is what the restore comes back to".

  it("scenario: user rejects, then closes VS Code → restore comes back in Plan mode", () => {
    let plans: PlanEntry[] | undefined;
    plans = appendPlanEntry(plans, { text: "draft 1", verdict: "rejected", afterUserMessage: 1 });
    expect(decideRestoreState(plans).planActive).toBe(true);
  });

  it("scenario: user rejects then approves → restore comes back in Agent mode", () => {
    let plans: PlanEntry[] | undefined;
    plans = appendPlanEntry(plans, { text: "draft 1", verdict: "rejected", afterUserMessage: 1 });
    plans = appendPlanEntry(plans, { text: "draft 2", verdict: "approved", afterUserMessage: 2 });
    expect(decideRestoreState(plans).planActive).toBe(false);
  });

  it("scenario: user rejects then cancels → restore comes back in Agent mode (no plan-mode lock-in)", () => {
    let plans: PlanEntry[] | undefined;
    plans = appendPlanEntry(plans, { text: "draft 1", verdict: "rejected", afterUserMessage: 1 });
    plans = appendPlanEntry(plans, { text: "draft 2", verdict: "abandoned", afterUserMessage: 2 });
    expect(decideRestoreState(plans).planActive).toBe(false);
  });

  it("scenario: legacy session (never persisted) → restore comes back in Agent mode, no surprise gate", () => {
    expect(decideRestoreState(undefined).planActive).toBe(false);
  });
});

// Rewind (and Edit, which is a rewind underneath) truncates grok's history, but
// plan and permission cards are the EXTENSION's own records — the CLI replays
// neither on session/load. Without truncating them too, cards for deleted turns
// come back at the BOTTOM of the restored conversation, under the messages that
// survived. Reported after two Edits left two plan cards orphaned.
describe("truncateResolvedAfter (rewind must drop our own cards too)", () => {
  const plan = (afterUserMessage: number | undefined, text: string) => ({
    text,
    verdict: "rejected" as const,
    afterUserMessage,
  });

  it("keeps cards from surviving turns and drops the rest", () => {
    const plans = [plan(1, "a"), plan(3, "b"), plan(5, "c")];
    // Rewound so 3 user messages remain: the card resolved during turn 5 goes.
    expect(truncateResolvedAfter(plans, 3).map((p) => p.text)).toEqual(["a", "b"]);
  });

  it("keeps a card resolved during the LAST surviving turn (boundary)", () => {
    // afterUserMessage === surviving means it belongs to the final kept turn.
    expect(truncateResolvedAfter([plan(3, "edge")], 3)).toHaveLength(1);
    expect(truncateResolvedAfter([plan(4, "past")], 3)).toHaveLength(0);
  });

  it("drops everything when the whole conversation is rewound away", () => {
    expect(truncateResolvedAfter([plan(1, "a"), plan(2, "b")], 0)).toEqual([]);
  });

  it("KEEPS position-less legacy entries rather than guessing", () => {
    // Deleting a user's plan record on a guess is worse than one stray card.
    const out = truncateResolvedAfter([plan(undefined, "legacy"), plan(9, "new")], 2);
    expect(out.map((p) => p.text)).toEqual(["legacy"]);
  });

  it("handles an absent collection", () => {
    expect(truncateResolvedAfter(undefined, 3)).toEqual([]);
  });

  it("works for permission entries too (same positional shape)", () => {
    const perms = [
      { title: "Run npm test", outcome: "allowed" as const, afterUserMessage: 1 },
      { title: "Delete src/", outcome: "rejected" as const, afterUserMessage: 4 },
    ];
    expect(truncateResolvedAfter(perms, 2).map((p) => p.title)).toEqual(["Run npm test"]);
  });

  it("uses the shared history boundary for new plan, permission, and usage records", () => {
    const entries = [
      { label: "kept", afterUserMessage: 9, afterHistoryEvent: 4 },
      { label: "dropped", afterUserMessage: 1, afterHistoryEvent: 8 },
      { label: "legacy", afterUserMessage: 2 },
    ];
    expect(truncateResolvedAfter(entries, 3, 5).map((entry) => entry.label))
      .toEqual(["kept", "legacy"]);
  });
});

// Regression: after a rewind removed every plan, the restored session showed
// the deleted plan again, labelled "Restored from the previous session".
//
// Cause: the empty array a rewind leaves behind was treated the same as "no
// record", which triggers the legacy fallback that reads grok's own plan.md —
// and a rewind does NOT truncate plan.md. So dropping our record is precisely
// what resurrected the plan.
describe("planRestoreSource ([] is a record, not a gap)", () => {
  const plan = (text: string) => ({ text, verdict: "rejected" as const, afterUserMessage: 1 });

  it("renders our saved plans when we have some", () => {
    expect(planRestoreSource([plan("a")])).toBe("saved");
  });

  it("falls back to grok's plan.md ONLY when we have no record at all", () => {
    // A session from before per-plan persistence.
    expect(planRestoreSource(undefined)).toBe("disk");
  });

  it("shows nothing when our record says there are no plans", () => {
    // The rewind case. Reading plan.md here brings back the deleted plan.
    expect(planRestoreSource([])).toBe("none");
  });

  it("never falls back to disk once a record exists", () => {
    // The invariant that matters: [] must not degrade into "disk".
    expect(planRestoreSource([])).not.toBe("disk");
  });

  it("survives a truncation that empties the list", () => {
    // End-to-end of the two helpers: rewind past everything -> [] -> "none".
    const truncated = truncateResolvedAfter([plan("a"), plan("b")], 0);
    expect(truncated).toEqual([]);
    expect(planRestoreSource(truncated)).toBe("none");
  });

  it("still renders survivors when a truncation leaves some", () => {
    const kept = truncateResolvedAfter(
      [{ ...plan("a"), afterUserMessage: 1 }, { ...plan("b"), afterUserMessage: 5 }],
      2,
    );
    expect(kept.map((p) => p.text)).toEqual(["a"]);
    expect(planRestoreSource(kept)).toBe("saved");
  });
});
