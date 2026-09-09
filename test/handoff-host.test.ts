// AP-11 — handoff and second opinion, in the host.
//
// The pure derivation is covered in handoff.test.ts. What is pinned here is
// everything the host contributes and the pure module deliberately cannot see:
// that the briefing is built from THIS session's structures and one user
// message rather than its transcript, that a button confirms and a typed
// command does not, that a declined confirmation costs nothing at all, and
// that the whole run rides AP-10's machinery instead of a second copy of it.
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { AgentRunStore } from "../src/agent-run";
import { HOST_SLASH_COMMANDS, parseHandoffCommand } from "../src/slash-filter";
import type { PlanEntry } from "../src/plan-entries";

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

interface HarnessOptions {
  roleFiles?: Record<string, string>;
  usable?: string[];
  /** Answer the in-chat confirmation this way. Default: accept. */
  confirm?: boolean;
  /** Diff blocks the CALLER's session has accumulated (AP-09). */
  callerEdits?: string[];
  /** The caller's plan rail (AP-02). */
  planEntries?: PlanEntry[];
  /** Messages already in the caller's transcript buffer. */
  buffer?: { type: string; text?: string }[];
  provider?: string;
}

function harness(options: HarnessOptions = {}) {
  const workspace = tempDir("handoff-ws-");
  const storeRoot = tempDir("handoff-store-");
  if (options.roleFiles) {
    mkdirSync(join(workspace, ".companions", "agents"), { recursive: true });
    for (const [name, text] of Object.entries(options.roleFiles)) {
      writeFileSync(join(workspace, ".companions", "agents", name), text, "utf8");
    }
  }

  const posted: any[] = [];
  const logged: string[] = [];
  const sent: { text: string; session: Session }[] = [];
  const started: Session[] = [];
  const confirms: any[] = [];
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
  sidebar.host = { appendLine: (line: string) => { logged.push(line); } };
  sidebar.emit = (_session: Session, message: unknown) => { posted.push(message); };
  sidebar.setStatus = (session: Session, status: string) => { session.status = status as any; };
  sidebar.sessionCwd = () => workspace;
  sidebar.workspaceRoot = () => workspace;
  sidebar.usableProviders = () => options.usable ?? ["claude", "gemini"];
  sidebar.state = { get: (_key: string, fallback: unknown) => fallback, update: async () => {} };
  sidebar.pool = { add: () => {} };
  sidebar.sessionCache = { delete: () => {} };
  sidebar.setSessionCwd = (session: Session, cwd: string) => { session.cwd = cwd; };
  sidebar.newLocalSession = () => new Session();
  sidebar.postSessionName = () => {};
  sidebar.postSessionsList = () => {};
  sidebar.teardownEmptySession = () => {};
  sidebar.persistedUsageLedger = () => ({ usageLog: [], usage: { totalTokens: 100, costUsdTicks: 1_000_000_000 } });
  sidebar.confirmInChat = vi.fn(async (_session: Session, opts: unknown) => {
    confirms.push(opts);
    return options.confirm !== false;
  });
  sidebar.startSession = vi.fn(async (_resume: unknown, session: Session) => {
    started.push(session);
    session.activeSessionId = `role-session-${started.length}`;
    return { sessionId: session.activeSessionId };
  });
  sidebar.handleSend = vi.fn(async (text: string, _bare: boolean, session: Session) => {
    sent.push({ text, session });
    session.hasHistory = true;
    session.userMessageCount = 1;
    session.agentTextTap?.("## Summary\nLooked at it.\n\n## Files touched\n- none\n");
  });

  const caller = new Session();
  caller.provider = (options.provider ?? "claude") as any;
  caller.activeSessionId = "caller-1";
  caller.userMessageCount = 1;
  caller.planEntries = options.planEntries ?? [];
  caller.buffer = (options.buffer ?? [{ type: "userMessage", text: "Get checkout off the legacy token." }]) as any;
  caller.reviewBlocks = (options.callerEdits ?? []).map((path, index) => ({
    path,
    oldText: "a",
    newText: "b",
    sites: [{ oldText: "a", newText: "b" }],
    toolCallId: `call-${index}`,
    turnId: "1",
    status: "completed" as const,
  }));

  return { sidebar, caller, posted, logged, sent, started, confirms, workspace, storeRoot };
}

function card(posted: any[]) {
  return posted.find((m) => m?.type === "agentResult");
}
function notices(posted: any[]): string[] {
  return posted.filter((m) => m?.type === "hostNotice").map((m) => m.text);
}
function runDirs(storeRoot: string): string[] {
  const root = join(storeRoot, "runs");
  return existsSync(root) ? readdirSync(root) : [];
}
function brief(storeRoot: string): string {
  const [runId] = runDirs(storeRoot);
  return readFileSync(join(storeRoot, "runs", runId, "step-01.brief.md"), "utf8");
}

describe("the commands are host-answered", () => {
  it("registers both so neither can be forwarded to a CLI", () => {
    expect(HOST_SLASH_COMMANDS.has("handoff")).toBe(true);
    expect(HOST_SLASH_COMMANDS.has("second-opinion")).toBe(true);
  });

  it("leaves prose that merely mentions them alone", () => {
    expect(parseHandoffCommand("ask for a /handoff later").kind).toBe("none");
    expect(parseHandoffCommand("/handoffs").kind).toBe("none");
  });

  it("takes a role and nothing more, and says so when given more", () => {
    expect(parseHandoffCommand("/second-opinion")).toEqual({ kind: "run", handoff: "second-opinion" });
    expect(parseHandoffCommand("/handoff planner")).toEqual({ kind: "run", handoff: "handoff", role: "planner" });
    const extra = parseHandoffCommand("/second-opinion check the auth flow");
    expect(extra.kind).toBe("error");
    if (extra.kind !== "error") throw new Error("unreachable");
    // Dropping the words silently and reviewing something else would be worse
    // than refusing, so the message points at the command that does take a task.
    expect(extra.message).toContain("/agent");
  });
});

describe("the briefing is built from the thread, not copied from it", () => {
  it("carries changed PATHS and no transcript", async () => {
    const h = harness({ callerEdits: ["src/checkout.ts", "src/token.ts"] });
    await h.sidebar.handleHandoffCommand("/second-opinion", h.caller, "local");
    const text = brief(h.storeRoot);
    expect(text).toContain("src/checkout.ts");
    expect(text).toContain("src/token.ts");
    expect(text).toContain("These are paths, not contents");
    // The one user message travels, as the goal. Nothing else from the thread.
    expect(text).toContain("Get checkout off the legacy token.");
    expect(text).not.toContain("Looked at it.");
  });

  it("reads the LAST user message even with agent traffic after it", async () => {
    const h = harness({
      callerEdits: ["src/a.ts"],
      buffer: [
        { type: "userMessage", text: "first ask" },
        { type: "userMessage", text: "the real ask" },
        ...Array.from({ length: 10 }, () => ({ type: "agentText", text: "chatter" })),
      ],
    });
    await h.sidebar.handleHandoffCommand("/second-opinion", h.caller, "local");
    const text = brief(h.storeRoot);
    expect(text).toContain("the real ask");
    expect(text).not.toContain("first ask");
    expect(text).not.toContain("chatter");
  });

  it("hands over open steps and forbids redoing the finished ones", async () => {
    const h = harness({
      planEntries: [
        { id: "1", content: "Swap the reader", status: "completed" },
        { id: "2", content: "Swap the writer", status: "pending" },
      ],
    });
    await h.sidebar.handleHandoffCommand("/handoff", h.caller, "local");
    const text = brief(h.storeRoot);
    expect(text).toContain("Swap the writer");
    expect(text).toContain("Already decided");
    expect(text).toContain("Do not redo the completed steps");
  });

  it("says WHY there are no steps when the companion cannot report them", async () => {
    const h = harness({ provider: "grok", usable: ["grok"], callerEdits: ["src/a.ts"] });
    await h.sidebar.handleHandoffCommand("/handoff", h.caller, "local");
    const text = brief(h.storeRoot);
    expect(text).toContain("## Where this came from");
    expect(text).toContain("does not report a structured step list at all");
  });

  it("merges the role's own standing rules into the derived ones", async () => {
    const h = harness({ callerEdits: ["src/a.ts"] });
    await h.sidebar.handleHandoffCommand("/second-opinion", h.caller, "local");
    const text = brief(h.storeRoot);
    // Kind-specific rule first, where it is read; the shared base still there.
    expect(text.indexOf("Do not edit, create or delete any file"))
      .toBeLessThan(text.indexOf("Do not commit, push"));
    // …and only once, though both lists contain it.
    expect(text.split("Do not commit, push").length - 1).toBe(1);
  });
});

describe("refusing costs nothing", () => {
  it("does not start a role when the turn changed nothing", async () => {
    const h = harness();
    await h.sidebar.handleHandoffCommand("/second-opinion", h.caller, "local");
    expect(notices(h.posted).join("\n")).toContain("nothing to review");
    expect(h.started).toEqual([]);
    expect(runDirs(h.storeRoot)).toEqual([]);
    expect(card(h.posted)).toBeUndefined();
  });

  it("never even asks before refusing", async () => {
    // Deriving happens BEFORE the dialog on purpose: a refusal is the cheapest
    // outcome there is and must not cost the user a decision.
    const h = harness();
    await h.sidebar.startHandoff("second-opinion", undefined, h.caller, "local", true);
    expect(h.confirms).toEqual([]);
    expect(h.started).toEqual([]);
  });
});

describe("the confirmation (decision 18.3)", () => {
  it("asks on the button path and names the role, provider and model", async () => {
    const h = harness({ callerEdits: ["src/a.ts"] });
    await h.sidebar.startHandoff("second-opinion", undefined, h.caller, "local", true);
    expect(h.confirms).toHaveLength(1);
    expect(h.confirms[0].title).toContain("reviewer");
    expect(String(h.confirms[0].body)).toMatch(/Claude|Gemini/);
  });

  it("shows no cost and no token figure anywhere in it", async () => {
    // 18.3, decided 2026-09-09: no cost indication before the run. The exact
    // cost on the result card afterwards is therefore the ONLY number about
    // money in this path, which is also why it must stay exact.
    const h = harness({ callerEdits: ["src/a.ts"] });
    await h.sidebar.startHandoff("second-opinion", undefined, h.caller, "local", true);
    const text = JSON.stringify(h.confirms[0]);
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/token/i);
    expect(text).not.toMatch(/estimat/i);
  });

  it("does not ask on the typed path", async () => {
    // `/handoff reviewer` named the action and the role. `/agent` does not ask
    // either, and for the same reason.
    const h = harness({ callerEdits: ["src/a.ts"] });
    await h.sidebar.handleHandoffCommand("/second-opinion", h.caller, "local");
    expect(h.confirms).toEqual([]);
    expect(h.started).toHaveLength(1);
  });

  it("leaves nothing behind when declined", async () => {
    const h = harness({ confirm: false, callerEdits: ["src/a.ts"] });
    await h.sidebar.startHandoff("second-opinion", undefined, h.caller, "local", true);
    expect(h.started).toEqual([]);
    expect(runDirs(h.storeRoot)).toEqual([]);
    expect(card(h.posted)).toBeUndefined();
    expect(h.caller.agentRun).toBeUndefined();
  });
});

describe("the run itself is AP-10's, unchanged", () => {
  it("runs in its own session and returns a card with the exact cost", async () => {
    const h = harness({ callerEdits: ["src/a.ts"] });
    await h.sidebar.handleHandoffCommand("/second-opinion", h.caller, "local");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].session).not.toBe(h.caller);
    const c = card(h.posted);
    expect(c.role).toBe("reviewer");
    expect(c.origin).toBe("second-opinion");
    expect(c.cost).toContain("$");
  });

  it("marks a handoff card as a handoff", async () => {
    const h = harness({ callerEdits: ["src/a.ts"] });
    await h.sidebar.handleHandoffCommand("/handoff", h.caller, "local");
    expect(card(h.posted).origin).toBe("handoff");
  });

  it("refuses a second role while one is running", async () => {
    const h = harness({ callerEdits: ["src/a.ts"] });
    h.caller.agentRun = { runId: "run-x", step: 1, roleName: "fixer", roleSession: new Session(), cancelled: false };
    await h.sidebar.handleHandoffCommand("/second-opinion", h.caller, "local");
    expect(notices(h.posted).join("\n")).toContain("still running");
    expect(h.started).toEqual([]);
  });

  it("puts the request in the transcript exactly once, on either path", async () => {
    // The typed path echoes what the user typed; the button path writes the
    // equivalent line because there was nothing to echo. Doing both put the
    // same request in the transcript twice.
    const typed = harness({ callerEdits: ["src/a.ts"] });
    await typed.sidebar.handleHandoffCommand("/second-opinion reviewer", typed.caller, "local");
    const typedEchoes = typed.posted.filter((m: any) => m?.type === "userMessage");
    expect(typedEchoes).toHaveLength(1);
    expect(typedEchoes[0].text).toBe("/second-opinion reviewer");

    const clicked = harness({ callerEdits: ["src/a.ts"] });
    await clicked.sidebar.startHandoff("second-opinion", undefined, clicked.caller, "local", true);
    const clickedEchoes = clicked.posted.filter((m: any) => m?.type === "userMessage");
    expect(clickedEchoes).toHaveLength(1);
    expect(clickedEchoes[0].text).toBe("/second-opinion reviewer");
  });

  it("names a role that does not exist instead of falling back to one that does", async () => {
    const h = harness({ callerEdits: ["src/a.ts"] });
    await h.sidebar.handleHandoffCommand("/handoff nope", h.caller, "local");
    expect(notices(h.posted).join("\n")).toContain("`nope`");
    expect(h.started).toEqual([]);
  });
});

describe("async boundaries in the send path", () => {
  const sidebarSrc = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

  /** Drop comments so a rule EXPLAINED in prose is not read as a violation
   *  of itself — the sentence above the guard uses the word "await". */
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // The same regression AP-10 hit, which `npm test` could not see and the
  // Electron smoke could: an unconditional await at the head of either send
  // path suspends EVERY ordinary message before the checks that decide the
  // duplicate-dequeue and turn-in-flight races. Pinned for the new commands
  // too, because without a pin the next crew AP reintroduces it.
  it("parses the handoff commands synchronously in the composer path", () => {
    const sendCase = sidebarSrc.slice(
      sidebarSrc.indexOf('      case "send":'),
      sidebarSrc.indexOf("let queuedSendCommit"),
    );
    expect(sendCase).toContain('if (parseHandoffCommand(msg.text).kind !== "none") {');
    expect(sendCase).not.toMatch(/if \(await this\.handleHandoffCommand/);
  });

  it("parses them synchronously in the handleSend backstop, with no await ahead", () => {
    const start = sidebarSrc.indexOf("const session = target ?? this.focused;");
    const head = sidebarSrc.slice(start, sidebarSrc.indexOf("await this.waitForSessionStart(session);", start));
    expect(head).toContain('if (parseHandoffCommand(text).kind !== "none") {');
    // Comments stripped, then the `/agent` guard's own await removed: that
    // one is conditional (it runs only for an actual `/agent`) and so is not
    // the hazard. What must not appear is an UNCONDITIONAL await ahead of
    // this guard.
    const beforeGuard = stripComments(head.slice(0, head.indexOf("if (parseHandoffCommand(text)")))
      .replace(/await this\.handleAgentCommand\([^)]*\);/g, "");
    expect(beforeGuard).not.toMatch(/\bawait\b/);
  });
});
