// The Review Center's turn-scope "Open diff" (upstream 2a8ffb0 / 033360c,
// #168): one diff per file for everything the turn did, against a git
// baseline taken as the turn began — so an edit a shell command made counts
// too, and several edits read as one. Anything untrustworthy falls back.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { GitRunGate } from "../src/git-run";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

function repo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "turn-diff-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  git("add", ".");
  git("commit", "-qm", "init");
  return dir;
}

function harness(root: string) {
  const sidebar = Object.create(GrokSidebar.prototype) as any;
  sidebar.turnGitBaselines = new WeakMap();
  sidebar.gitRunGate = new GitRunGate();
  sidebar.diffSeq = 0;
  const contents = new Map<string, string>();
  sidebar.diffProvider = { set: (uri: any, text: string) => contents.set(String(uri), text) };
  sidebar.host = { openDiff: vi.fn(async () => {}) };
  sidebar.sessionCwd = () => root;
  sidebar.readFileForDiff = (_s: unknown, abs: string) => fs.readFileSync(abs, "utf8");
  const session = new Session();
  session.userMessageCount = 1;
  return { sidebar, session, contents };
}

async function settled(sidebar: any, session: Session) {
  for (let i = 0; i < 200; i++) {
    if (!sidebar.turnGitBaselines.get(session)?.pending) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("baseline capture never settled");
}

describe("Review Center turn diff against a git baseline", () => {
  it("diffs everything the turn did, including a shell-made edit, against the turn's start", async () => {
    const root = repo();
    fs.writeFileSync(path.join(root, "a.txt"), "one\nbefore-turn\n"); // uncommitted before the turn
    const { sidebar, session, contents } = harness(root);
    sidebar.startTurnGitBaseline(session, {});
    await settled(sidebar, session);
    fs.writeFileSync(path.join(root, "a.txt"), "one\nbefore-turn\nturn edit\n");
    await expect(sidebar.openTurnGitDiff(session, "a.txt")).resolves.toBe(true);
    const [left, right, title, opts] = sidebar.host.openDiff.mock.calls[0];
    expect(contents.get(String(left))).toBe("one\nbefore-turn\n");
    expect(contents.get(String(right))).toBe("one\nbefore-turn\nturn edit\n");
    expect(title).toBe("Turn diff: a.txt");
    expect(opts).toMatchObject({ preview: false });
  });

  it("treats a file the turn created as empty before", async () => {
    const root = repo();
    const { sidebar, session, contents } = harness(root);
    sidebar.startTurnGitBaseline(session, {});
    await settled(sidebar, session);
    fs.writeFileSync(path.join(root, "new.txt"), "fresh\n");
    await expect(sidebar.openTurnGitDiff(session, "new.txt")).resolves.toBe(true);
    expect(contents.get(String(sidebar.host.openDiff.mock.calls[0][0]))).toBe("");
  });

  it("falls back when a tool started before the capture finished", async () => {
    const root = repo();
    const { sidebar, session } = harness(root);
    sidebar.startTurnGitBaseline(session, {});
    // What emit() does on the first toolCall while the capture is in flight.
    const entry = sidebar.turnGitBaselines.get(session);
    entry.pending = false;
    entry.baseline = undefined;
    entry.turn = {};
    await new Promise((r) => setTimeout(r, 300));
    await expect(sidebar.openTurnGitDiff(session, "a.txt")).resolves.toBe(false);
  });

  it("falls back for another turn, outside the repo, or outside git", async () => {
    const root = repo();
    const { sidebar, session } = harness(root);
    sidebar.startTurnGitBaseline(session, {});
    await settled(sidebar, session);
    await expect(sidebar.openTurnGitDiff(session, "../escape.txt")).resolves.toBe(false);
    session.userMessageCount = 2;
    await expect(sidebar.openTurnGitDiff(session, "a.txt")).resolves.toBe(false);

    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
    dirs.push(plain);
    const other = harness(plain);
    other.sidebar.startTurnGitBaseline(other.session, {});
    await settled(other.sidebar, other.session);
    await expect(other.sidebar.openTurnGitDiff(other.session, "a.txt")).resolves.toBe(false);
  });
});
