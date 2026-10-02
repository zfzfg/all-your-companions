import { describe, expect, it } from "vitest";
import { computeLineDiff } from "../src/shared/line-diff";
import { aggregateReviewChanges, ingestReviewToolCall, type ReviewDiffBlock } from "../src/review-center";

const block = (before: string, after: string, turnId: string, id: string): ReviewDiffBlock => ({
  path: "a.ts", oldText: before, newText: after, sites: [], toolCallId: id, turnId, status: "completed",
  reviewBefore: { text: before, existed: true, source: "git" }, reviewAfter: { text: after, existed: true },
});
describe("large and net review regressions", () => {
  it.each([6000, 11000])("counts sparse edits in a %i-line file", size => {
    const before = Array.from({ length: size }, (_, i) => `line ${i}`);
    const after = [...before]; after[1] = "changed first"; after[size - 2] = "changed last";
    const result = computeLineDiff(before.join("\n"), after.join("\n"));
    expect(result).toMatchObject({ added: 2, removed: 2, countsKnown: true, truncated: false });
    expect(result.lines.filter(line => line.type !== "add").map(line => line.text)).toEqual(before);
    expect(result.lines.filter(line => line.type !== "del").map(line => line.text)).toEqual(after);
  });
  it("retains native multiple-site context and normalizes CRLF", () => {
    expect(computeLineDiff("a\r\nb\r\n", "a\nb\n")).toMatchObject({ added: 0, removed: 0 });
  });
  it("compares each scope with its own baseline and drops a completely undone file", () => {
    const first = block("before", "middle", "1", "a"), last = block("middle", "after", "2", "b");
    const row = aggregateReviewChanges([first, last], { currentTurnId: "2" }).files[0];
    expect(row.diff).toMatchObject({ oldText: "before", newText: "after", net: true });
    expect(row.turnDiff).toMatchObject({ oldText: "middle", newText: "after", net: true });
    expect(row.added).toBe(1);
    expect(aggregateReviewChanges([first, block("middle", "before", "1", "b")], { currentTurnId: "1" }).files).toEqual([]);
  });
  it("does not interpret a missing previous Write body as file creation", () => {
    const blocks = ingestReviewToolCall([], { toolCallId: "w", status: "completed", content: [{ type: "diff", path: "a", oldText: null, newText: "body" }] }, "1");
    expect(aggregateReviewChanges(blocks).files[0]).toMatchObject({ countsKnown: false, netAvailable: false });
  });
  it("keeps update order and retains other file blocks when a native update arrives late", () => {
    const call = (id: string, path: string, oldText: string, newText: string) => ({ toolCallId: id, status: "completed",
      content: [{ type: "diff", path, oldText, newText }] });
    let blocks = ingestReviewToolCall([], call("first", "a", "a", "b"), "1");
    blocks = ingestReviewToolCall(blocks, call("second", "a", "b", "c"), "1");
    blocks = ingestReviewToolCall(blocks, call("first", "a", "a", "b"), "2");
    expect(blocks.map(b => [b.toolCallId, b.turnId])).toEqual([["first", "1"], ["second", "1"]]);
    expect(aggregateReviewChanges(blocks).files[0].diff.newText).toBe("c");
    blocks = ingestReviewToolCall(blocks, call("first", "other", "x", "y"), "2");
    expect(blocks.filter(b => b.toolCallId === "first")).toHaveLength(2);
  });
  it("shows unknown net counts for disconnected historical fragments", () => {
    const a = block("a", "b", "1", "a"), b = block("x", "y", "1", "b");
    delete a.reviewBefore; delete a.reviewAfter; delete b.reviewBefore; delete b.reviewAfter;
    expect(aggregateReviewChanges([a, b]).files[0]).toMatchObject({ countsKnown: false, netAvailable: false });
  });
  it("agrees with an independent LCS length on small repeated-line inputs", () => {
    let seed = 17;
    const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
    for (let run = 0; run < 100; run++) {
      const a = Array.from({ length: next() % 12 + 1 }, () => String(next() % 4));
      const b = Array.from({ length: next() % 12 + 1 }, () => String(next() % 4));
      const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
      for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      const result = computeLineDiff(a.join("\n"), b.join("\n"));
      expect(result.added).toBe(b.length - dp[0][0]); expect(result.removed).toBe(a.length - dp[0][0]);
    }
  });
});
