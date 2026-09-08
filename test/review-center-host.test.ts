/**
 * AP-09 host wiring: ingest diffs, emit the snapshot, discard-all via the
 * AP-08 checkpoint (not N sequential reverts).
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session, sessionUiSnapshot } from "../src/session";
import { CheckpointStore } from "../src/checkpoint-store";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function harness() {
  const workspace = tempDir("rc-ws-");
  const storeRoot = tempDir("rc-store-");
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "a.ts"), "before-a\n", "utf8");
  writeFileSync(join(workspace, "src", "b.ts"), "before-b\n", "utf8");

  const posted: unknown[] = [];
  const sidebar: any = Object.create(GrokSidebar.prototype);
  sidebar.checkpointStore = new CheckpointStore({
    root: storeRoot,
    fs: {
      mkdirSync: (p: string, o: { recursive: true }) => mkdirSync(p, o),
      writeFileSync: (p: string, d: Uint8Array | string) => writeFileSync(p, d),
      readFileSync: (p: string) => readFileSync(p),
      readdirSync: (p: string) => require("node:fs").readdirSync(p),
      existsSync: (p: string) => require("node:fs").existsSync(p),
      statSync: (p: string) => require("node:fs").statSync(p),
      rmSync: (p: string, o: { recursive: boolean; force: boolean }) => rmSync(p, o),
    },
    now: () => 1,
  });
  sidebar.emit = (_s: Session, m: unknown) => { posted.push(m); };
  sidebar.setStatus = () => {};
  sidebar.sessionCwd = () => workspace;
  sidebar.state = { get: () => ({}), update: async () => {} };
  sidebar.host = {
    appendLine: () => {},
    showQuickPick: async () => undefined,
    showWarningMessage: async () => undefined,
  };
  sidebar.confirmInChat = async () => true;

  const session = new Session();
  session.activeSessionId = "sess-1";
  session.userMessageCount = 1;
  session.cwd = workspace;
  session.status = "done";
  return { sidebar, session, posted, workspace };
}

const editCall = (id: string, path: string, oldText: string, newText: string, status = "completed") => ({
  toolCallId: id,
  status,
  content: [{ type: "diff", path, oldText, newText }],
});

describe("noteReviewToolCall", () => {
  it("emits a path-deduped reviewCenter snapshot as diffs land", () => {
    const h = harness();
    h.sidebar.noteReviewToolCall(h.session, editCall("e1", "src/a.ts", "before-a\n", "after-a\n"));
    h.sidebar.noteReviewToolCall(h.session, editCall("e2", "src/a.ts", "after-a\n", "after-a2\n"));
    h.sidebar.noteReviewToolCall(h.session, editCall("e3", "src/b.ts", "before-b\n", "after-b\n"));

    const snaps = h.posted.filter((m: any) => m.type === "reviewCenter") as any[];
    expect(snaps.length).toBeGreaterThan(0);
    const last = snaps[snaps.length - 1];
    expect(last.files.map((f: any) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(last.currentTurnId).toBe("1");
    expect(h.session.reviewBlocks).toHaveLength(3);
  });

  it("does not emit for a call with no useful diff", () => {
    const h = harness();
    h.sidebar.noteReviewToolCall(h.session, { toolCallId: "x", status: "completed", content: [] });
    expect(h.posted.filter((m: any) => m.type === "reviewCenter")).toEqual([]);
  });

  it("sessionUiSnapshot carries the list only when there are files", () => {
    const h = harness();
    expect(sessionUiSnapshot(h.session, "agent").some((m) => m.type === "reviewCenter")).toBe(false);
    h.sidebar.noteReviewToolCall(h.session, editCall("e1", "src/a.ts", "a", "b"));
    expect(sessionUiSnapshot(h.session, "agent")).toContainEqual(
      expect.objectContaining({ type: "reviewCenter", currentTurnId: "1" }),
    );
  });
});

describe("reviewRevertAll uses the checkpoint, not N reverts", () => {
  it("restores both files from the snapshot and does not truncate the conversation", async () => {
    const h = harness();
    h.sidebar.beginCheckpointTurn(h.session, "edit both");
    h.sidebar.snapshotRelOrAbsPaths(h.session, ["src/a.ts", "src/b.ts"], h.workspace);
    writeFileSync(join(h.workspace, "src", "a.ts"), "after-a\n");
    writeFileSync(join(h.workspace, "src", "b.ts"), "after-b\n");
    h.sidebar.noteCheckpointAfterContent(h.session, join(h.workspace, "src", "a.ts"), "after-a\n");
    h.sidebar.noteCheckpointAfterContent(h.session, join(h.workspace, "src", "b.ts"), "after-b\n");
    h.sidebar.finishCheckpointTurn(h.session);
    h.sidebar.noteReviewToolCall(h.session, editCall("e1", "src/a.ts", "before-a\n", "after-a\n"));
    h.sidebar.noteReviewToolCall(h.session, editCall("e2", "src/b.ts", "before-b\n", "after-b\n"));
    h.session.userMessageCount = 1;

    await h.sidebar.reviewRevertAll(h.session, "turn");

    expect(readFileSync(join(h.workspace, "src", "a.ts"), "utf8")).toBe("before-a\n");
    expect(readFileSync(join(h.workspace, "src", "b.ts"), "utf8")).toBe("before-b\n");
    expect(h.session.userMessageCount).toBe(1);
    expect(h.session.reviewBlocks).toEqual([]);
    const last = [...h.posted].reverse().find((m: any) => m.type === "reviewCenter") as any;
    expect(last.files).toEqual([]);
  });

  it("a cancelled conflict leaves every file untouched — no half-state", async () => {
    const h = harness();
    h.sidebar.beginCheckpointTurn(h.session, "edit both");
    h.sidebar.snapshotRelOrAbsPaths(h.session, ["src/a.ts", "src/b.ts"], h.workspace);
    writeFileSync(join(h.workspace, "src", "a.ts"), "after-a\n");
    writeFileSync(join(h.workspace, "src", "b.ts"), "after-b\n");
    h.sidebar.noteCheckpointAfterContent(h.session, join(h.workspace, "src", "a.ts"), "after-a\n");
    h.sidebar.noteCheckpointAfterContent(h.session, join(h.workspace, "src", "b.ts"), "after-b\n");
    h.sidebar.finishCheckpointTurn(h.session);
    writeFileSync(join(h.workspace, "src", "a.ts"), "foreign-a\n");
    writeFileSync(join(h.workspace, "src", "b.ts"), "foreign-b\n");
    let confirms = 0;
    h.sidebar.confirmInChat = async () => {
      confirms++;
      return confirms === 1; // first (discard?) yes, second (overwrite) no
    };

    await h.sidebar.reviewRevertAll(h.session, "turn");

    expect(readFileSync(join(h.workspace, "src", "a.ts"), "utf8")).toBe("foreign-a\n");
    expect(readFileSync(join(h.workspace, "src", "b.ts"), "utf8")).toBe("foreign-b\n");
  });

  it("refuses to discard all when there is no checkpoint rather than walking files", async () => {
    const h = harness();
    h.sidebar.noteReviewToolCall(h.session, editCall("e1", "src/a.ts", "a", "b"));
    await h.sidebar.reviewRevertAll(h.session, "turn");
    expect(h.posted.some((m: any) => m.type === "hostNotice" && /no checkpoint/.test(m.text))).toBe(true);
    expect(readFileSync(join(h.workspace, "src", "a.ts"), "utf8")).toBe("before-a\n");
  });
});
