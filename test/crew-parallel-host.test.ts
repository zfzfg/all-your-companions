// AP-13: two independent writers run at the same time, each in its own
// worktree. No real git, no real CLI — the worktree ops and the role turn
// are injected, and a gate proves the two handleSend calls overlap.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { AgentRunStore } from "../src/agent-run";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("parallel crew roles", () => {
  it("runs two implementers at once in two worktrees and applies both at the end", async () => {
    const workspace = tempDir("crew-par-ws-");
    const storeRoot = tempDir("crew-par-store-");
    mkdirSync(join(workspace, ".companions", "crews"), { recursive: true });
    writeFileSync(
      join(workspace, ".companions", "crews", "fast.md"),
      ["---", "name: fast", "parallel: true", "roles: [implementer]", "---", "two writers"].join("\n"),
      "utf8",
    );

    const posted: any[] = [];
    const sent: { text: string; cwd: string }[] = [];
    const applied: string[] = [];
    const created: string[] = [];
    let live = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });

    const nodeFs = require("node:fs");
    const nodePath = require("node:path");
    const sidebar: any = Object.create(GrokSidebar.prototype);
    sidebar.agentRuns = new AgentRunStore({
      root: join(storeRoot, "runs"),
      fs: {
        mkdirSync: (dir: string, opts: { recursive: true }) => { nodeFs.mkdirSync(dir, opts); },
        writeFileSync: (file: string, data: string) => { nodeFs.writeFileSync(file, data, "utf8"); },
        appendFileSync: (file: string, data: string) => { nodeFs.appendFileSync(file, data, "utf8"); },
        existsSync: (target: string) => nodeFs.existsSync(target),
        rmSync: (target: string, opts: { recursive: boolean; force: boolean }) => nodeFs.rmSync(target, opts),
      },
      join: (...parts: string[]) => nodePath.join(...parts),
    });
    sidebar.host = {
      appendLine: () => {},
      // This test is the legacy in-thread `/crew` path, which now lives
      // behind companions.crew.inThreadCommand (D8).
      getConfiguration: () => ({ get: (key: string, fallback: unknown) =>
        key === "crew.inThreadCommand" ? true : fallback }),
    };
    sidebar.emit = (_s: Session, message: unknown) => { posted.push(message); };
    sidebar.setStatus = (session: Session, status: string) => { session.status = status as any; };
    sidebar.sessionCwd = (s: Session) => s.cwd || workspace;
    sidebar.workspaceRoot = () => workspace;
    sidebar.usableProviders = () => ["claude"];
    sidebar.state = { get: (_k: string, fallback: unknown) => fallback, update: async () => {} };
    sidebar.context = { globalStorageUri: { fsPath: storeRoot } };
    const pool = new Set<Session>();
    sidebar.pool = pool;
    sidebar.sessionCache = { delete: () => {} };
    sidebar.setSessionCwd = (session: Session, cwd: string) => { session.cwd = cwd; };
    sidebar.newLocalSession = () => new Session();
    sidebar.postSessionName = () => {};
    sidebar.postSessionsList = () => {};
    sidebar.teardownEmptySession = () => {};
    sidebar.confirmInChat = async () => true;
    sidebar.persistedUsageLedger = () => ({
      usageLog: [],
      usage: { totalTokens: 10, costUsdTicks: 1 },
    });
    sidebar.startSession = vi.fn(async (_resume: unknown, session: Session) => {
      session.activeSessionId = `role-${pool.size + 1}`;
      return { sessionId: session.activeSessionId };
    });
    sidebar.handleSend = vi.fn(async (_text: string, _bare: boolean, session: Session) => {
      live += 1;
      if (live >= 2) release();
      await gate;
      sent.push({ text: _text, cwd: session.cwd || "" });
      session.hasHistory = true;
      session.userMessageCount = 1;
      session.reviewBlocks = [{
        path: session.cwd?.includes("s1") ? "src/a.ts" : "src/b.ts",
        oldText: "a",
        newText: "b",
        sites: [{ oldText: "a", newText: "b" }],
        toolCallId: "c1",
        turnId: "1",
        status: "completed" as const,
      }];
      session.agentTextTap?.("## Summary\nDone.\n\n## Files touched\n- src/x.ts\n");
    });
    sidebar.crewWorktreeCreate = async (_src: string, label: string) => {
      created.push(label);
      return { path: join(workspace, "wt", label), label, sourceGitRoot: workspace };
    };
    sidebar.crewWorktreeApply = async (wt: { path: string }) => { applied.push(wt.path); };

    const caller = new Session();
    caller.provider = "claude";
    caller.activeSessionId = "caller-1";
    caller.cwd = workspace;
    caller.planEntries = [
      { id: "1", content: "[implementer] Write src/a.ts", status: "pending" },
      { id: "2", content: "[implementer] Write src/b.ts", status: "pending" },
    ];
    sidebar.focused = caller;
    pool.add(caller);

    const consumed = await sidebar.handleCrewCommand("/crew fast", caller, "local");
    expect(consumed).toBe(true);
    expect(sent).toHaveLength(2);
    expect(new Set(sent.map((s) => s.cwd)).size).toBe(2);
    expect(created).toHaveLength(2);
    expect(applied).toHaveLength(2);
    expect(applied.slice().sort()).toEqual(created.map((l) => join(workspace, "wt", l)).sort());
    expect(caller.crewRun?.status).toBe("done");
    expect(caller.crewLive ?? []).toEqual([]);
  });
});
