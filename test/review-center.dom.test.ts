// DOM-level test of the review-center panel (AP-09) — drives the REAL shipped
// media/chat.js in happy-dom and dispatches the same `reviewCenter` messages
// sidebar.ts posts.
//
// What this covers that a pure test cannot:
//   - the panel stays off until a list arrives (empty turn: not an empty card)
//   - one row per path with +N −M and the headline matching the inline sum
//   - "this turn" / "session" filters the list without a host round-trip
//   - open diff posts the existing `openDiff` payload; discard posts the new
//     reviewRevert* messages
//   - a `sessionUiSnapshot` replay puts it back after a focus switch
import { describe, it, expect } from "vitest";
import { bootWebview, dispatch, click } from "./webview-harness";
import { formatReviewHeadline } from "../media/webview-helpers.js";

const file = (over: Record<string, unknown> = {}) => ({
  path: "src/a.ts",
  added: 4,
  removed: 1,
  turnAdded: 4,
  turnRemoved: 1,
  completed: true,
  turnCompleted: true,
  diff: {
    toolCallId: "t1",
    oldText: "foo",
    newText: "bar",
    sites: [{ oldText: "foo", newText: "bar" }],
  },
  turnDiff: {
    toolCallId: "t1",
    oldText: "foo",
    newText: "bar",
    sites: [{ oldText: "foo", newText: "bar" }],
  },
  ...over,
});

const rows = (doc: Document) => [...doc.querySelectorAll("#review-center-list .review-file")];

describe("review center (real chat.js in a DOM)", () => {
  it("stays hidden until a change list arrives — empty turn is not an empty card", () => {
    const { doc } = bootWebview();
    const panel = doc.getElementById("review-center")!;
    expect(panel).not.toBeNull();
    expect(panel.hidden).toBe(true);
    expect(rows(doc).length).toBe(0);
  });

  it("renders one row per file with the headline matching the inline sums", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "reviewCenter",
      currentTurnId: "1",
      files: [
        file({ path: "src/a.ts", added: 4, removed: 1, turnAdded: 4, turnRemoved: 1 }),
        file({
          path: "src/b.ts",
          added: 2,
          removed: 2,
          turnAdded: 2,
          turnRemoved: 2,
          diff: { toolCallId: "t2", oldText: "x", newText: "y", sites: [{ oldText: "x", newText: "y" }] },
        }),
      ],
    });

    const panel = doc.getElementById("review-center")!;
    expect(panel.hidden).toBe(false);
    expect(rows(doc).map((li) => li.querySelector(".review-file-name")!.textContent)).toEqual(["a.ts", "b.ts"]);
    expect(doc.getElementById("review-center-count")!.getAttribute("aria-label")).toBe(formatReviewHeadline(2, 6, 3));
    expect(rows(doc)[0].querySelector(".diff-stat-add")!.textContent).toBe("+4");
    expect(rows(doc)[0].querySelector(".diff-stat-del")!.textContent).toBe("−1");
  });

  it("hides the panel again when the list goes empty", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "reviewCenter", currentTurnId: "1", files: [file()] });
    expect(doc.getElementById("review-center")!.hidden).toBe(false);

    dispatch(window, { type: "reviewCenter", currentTurnId: "1", files: [] });
    const panel = doc.getElementById("review-center")!;
    expect(panel.hidden).toBe(true);
    expect(rows(doc).length).toBe(0);
  });

  it("the turn switcher hides files that only belong to earlier turns", () => {
    const { window, doc } = bootWebview();
    dispatch(window, {
      type: "reviewCenter",
      currentTurnId: "2",
      files: [
        file({ path: "src/old.ts", added: 1, removed: 1, turnAdded: 0, turnRemoved: 0, turnCompleted: false, turnDiff: undefined }),
        file({ path: "src/new.ts", added: 3, removed: 0, turnAdded: 3, turnRemoved: 0 }),
      ],
    });

    expect(rows(doc).map((li) => li.querySelector(".review-file-name")!.textContent)).toEqual(["new.ts"]);
    expect(doc.getElementById("review-center-count")!.getAttribute("aria-label")).toBe(formatReviewHeadline(1, 3, 0));

    click(window, doc.getElementById("review-scope-session")!);
    expect(rows(doc).map((li) => li.querySelector(".review-file-name")!.textContent)).toEqual(["old.ts", "new.ts"]);
    expect(doc.getElementById("review-center-count")!.getAttribute("aria-label")).toBe(formatReviewHeadline(2, 4, 1));
  });

  it("open diff posts the existing openDiff payload for that file", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "reviewCenter", currentTurnId: "1", files: [file()] });
    click(window, rows(doc)[0].querySelector(".review-open")!);
    const sent = posted.filter((m: { type: string }) => m.type === "openDiff");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "openDiff",
      path: "src/a.ts",
      oldText: "foo",
      newText: "bar",
    });
  });

  it("discard file posts reviewRevertFile with the current scope", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, { type: "reviewCenter", currentTurnId: "1", files: [file()] });
    const discard = rows(doc)[0].querySelector(".review-discard")!;
    click(window, discard);
    expect(posted.filter((m: { type: string }) => m.type === "reviewRevertFile")).toEqual([
      { type: "reviewRevertFile", path: "src/a.ts", scope: "turn" },
    ]);
  });

  it("discard all posts reviewRevertAll rather than N per-file reverts", () => {
    const { window, doc, posted } = bootWebview();
    dispatch(window, {
      type: "reviewCenter",
      currentTurnId: "1",
      files: [file({ path: "a.ts" }), file({ path: "b.ts", diff: { toolCallId: "t2", oldText: "x", newText: "y", sites: [] } })],
    });
    // Two presses: the first arms it and says what the second does.
    click(window, doc.getElementById("review-revert-all")!);
    expect(posted.filter((m: { type: string }) => m.type === "reviewRevertAll")).toEqual([]);
    expect(doc.getElementById("review-revert-all")!.textContent).toBe("Discard all?");
    click(window, doc.getElementById("review-revert-all")!);
    expect(posted.filter((m: { type: string }) => m.type === "reviewRevertAll")).toEqual([
      { type: "reviewRevertAll", scope: "turn" },
    ]);
    expect(posted.filter((m: { type: string }) => m.type === "reviewRevertFile")).toEqual([]);
    expect(posted.filter((m: { type: string }) => m.type === "revertToolEdit")).toEqual([]);
  });

  it("survives a focus switch: cleared by clearMessages, restored by the snapshot", () => {
    const { window, doc } = bootWebview();
    dispatch(window, { type: "reviewCenter", currentTurnId: "1", files: [file()] });
    expect(rows(doc).length).toBe(1);

    dispatch(window, { type: "clearMessages" });
    expect(doc.getElementById("review-center")!.hidden).toBe(true);
    dispatch(window, { type: "historyReplay", active: true });
    dispatch(window, { type: "historyReplay", active: false });
    dispatch(window, { type: "reviewCenter", currentTurnId: "1", files: [file()] });

    expect(doc.getElementById("review-center")!.hidden).toBe(false);
    expect(rows(doc).length).toBe(1);
  });
});
