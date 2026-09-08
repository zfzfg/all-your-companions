// Pure tests for the plan-checklist normalizer (AP-02).
//
// The load-bearing case is the grok describe block below: a grok/Antigravity
// plan update carries prose and no entry list, and must normalize to `null`
// rather than to a one-element checklist. Everything downstream — the session
// field, the host message, the rail — hangs off that null, and it is the
// mechanism by which "no Todo rail for grok" is implemented (maintainer
// decision, blocker question 18.7). There is deliberately no text parser here
// to test.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { sessionUiSnapshot } from "../src/session";
import {
  PLAN_ENTRY_STATUSES,
  parsePlanEntries,
  planProgress,
  type PlanEntry,
} from "../src/plan-entries";
import { planEntriesProgress } from "../media/webview-helpers.js";

const update = (entries: unknown) => ({ sessionUpdate: "plan", entries });

describe("parsePlanEntries", () => {
  it("normalizes a well-formed ACP plan update", () => {
    expect(parsePlanEntries(update([
      { content: "Read the dispatcher", status: "completed", priority: "high" },
      { content: "Add the session field", status: "in_progress", priority: "medium" },
      { content: "Write the DOM test", status: "pending", priority: "low" },
    ]))).toEqual([
      { id: "plan-0-read-the-dispatcher", content: "Read the dispatcher", status: "completed", priority: "high" },
      { id: "plan-1-add-the-session-field", content: "Add the session field", status: "in_progress", priority: "medium" },
      { id: "plan-2-write-the-dom-test", content: "Write the DOM test", status: "pending", priority: "low" },
    ]);
  });

  it("keeps an agent-supplied id instead of deriving one", () => {
    const [entry] = parsePlanEntries(update([{ id: " step-7 ", content: "Ship it", status: "pending" }]))!;
    expect(entry.id).toBe("step-7");
  });

  it("reads an unknown, missing or misspelled status as pending", () => {
    const entries = parsePlanEntries(update([
      { content: "no status at all" },
      { content: "null status", status: null },
      { content: "invented by a later spec", status: "deferred" },
      { content: "not even a string", status: 3 },
    ]))!;
    expect(entries.map((e) => e.status)).toEqual(["pending", "pending", "pending", "pending"]);
  });

  it("folds the separator and case variants of in_progress and completed", () => {
    const entries = parsePlanEntries(update([
      { content: "a", status: "in-progress" },
      { content: "b", status: "inProgress" },
      { content: "c", status: "IN_PROGRESS" },
      { content: "d", status: "Complete" },
      { content: "e", status: "COMPLETED" },
    ]))!;
    expect(entries.map((e) => e.status)).toEqual([
      "in_progress", "in_progress", "in_progress", "completed", "completed",
    ]);
  });

  it("drops an unknown priority rather than passing it through", () => {
    const entries = parsePlanEntries(update([
      { content: "a", priority: "urgent" },
      { content: "b", priority: 1 },
      { content: "c", priority: "HIGH" },
    ]))!;
    expect(entries.map((e) => e.priority)).toEqual([undefined, undefined, "high"]);
  });

  it("drops entries with no usable content, so the counter cannot count a blank row", () => {
    const entries = parsePlanEntries(update([
      { content: "real step" },
      { content: "   " },
      { content: 42 },
      { status: "completed" },
      null,
      "just a string",
    ]))!;
    expect(entries.map((e) => e.content)).toEqual(["real step"]);
  });

  it("accepts a content BLOCK, because agents reuse their block serializer", () => {
    const entries = parsePlanEntries(update([{ content: { type: "text", text: " wrapped " } }]))!;
    expect(entries[0].content).toBe("wrapped");
  });

  it("disambiguates duplicate ids instead of dropping a real step", () => {
    const entries = parsePlanEntries(update([
      { id: "same", content: "first" },
      { id: "same", content: "second" },
      { id: "same", content: "third" },
    ]))!;
    expect(entries.map((e) => e.id)).toEqual(["same", "same#2", "same#3"]);
    expect(new Set(entries.map((e) => e.id)).size).toBe(3);
  });

  it("gives repeated text at different positions distinct derived ids", () => {
    const entries = parsePlanEntries(update([
      { content: "run the tests" },
      { content: "run the tests" },
    ]))!;
    expect(entries.map((e) => e.id)).toEqual(["plan-0-run-the-tests", "plan-1-run-the-tests"]);
  });

  it("derives a usable id from text that slugs to nothing", () => {
    const entries = parsePlanEntries(update([{ content: "!!! ???" }, { content: "###" }]))!;
    expect(entries.map((e) => e.id)).toEqual(["plan-0-step", "plan-1-step"]);
  });

  it("keeps ids stable across two updates of the same plan", () => {
    const first = parsePlanEntries(update([
      { content: "Read the dispatcher", status: "in_progress" },
      { content: "Add the session field", status: "pending" },
    ]))!;
    const second = parsePlanEntries(update([
      { content: "Read the dispatcher", status: "completed" },
      { content: "Add the session field", status: "in_progress" },
    ]))!;
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
    expect(second.map((e) => e.status)).toEqual(["completed", "in_progress"]);
  });

  it("returns the EMPTY list for an entries array that yields nothing usable", () => {
    // An update that says "here is my checklist" and lists nothing has retired
    // the previous checklist. Null would leave a stale rail standing.
    expect(parsePlanEntries(update([]))).toEqual([]);
    expect(parsePlanEntries(update([{ content: "" }, null]))).toEqual([]);
  });

  it("returns null when the update carries no entries array at all", () => {
    expect(parsePlanEntries(undefined)).toBeNull();
    expect(parsePlanEntries(null)).toBeNull();
    expect(parsePlanEntries("plan text")).toBeNull();
    expect(parsePlanEntries(42)).toBeNull();
    expect(parsePlanEntries({ sessionUpdate: "plan" })).toBeNull();
    expect(parsePlanEntries(update(null))).toBeNull();
    expect(parsePlanEntries(update("1. do the thing"))).toBeNull();
    expect(parsePlanEntries(update({ 0: { content: "a" }, length: 1 }))).toBeNull();
  });
});

describe("parsePlanEntries against a grok-style plan update", () => {
  // What src/agy-acp-adapter.ts sends, and the shape src/sidebar.ts has always
  // stashed into `lastPlanText`.
  const grokPlan = {
    sessionUpdate: "plan",
    plan: "## Plan\n\n1. Read the dispatcher\n2. Add the session field\n- [ ] Write the test\n",
  };

  it("finds no checklist in plan TEXT, however list-shaped the prose is", () => {
    expect(parsePlanEntries(grokPlan)).toBeNull();
    expect(parsePlanEntries({ sessionUpdate: "plan", planText: grokPlan.plan })).toBeNull();
    expect(parsePlanEntries({ sessionUpdate: "plan", content: grokPlan.plan })).toBeNull();
    expect(parsePlanEntries({ sessionUpdate: "plan", content: { text: grokPlan.plan } })).toBeNull();
  });

  it("carries no text scanner that a formatting change could start firing", () => {
    const src = readFileSync(new URL("../src/plan-entries.ts", import.meta.url), "utf8");
    // The module reads exactly one field off the update. Anything that split or
    // line-scanned the plan STRING would be the heuristic decision 18.7 rules
    // out — the surviving regexes all operate on one entry's own text.
    for (const forbidden of ["split(", "checkbox", "- [ ]", ".plan", "planText"]) {
      expect(src).not.toContain(forbidden);
    }
  });
});

describe("planProgress", () => {
  const entries: PlanEntry[] = [
    { id: "a", content: "a", status: "completed" },
    { id: "b", content: "b", status: "completed" },
    { id: "c", content: "c", status: "in_progress" },
    { id: "d", content: "d", status: "pending" },
  ];

  it("counts completed against the whole list and names the active step", () => {
    expect(planProgress(entries)).toEqual({ done: 2, total: 4, active: entries[2] });
  });

  it("names the FIRST in-progress step when an agent marks several", () => {
    const many: PlanEntry[] = [
      { id: "a", content: "a", status: "in_progress" },
      { id: "b", content: "b", status: "in_progress" },
    ];
    expect(planProgress(many).active).toBe(many[0]);
  });

  it("omits `active` when nothing is in progress, and survives an empty list", () => {
    expect(planProgress([{ id: "a", content: "a", status: "pending" }])).toEqual({ done: 0, total: 1 });
    expect(planProgress([])).toEqual({ done: 0, total: 0 });
    expect(planProgress(undefined as unknown as PlanEntry[])).toEqual({ done: 0, total: 0 });
  });

  it("agrees with the webview's own copy of the counter", () => {
    // media/webview-helpers.js cannot import the TypeScript, so it carries a
    // duplicate — pinned here the same way the message-type lists are.
    const lists: PlanEntry[][] = [entries, [], [{ id: "x", content: "x", status: "pending" }]];
    for (const list of lists) {
      const ts = planProgress(list);
      const js = planEntriesProgress(list);
      expect({ done: js.done, total: js.total }).toEqual({ done: ts.done, total: ts.total });
      expect(js.activeIndex).toBe(ts.active ? list.indexOf(ts.active) : -1);
    }
  });
});

describe("the status vocabulary", () => {
  it("is exactly ACP's three plan-entry states", () => {
    expect(PLAN_ENTRY_STATUSES).toEqual(["pending", "in_progress", "completed"]);
  });
});

describe("the host's plan handler (GrokSidebar.applyPlanUpdate)", () => {
  // The `client.on("plan")` closure delegates straight to this method, so the
  // handler can be exercised without an ACP process. `emit` is the only thing
  // it reaches for besides the log line.
  function makeSidebar() {
    const instance = Object.create(GrokSidebar.prototype) as any;
    instance.host = { appendLine: vi.fn() };
    instance.emit = vi.fn();
    return instance;
  }

  it("sets lastPlanText and emits NOTHING for a grok-style plan text", () => {
    const sidebar = makeSidebar();
    const session = new Session();
    const planText = "## Plan\n\n1. Read the dispatcher\n2. Add the session field\n";

    sidebar.applyPlanUpdate(session, { sessionUpdate: "plan", plan: planText });

    // Byte-for-byte the behaviour that shipped before AP-02.
    expect(session.lastPlanText).toBe(planText);
    expect(session.planEntries).toEqual([]);
    expect(sidebar.emit).not.toHaveBeenCalled();
    // …and nothing for the webview to restore either, so no rail can appear on
    // a focus switch.
    expect(sessionUiSnapshot(session, "plan").some((m) => m.type === "planEntries")).toBe(false);
  });

  it("keeps the older plan-text field spellings working", () => {
    for (const update of [
      { planText: "from planText" },
      { content: "from content" },
      { content: { text: "from content.text" } },
    ]) {
      const sidebar = makeSidebar();
      const session = new Session();
      sidebar.applyPlanUpdate(session, { sessionUpdate: "plan", ...update });
      expect(session.lastPlanText).toMatch(/^from /);
      expect(sidebar.emit).not.toHaveBeenCalled();
    }
  });

  it("stores and emits the checklist for a structured plan update", () => {
    const sidebar = makeSidebar();
    const session = new Session();

    sidebar.applyPlanUpdate(session, {
      sessionUpdate: "plan",
      entries: [
        { content: "Read the dispatcher", status: "completed" },
        { content: "Add the session field", status: "in_progress" },
      ],
    });

    expect(session.planEntries.map((e) => e.status)).toEqual(["completed", "in_progress"]);
    expect(sidebar.emit).toHaveBeenCalledTimes(1);
    expect(sidebar.emit.mock.calls[0][1]).toEqual({
      type: "planEntries",
      entries: session.planEntries,
    });
    // A structured update carries no plan prose, which is what it always
    // resolved to — the two paths do not interfere.
    expect(session.lastPlanText).toBe("");
    expect(sessionUiSnapshot(session, "agent")).toContainEqual({
      type: "planEntries",
      entries: session.planEntries,
    });
  });

  it("replaces the whole list on the next update rather than merging", () => {
    const sidebar = makeSidebar();
    const session = new Session();
    sidebar.applyPlanUpdate(session, { sessionUpdate: "plan", entries: [{ content: "a" }, { content: "b" }] });
    sidebar.applyPlanUpdate(session, { sessionUpdate: "plan", entries: [{ content: "c" }] });

    expect(session.planEntries.map((e) => e.content)).toEqual(["c"]);
  });

  it("retires the rail when the agent sends an empty checklist", () => {
    const sidebar = makeSidebar();
    const session = new Session();
    sidebar.applyPlanUpdate(session, { sessionUpdate: "plan", entries: [{ content: "a" }] });
    sidebar.applyPlanUpdate(session, { sessionUpdate: "plan", entries: [] });

    expect(session.planEntries).toEqual([]);
    expect(sidebar.emit.mock.calls[1][1]).toEqual({ type: "planEntries", entries: [] });
    expect(sessionUiSnapshot(session, "agent").some((m) => m.type === "planEntries")).toBe(false);
  });

  it("clearPlanEntries announces the drop, but only when there was a list", () => {
    const sidebar = makeSidebar();
    const session = new Session();

    // A rewind on a grok session must not post a message no client asked for.
    sidebar.clearPlanEntries(session);
    expect(sidebar.emit).not.toHaveBeenCalled();

    sidebar.applyPlanUpdate(session, { sessionUpdate: "plan", entries: [{ content: "a" }] });
    sidebar.clearPlanEntries(session);
    expect(session.planEntries).toEqual([]);
    expect(sidebar.emit.mock.calls[1][1]).toEqual({ type: "planEntries", entries: [] });
  });
});
