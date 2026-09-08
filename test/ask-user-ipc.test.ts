// AP-05 — the real pipe, the real script, no CLI.
//
// This file starts `resources/mcp/ask-user-server.cjs` as an actual child
// process and speaks MCP JSON-RPC to its stdin/stdout, exactly as a CLI would.
// It NEVER starts a grok/claude/codex/gemini binary — the suite is binary-free
// and stays that way; the child here is plain Node running our own script.
//
// The cases are the ones that leave something hanging when they are wrong:
// an answer that never arrives, a cancel nobody sends, a timeout, a client that
// dies mid-question, and a host that dies mid-question. Each of those, done
// wrong, is a CLI blocked inside `tools/call` with no timeout of its own.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  ASK_USER_ADDRESS_ENV,
  ASK_USER_SERVER_NAME,
  ASK_USER_TOKEN_ENV,
} from "../src/ask-user-protocol";
import { AskUserServer, type AskUserRequest } from "../src/ask-user-server";

const SCRIPT = path.join(__dirname, "..", "resources", "mcp", "ask-user-server.cjs");

const started: Array<{ server?: AskUserServer; child?: ChildProcessWithoutNullStreams }> = [];

afterEach(() => {
  for (const { server, child } of started.splice(0)) {
    try { server?.dispose(); } catch { /* already down */ }
    try { child?.kill(); } catch { /* already gone */ }
  }
});

interface Harness {
  server: AskUserServer;
  /** Questions the host was asked to show, oldest first. */
  requests: AskUserRequest[];
  /** Ids the host was told to take down. */
  withdrawn: string[];
  token: string;
  child: ChildProcessWithoutNullStreams;
  /** Send one JSON-RPC message to the child's stdin. */
  send(message: unknown): void;
  /** Resolve with the child's reply to this JSON-RPC id. */
  reply(id: number): Promise<any>;
  /** Resolve once the host has been asked to show `n` questions. */
  waitForRequests(n: number): Promise<AskUserRequest[]>;
}

async function boot(options: { token?: string; badToken?: boolean } = {}): Promise<Harness> {
  const requests: AskUserRequest[] = [];
  const withdrawn: string[] = [];
  const server = new AskUserServer({
    scriptPath: SCRIPT,
    log: () => { /* quiet in tests */ },
    onRequest: (_token, request) => { requests.push(request); },
    onWithdraw: (_token, id) => { withdrawn.push(id); },
  });
  started.push({ server });
  const address = await server.listen();
  expect(address, "the pipe must bind for this test to mean anything").toBeTruthy();
  const token = server.register();

  const spec = server.spawnSpec(token)!;
  expect(spec.name).toBe(ASK_USER_SERVER_NAME);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of spec.env) env[entry.name] = entry.value;
  if (options.badToken) env[ASK_USER_TOKEN_ENV] = "not-a-real-token";
  // `process.execPath` under vitest is plain node, so ELECTRON_RUN_AS_NODE is
  // inert here — it is asserted on the spec instead (see the spawn-spec test).
  const child = spawn(process.execPath, spec.args, { env, stdio: ["pipe", "pipe", "pipe"] });
  started[started.length - 1].child = child;

  const replies = new Map<number, (value: any) => void>();
  const pendingReplies = new Map<number, any>();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message?.id !== "number") return;
    const waiter = replies.get(message.id);
    if (waiter) { replies.delete(message.id); waiter(message); }
    else pendingReplies.set(message.id, message);
  });

  const harness: Harness = {
    server,
    requests,
    withdrawn,
    token,
    child,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    reply: (id) => new Promise((resolve) => {
      const already = pendingReplies.get(id);
      if (already) { pendingReplies.delete(id); resolve(already); return; }
      replies.set(id, resolve);
    }),
    waitForRequests: async (n) => {
      // Wait on the CONDITION, not on a frame count or a fixed sleep.
      const deadline = Date.now() + 10_000;
      while (requests.length < n) {
        if (Date.now() > deadline) throw new Error(`only ${requests.length} of ${n} questions arrived`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return requests;
    },
  };
  return harness;
}

function callAskUser(h: Harness, id: number, args: unknown): Promise<any> {
  const pending = h.reply(id);
  h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ask_user", arguments: args } });
  return pending;
}

describe("ask_user MCP server over a real pipe", () => {
  it("answers initialize and tools/list without touching the host", async () => {
    // Codex aborts an MCP server that is slow to start, so these must not wait
    // on the pipe, on the handshake, or on anything else.
    const h = await boot();
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const init = await h.reply(1);
    expect(init.result.serverInfo.name).toBe(ASK_USER_SERVER_NAME);

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = await h.reply(2);
    expect(tools.result.tools.map((t: any) => t.name)).toEqual(["ask_user"]);
    expect(h.requests).toHaveLength(0);
  });

  it("carries a question to the host and the answer back to the tool call", async () => {
    const h = await boot();
    const call = callAskUser(h, 3, {
      questions: [{ question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }] }],
    });
    const [request] = await h.waitForRequests(1);
    expect(request.questions[0].question).toBe("Which database?");
    expect(request.questions[0].options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);

    expect(request.answer({ "Which database?": "Postgres" }, {})).toBe(true);
    const result = await call;
    expect(result.result.content[0].text).toBe("Which database?: Postgres");
    expect(result.result.isError).toBeUndefined();
  });

  it("carries a cancel back as a result the model can keep working from", async () => {
    const h = await boot();
    const call = callAskUser(h, 4, { questions: [{ question: "Ship it?" }] });
    const [request] = await h.waitForRequests(1);
    expect(request.cancel()).toBe(true);
    const result = await call;
    expect(result.result.content[0].text).toMatch(/dismissed/);
    expect(result.result.isError).toBeUndefined();
  });

  it("says a timeout continued the card, not that the user chose", async () => {
    const h = await boot();
    const call = callAskUser(h, 5, { questions: [{ question: "Which?", options: ["A", "B"] }] });
    const [request] = await h.waitForRequests(1);
    // What the host's auto-continue does with a complete draft.
    expect(request.answer({ "Which?": "A" }, {}, true)).toBe(true);
    const result = await call;
    expect(result.result.content[0].text).toContain("continued automatically");
    expect(result.result.content[0].text).toContain("Which?: A");
  });

  it("ignores a second answer to the same question", async () => {
    // The stale-card invariant, on this side of the pipe: a card replayed from
    // the session buffer or still open in a second tab must not answer twice.
    const h = await boot();
    const call = callAskUser(h, 6, { questions: [{ question: "Once?" }] });
    const [request] = await h.waitForRequests(1);
    expect(request.answer({ "Once?": "yes" }, {})).toBe(true);
    expect(request.answer({ "Once?": "no" }, {})).toBe(false);
    expect(request.cancel()).toBe(false);
    expect((await call).result.content[0].text).toBe("Once?: yes");
    expect(h.server.openCount).toBe(0);
  });

  it("returns a repair message as a tool result rather than failing the call", async () => {
    const h = await boot();
    const result = await callAskUser(h, 7, { questions: [{ header: "no question" }] });
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toMatch(/`question`/);
    expect(result.error).toBeUndefined();
    expect(h.requests).toHaveLength(0);
  });

  it("refuses a wrong token, and the refused child exits instead of lingering", async () => {
    // On Windows the pipe has no permissions of its own; the token IS the access
    // control. A refused child is one the host has no session for, so it leaves
    // rather than sit in the CLI's process table answering nothing — the CLI
    // then reports a dead MCP server, which is at least visible. (A token that
    // is revoked LATER is a different path: the host drops the socket, the child
    // stays up, and in-flight calls come back "not reachable" — see the two
    // tests below.)
    const h = await boot({ badToken: true });
    const exit = await new Promise<number | null>((resolve) => h.child.once("exit", resolve));
    expect(exit).toBe(0);
    expect(h.requests).toHaveLength(0);
  });

  it("takes the card down when the client dies mid-question", async () => {
    const h = await boot();
    void callAskUser(h, 9, { questions: [{ question: "Still there?" }] });
    const [request] = await h.waitForRequests(1);
    h.child.kill();
    const deadline = Date.now() + 10_000;
    while (!h.withdrawn.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(h.withdrawn).toEqual([request.id]);
    expect(h.server.openCount).toBe(0);
  });

  it("answers every in-flight call when the host goes away mid-question", async () => {
    // Window reload and extension deactivation both land on dispose(). Without
    // this the CLI sits inside tools/call for the rest of its life.
    const h = await boot();
    const call = callAskUser(h, 10, { questions: [{ question: "Waiting?" }] });
    await h.waitForRequests(1);
    h.server.dispose();
    const result = await call;
    expect(result.result.content[0].text).toMatch(/dismissed|not reachable/);
  });

  it("cancels a session's open questions when its token is revoked", async () => {
    // A session restart revokes; the old CLI's child must not be left blocked.
    const h = await boot();
    const call = callAskUser(h, 11, { questions: [{ question: "Restarting?" }] });
    await h.waitForRequests(1);
    h.server.revoke(h.token);
    expect(h.server.openCount).toBe(0);
    const result = await call;
    expect(result.result.content[0].text).toMatch(/dismissed|not reachable/);
    expect(h.server.spawnSpec(h.token)).toBeUndefined();
  });
});

describe("the spawn spec handed to the CLI", () => {
  it("puts the address and token in env and only the script in argv", async () => {
    const server = new AskUserServer({
      scriptPath: SCRIPT,
      log: () => { /* quiet */ },
      onRequest: () => { /* unused */ },
      onWithdraw: () => { /* unused */ },
    });
    started.push({ server });
    await server.listen();
    const spec = server.spawnSpec(server.register())!;

    expect(spec.args).toEqual([SCRIPT]);
    // The process list is readable by anything on the machine.
    expect(spec.args.join(" ")).not.toContain("pipe");
    const env = Object.fromEntries(spec.env.map((e) => [e.name, e.value]));
    // Same pattern as claude-backend.ts: this binary re-entered as plain Node.
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(spec.command).toBe(process.execPath);
    expect(env[ASK_USER_ADDRESS_ENV]).toBeTruthy();
    expect(env[ASK_USER_TOKEN_ENV]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hands out nothing once disposed", async () => {
    const server = new AskUserServer({
      scriptPath: SCRIPT,
      log: () => { /* quiet */ },
      onRequest: () => { /* unused */ },
      onWithdraw: () => { /* unused */ },
    });
    await server.listen();
    const token = server.register();
    server.dispose();
    expect(server.spawnSpec(token)).toBeUndefined();
    expect(await server.listen()).toBeUndefined();
  });
});
