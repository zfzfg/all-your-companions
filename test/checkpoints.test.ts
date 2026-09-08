/**
 * Pure checkpoint helpers (AP-08): restore planning, CRLF vs LF hashing,
 * retention caps, merge-across-turns, skip large/binary files.
 */
import { describe, expect, it } from "vitest";
import {
  CHECKPOINT_MAX_FILE_BYTES,
  capRetention,
  checkpointRelPath,
  classifySnapshotBytes,
  mergeCheckpoints,
  normalizeRelPath,
  planRestore,
  planRestoreDetailed,
  previewUserMessage,
  restoreActions,
  sha256Text,
  snapshotFromBytes,
  survivingAfterClientRewind,
  turnIdsToRestore,
  type Checkpoint,
  type CheckpointFile,
} from "../src/checkpoints";

function file(over: Partial<CheckpointFile> & Pick<CheckpointFile, "relPath" | "blob">): CheckpointFile {
  return {
    sha256: sha256Text(over.blob),
    existedBefore: over.existedBefore ?? true,
    ...over,
  };
}

function cp(over: Partial<Checkpoint> = {}): Checkpoint {
  return {
    id: "s:1",
    sessionId: "s",
    turnId: "1",
    createdAt: 1,
    userMessagePreview: "hello",
    files: [],
    skipped: [],
    bytes: 0,
    ...over,
  };
}

function current(entries: Record<string, string | null>): Map<string, string | null> {
  return new Map(Object.entries(entries));
}

describe("sha256Text / CRLF vs LF", () => {
  it("gives different hashes for CRLF and LF of the same letters", () => {
    const crlf = "line1\r\nline2\r\n";
    const lf = "line1\nline2\n";
    expect(sha256Text(crlf)).not.toBe(sha256Text(lf));
    expect(sha256Text(crlf)).toBe(sha256Text("line1\r\nline2\r\n"));
    expect(sha256Text(lf)).toBe(sha256Text("line1\nline2\n"));
  });

  it("is stable for a file that never had a trailing newline", () => {
    expect(sha256Text("no-nl")).toBe(sha256Text("no-nl"));
    expect(sha256Text("no-nl")).not.toBe(sha256Text("no-nl\n"));
  });
});

describe("snapshotFromBytes", () => {
  it("records a missing file as existedBefore: false with empty blob", () => {
    const cap = snapshotFromBytes("src/a.ts", null);
    expect(cap).toEqual({
      kind: "file",
      file: {
        relPath: "src/a.ts",
        sha256: sha256Text(""),
        blob: "",
        existedBefore: false,
      },
    });
  });

  it("keeps CRLF in the blob and in the hash", () => {
    const bytes = Buffer.from("a\r\nb\r\n", "utf8");
    const cap = snapshotFromBytes("win.txt", bytes);
    expect(cap.kind).toBe("file");
    if (cap.kind !== "file") return;
    expect(cap.file.blob).toBe("a\r\nb\r\n");
    expect(cap.file.sha256).toBe(sha256Text("a\r\nb\r\n"));
    expect(cap.file.existedBefore).toBe(true);
  });

  it("skips a NUL-containing buffer as binary", () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]);
    const cap = snapshotFromBytes("x.png", bytes);
    expect(cap).toEqual({
      kind: "skipped",
      skipped: { relPath: "x.png", reason: "binary", bytes: 6 },
    });
  });

  it("skips a buffer over the per-file ceiling without treating it as text", () => {
    const bytes = Buffer.alloc(CHECKPOINT_MAX_FILE_BYTES + 1, 65);
    const cap = snapshotFromBytes("big.bin", bytes);
    expect(cap.kind).toBe("skipped");
    if (cap.kind !== "skipped") return;
    expect(cap.skipped.reason).toBe("too-large");
    expect(cap.skipped.bytes).toBe(CHECKPOINT_MAX_FILE_BYTES + 1);
  });

  it("can skip from a size-only stat without reading the body", () => {
    const cap = snapshotFromBytes("huge.bin", null, { reportedBytes: CHECKPOINT_MAX_FILE_BYTES + 10 });
    expect(cap).toEqual({
      kind: "skipped",
      skipped: { relPath: "huge.bin", reason: "too-large", bytes: CHECKPOINT_MAX_FILE_BYTES + 10 },
    });
  });

  it("normalizes backslashes in the stored relPath", () => {
    const cap = snapshotFromBytes("src\\a.ts", Buffer.from("x"));
    expect(cap.kind).toBe("file");
    if (cap.kind !== "file") return;
    expect(cap.file.relPath).toBe("src/a.ts");
  });
});

describe("classifySnapshotBytes", () => {
  it("accepts ordinary UTF-8 text under the limit", () => {
    expect(classifySnapshotBytes(Buffer.from("hello\n"))).toBe("ok");
  });
});

describe("planRestore", () => {
  const before = file({ relPath: "src/a.ts", blob: "old\n", existedBefore: true, afterSha256: sha256Text("new\n") });

  it("restores when the disk still holds this turn's write", () => {
    const outcome = planRestore(cp({ files: [before] }), current({ "src/a.ts": "new\n" }));
    expect(outcome).toEqual({ kind: "restore", files: ["src/a.ts"] });
  });

  it("is nothing when the disk already matches the snapshot", () => {
    expect(planRestore(cp({ files: [before] }), current({ "src/a.ts": "old\n" }))).toEqual({ kind: "nothing" });
  });

  it("conflicts when a third party changed the file since the snapshot", () => {
    expect(planRestore(cp({ files: [before] }), current({ "src/a.ts": "foreign\n" }))).toEqual({
      kind: "conflict",
      changedSince: ["src/a.ts"],
    });
  });

  it("conflicts when the after-hash was never recorded and the file differs", () => {
    const noAfter = file({ relPath: "src/a.ts", blob: "old\n", existedBefore: true });
    expect(planRestore(cp({ files: [noAfter] }), current({ "src/a.ts": "new\n" }))).toEqual({
      kind: "conflict",
      changedSince: ["src/a.ts"],
    });
  });

  it("deletes a file this turn created when the after-hash still matches", () => {
    const created = file({
      relPath: "src/new.ts",
      blob: "",
      existedBefore: false,
      afterSha256: sha256Text("created\n"),
    });
    const plan = planRestoreDetailed(cp({ files: [created] }), current({ "src/new.ts": "created\n" }));
    expect(plan.deletes).toEqual(["src/new.ts"]);
    expect(planRestore(cp({ files: [created] }), current({ "src/new.ts": "created\n" }))).toEqual({
      kind: "restore",
      files: ["src/new.ts"],
    });
  });

  it("is nothing when a created file is already gone", () => {
    const created = file({ relPath: "src/new.ts", blob: "", existedBefore: false, afterSha256: sha256Text("x") });
    expect(planRestore(cp({ files: [created] }), current({ "src/new.ts": null }))).toEqual({ kind: "nothing" });
  });

  it("conflicts when a created file was edited after the turn", () => {
    const created = file({
      relPath: "src/new.ts",
      blob: "",
      existedBefore: false,
      afterSha256: sha256Text("created\n"),
    });
    expect(planRestore(cp({ files: [created] }), current({ "src/new.ts": "user-edit\n" }))).toEqual({
      kind: "conflict",
      changedSince: ["src/new.ts"],
    });
  });

  it("recreates a deleted pre-existing file when we never saw the after-hash", () => {
    const f = file({ relPath: "src/a.ts", blob: "old\n", existedBefore: true });
    const plan = planRestoreDetailed(cp({ files: [f] }), current({ "src/a.ts": null }));
    expect(plan.writes).toEqual([{ relPath: "src/a.ts", blob: "old\n" }]);
  });

  it("conflicts when a file we wrote was later deleted (after-hash known)", () => {
    expect(planRestore(cp({ files: [before] }), current({ "src/a.ts": null }))).toEqual({
      kind: "conflict",
      changedSince: ["src/a.ts"],
    });
  });

  it("a disabled checkpoint restores nothing", () => {
    expect(planRestore(cp({ files: [before], disabled: true }), current({ "src/a.ts": "new\n" }))).toEqual({
      kind: "nothing",
    });
  });

  it("CRLF snapshot restores only against the same line endings", () => {
    const win = file({
      relPath: "a.txt",
      blob: "a\r\nb\r\n",
      existedBefore: true,
      afterSha256: sha256Text("A\r\nB\r\n"),
    });
    expect(planRestore(cp({ files: [win] }), current({ "a.txt": "A\r\nB\r\n" }))).toEqual({
      kind: "restore",
      files: ["a.txt"],
    });
    expect(planRestore(cp({ files: [win] }), current({ "a.txt": "A\nB\n" }))).toEqual({
      kind: "conflict",
      changedSince: ["a.txt"],
    });
  });
});

describe("restoreActions overwrite", () => {
  it("includes conflict files only when overwriteConflicts is set", () => {
    const f = file({ relPath: "src/a.ts", blob: "old\n", existedBefore: true, afterSha256: sha256Text("new\n") });
    const checkpoint = cp({ files: [f] });
    const plan = planRestoreDetailed(checkpoint, current({ "src/a.ts": "foreign\n" }));
    expect(restoreActions(plan, false, checkpoint).writes).toEqual([]);
    expect(restoreActions(plan, true, checkpoint).writes).toEqual([{ relPath: "src/a.ts", blob: "old\n" }]);
  });

  it("overwrite of a foreign-edited create deletes the file", () => {
    const f = file({ relPath: "n.ts", blob: "", existedBefore: false, afterSha256: sha256Text("x") });
    const checkpoint = cp({ files: [f] });
    const plan = planRestoreDetailed(checkpoint, current({ "n.ts": "foreign" }));
    expect(restoreActions(plan, true, checkpoint).deletes).toEqual(["n.ts"]);
  });
});

describe("mergeCheckpoints", () => {
  it("keeps the oldest before-image and the newest after-hash", () => {
    const t1 = cp({
      turnId: "1",
      files: [file({ relPath: "a.ts", blob: "v0\n", existedBefore: true, afterSha256: sha256Text("v1\n") })],
    });
    const t2 = cp({
      turnId: "2",
      files: [file({ relPath: "a.ts", blob: "v1\n", existedBefore: true, afterSha256: sha256Text("v2\n") })],
    });
    const t3 = cp({
      turnId: "3",
      files: [file({ relPath: "b.ts", blob: "b0\n", existedBefore: true, afterSha256: sha256Text("b1\n") })],
    });
    const merged = mergeCheckpoints([t1, t2, t3]);
    expect(merged.files).toEqual([
      file({ relPath: "a.ts", blob: "v0\n", existedBefore: true, afterSha256: sha256Text("v2\n") }),
      file({ relPath: "b.ts", blob: "b0\n", existedBefore: true, afterSha256: sha256Text("b1\n") }),
    ]);
  });

  it("skips disabled turns", () => {
    const t1 = cp({ turnId: "1", files: [file({ relPath: "a.ts", blob: "v0\n" })], disabled: true });
    const t2 = cp({ turnId: "2", files: [file({ relPath: "b.ts", blob: "b0\n" })] });
    expect(mergeCheckpoints([t1, t2]).files.map((f) => f.relPath)).toEqual(["b.ts"]);
  });
});

describe("capRetention", () => {
  it("drops the oldest turns when the count cap is hit", () => {
    const existing = [1, 2, 3].map((n) => ({ turnId: String(n), bytes: 10 }));
    expect(capRetention(existing, 10, 3, 10_000).map((t) => t.turnId)).toEqual(["1"]);
  });

  it("drops oldest-first when the byte cap is hit, even under the turn cap", () => {
    const existing = [
      { turnId: "1", bytes: 80 },
      { turnId: "2", bytes: 80 },
    ];
    expect(capRetention(existing, 80, 20, 200).map((t) => t.turnId)).toEqual(["1"]);
  });

  it("may drop several turns to get under the byte cap", () => {
    const existing = [1, 2, 3, 4].map((n) => ({ turnId: String(n), bytes: 80 }));
    expect(capRetention(existing, 80, 20, 200).map((t) => t.turnId)).toEqual(["1", "2", "3"]);
  });

  it("drops nothing when both caps have room", () => {
    expect(capRetention([{ turnId: "1", bytes: 10 }], 10, 20, 200)).toEqual([]);
  });
});

describe("turn mapping", () => {
  it("maps a bubble index to surviving user messages (target is discarded)", () => {
    expect(survivingAfterClientRewind(0)).toBe(0);
    expect(survivingAfterClientRewind(2)).toBe(2);
    expect(survivingAfterClientRewind(-1)).toBe(0);
  });

  it("selects turn ids strictly after the surviving count", () => {
    expect(turnIdsToRestore(1, ["1", "3", "2", "nope"])).toEqual(["2", "3"]);
    expect(turnIdsToRestore(3, ["1", "2", "3"])).toEqual([]);
  });
});

describe("path helpers", () => {
  it("relativizes under the workspace and rejects escapes", () => {
    expect(checkpointRelPath("/repo/src/a.ts", "/repo")).toBe("src/a.ts");
    expect(checkpointRelPath("/repo/../etc/passwd", "/repo")).toBeUndefined();
    expect(checkpointRelPath("/elsewhere/a.ts", "/repo")).toBeUndefined();
  });

  it("normalizeRelPath collapses backslashes", () => {
    expect(normalizeRelPath("src\\foo\\bar.ts")).toBe("src/foo/bar.ts");
  });
});

describe("previewUserMessage", () => {
  it("collapses whitespace and caps length", () => {
    expect(previewUserMessage("  hello   world  ")).toBe("hello world");
    expect(previewUserMessage("x".repeat(100)).length).toBe(80);
    expect(previewUserMessage("x".repeat(100)).endsWith("…")).toBe(true);
  });
});
