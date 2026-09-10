// AP-16 — the real pipe, the real script, no CLI.
//
// Sibling of `test/ask-user-ipc.test.ts`: this file starts
// `resources/mcp/companions-server.cjs` as an actual child process and speaks
// MCP JSON-RPC to its stdin/stdout, exactly as a CLI would. It NEVER starts a
// grok/claude/codex/gemini binary — the suite is binary-free and stays that
// way; the child here is plain Node running our own script.
//
// The cases are the ones that leave something hanging when they are wrong: a
// result that never arrives, a client that dies mid-call, a host that dies
// mid-call, a revoked session, a bad token, an oversized frame. Each of those,
// done wrong, is a CLI blocked inside `tools/call` with no timeout of its own —
// and, worse than for a question card, a subagent still burning a subscription
// for a parent that is never told about it.
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import * as readline from "node:readline";
import {
  COMPANIONS_ADDRESS_ENV,
  COMPANIONS_AWAIT_TOOL,
  COMPANIONS_LIST_TOOL,
  COMPANIONS_PRIMER,
  COMPANIONS_SERVER_NAME,
  COMPANIONS_SPAWN_TOOL,
  COMPANIONS_TOKEN_ENV,
  COMPANIONS_TOOL_NAMES,
} from "../src/companions-protocol";
import { CompanionsHostServer, type CompanionsCall } from "../src/companions-server";
import { AskUserServer } from "../src/ask-user-server";
import { HostPipeMux } from "../src/host-pipe-mux";
import * as net from "node:net";

const ASK_USER_SCRIPT = path.join(__dirname, "..", "resources", "mcp", "ask-user-server.cjs");
import { GENERATOR_PRIMER, GENERATOR_TOOL_NAMES } from "../src/workflow-generator";

const SCRIPT = path.join(__dirname, "..", "resources", "mcp", "companions-server.cjs");

const started: Array<{
  server?: { dispose(): void };
  child?: ChildProcessWithoutNullStreams;
}> = [];

afterEach(() => {
  for (const { server, child } of started.splice(0)) {
    try { server?.dispose(); } catch { /* already down */ }
    try { child?.kill(); } catch { /* already gone */ }
  }
});

interface Harness {
  server: CompanionsHostServer;
  /** Calls the host was asked to answer, oldest first. */
  calls: CompanionsCall[];
  /** Ids the host was told to give up on. */
  abandoned: string[];
  token: string;
  child: ChildProcessWithoutNullStreams;
  send(message: unknown): void;
  reply(id: number): Promise<any>;
  waitForCalls(n: number): Promise<CompanionsCall[]>;
}

async function boot(options: { badToken?: boolean; noAddress?: boolean; mode?: "delegate" | "generator" } = {}): Promise<Harness> {
  const calls: CompanionsCall[] = [];
  const abandoned: string[] = [];
  const server = new CompanionsHostServer({
    scriptPath: SCRIPT,
    log: () => { /* quiet in tests */ },
    onCall: (_token, call) => { calls.push(call); },
    onAbandon: (_token, id) => { abandoned.push(id); },
  });
  started.push({ server });
  const address = await server.listen();
  expect(address, "the pipe must bind for this test to mean anything").toBeTruthy();
  const token = server.register(options.mode ?? "delegate");

  const spec = server.spawnSpec(token)!;
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const entry of spec.env) env[entry.name] = entry.value;
  if (options.badToken) env[COMPANIONS_TOKEN_ENV] = "not-a-real-token";
  if (options.noAddress) delete env[COMPANIONS_ADDRESS_ENV];
  const child = spawn(process.execPath, spec.args, { env, stdio: ["pipe", "pipe", "pipe"] });
  started[started.length - 1].child = child;

  const replies = new Map<number, (value: any) => void>();
  const pending = new Map<number, any>();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message: any;
    try { message = JSON.parse(line); } catch { return; }
    if (typeof message?.id !== "number") return;
    const waiter = replies.get(message.id);
    if (waiter) { replies.delete(message.id); waiter(message); }
    else pending.set(message.id, message);
  });

  return {
    server,
    calls,
    abandoned,
    token,
    child,
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    reply: (id) => new Promise((resolve) => {
      const already = pending.get(id);
      if (already) { pending.delete(id); resolve(already); return; }
      replies.set(id, resolve);
    }),
    waitForCalls: async (n) => {
      // Wait on the CONDITION, not on a fixed sleep.
      const deadline = Date.now() + 10_000;
      while (calls.length < n) {
        if (Date.now() > deadline) throw new Error(`only ${calls.length} of ${n} calls arrived`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return calls;
    },
  };
}

function callTool(h: Harness, id: number, name: string, args: unknown): Promise<any> {
  const pending = h.reply(id);
  h.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return pending;
}

const parsePayload = (reply: any) => JSON.parse(reply.result.content[0].text);

describe("companions MCP server over a real pipe", () => {
  it("answers initialize and tools/list without touching the host", async () => {
    // Codex aborts an MCP server that is slow to start, so these must not wait
    // on the pipe, on the handshake, or on anything else.
    const h = await boot();
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    const init = await h.reply(1);
    expect(init.result.serverInfo.name).toBe(COMPANIONS_SERVER_NAME);

    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = await h.reply(2);
    expect(tools.result.tools.map((t: any) => t.name).sort())
      .toEqual([...COMPANIONS_TOOL_NAMES].sort());
    expect(h.calls).toHaveLength(0);
  });

  it("advertises exactly three tools — cancel and read are await actions", async () => {
    // §2.1 point 2. Six tools was the alternative, and it costs schema budget
    // in every parent turn for three verbs that are one argument.
    const h = await boot();
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = await h.reply(1);
    const names: string[] = tools.result.tools.map((t: any) => t.name);
    expect(names).toHaveLength(3);
    expect(names).not.toContain("companions_cancel_subagent");
    expect(names).not.toContain("companions_read_subagent_result");
    expect(names).not.toContain("companions_subagent_status");
    const awaitTool = tools.result.tools.find((t: any) => t.name === COMPANIONS_AWAIT_TOOL);
    expect(awaitTool.inputSchema.properties.action.enum).toEqual(["wait", "cancel", "read"]);
  });

  it("advertises generator tools (not spawn/await) when the token is a generator session", async () => {
    const h = await boot({ mode: "generator" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await h.reply(1);
    expect(init.result.instructions).toBe(GENERATOR_PRIMER);
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const tools = await h.reply(2);
    const names: string[] = tools.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([...GENERATOR_TOOL_NAMES].slice().sort());
    expect(names).not.toContain(COMPANIONS_SPAWN_TOOL);
    expect(names).not.toContain(COMPANIONS_AWAIT_TOOL);
    expect(names).toContain(COMPANIONS_LIST_TOOL);
  });

  it("carries the primer in the server's instructions once the host is up", async () => {
    // §6.9: the primer travels in `instructions` and nowhere else, because a
    // hidden primer TURN is what this repository deliberately retired.
    const h = await boot();
    // Give the handshake a moment; initialize is served from constants and the
    // primer only exists after the host answers, which is why it is asserted
    // on a later initialize rather than the first.
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const init = await h.reply(1);
    expect(init.result.instructions).toBe(COMPANIONS_PRIMER);
    expect(init.result.instructions).toContain("never this conversation");
    // Non-goal 4: the native tool keeps working, and the primer is where the
    // two are told apart.
    expect(init.result.instructions).toContain("native Task/spawn_subagent");
  });

  it("keeps the primer out of the tool descriptions", async () => {
    // §2.1 point 2: descriptions are two or three sentences. A primer repeated
    // per tool is the same instruction tax paid three times per turn.
    const h = await boot();
    await new Promise((resolve) => setTimeout(resolve, 300));
    h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = await h.reply(1);
    for (const tool of tools.result.tools) {
      expect(tool.description.length).toBeLessThan(320);
      expect(tool.description).not.toContain("Honour <companions-subagent-directives>");
    }
  });

  it("routes a spawn to the host and returns its payload as JSON", async () => {
    const h = await boot();
    const pending = callTool(h, 1, COMPANIONS_SPAWN_TOOL, { task: "map the auth callers" });
    const [call] = await h.waitForCalls(1);
    expect(call.tool).toBe(COMPANIONS_SPAWN_TOOL);
    expect((call.args as any).task).toBe("map the auth callers");
    call.resolve({ subagentId: "sa_1", status: "completed", result: { summary: "17 call sites" } });
    const payload = parsePayload(await pending);
    expect(payload).toMatchObject({ subagentId: "sa_1", status: "completed" });
  });

  it("passes list and await through the same channel", async () => {
    const h = await boot();
    const listPending = callTool(h, 1, COMPANIONS_LIST_TOOL, {});
    const [listCall] = await h.waitForCalls(1);
    listCall.resolve({ targets: [] });
    expect(parsePayload(await listPending)).toEqual({ targets: [] });

    const awaitPending = callTool(h, 2, COMPANIONS_AWAIT_TOOL, { ids: ["sa_1"] });
    const calls = await h.waitForCalls(2);
    calls[1].resolve({ completed: [], running: ["sa_1"], unknown: [] });
    expect(parsePayload(await awaitPending)).toMatchObject({ running: ["sa_1"] });
  });

  it("refuses a spawn with no task as a RESULT, not a JSON-RPC error", async () => {
    // An error kills the turn; a result the model can read lets it fix the call
    // inside the same turn.
    const h = await boot();
    const reply = await callTool(h, 1, COMPANIONS_SPAWN_TOOL, { label: "no task here" });
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain("`task` is required");
    expect(h.calls).toHaveLength(0);
  });

  it("refuses an await with no ids the same way", async () => {
    const h = await boot();
    const reply = await callTool(h, 1, COMPANIONS_AWAIT_TOOL, { ids: [] });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain("`ids` is required");
  });

  it("rejects an unknown tool name", async () => {
    const h = await boot();
    const reply = await callTool(h, 1, "companions_do_whatever", {});
    expect(reply.error.code).toBe(-32602);
  });

  it("tells the model to continue alone when its token is refused", async () => {
    // Not an error result: a main agent whose delegation channel died must keep
    // working rather than fail the turn. And the script must STAY UP — unlike
    // the ask_user server, whose whole job ends with the host. §6.4.1: losing
    // the channel costs the session its delegation tools and nothing else.
    const h = await boot({ badToken: true });
    const reply = await callTool(h, 1, COMPANIONS_SPAWN_TOOL, { task: "anything" });
    expect(reply.result.isError).toBeUndefined();
    expect(reply.result.content[0].text).toContain("Continue alone and tell the user why");
    expect(h.calls).toHaveLength(0);
    // Still answering, so the CLI never sees a dead MCP server.
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await h.reply(2)).result.tools).toHaveLength(3);
  });

  it("keeps serving when no address was configured at all", async () => {
    // The pipe never bound (a locked-down machine, an unwritable tmpdir). The
    // session still starts; it just cannot delegate.
    const h = await boot({ noAddress: true });
    const reply = await callTool(h, 1, COMPANIONS_LIST_TOOL, {});
    expect(reply.result.content[0].text).toContain("Continue alone and tell the user why");
  });

  it("settles an in-flight call when the session is revoked", async () => {
    // Session restart. Without this the CLI sits inside `tools/call` for ever.
    const h = await boot();
    const pending = callTool(h, 1, COMPANIONS_SPAWN_TOOL, { task: "long job" });
    const [call] = await h.waitForCalls(1);
    h.server.revoke(h.token);
    const reply = await pending;
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toContain("session");
    // And the sidebar is told, so the child it started is cancelled too.
    expect(h.abandoned).toContain(call.id);
  });

  it("settles an in-flight call when the host is disposed", async () => {
    // Window reload and extension deactivation both land here.
    const h = await boot();
    const pending = callTool(h, 1, COMPANIONS_SPAWN_TOOL, { task: "long job" });
    await h.waitForCalls(1);
    h.server.dispose();
    const reply = await pending;
    expect(reply.result.isError).toBe(true);
    // `dispose` revokes every token first, so the reason names the session —
    // which is the accurate one: the session is what went away.
    expect(reply.result.content[0].text).toMatch(/session|editor/);
  });

  it("tells the sidebar to cancel when the CLI's child dies mid-call", async () => {
    // The parent CLI is gone, so nothing is waiting for this result — but the
    // subagent is still running and still spending a subscription.
    const h = await boot();
    void callTool(h, 1, COMPANIONS_SPAWN_TOOL, { task: "long job" });
    const [call] = await h.waitForCalls(1);
    h.child.kill();
    const deadline = Date.now() + 10_000;
    while (!h.abandoned.includes(call.id)) {
      if (Date.now() > deadline) throw new Error("the host was never told the call was abandoned");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(h.server.openCount).toBe(0);
  });

  it("answers exactly once, so a late second resolve cannot desynchronize the child", async () => {
    const h = await boot();
    const pending = callTool(h, 1, COMPANIONS_SPAWN_TOOL, { task: "one job" });
    const [call] = await h.waitForCalls(1);
    expect(call.resolve({ subagentId: "sa_1", status: "completed" })).toBe(true);
    expect(call.resolve({ subagentId: "sa_1", status: "failed" })).toBe(false);
    expect(call.open).toBe(false);
    expect(parsePayload(await pending)).toMatchObject({ status: "completed" });
  });

  it("keeps two sessions' calls apart", async () => {
    // §12.1: a token for session A can never spawn on behalf of session B. The
    // ids the two scripts use both start at 1, so the host namespaces them.
    const h = await boot();
    const secondToken = h.server.register();
    const spec = h.server.spawnSpec(secondToken)!;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of spec.env) env[entry.name] = entry.value;
    const second = spawn(process.execPath, spec.args, { env, stdio: ["pipe", "pipe", "pipe"] });
    started.push({ child: second });

    void callTool(h, 1, COMPANIONS_SPAWN_TOOL, { task: "from session A" });
    second.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: COMPANIONS_SPAWN_TOOL, arguments: { task: "from session B" } },
    })}\n`);

    const calls = await h.waitForCalls(2);
    expect(calls[0].id).not.toBe(calls[1].id);
    const tasks = calls.map((call) => (call.args as any).task).sort();
    expect(tasks).toEqual(["from session A", "from session B"]);

    // Revoking A must leave B's call untouched.
    h.server.revoke(h.token);
    const bStillOpen = calls.find((call) => (call.args as any).task === "from session B")!;
    expect(bStillOpen.open).toBe(true);
  });

  it("hands over a spawn spec whose secrets live in env, never in argv", async () => {
    // On Windows the pipe has no ACL at all, so the token IS the access
    // control — and argv is readable by every process on the machine.
    const h = await boot();
    const spec = h.server.spawnSpec(h.token)!;
    expect(spec.args.join(" ")).not.toContain(h.token);
    expect(spec.env.map((e) => e.name)).toContain(COMPANIONS_TOKEN_ENV);
    expect(spec.env.find((e) => e.name === "ELECTRON_RUN_AS_NODE")?.value).toBe("1");
  });

  it("hands over no spec for a token it does not know", async () => {
    const h = await boot();
    expect(h.server.spawnSpec("some-other-token")).toBeUndefined();
    h.server.revoke(h.token);
    expect(h.server.spawnSpec(h.token)).toBeUndefined();
  });

  it("binds a window pipe rather than one of its own (P6)", async () => {
    // v1 shipped two listeners (§6.4.1) and P6 multiplexes them. The address is
    // the shared one, and the token — not the address — is what routes a
    // connection to the right protocol.
    const h = await boot();
    const spec = h.server.spawnSpec(h.token)!;
    const address = spec.env.find((e) => e.name.endsWith("ADDRESS"))!.value;
    expect(address).toContain("companions-host");
  });
});

describe("one pipe, two protocols (P6, §16)", () => {
  it("routes each connection to the protocol that minted its token", async () => {
    // The whole multiplex rests on this: tokens are 256 bits of randomness
    // minted per server, so a token one side knows is by construction not one
    // the other knows. Nothing in either wire format had to change.
    const mux = new HostPipeMux({ log: () => {} });
    const questions: string[] = [];
    const calls: string[] = [];

    const askUser = new AskUserServer({
      scriptPath: ASK_USER_SCRIPT,
      log: () => {},
      mux,
      onRequest: (_token, request) => { questions.push(request.questions[0].question); request.cancel(); },
      onWithdraw: () => {},
    });
    const companions = new CompanionsHostServer({
      scriptPath: SCRIPT,
      log: () => {},
      mux,
      onCall: (_token, call) => { calls.push(call.tool); call.resolve({ ok: true }); },
      onAbandon: () => {},
    });
    started.push({ server: askUser }, { server: companions });

    const address = await askUser.listen();
    expect(address, "the shared pipe must bind").toBeTruthy();
    // Both protocols answer with the SAME address — that is the point.
    expect(await companions.listen()).toBe(address);

    const askSpec = askUser.spawnSpec(askUser.register())!;
    const delegateSpec = companions.spawnSpec(companions.register("delegate"))!;
    const addressOf = (spec: { env: { name: string; value: string }[] }) =>
      spec.env.find((entry) => entry.name.endsWith("ADDRESS"))!.value;
    expect(addressOf(askSpec)).toBe(addressOf(delegateSpec));
    // Two entries in `mcpServers` still, because the CLI needs two stdio
    // servers — one pipe underneath them, not one server.
    expect(askSpec.name).not.toBe(delegateSpec.name);

    const spawnChild = (spec: { args: string[]; env: { name: string; value: string }[] }) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const entry of spec.env) env[entry.name] = entry.value;
      const child = spawn(process.execPath, spec.args, { env, stdio: ["pipe", "pipe", "pipe"] });
      started.push({ child });
      return child;
    };
    const askChild = spawnChild(askSpec);
    const delegateChild = spawnChild(delegateSpec);

    askChild.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "ask_user", arguments: { questions: [{ question: "Which one?" }] } },
    }) + "\n");
    delegateChild.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: COMPANIONS_SPAWN_TOOL, arguments: { task: "map the callers" } },
    }) + "\n");

    const deadline = Date.now() + 10_000;
    while (!questions.length || !calls.length) {
      if (Date.now() > deadline) {
        throw new Error("routing failed: " + questions.length + " question(s), " + calls.length + " call(s)");
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Each side got its own traffic and none of the other's.
    expect(questions).toEqual(["Which one?"]);
    expect(calls).toEqual([COMPANIONS_SPAWN_TOOL]);
    mux.dispose();
  });

  it("refuses a token neither protocol minted, and the client keeps serving", async () => {
    const mux = new HostPipeMux({ log: () => {} });
    const companions = new CompanionsHostServer({
      scriptPath: SCRIPT,
      log: () => {},
      mux,
      onCall: () => {},
      onAbandon: () => {},
    });
    started.push({ server: companions });
    const address = await companions.listen();
    expect(address).toBeTruthy();
    const spec = companions.spawnSpec(companions.register())!;
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of spec.env) env[entry.name] = entry.value;
    env[COMPANIONS_TOKEN_ENV] = "not-a-real-token";
    const child = spawn(process.execPath, spec.args, { env, stdio: ["pipe", "pipe", "pipe"] });
    started.push({ child });

    const replies: any[] = [];
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      try { replies.push(JSON.parse(line)); } catch { /* not ours */ }
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: COMPANIONS_SPAWN_TOOL, arguments: { task: "anything" } },
    }) + "\n");

    const deadline = Date.now() + 10_000;
    while (!replies.length) {
      if (Date.now() > deadline) throw new Error("the refused client never answered its CLI");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // Refused, and still answering its CLI rather than leaving `tools/call`
    // hanging — the same rule as before the multiplex.
    expect(replies[0].result.content[0].text).toContain("Continue alone and tell the user why");
    mux.dispose();
  });

  it("answers a bad handshake with denied and stops talking to the peer", async () => {
    // An unknown peer holding a handle on the window's pipe. Before the
    // handshake there is nothing to settle, so the only correct answer is to
    // refuse it and hang up.
    const mux = new HostPipeMux({ log: () => {} });
    const companions = new CompanionsHostServer({
      scriptPath: SCRIPT,
      log: () => {},
      mux,
      onCall: () => {},
      onAbandon: () => {},
    });
    started.push({ server: companions });
    const address = (await companions.listen())!;
    const socket = net.createConnection(address);
    const seen: string[] = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => seen.push(chunk));
    socket.write(JSON.stringify({ t: "hello", v: 1, token: "wrong" }) + "\n");

    const deadline = Date.now() + 10_000;
    while (!seen.length) {
      if (Date.now() > deadline) throw new Error("the mux never answered a bad handshake");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(seen.join("")).toContain('"denied"');
    socket.destroy();
    mux.dispose();
  });
});
