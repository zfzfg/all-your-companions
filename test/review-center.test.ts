import { describe, expect, it } from "vitest";
import { planEditRevert } from "../src/diff-view";
import {
  aggregateReviewChanges,
  completedBlocksForPath,
  countLineDiff,
  dropReviewPath,
  dropReviewTurnsAfter,
  extractReviewSites,
  filesForScope,
  formatReviewHeadline,
  headlineForScope,
  ingestReviewToolCall,
  normalizeReviewPath,
  planDiscardAll,
  planFileRevert,
  reviewCenterSnapshot,
  type ReviewDiffBlock,
} from "../src/review-center";
import { computeLineDiff, formatReviewHeadline as jsHeadline } from "../media/webview-helpers.js";

const block = (over: Partial<ReviewDiffBlock> & Pick<ReviewDiffBlock, "path" | "oldText" | "newText">): ReviewDiffBlock => ({
  sites: [{ oldText: over.oldText, newText: over.newText }],
  toolCallId: over.toolCallId ?? "t1",
  turnId: over.turnId ?? "1",
  status: over.status ?? "completed",
  ...over,
});

describe("normalizeReviewPath", () => {
  it("folds slashes and a leading ./ so the same file is one row", () => {
    expect(normalizeReviewPath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizeReviewPath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizeReviewPath("src/a.ts")).toBe("src/a.ts");
  });
});

describe("countLineDiff matches the inline computeLineDiff", () => {
  const cases: Array<[string, string]> = [
    ["", "hello\n"],
    ["hello\n", ""],
    ["a\nb\nc\n", "a\nB\nc\n"],
    ["foo", "bar"],
    ["same\n", "same\n"],
    ["a\r\nb\r\n", "a\nb\n"],
    ["TOKEN", "REPLACED"],
  ];
  for (const [oldText, newText] of cases) {
    it(`agrees on ${JSON.stringify(oldText)} → ${JSON.stringify(newText)}`, () => {
      const ts = countLineDiff(oldText, newText);
      const js = computeLineDiff(oldText, newText);
      expect({ added: ts.added, removed: ts.removed }).toEqual({ added: js.added, removed: js.removed });
    });
  }
});

describe("extractReviewSites", () => {
  it("expands details[] the way the inline diff does, including line_prefix", () => {
    const sites = extractReviewSites({
      oldText: "TOKEN",
      newText: "REPLACED",
      _meta: {
        details: [
          { old_string: "TOKEN", new_string: "REPLACED", old_line: 1, new_line: 1, line_prefix: "item 1: " },
          { old_string: "TOKEN", new_string: "REPLACED", old_line: 4, new_line: 4, line_prefix: "item 2: " },
        ],
      },
    });
    expect(sites).toEqual([
      { oldText: "item 1: TOKEN", newText: "item 1: REPLACED", oldLine: 1, newLine: 1 },
      { oldText: "item 2: TOKEN", newText: "item 2: REPLACED", oldLine: 4, newLine: 4 },
    ]);
  });

  it("falls back to the block when details[] is absent", () => {
    expect(extractReviewSites({ oldText: "a", newText: "b", _meta: { old_line: 3, new_line: 3 } }))
      .toEqual([{ oldText: "a", newText: "b", oldLine: 3, newLine: 3 }]);
  });
});

describe("ingestReviewToolCall", () => {
  it("records a useful diff and replaces the echo for the same toolCallId+path", () => {
    const echo = ingestReviewToolCall([], {
      toolCallId: "e1",
      status: "in_progress",
      content: [{ type: "diff", path: "src/a.ts", oldText: "", newText: "new\n" }],
    }, "1");
    expect(echo).toHaveLength(1);
    expect(echo[0].oldText).toBe("");
    const done = ingestReviewToolCall(echo, {
      toolCallId: "e1",
      status: "completed",
      content: [{ type: "diff", path: "src/a.ts", oldText: "old\n", newText: "new\n" }],
    }, "1");
    expect(done).toHaveLength(1);
    expect(done[0].oldText).toBe("old\n");
    expect(done[0].status).toBe("completed");
  });

  it("drops a failed tool call instead of leaving a stale row", () => {
    const live = ingestReviewToolCall([], {
      toolCallId: "e1",
      status: "in_progress",
      content: [{ type: "diff", path: "a.ts", oldText: "a", newText: "b" }],
    }, "1");
    expect(ingestReviewToolCall(live, { toolCallId: "e1", status: "failed" }, "1")).toEqual([]);
  });

  it("ignores a degenerate oldText===newText block with no differing sites", () => {
    expect(ingestReviewToolCall([], {
      toolCallId: "e1",
      status: "completed",
      content: [{ type: "diff", path: "a.ts", oldText: "same", newText: "same" }],
    }, "1")).toEqual([]);
  });

  it("ignores an empty path", () => {
    expect(ingestReviewToolCall([], {
      toolCallId: "e1",
      status: "completed",
      content: [{ type: "diff", path: "  ", oldText: "a", newText: "b" }],
    }, "1")).toEqual([]);
  });
});

describe("aggregateReviewChanges", () => {
  it("dedupes by path and sums the inline site counts", () => {
    const a1 = block({
      path: "src/a.ts",
      oldText: "foo",
      newText: "bar",
      toolCallId: "1",
      sites: [{ oldText: "foo", newText: "bar" }],
    });
    const a2 = block({
      path: "./src/a.ts",
      oldText: "bar",
      newText: "baz",
      toolCallId: "2",
      sites: [{ oldText: "bar", newText: "baz" }],
    });
    const other = block({
      path: "src/b.ts",
      oldText: "x\n",
      newText: "x\ny\n",
      toolCallId: "3",
      sites: [{ oldText: "x\n", newText: "x\ny\n" }],
    });
    const summary = aggregateReviewChanges([a1, a2, other], { currentTurnId: "1" });
    expect(summary.fileCount).toBe(2);
    const rowA = summary.files.find((f) => f.path === "src/a.ts")!;
    const inlineA = [
      computeLineDiff("foo", "bar"),
      computeLineDiff("bar", "baz"),
    ];
    expect(rowA.added).toBe(inlineA[0].added + inlineA[1].added);
    expect(rowA.removed).toBe(inlineA[0].removed + inlineA[1].removed);
    expect(summary.added).toBe(rowA.added + summary.files.find((f) => f.path === "src/b.ts")!.added);
    expect(summary.removed).toBe(rowA.removed + summary.files.find((f) => f.path === "src/b.ts")!.removed);
  });

  it("a replace_all with details[] matches the sum of every inline site, not the token-sized block", () => {
    const sites = [
      { oldText: "TOKEN", newText: "REPLACED" },
      { oldText: "TOKEN", newText: "REPLACED" },
      { oldText: "TOKEN", newText: "REPLACED" },
    ];
    const summary = aggregateReviewChanges([block({
      path: "a.ts",
      oldText: "TOKEN",
      newText: "REPLACED",
      sites,
    })]);
    let added = 0;
    let removed = 0;
    for (const s of sites) {
      const n = computeLineDiff(s.oldText, s.newText);
      added += n.added;
      removed += n.removed;
    }
    expect(summary.files).toHaveLength(1);
    expect(summary.added).toBe(added);
    expect(summary.removed).toBe(removed);
    expect(summary.added).toBeGreaterThan(countLineDiff("TOKEN", "REPLACED").added);
  });

  it("an empty list is zero files, not a phantom row", () => {
    const summary = aggregateReviewChanges([]);
    expect(summary).toEqual({ files: [], fileCount: 0, added: 0, removed: 0 });
  });

  it("splits this-turn counts from the session total", () => {
    const t1 = block({ path: "a.ts", oldText: "a", newText: "b", turnId: "1", toolCallId: "1" });
    const t2 = block({ path: "a.ts", oldText: "b", newText: "c", turnId: "2", toolCallId: "2" });
    const snap = reviewCenterSnapshot([t1, t2], "2");
    expect(snap).toHaveLength(1);
    expect(snap[0].added).toBe(countLineDiff("a", "b").added + countLineDiff("b", "c").added);
    expect(snap[0].turnAdded).toBe(countLineDiff("b", "c").added);
    expect(filesForScope(snap, "turn")).toHaveLength(1);
    expect(filesForScope(reviewCenterSnapshot([t1, t2], "3"), "turn")).toHaveLength(0);
    expect(filesForScope(reviewCenterSnapshot([t1, t2], "3"), "session")).toHaveLength(1);
  });
});

describe("formatReviewHeadline", () => {
  it("matches the webview helper, including the real minus sign", () => {
    expect(formatReviewHeadline(3, 47, 12)).toBe("3 files · +47 −12");
    expect(formatReviewHeadline(1, 1, 0)).toBe("1 file · +1 −0");
    expect(jsHeadline(3, 47, 12)).toBe(formatReviewHeadline(3, 47, 12));
    expect(headlineForScope([
      { path: "a.ts", added: 4, removed: 1, turnAdded: 2, turnRemoved: 1, completed: true, turnCompleted: true, diff: { toolCallId: "t", oldText: "a", newText: "b", sites: [] } },
      { path: "b.ts", added: 3, removed: 2, turnAdded: 0, turnRemoved: 0, completed: true, turnCompleted: false, diff: { toolCallId: "t", oldText: "a", newText: "b", sites: [] } },
    ], "session").text).toBe("2 files · +7 −3");
  });
});

describe("planFileRevert", () => {
  it("chains two edits in memory and writes the original once", () => {
    const current = "header\nbaz\nfooter\n";
    const blocks = [
      block({ path: "a.ts", oldText: "foo", newText: "bar", toolCallId: "1" }),
      block({ path: "a.ts", oldText: "bar", newText: "baz", toolCallId: "2" }),
    ];
    expect(planFileRevert(blocks, current)).toEqual({
      action: "write",
      text: "header\nfoo\nfooter\n",
    });
  });

  it("is a conflict for the whole file when a later region is gone — no partial plan", () => {
    const blocks = [
      block({ path: "a.ts", oldText: "foo", newText: "bar", toolCallId: "1" }),
      block({ path: "a.ts", oldText: "bar", newText: "baz", toolCallId: "2" }),
    ];
    expect(planFileRevert(blocks, "foreign content, neither region")).toEqual({ action: "conflict" });
  });

  it("uses planEditRevert for a single completed edit", () => {
    const blocks = [block({ path: "a.ts", oldText: "41", newText: "42" })];
    const current = "header\nconst answer = 42;\nfooter\n";
    expect(planFileRevert(blocks, current)).toEqual(
      planEditRevert({ oldText: "41", newText: "42", currentText: current }),
    );
  });

  it("ignores in-flight (pending) blocks so a half-written edit is not reversed", () => {
    const blocks = [
      block({ path: "a.ts", oldText: "foo", newText: "bar", status: "pending" }),
    ];
    expect(planFileRevert(blocks, "header\nbar\nfooter\n")).toEqual({ action: "conflict" });
  });
});

describe("planDiscardAll", () => {
  it("names a checkpoint restore, never a list of per-file reverts", () => {
    expect(planDiscardAll("turn", "3")).toEqual({ kind: "checkpoint", mode: "turn", turnId: "3" });
    expect(planDiscardAll("session", "3")).toEqual({ kind: "checkpoint", mode: "session", turnId: "3" });
    expect(planDiscardAll("turn", "0")).toEqual({ kind: "unavailable" });
  });
});

describe("drop helpers", () => {
  it("dropReviewPath removes one file across turns unless scoped", () => {
    const blocks = [
      block({ path: "a.ts", oldText: "a", newText: "b", turnId: "1", toolCallId: "1" }),
      block({ path: "a.ts", oldText: "b", newText: "c", turnId: "2", toolCallId: "2" }),
      block({ path: "b.ts", oldText: "x", newText: "y", turnId: "2", toolCallId: "3" }),
    ];
    expect(dropReviewPath(blocks, "a.ts").map((b) => b.path)).toEqual(["b.ts"]);
    expect(dropReviewPath(blocks, "a.ts", { turnId: "2" }).map((b) => b.toolCallId)).toEqual(["1", "3"]);
  });

  it("dropReviewTurnsAfter keeps the surviving prefix", () => {
    const blocks = [
      block({ path: "a.ts", oldText: "a", newText: "b", turnId: "1" }),
      block({ path: "a.ts", oldText: "b", newText: "c", turnId: "2" }),
    ];
    expect(dropReviewTurnsAfter(blocks, 1).map((b) => b.turnId)).toEqual(["1"]);
  });

  it("completedBlocksForPath respects the turn scope", () => {
    const blocks = [
      block({ path: "a.ts", oldText: "a", newText: "b", turnId: "1", toolCallId: "1" }),
      block({ path: "a.ts", oldText: "b", newText: "c", turnId: "2", toolCallId: "2" }),
    ];
    expect(completedBlocksForPath(blocks, "a.ts", "session", "2")).toHaveLength(2);
    expect(completedBlocksForPath(blocks, "a.ts", "turn", "2")).toHaveLength(1);
  });
});
