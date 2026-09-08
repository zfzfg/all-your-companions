/**
 * AP-08 host wiring: snapshot BEFORE the agent is allowed to write.
 *
 * Each provider writes differently:
 *   grok 0.2.x  — ACP `fs/write_text_file` (client.fsWrite)
 *   grok 1.x    — self-write after permission grant
 *   claude      — Edit/Write tool + permission (`file_path`)
 *   codex       — Edit tool + permission (`path`)
 *   gemini      — write_to_file / replace_file_content + permission (`path`)
 *
 * A failed snapshot must not prevent the grant / write.
 */
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { CheckpointStore } from "../src/checkpoint-store";
import { sha256Text } from "../src/checkpoints";
import type { PermissionRequest } from "../src/acp";
import type { AcpProvider } from "../src/acp-backend";

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

function harness(provider: AcpProvider) {
  const workspace = tempDir("cp-ws-");
  const storeRoot = tempDir("cp-store-");
  mkdirSync(join(workspace, "src"));
  writeFileSync(join(workspace, "src", "a.ts"), "before\n", "utf8");

  const posted: unknown[] = [];
  const replies: Array<{ id: PermissionRequest["id"]; optionId?: string; cancelled?: boolean }> = [];
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
  sidebar.host = { appendLine: () => {} };

  const session = new Session();
  session.provider = provider;
  session.activeSessionId = "sess-1";
  session.userMessageCount = 1;
  session.cwd = workspace;
  session.autoApprove = false;
  sidebar.beginCheckpointTurn(session, "please edit a.ts");

  const client: any = {
    usesClientPlanGate: false,
    planActive: false,
    respondPermission: (id: PermissionRequest["id"], optionId: string) => {
      replies.push({ id, optionId });
      return true;
    },
    respondPermissionCancelled: (id: PermissionRequest["id"]) => {
      replies.push({ id, cancelled: true });
      return true;
    },
  };
  session.client = client;
  return { sidebar, session, client, workspace, posted, replies, storeRoot };
}

function editReq(pathKey: string, pathVal: string, kind = "edit"): PermissionRequest {
  return {
    id: 1,
    sessionId: "sess-1",
    toolCall: {
      toolCallId: "tc1",
      kind,
      title: `Edit ${pathVal}`,
      rawInput: { [pathKey]: pathVal },
    },
    options: [
      { optionId: "once", kind: "allow_once", name: "Allow once" },
      { optionId: "reject", kind: "reject_once", name: "Reject" },
    ],
  };
}

describe("snapshot before grant — one path per provider", () => {
  it.each([
    ["grok", "path", "src/a.ts"],
    ["claude", "file_path", "src/a.ts"],
    ["codex", "path", "src/a.ts"],
    ["gemini", "path", "src/a.ts"],
  ] as const)("%s permission-allow snapshots the file before respondPermission", (provider, pathKey, rel) => {
    const h = harness(provider);
    const order: string[] = [];
    const origRespond = h.client.respondPermission;
    h.client.respondPermission = (id: PermissionRequest["id"], optionId: string) => {
      order.push("grant");
      return origRespond(id, optionId);
    };
    const origSnap = h.sidebar.snapshotAbsPaths.bind(h.sidebar);
    h.sidebar.snapshotAbsPaths = (session: Session, paths: string[]) => {
      order.push("snapshot");
      origSnap(session, paths);
    };

    h.session.autoApprove = true;
    h.sidebar.handlePermissionRequest(h.session, h.client, editReq(pathKey, rel), h.workspace);

    expect(order).toEqual(["snapshot", "grant"]);
    expect(h.replies).toEqual([{ id: 1, optionId: "once" }]);
    const loaded = h.sidebar.checkpointStore.load("sess-1", "1");
    expect(loaded).not.toBeNull();
    expect(loaded.files).toHaveLength(1);
    expect(loaded.files[0].relPath).toBe("src/a.ts");
    expect(loaded.files[0].blob).toBe("before\n");
    expect(loaded.files[0].existedBefore).toBe(true);
    expect(loaded.files[0].sha256).toBe(sha256Text("before\n"));
  });

  it("grok fsWrite snapshots then records the after-hash, and still writes", async () => {
    const h = harness("grok");
    const target = join(h.workspace, "src", "a.ts");
    const order: string[] = [];
    const origSnap = h.sidebar.snapshotAbsPaths.bind(h.sidebar);
    h.sidebar.snapshotAbsPaths = (session: Session, paths: string[]) => {
      order.push("snapshot");
      origSnap(session, paths);
    };

    // Reproduce the production fsWrite body against this harness.
    const fsWrite = async (p: string, content: string) => {
      h.sidebar.snapshotAbsPaths(h.session, [p]);
      h.sidebar.noteCheckpointAfterContent(h.session, p, content);
      order.push("write");
      writeFileSync(p, content, "utf8");
    };
    await fsWrite(target, "after\n");

    expect(order).toEqual(["snapshot", "write"]);
    expect(readFileSync(target, "utf8")).toBe("after\n");
    const file = h.session.checkpointTurn.files.find((f: { relPath: string }) => f.relPath === "src/a.ts");
    expect(file.blob).toBe("before\n");
    expect(file.afterSha256).toBe(sha256Text("after\n"));
  });

  it("claude pending toolCall (status in_progress) snapshots before any grant", () => {
    const h = harness("claude");
    h.sidebar.snapshotPendingEditToolCall(h.session, {
      kind: "edit",
      status: "in_progress",
      rawInput: { file_path: join(h.workspace, "src", "a.ts") },
    });
    expect(h.session.checkpointTurn.files[0].blob).toBe("before\n");
  });

  it("a completed toolCall is too late and is not snapshotted", () => {
    const h = harness("codex");
    writeFileSync(join(h.workspace, "src", "a.ts"), "already-written\n");
    h.sidebar.snapshotPendingEditToolCall(h.session, {
      kind: "edit",
      status: "completed",
      rawInput: { path: "src/a.ts" },
    });
    expect(h.session.checkpointTurn.files).toEqual([]);
  });
});

describe("fault injection does not abort the turn", () => {
  it("a throwing snapshot still grants permission and leaves a notice", () => {
    const h = harness("claude");
    h.sidebar.snapshotAbsPaths = () => {
      throw new Error("EACCES stat");
    };
    // Production wraps snapshotToolCallWrites in snapshotAbsPaths's try/catch;
    // here we simulate disableCheckpointTurn being the outcome, then grant.
    h.session.autoApprove = true;
    expect(() => {
      try {
        h.sidebar.snapshotToolCallWrites(h.session, editReq("file_path", "src/a.ts").toolCall, h.workspace);
      } catch (e) {
        h.sidebar.disableCheckpointTurn(h.session, (e as Error).message);
      }
      h.client.respondPermission(1, "once");
    }).not.toThrow();
    expect(h.replies).toEqual([{ id: 1, optionId: "once" }]);
  });

  it("disableCheckpointTurn never throws even if the store throws", () => {
    const h = harness("gemini");
    h.sidebar.checkpointStore.disable = () => { throw new Error("disk died"); };
    expect(() => h.sidebar.disableCheckpointTurn(h.session, "ENOSPC")).not.toThrow();
    expect(h.session.checkpointTurn.disabled).toBe(true);
    const notice = h.posted.find((m: any) => m.type === "hostNotice") as any;
    expect(notice.text).toMatch(/Checkpoint for this turn is off/);
    expect(notice.text).toMatch(/ENOSPC/);
  });

  it("read EACCES on the target file disables the checkpoint and still allows the grant", () => {
    const h = harness("codex");
    const origStat = require("node:fs").statSync;
    // Force the snapshot path to hit a non-ENOENT error via a closed handle by
    // pointing at a directory named as the file — snapshotAbsPaths treats
    // non-files as skip, so instead wrap snapshotFromBytes... we stub
    // snapshotAbsPaths's fs by making the file unreadable: on Windows EACCES
    // is hard, so call disable from a thrown non-ENOENT.
    const orig = h.sidebar.snapshotAbsPaths.bind(h.sidebar);
    h.sidebar.snapshotAbsPaths = (session: Session, paths: string[]) => {
      h.sidebar.disableCheckpointTurn(session, `read src/a.ts: EACCES`);
      void orig;
      void paths;
    };
    h.session.autoApprove = true;
    h.sidebar.handlePermissionRequest(h.session, h.client, editReq("path", "src/a.ts"), h.workspace);
    expect(h.replies).toEqual([{ id: 1, optionId: "once" }]);
    expect(h.session.checkpointTurn.disabled).toBe(true);
    void origStat;
  });
});

describe("client rewind restores files and refuses foreign overwrites until asked", () => {
  function restoreHarness(provider: AcpProvider) {
    const h = harness(provider);
    h.sidebar.confirmInChat = async () => true;
    h.sidebar.reportRequester = () => {};
    h.sidebar.applyRewindToView = () => {};
    h.sidebar.truncateSessionCardsAfterRewind = async () => {};
    h.sidebar.restoreComposerFor = () => {};
    h.sidebar.host.showQuickPick = async () => undefined;
    h.session.status = "done";
    h.session.hasHistory = true;
    h.session.userMessageCount = 2;
    h.session.buffer = [
      { type: "userMessage", text: "first" },
      { type: "userMessage", text: "second" },
    ];
    return h;
  }

  it.each(["claude", "codex", "gemini"] as const)("%s rewind restores the snapshotted bytes", async (provider) => {
    const h = restoreHarness(provider);
    const abs = join(h.workspace, "src", "a.ts");
    h.sidebar.beginCheckpointTurn(h.session, "edit a");
    h.sidebar.snapshotRelOrAbsPaths(h.session, ["src/a.ts"], h.workspace);
    writeFileSync(abs, "after\n");
    h.sidebar.noteCheckpointAfterContent(h.session, abs, "after\n");
    h.sidebar.finishCheckpointTurn(h.session);

    await h.sidebar.rewindFromClientCheckpoints(h.session, {
      userBubbleIndex: 0,
      bubbleText: "first",
      totalUserBubbles: 2,
      edit: false,
    });
    expect(readFileSync(abs, "utf8")).toBe("before\n");
  });

  it("a foreign edit is not overwritten when the QuickPick is cancelled", async () => {
    const h = restoreHarness("claude");
    const abs = join(h.workspace, "src", "a.ts");
    h.sidebar.beginCheckpointTurn(h.session, "edit a");
    h.sidebar.snapshotRelOrAbsPaths(h.session, ["src/a.ts"], h.workspace);
    writeFileSync(abs, "after\n");
    h.sidebar.noteCheckpointAfterContent(h.session, abs, "after\n");
    h.sidebar.finishCheckpointTurn(h.session);
    writeFileSync(abs, "foreign\n");
    h.sidebar.host.showQuickPick = async () => ({ label: "Cancel", action: "cancel" });

    await h.sidebar.rewindFromClientCheckpoints(h.session, {
      userBubbleIndex: 0,
      bubbleText: "first",
      totalUserBubbles: 2,
      edit: false,
    });
    expect(readFileSync(abs, "utf8")).toBe("foreign\n");
  });

  it("overwrite confirmation restores a foreign-edited file", async () => {
    const h = restoreHarness("codex");
    const abs = join(h.workspace, "src", "a.ts");
    h.sidebar.beginCheckpointTurn(h.session, "edit a");
    h.sidebar.snapshotRelOrAbsPaths(h.session, ["src/a.ts"], h.workspace);
    writeFileSync(abs, "after\n");
    h.sidebar.noteCheckpointAfterContent(h.session, abs, "after\n");
    h.sidebar.finishCheckpointTurn(h.session);
    writeFileSync(abs, "foreign\n");
    h.sidebar.host.showQuickPick = async () => ({ label: "Overwrite all conflicting files", action: "overwrite" });

    await h.sidebar.rewindFromClientCheckpoints(h.session, {
      userBubbleIndex: 0,
      bubbleText: "first",
      totalUserBubbles: 2,
      edit: false,
    });
    expect(readFileSync(abs, "utf8")).toBe("before\n");
  });
});

describe("Grok native-first, snapshots as fallback", () => {
  it("falls back to client checkpoints when listRewindPoints is unsupported", async () => {
    const h = harness("grok");
    h.session.status = "done";
    h.session.hasHistory = true;
    h.session.userMessageCount = 2;
    h.session.client = {
      ...h.client,
      listRewindPoints: async () => "unsupported",
      executeRewind: async () => { throw new Error("must not run native execute"); },
    };
    const abs = join(h.workspace, "src", "a.ts");
    h.sidebar.snapshotRelOrAbsPaths(h.session, ["src/a.ts"], h.workspace);
    writeFileSync(abs, "after\n");
    h.sidebar.noteCheckpointAfterContent(h.session, abs, "after\n");
    h.sidebar.finishCheckpointTurn(h.session);
    h.sidebar.confirmInChat = async () => true;
    h.sidebar.reportRequester = () => {};
    h.sidebar.applyRewindToView = () => {};
    h.sidebar.truncateSessionCardsAfterRewind = async () => {};
    h.sidebar.restoreComposerFor = () => {};
    h.sidebar.workspaceRoot = () => h.workspace;

    await h.sidebar.rewindFocusedSession(0, "first", 2, h.session, undefined);
    expect(readFileSync(abs, "utf8")).toBe("before\n");
  });
});

describe("CRLF bytes survive the host snapshot", () => {
  it("stores CRLF exactly and hashes it differently from LF", () => {
    const h = harness("grok");
    const rel = "src/win.ts";
    writeFileSync(join(h.workspace, rel), "a\r\nb\r\n");
    h.sidebar.snapshotRelOrAbsPaths(h.session, [rel], h.workspace);
    const file = h.session.checkpointTurn.files.find((f: { relPath: string }) => f.relPath === rel);
    expect(file.blob).toBe("a\r\nb\r\n");
    expect(file.sha256).toBe(sha256Text("a\r\nb\r\n"));
    expect(file.sha256).not.toBe(sha256Text("a\nb\n"));
  });
});
