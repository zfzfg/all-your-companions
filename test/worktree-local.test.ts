/**
 * Pure half of AP-13a: porcelain → WorktreeRecord, name-status → apply rows,
 * and the per-file conflict rule. No git binary, no disk.
 */
import { describe, expect, it } from "vitest";
import { parseGitWorktreeList, parseGitWorktreeListPorcelain } from "../src/worktree";
import { decideLocalApplyFile, planLocalApply } from "../src/worktree-local";

const enc = (s: string) => new TextEncoder().encode(s);

describe("parseGitWorktreeList", () => {
  it("parses linked, detached, prunable and bare records from porcelain", () => {
    const porcelain = [
      "worktree /repos/app",
      "HEAD abcdef",
      "branch refs/heads/main",
      "",
      "worktree /home/u/.grok/worktrees/app/feat",
      "HEAD 123456",
      "branch refs/heads/companions/feat",
      "",
      "worktree /home/u/.grok/worktrees/app/old",
      "HEAD deadbee",
      "detached",
      "prunable",
      "",
      "worktree /repos/bare.git",
      "bare",
      "",
    ].join("\n");
    const records = parseGitWorktreeList(porcelain);
    expect(records).toHaveLength(4);
    expect(records[0]).toMatchObject({
      path: "/repos/app",
      gitRef: "main",
      headCommit: "abcdef",
      creationMode: "linked",
      status: "alive",
      kind: "session",
      label: "app",
    });
    expect(records[1]).toMatchObject({
      path: "/home/u/.grok/worktrees/app/feat",
      gitRef: "companions/feat",
      creationMode: "linked",
      status: "alive",
      label: "feat",
    });
    expect(records[2]).toMatchObject({
      path: "/home/u/.grok/worktrees/app/old",
      gitRef: "HEAD",
      status: "prunable",
    });
    expect(records[3]).toMatchObject({
      path: "/repos/bare.git",
      kind: "bare",
      creationMode: "linked",
    });
  });

  it("keeps paths with spaces and Windows drive letters; accepts CRLF", () => {
    const porcelain = [
      "worktree C:\\Users\\me\\My Project",
      "HEAD aa",
      "branch refs/heads/main",
      "",
      'worktree "D:/work/quoted path"',
      "HEAD bb",
      "detached",
      "",
    ].join("\r\n");
    const records = parseGitWorktreeList(porcelain);
    expect(records.map((r) => r.path)).toEqual([
      "C:\\Users\\me\\My Project",
      "D:/work/quoted path",
    ]);
    expect(parseGitWorktreeListPorcelain(porcelain)).toEqual(records.map((r) => r.path));
  });

  it("returns [] for empty, null-like, and unknown enum noise", () => {
    expect(parseGitWorktreeList("")).toEqual([]);
    expect(parseGitWorktreeList("locked\n")).toEqual([]);
    expect(parseGitWorktreeList(null as unknown as string)).toEqual([]);
  });

  it("never claims clone mode — local git can only be linked (18.8)", () => {
    for (const rec of parseGitWorktreeList("worktree /x\nHEAD a\nbranch refs/heads/x\n")) {
      expect(rec.creationMode).toBe("linked");
    }
  });
});

describe("planLocalApply", () => {
  it("maps name-status rows, including renames as delete+add", () => {
    const status = [
      "M\tsrc/a.ts",
      "A\tsrc/new.ts",
      "D\told.ts",
      "R100\tfrom.ts\tto.ts",
    ].join("\n");
    expect(planLocalApply(status)).toEqual([
      { path: "src/a.ts", type: "modified", additions: 0, deletions: 0 },
      { path: "src/new.ts", type: "added", additions: 0, deletions: 0 },
      { path: "old.ts", type: "deleted", additions: 0, deletions: 0 },
      { path: "from.ts", type: "deleted", additions: 0, deletions: 0 },
      { path: "to.ts", type: "added", additions: 0, deletions: 0 },
    ]);
  });

  it("accepts CRLF and drops empty / unknown lines", () => {
    expect(planLocalApply("M\ta.ts\r\n\r\n??\tskip-me\r\n")).toEqual([
      { path: "a.ts", type: "modified", additions: 0, deletions: 0 },
    ]);
    expect(planLocalApply("")).toEqual([]);
    expect(planLocalApply(null as unknown as string)).toEqual([]);
  });
});

describe("decideLocalApplyFile", () => {
  it("writes when the source is still at the merge-base", () => {
    expect(decideLocalApplyFile({
      base: enc("old\n"),
      worktree: enc("new\n"),
      current: enc("old\n"),
    })).toBe("write");
  });

  it("skips when the source already matches the worktree", () => {
    expect(decideLocalApplyFile({
      base: enc("old\n"),
      worktree: enc("new\n"),
      current: enc("new\n"),
    })).toBe("skip");
  });

  it("conflicts when the source changed since the branch point — no silent write", () => {
    expect(decideLocalApplyFile({
      base: enc("old\n"),
      worktree: enc("new\n"),
      current: enc("foreign\n"),
    })).toBe("conflict");
  });

  it("treats a missing current and missing base as a create, a missing worktree as a delete", () => {
    expect(decideLocalApplyFile({ base: null, worktree: enc("x"), current: null })).toBe("write");
    expect(decideLocalApplyFile({ base: enc("x"), worktree: null, current: enc("x") })).toBe("delete");
    expect(decideLocalApplyFile({ base: enc("x"), worktree: null, current: enc("y") })).toBe("conflict");
    expect(decideLocalApplyFile({ base: enc("x"), worktree: null, current: null })).toBe("skip");
  });

  it("does not normalise CRLF — 'a\\r\\nb' and 'a\\nb' are different files", () => {
    expect(decideLocalApplyFile({
      base: enc("a\nb"),
      worktree: enc("a\r\nb"),
      current: enc("a\nb"),
    })).toBe("write");
    expect(decideLocalApplyFile({
      base: enc("a\nb"),
      worktree: enc("changed"),
      current: enc("a\r\nb"),
    })).toBe("conflict");
  });
});
