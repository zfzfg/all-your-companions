// AP-10 host wiring, without a webview and without a process.
//
// What a unit test of the pure modules cannot reach: that `/agent` is answered
// by the host and never handed to a CLI, that the brief lands on disk before
// the role starts, that the card carries the cost, that model and effort are
// set on the newSession path rather than by a live switch, and that a role
// cancelled before it produced anything leaves neither an empty "New session"
// nor a run directory holding an unanswered brief.
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GrokSidebar } from "../src/sidebar";
import { Session } from "../src/session";
import { AgentRunStore } from "../src/agent-run";
import { parseAgentCommand, HOST_SLASH_COMMANDS } from "../src/slash-filter";

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
  models?: Record<string, { modelId: string }[]>;
  /** What the role's turn produces. Empty string means it produced nothing. */
  reply?: string;
  /** Fail the role's session start. */
  failStart?: boolean;
  /** Cancel the run from inside handleSend, as Stop would. */
  cancelDuringTurn?: boolean;
  /** Throw from the run store's writes whose path matches (fault injection). */
  failWrite?: RegExp;
  /** Throw from every append to log.jsonl. */
  failLog?: boolean;
  /** Diff blocks the role's session accumulated — the host's own evidence. */
  observedEdits?: string[];
}

function harness(options: HarnessOptions = {}) {
  const workspace = tempDir("agent-ws-");
  const storeRoot = tempDir("agent-store-");
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
  const removed: Session[] = [];
  const nodeFs = require("node:fs");
  const nodePath = require("node:path");

  const sidebar: any = Object.create(GrokSidebar.prototype);
  sidebar.agentRuns = new AgentRunStore({
    root: join(storeRoot, "runs"),
    fs: {
      mkdirSync: (dir: string, opts: { recursive: true }) => { nodeFs.mkdirSync(dir, opts); },
      writeFileSync: (file: string, data: string) => {
        if (options.failWrite?.test(file)) throw new Error("EROFS: read-only file system");
        nodeFs.writeFileSync(file, data, "utf8");
      },
      appendFileSync: (file: string, data: string) => {
        if (options.failLog) throw new Error("ENOSPC: no space left on device");
        nodeFs.appendFileSync(file, data, "utf8");
      },
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
  sidebar.state = {
    get: (key: string, fallback: unknown) =>
      key === "grok.providerModelCache"
        ? Object.fromEntries(Object.entries(options.models ?? {}).map(([k, v]) => [k, { models: v }]))
        : fallback,
    update: async () => {},
  };
  sidebar.pool = { add: () => {} };
  sidebar.sessionCache = { delete: () => {} };
  sidebar.setSessionCwd = (session: Session, cwd: string) => { session.cwd = cwd; };
  sidebar.newLocalSession = () => new Session();
  sidebar.postSessionName = () => {};
  sidebar.postSessionsList = () => {};
  sidebar.teardownEmptySession = (session: Session) => { removed.push(session); };
  sidebar.persistedUsageLedger = () => ({
    usageLog: [],
    usage: { totalTokens: 4210, costUsdTicks: 12_300_000_000 },
  });
  const overridesAtStart: unknown[] = [];
  sidebar.startSession = vi.fn(async (_resume: unknown, session: Session) => {
    started.push(session);
    overridesAtStart.push(session.startOverrides);
    if (options.failStart) return undefined;
    session.activeSessionId = `role-session-${started.length}`;
    return { sessionId: session.activeSessionId };
  });
  sidebar.handleSend = vi.fn(async (text: string, _bare: boolean, session: Session) => {
    sent.push({ text, session });
    session.hasHistory = true;
    session.userMessageCount = 1;
    // Stand in for the AP-09 blocks the diff machinery would have folded in.
    session.reviewBlocks = (options.observedEdits ?? []).map((path, index) => ({
      path,
      oldText: "a",
      newText: "b",
      sites: [{ oldText: "a", newText: "b" }],
      toolCallId: `call-${index}`,
      turnId: "1",
      status: "completed" as const,
    }));
    if (options.cancelDuringTurn) sidebar.cancelAgentRun(caller);
    const reply = options.reply ?? "## Summary\nDone.\n\n## Files touched\n- src/a.ts\n";
    session.agentTextTap?.(reply);
  });

  const caller = new Session();
  caller.provider = "claude";
  caller.activeSessionId = "caller-1";

  return { sidebar, caller, posted, logged, sent, started, removed, overridesAtStart, workspace, storeRoot };
}

function card(posted: any[]) {
  return posted.find((message) => message?.type === "agentResult");
}
function notices(posted: any[]): string[] {
  return posted.filter((message) => message?.type === "hostNotice").map((message) => message.text);
}
function runDirs(storeRoot: string): string[] {
  const root = join(storeRoot, "runs");
  return existsSync(root) ? readdirSync(root) : [];
}

describe("/agent is answered by the host", () => {
  it("is registered as a host command so it can never be forwarded", () => {
    expect(HOST_SLASH_COMMANDS.has("agent")).toBe(true);
  });

  it("consumes the message instead of sending it to the CLI", async () => {
    const h = harness();
    const consumed = await h.sidebar.handleAgentCommand("/agent researcher where is the parser", h.caller, "local");
    expect(consumed).toBe(true);
    // handleSend was called exactly once, for the ROLE session with the
    // briefing — never for the caller with the slash text.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].session).not.toBe(h.caller);
    expect(h.sent[0].text.startsWith("/agent")).toBe(false);
    expect(h.sent[0].text).toContain("# Briefing — researcher");
  });

  it("leaves ordinary prose alone", async () => {
    const h = harness();
    expect(await h.sidebar.handleAgentCommand("please review /agent-style naming", h.caller, "local")).toBe(false);
    expect(h.posted).toEqual([]);
  });

  it("lists the roles when no name is given", async () => {
    const h = harness();
    await h.sidebar.handleAgentCommand("/agent", h.caller, "local");
    const text = notices(h.posted).join("\n");
    for (const name of ["planner", "implementer", "reviewer", "researcher", "fixer"]) {
      expect(text).toContain(`/agent ${name}`);
    }
    expect(card(h.posted)).toBeUndefined();
  });

  it("asks for a task rather than briefing a role with nothing", async () => {
    const h = harness();
    await h.sidebar.handleAgentCommand("/agent reviewer", h.caller, "local");
    expect(notices(h.posted).join("\n")).toContain("needs a task");
    expect(h.started).toEqual([]);
  });

  it("names the unknown role and lists what does exist", async () => {
    const h = harness();
    await h.sidebar.handleAgentCommand("/agent nope do a thing", h.caller, "local");
    expect(notices(h.posted).join("\n")).toContain("There is no role `nope`");
    expect(h.started).toEqual([]);
  });

  it("echoes the typed command into the thread as a user message", async () => {
    const h = harness();
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    expect(h.posted.find((m) => m.type === "userMessage")?.text).toBe("/agent researcher find it");
  });
});

describe("parseAgentCommand", () => {
  it("keeps a multi-line task verbatim", () => {
    const parsed = parseAgentCommand("/agent fixer make tests pass\nrun: npm test");
    expect(parsed).toEqual({ kind: "run", command: { name: "fixer", task: "make tests pass\nrun: npm test" } });
  });

  it("parses /agents as an alias for /agent", () => {
    expect(parseAgentCommand("/agents")).toEqual({ kind: "list" });
    expect(parseAgentCommand("/agent")).toEqual({ kind: "list" });
    expect(parseAgentCommand("/agents reviewer check diff")).toEqual({
      kind: "run",
      command: { name: "reviewer", task: "check diff" },
    });
  });

  it("rejects a name that would read as a flag", () => {
    const parsed = parseAgentCommand("/agent --force do it");
    expect(parsed.kind).toBe("error");
  });
});

describe("a role runs in its own session", () => {
  it("writes the brief to disk BEFORE starting the role", async () => {
    const h = harness();
    await h.sidebar.handleAgentCommand("/agent researcher where is the parser", h.caller, "local");
    const [runId] = runDirs(h.storeRoot);
    expect(runId).toMatch(/^run-\d{8}-\d{6}-/);
    const brief = readFileSync(join(h.storeRoot, "runs", runId, "step-01.brief.md"), "utf8");
    expect(brief).toContain("# Briefing — researcher");
    expect(brief).toContain("where is the parser");
    // runId and step are in the format from day one.
    expect(brief).toContain(`run ${runId} · step 1`);
  });

  it("sets model and effort on the newSession path, never as a live switch", async () => {
    const h = harness({
      roleFiles: {
        "swift.md": "---\nprovider: claude\nmodel: claude-haiku-4-5\neffort: low\nwhen_to_use: fast work\n---\n",
      },
      models: { claude: [{ modelId: "claude-haiku-4-5" }] },
    });
    await h.sidebar.handleAgentCommand("/agent swift do the thing", h.caller, "local");
    const roleSession = h.started[0];
    // The recipe must already be ON the session when startSession is called —
    // `startSessionBody` consumes it on the newSession path, ahead of turn one.
    // Anything applied afterwards would be the live switch that fails with
    // MODEL_SWITCH_INCOMPATIBLE_AGENT.
    expect(h.overridesAtStart[0]).toEqual({ model: "claude-haiku-4-5", effort: "low" });
    expect(roleSession.provider).toBe("claude");
    expect(h.sent[0].session).toBe(roleSession);
  });

  it("writes the result and reports it on a card with the cost", async () => {
    const h = harness();
    await h.sidebar.handleAgentCommand("/agent researcher where is the parser", h.caller, "local");
    const [runId] = runDirs(h.storeRoot);
    const result = readFileSync(join(h.storeRoot, "runs", runId, "step-01.result.md"), "utf8");
    expect(result).toContain("## Summary");
    expect(result).toContain("Done.");
    expect(result).toContain("- src/a.ts");

    const message = card(h.posted);
    expect(message.role).toBe("researcher");
    expect(message.outcome).toBe("completed");
    expect(message.summary).toBe("Done.");
    expect(message.files).toEqual(["src/a.ts"]);
    // A role is a second run and the card says what it cost.
    expect(message.cost).toBe("$1.23 · 4,210 tokens");
    expect(message.runId).toBe(runId);
    expect(message.step).toBe(1);
    expect(message.sessionId).toBe("role-session-1");
  });

  it("logs the run as JSON lines", async () => {
    const h = harness();
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    const [runId] = runDirs(h.storeRoot);
    const lines = readFileSync(join(h.storeRoot, "runs", runId, "log.jsonl"), "utf8").trim().split("\n");
    expect(lines.map((line) => JSON.parse(line).event)).toEqual(["briefed", "finished"]);
    expect(JSON.parse(lines[1]).costUsdTicks).toBe(12_300_000_000);
  });

  it("refuses a second role while one is still running", async () => {
    const h = harness();
    h.caller.agentRun = { runId: "run-x", step: 1, roleName: "reviewer", roleSession: new Session(), cancelled: false };
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    expect(notices(h.posted).join("\n")).toContain("Role `reviewer` is still running");
    expect(h.started).toEqual([]);
  });

  it("reports a failed start as a failed card, not a silent nothing", async () => {
    const h = harness({ failStart: true });
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    const message = card(h.posted);
    expect(message.outcome).toBe("failed");
    expect(message.detail).toContain("could not start a session");
  });
});

describe("provider and model validation", () => {
  it("rejects a model the provider does not carry instead of falling back", async () => {
    const h = harness({
      roleFiles: { "bad.md": "---\nprovider: claude\nmodel: gpt-9\nwhen_to_use: nope\n---\n" },
      models: { claude: [{ modelId: "claude-opus-5" }] },
    });
    await h.sidebar.handleAgentCommand("/agent bad do it", h.caller, "local");
    expect(notices(h.posted).join("\n")).toContain("Claude does not have a model `gpt-9`");
    expect(h.started).toEqual([]);
  });

  it("runs anyway when the model cache is not warmed, and says so in the log", async () => {
    const h = harness({
      roleFiles: { "cold.md": "---\nprovider: claude\nmodel: claude-opus-5\nwhen_to_use: whatever\n---\n" },
      models: {},
    });
    await h.sidebar.handleAgentCommand("/agent cold do it", h.caller, "local");
    expect(card(h.posted)?.outcome).toBe("completed");
    expect(h.logged.join("\n")).toContain("model list is not warmed yet");
  });

  it("does not silently swap the provider a project role named", async () => {
    const h = harness({
      roleFiles: { "offline.md": "---\nprovider: grok\nwhen_to_use: whatever\n---\n" },
      usable: ["claude"],
    });
    await h.sidebar.handleAgentCommand("/agent offline do it", h.caller, "local");
    expect(notices(h.posted).join("\n")).toContain("which is not connected");
    expect(h.started).toEqual([]);
  });

  it("lets a BUILT-IN role fall back to a connected provider", async () => {
    // The built-ins carry a placeholder provider; without this the feature is
    // dead on any install that does not happen to have that one account.
    const h = harness({ usable: ["gemini"] });
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    expect(card(h.posted)?.provider).toBe("gemini");
  });

  it("reports a broken role file and still lists the working roles", async () => {
    const h = harness({ roleFiles: { "broken.md": "no frontmatter" } });
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    expect(notices(h.posted).join("\n")).toContain("could not be read");
    expect(card(h.posted)?.outcome).toBe("completed");
  });

  it("runs the five built-ins with no .companions/agents at all", async () => {
    const h = harness();
    for (const name of ["planner", "implementer", "reviewer", "researcher", "fixer"]) {
      const fresh = harness();
      await fresh.sidebar.handleAgentCommand(`/agent ${name} do it`, fresh.caller, "local");
      expect(card(fresh.posted), name).toBeTruthy();
    }
    expect(h.posted).toEqual([]);
  });
});

describe("cancellation", () => {
  it("leaves no empty session and no orphan run directory", async () => {
    const h = harness({ cancelDuringTurn: true, reply: "" });
    // hasHistory must be false for the teardown to apply — an aborted role
    // that never answered is exactly an abandoned empty session.
    h.sidebar.handleSend = vi.fn(async (_text: string, _bare: boolean, session: Session) => {
      h.sidebar.cancelAgentRun(h.caller);
      session.agentTextTap?.("");
    });
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    expect(h.removed).toHaveLength(1);
    expect(runDirs(h.storeRoot)).toEqual([]);
    const message = card(h.posted);
    expect(message.outcome).toBe("cancelled");
  });

  it("keeps the artefacts when the role did produce something before Stop", async () => {
    const h = harness({ cancelDuringTurn: true, reply: "## Summary\nPartial.\n" });
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    expect(runDirs(h.storeRoot)).toHaveLength(1);
    expect(h.removed).toEqual([]);
    expect(card(h.posted).summary).toBe("Partial.");
  });

  it("cancelAgentRun reports whether there was a run to stop", () => {
    const h = harness();
    expect(h.sidebar.cancelAgentRun(h.caller)).toBe(false);
    const roleSession = new Session();
    const cancel = vi.fn(async () => {});
    (roleSession as any).client = { cancel };
    h.caller.agentRun = { runId: "r", step: 1, roleName: "x", roleSession, cancelled: false };
    expect(h.sidebar.cancelAgentRun(h.caller)).toBe(true);
    expect(h.caller.agentRun.cancelled).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });
});

describe("source pins", () => {
  const sidebarSrc = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

  it("consumes the start overrides on the newSession path and never live-switches", () => {
    const body = sidebarSrc.slice(
      sidebarSrc.indexOf("const startOverrides = session.startOverrides;"),
      sidebarSrc.indexOf("clock.record(\"new\", clock.elapsed(newAt))"),
    );
    expect(body).toContain("session.startOverrides = undefined;");
    expect(body).toContain("await client.newSession(defaultModel || undefined)");
    const runRole = sidebarSrc.slice(
      sidebarSrc.indexOf("private async runAgentRole"),
      sidebarSrc.indexOf("private nameAgentRoleSession"),
    );
    expect(runRole).not.toContain("switchModel");
    expect(runRole).not.toContain("setModel");
  });

  it("intercepts /agent ahead of the queued-send bookkeeping", () => {
    const sendCase = sidebarSrc.slice(
      sidebarSrc.indexOf('      case "send":'),
      sidebarSrc.indexOf("let queuedSendCommit"),
    );
    expect(sendCase).toContain("this.handleAgentCommand(msg.text, session, origin)");
  });

  it("routes Stop to the role run before the session's own cancel", () => {
    const cancelCase = sidebarSrc.slice(
      sidebarSrc.indexOf('      case "cancel": {'),
      sidebarSrc.indexOf('await session.client?.cancel("user Stop click")'),
    );
    expect(cancelCase).toContain("this.cancelAgentRun(session)");
  });
});

describe("the role's self-report is measured against what the host saw", () => {
  it("names an edit the role did not mention, in the card and on disk", async () => {
    const h = harness({
      reply: "## Summary\nTidied up.\n\n## Files touched\n- src/a.ts\n",
      observedEdits: ["src/a.ts", "src/secret.ts"],
    });
    await h.sidebar.handleAgentCommand("/agent implementer tidy up", h.caller, "local");
    const message = card(h.posted);
    expect(message.files).toEqual(["src/a.ts"]);
    expect(message.unreported).toEqual(["src/secret.ts"]);
    expect(message.claimedOnly).toBeUndefined();
    const [runId] = runDirs(h.storeRoot);
    const written = readFileSync(join(h.storeRoot, "runs", runId, "step-01.result.md"), "utf8");
    expect(written).toContain("## Edits the role did not report");
    expect(written).toContain("- src/secret.ts");
  });

  it("names a file the role claimed but the host never saw edited", async () => {
    const h = harness({
      reply: "## Summary\nDone.\n\n## Files touched\n- src/a.ts\n- docs/readme.md\n",
      observedEdits: ["src/a.ts"],
    });
    await h.sidebar.handleAgentCommand("/agent implementer do it", h.caller, "local");
    expect(card(h.posted).claimedOnly).toEqual(["docs/readme.md"]);
    expect(card(h.posted).unreported).toBeUndefined();
  });

  it("says nothing at all when the two agree — no permanently empty sections", async () => {
    const h = harness({
      reply: "## Summary\nDone.\n\n## Files touched\n- src/a.ts\n",
      observedEdits: ["src/a.ts"],
    });
    await h.sidebar.handleAgentCommand("/agent implementer do it", h.caller, "local");
    expect(card(h.posted).unreported).toBeUndefined();
    expect(card(h.posted).claimedOnly).toBeUndefined();
    const [runId] = runDirs(h.storeRoot);
    const written = readFileSync(join(h.storeRoot, "runs", runId, "step-01.result.md"), "utf8");
    expect(written).not.toContain("did not report");
    expect(written).not.toContain("not observed");
  });

  it("compares paths the way the review center does (separators, ./)", async () => {
    const h = harness({
      reply: "## Summary\nDone.\n\n## Files touched\n- ./src/a.ts\n",
      observedEdits: ["src\\a.ts"],
    });
    await h.sidebar.handleAgentCommand("/agent implementer do it", h.caller, "local");
    expect(card(h.posted).unreported).toBeUndefined();
    expect(card(h.posted).claimedOnly).toBeUndefined();
  });
});

describe("a review that cannot be an outside opinion says so", () => {
  it("steers the built-in reviewer to a different companion when one exists", async () => {
    const h = harness({ usable: ["claude", "gemini"] }); // the caller is on claude
    await h.sidebar.handleAgentCommand("/agent reviewer check the diff", h.caller, "local");
    expect(card(h.posted).provider).toBe("gemini");
    expect(card(h.posted).caution).toBeUndefined();
  });

  it("still runs on the only connected companion, but labels it honestly", async () => {
    const h = harness({ usable: ["claude"] });
    await h.sidebar.handleAgentCommand("/agent reviewer check the diff", h.caller, "local");
    const message = card(h.posted);
    expect(message.provider).toBe("claude");
    expect(message.outcome).toBe("completed");
    expect(message.caution).toContain("same companion as this conversation");
  });

  it("leaves roles that did not ask for a fresh pair of eyes alone", async () => {
    const h = harness({ usable: ["claude", "gemini"] });
    await h.sidebar.handleAgentCommand("/agent implementer do it", h.caller, "local");
    expect(card(h.posted).provider).toBe("claude");
    expect(card(h.posted).caution).toBeUndefined();
  });

  it("honours prefer_different_provider on a project role too", async () => {
    const h = harness({
      roleFiles: {
        "auditor.md": "---\nprovider: claude\nprefer_different_provider: true\nwhen_to_use: audit\n---\n",
      },
      usable: ["claude"],
    });
    await h.sidebar.handleAgentCommand("/agent auditor audit it", h.caller, "local");
    // A project role's provider is never swapped — but the caution still fires.
    expect(card(h.posted).provider).toBe("claude");
    expect(card(h.posted).caution).toContain("same companion");
  });
});

describe("fault injection on the run-artefact stream", () => {
  it("refuses to start the role when the briefing cannot be written", async () => {
    const h = harness({ failWrite: /brief\.md$/ });
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    // The brief IS the run — no session is spawned, and no card pretends one ran.
    expect(h.started).toEqual([]);
    expect(card(h.posted)).toBeUndefined();
    expect(notices(h.posted).join("\n")).toContain("Could not write the briefing");
    expect(notices(h.posted).join("\n")).toContain("The role was not started");
  });

  it("still delivers the card when only the RESULT file cannot be written", async () => {
    const h = harness({ failWrite: /result\.md$/ });
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    // The turn was already paid for; losing the file must not also lose the answer.
    expect(card(h.posted).outcome).toBe("completed");
    expect(card(h.posted).summary).toBe("Done.");
    expect(h.logged.join("\n")).toContain("could not write the result");
  });

  it("still runs when the log cannot be appended — the log is the account, not the run", async () => {
    const h = harness({ failLog: true });
    await h.sidebar.handleAgentCommand("/agent researcher find it", h.caller, "local");
    expect(card(h.posted).outcome).toBe("completed");
    expect(h.logged.join("\n")).toContain("could not append to the run log");
  });
});

describe("async boundaries in the send path", () => {
  const sidebarSrc = readFileSync(new URL("../src/sidebar.ts", import.meta.url), "utf8");

  /** Drop `//` and block comments so a rule EXPLAINED in prose is not read
   *  as a violation of itself. */
  const stripComments = (text: string) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // Caught by the Electron smoke, not by this suite: an unconditional
  // `await this.handleAgentCommand(...)` at the head of either send path
  // suspends EVERY ordinary message before the checks that decide the
  // duplicate-dequeue and turn-in-flight races. `npm test` stayed green while
  // `npm run test:integration` went red. Both call sites must parse
  // synchronously and await only on a hit.
  it("parses /agent synchronously in the composer path", () => {
    const sendCase = sidebarSrc.slice(
      sidebarSrc.indexOf('      case "send":'),
      sidebarSrc.indexOf("let queuedSendCommit"),
    );
    expect(sendCase).toContain('if (parseAgentCommand(msg.text).kind !== "none") {');
    expect(sendCase).not.toMatch(/if \(await this\.handleAgentCommand/);
  });

  it("parses /agent synchronously in the handleSend backstop", () => {
    const head = sidebarSrc.slice(
      sidebarSrc.indexOf("const session = target ?? this.focused;"),
      sidebarSrc.indexOf(
        "await this.waitForSessionStart(session);",
        sidebarSrc.indexOf("const session = target ?? this.focused;"),
      ),
    );
    expect(head).toContain('if (parseAgentCommand(text).kind !== "none") {');
    expect(head).not.toMatch(/if \(await this\.handleAgentCommand/);
    // Nothing may await BEFORE that synchronous guard — an await there
    // suspends every ordinary send, which is the whole regression. The await
    // inside the guard is fine: it only runs for an actual `/agent`.
    //
    // Comments are stripped first, and that is not cosmetic: the prose right
    // above the guard in sidebar.ts explains the rule using the word
    // "await", so a raw text search reports a violation that is really an
    // explanation. (This assertion previously held two literal backspace
    // bytes where `\b` was intended and therefore matched nothing at all —
    // it passed without ever checking anything.)
    const beforeGuard = stripComments(head.slice(0, head.indexOf("if (parseAgentCommand(text)")));
    expect(beforeGuard).not.toMatch(/\bawait\b/);
  });
});
