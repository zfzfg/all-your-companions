// DOM-level test of the agent step rail (AP-02) — drives the REAL shipped
// media/chat.js in happy-dom and dispatches the same `planEntries` messages
// sidebar.ts posts.
//
// What this covers that a pure test cannot:
//   - the card appears on the first list and stays ONE card across updates
//     (the message is replacing state, so a second card would be a second
//     claim about the same run)
//   - an empty list hides it rather than leaving an empty bordered strip
//   - a `sessionUiSnapshot` replay puts it back after a focus switch, which is
//     the whole reason the message is transient-plus-snapshot rather than
//     buffered
//   - a grok-shaped session — plan TEXT, so the host posts no `planEntries` at
//     all — never grows a rail
//
// No API is stubbed that happy-dom lacks; the rail uses only element ids,
// classes and localStorage, all of which happy-dom provides.
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";

const entries = (...rows: [string, string][]) =>
  rows.map(([content, status], i) => ({ id: `plan-${i}`, content, status }));

const items = (doc: Document) => [...doc.querySelectorAll("#todo-rail-list .todo-item")];

describe("todo rail (real chat.js in a DOM)", () => {
  it("stays hidden until a plan list arrives", () => {
    const { doc } = bootWebview();
    const rail = doc.getElementById("todo-rail")!;
    expect(rail).not.toBeNull();
    expect(rail.hidden).toBe(true);
  });

  it("renders one row per step with the status on the row", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "planEntries",
      entries: entries(
        ["Read the dispatcher", "completed"],
        ["Add the session field", "in_progress"],
        ["Write the DOM test", "pending"],
      ),
    });

    const rail = doc.getElementById("todo-rail")!;
    expect(rail.hidden).toBe(false);
    expect(items(doc).map((li) => li.querySelector(".todo-text")!.textContent)).toEqual([
      "Read the dispatcher",
      "Add the session field",
      "Write the DOM test",
    ]);
    expect(items(doc).map((li) => li.className)).toEqual([
      "cx-row todo-item todo-completed",
      "cx-row todo-item todo-in-progress todo-active",
      "cx-row todo-item todo-pending",
    ]);
  });

  it("shows the progress counter in the head", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "planEntries",
      entries: entries(["a", "completed"], ["b", "completed"], ["c", "in_progress"], ["d", "pending"]),
    });
    expect(doc.getElementById("todo-rail-count")!.textContent).toBe("2/4");
  });

  it("updates in place instead of stacking a second card", () => {
    const { window, doc } = bootWebview();
    const first = entries(["step one", "in_progress"], ["step two", "pending"]);
    dispatch(window, { type: "planEntries", entries: first });
    dispatch(window, {
      type: "planEntries",
      entries: entries(["step one", "completed"], ["step two", "in_progress"]),
    });

    expect(doc.querySelectorAll("#todo-rail").length).toBe(1);
    expect(items(doc).length).toBe(2);
    expect(doc.getElementById("todo-rail-count")!.textContent).toBe("1/2");
    expect(items(doc)[0].className).toContain("todo-completed");
    expect(items(doc)[1].className).toContain("todo-active");
  });

  it("hides the card again when the list goes empty", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "planEntries", entries: entries(["only step", "pending"]) });
    expect(doc.getElementById("todo-rail")!.hidden).toBe(false);

    dispatch(window, { type: "planEntries", entries: [] });
    const rail = doc.getElementById("todo-rail")!;
    expect(rail.hidden).toBe(true);
    // Emptied too, so a stale row cannot flash back on the next expand.
    expect(items(doc).length).toBe(0);
  });

  it("collapses to the counter and remembers that per conversation", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "sessionName", sessionId: "sess-a", name: "Open one", cwd: "/repo" });
    dispatch(window, { type: "planEntries", entries: entries(["a", "completed"], ["b", "pending"]) });

    const head = doc.getElementById("todo-rail-head")!;
    const list = doc.getElementById("todo-rail-list")! as HTMLElement;
    expect(list.hidden).toBe(false);
    expect(head.getAttribute("aria-expanded")).toBe("true");

    click(window, head);
    expect(list.hidden).toBe(true);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    // The counter survives the fold — it is the reason to keep the head.
    expect(doc.getElementById("todo-rail-count")!.textContent).toBe("1/2");
    expect(window.localStorage.getItem("grok.todoRail.collapsed:sess-a")).toBe("true");

    click(window, head);
    expect(list.hidden).toBe(false);
    expect(window.localStorage.getItem("grok.todoRail.collapsed:sess-a")).toBe("false");
  });

  it("survives a focus switch: cleared by clearMessages, restored by the snapshot", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "planEntries", entries: entries(["a", "completed"], ["b", "in_progress"]) });
    expect(items(doc).length).toBe(2);

    // What sidebar.ts sends when the user switches to another conversation and
    // back: clearMessages, the replay buffer (which never contains planEntries —
    // it is in TRANSIENT_TYPES), then sessionUiSnapshot.
    dispatch(window, { type: "clearMessages" });
    expect(doc.getElementById("todo-rail")!.hidden).toBe(true);
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "historyReplay", active: false });
    dispatch(window, { type: "planEntries", entries: entries(["a", "completed"], ["b", "in_progress"]) });

    expect(doc.getElementById("todo-rail")!.hidden).toBe(false);
    expect(items(doc).length).toBe(2);
    expect(doc.getElementById("todo-rail-count")!.textContent).toBe("1/2");
  });

  it("leaves a grok-shaped session with no rail at all", () => {
    // grok and Antigravity send plan TEXT, `parsePlanEntries` returns null, and
    // the host therefore posts NO planEntries message. The webview's whole
    // exposure to that decision is this: nothing arrives, nothing is drawn.
    const { window, doc } = bootWebview();
    dispatch(window, { type: "modeChanged", modeId: "plan" });
    dispatch(window, {
      type: "exitPlanRequest",
      req: { id: 1, plan: "## Plan\n\n1. one\n2. two\n- [ ] three" },
    });

    expect(doc.getElementById("todo-rail")!.hidden).toBe(true);
    expect(items(doc).length).toBe(0);
    // And the plan itself still rendered — this is the untouched path.
    expect(doc.querySelector(".card.plan")).not.toBeNull();
  });

  it("puts the step counter on the open conversation's history row only", () => {
    const { window, doc } = bootWebview();
    const row = (id: string, name: string, numMessages: number) => ({
      id, cwd: "/repo", displayName: name, rawSummary: "", updatedAt: Date.now(), createdAt: 1, numMessages,
    });
    dispatch(window, {
      type: "sessions",
      entries: [row("sess-a", "Open one", 4), row("sess-b", "Another", 2)],
      activeId: "sess-a",
      dots: {},
    });
    dispatch(window, { type: "sessionName", sessionId: "sess-a", name: "Open one", cwd: "/repo" });
    dispatch(window, { type: "planEntries", entries: entries(["a", "completed"], ["b", "pending"], ["c", "pending"]) });

    click(window, doc.getElementById("history-btn")!);
    const metas = [...doc.querySelectorAll("#history-popover .history-row-meta")].map((el) => el.textContent);
    expect(metas[0]).toContain("1/3 steps");
    expect(metas[1]).not.toContain("steps");
  });
});
