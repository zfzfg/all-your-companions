#!/usr/bin/env node
"use strict";
/**
 * AP-16 — the companion-subagent delegation MCP server the CLI spawns.
 *
 * The CLI owns this process's stdin/stdout and speaks MCP JSON-RPC over them.
 * The work, though, happens in the VS Code extension host, which is a different
 * process entirely — so this script keeps a second connection open on a named
 * pipe (Windows) or unix socket (POSIX) whose address and token arrive through
 * the ENVIRONMENT. Not argv: the process list is readable by anything on the
 * machine, and a Windows named pipe has no permissions of its own.
 *
 * Sibling of `ask-user-server.cjs`, and the same three properties are
 * load-bearing and easy to break:
 *
 * 1. **It answers immediately.** `initialize` and `tools/list` are served from
 *    constants, before and regardless of the pipe. Codex kills an MCP server
 *    that is slow to start (`startup_timeout_sec`), so nothing on the startup
 *    path may wait for I/O.
 * 2. **No dependencies and no build step.** Plain CommonJS, shipped as-is in
 *    the VSIX and run by `process.execPath` with `ELECTRON_RUN_AS_NODE=1`. It
 *    cannot import `src/companions-protocol.ts`, so the shared constants are
 *    restated below and `test/companions-server.test.ts` pins the two copies
 *    against each other.
 * 3. **It never leaves a `tools/call` hanging.** If the host goes away, every
 *    in-flight call is answered here rather than left for a CLI that has no
 *    timeout of its own.
 *
 * The server carries the delegation primer in `initialize`'s `instructions`
 * field, which §6.9 makes the ONLY channel for it — tool descriptions stay two
 * or three sentences and must not repeat it.
 */
const net = require("node:net");
const readline = require("node:readline");

// --- shared with src/companions-protocol.ts (kept in step by a test) -------
const COMPANIONS_SERVER_NAME = "companions_subagents";
const COMPANIONS_LIST_TOOL = "companions_list_subagent_targets";
const COMPANIONS_SPAWN_TOOL = "companions_spawn_subagent";
const COMPANIONS_AWAIT_TOOL = "companions_await_subagents";
const COMPANIONS_ADDRESS_ENV = "COMPANIONS_DELEGATE_ADDRESS";
const COMPANIONS_TOKEN_ENV = "COMPANIONS_DELEGATE_TOKEN";
const COMPANIONS_IPC_VERSION = 1;
const COMPANIONS_LABEL_MAX = 60;
const COMPANIONS_MIN_TIMEOUT_SEC = 30;
const COMPANIONS_MAX_AWAIT_IDS = 32;

/**
 * The tool list and the primer are handed over by the HOST at handshake time,
 * because both are generated from `ACP_PROVIDERS` and `EffortLevel` (D12) and
 * this script has no way to import them. Until the handshake completes, the
 * fallback below is advertised: it names the three tools with their required
 * fields, so a CLI that lists tools before the pipe is up gets a usable — if
 * enum-less — schema rather than nothing.
 */
const FALLBACK_TOOLS = [
  {
    name: COMPANIONS_LIST_TOOL,
    description:
      "List the providers you may currently launch a companion subagent on, with the user's own notes on each. Compact by default; pass `expand` with one provider id to see that provider's model list.",
    inputSchema: {
      type: "object",
      properties: {
        includeIneligible: { type: "boolean" },
        expand: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: COMPANIONS_SPAWN_TOOL,
    description:
      "Start a companion subagent on another provider with a self-contained task. It sees only what you pass here, never this conversation. Returns its result, or `running` plus an id to collect with the await tool.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string" },
        label: { type: "string", maxLength: COMPANIONS_LABEL_MAX },
        provider: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
        role: { type: "string" },
        profile: { type: "string" },
        scope: { type: "array", items: { type: "string" } },
        context: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        deliverable: { type: "string" },
        acceptance: { type: "string" },
        wait: { type: "string", enum: ["until_done", "none"] },
        timeoutSec: { type: "integer", minimum: COMPANIONS_MIN_TIMEOUT_SEC },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: COMPANIONS_AWAIT_TOOL,
    description:
      "Collect, cancel or read companion subagents you started. `action` is wait (the default), cancel, or read; `maxWaitSec: 0` is a status poll. A wait that returns before a child is done is normal — call again.",
    inputSchema: {
      type: "object",
      properties: {
        ids: { type: "array", items: { type: "string" }, minItems: 1 },
        action: { type: "string", enum: ["wait", "cancel", "read"] },
        mode: { type: "string", enum: ["all", "any"] },
        maxWaitSec: { type: "integer", minimum: 0 },
        offset: { type: "integer", minimum: 0 },
        length: { type: "integer", minimum: 1 },
        reason: { type: "string" },
      },
      required: ["ids"],
      additionalProperties: false,
    },
  },
];

const TOOL_NAMES = [COMPANIONS_LIST_TOOL, COMPANIONS_SPAWN_TOOL, COMPANIONS_AWAIT_TOOL];

/** Replaced by the host's generated copy the moment the handshake lands. */
let tools = FALLBACK_TOOLS;
let primer = "";

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// --- stdout ---------------------------------------------------------------

function writeStdout(message) {
  try {
    process.stdout.write(JSON.stringify(message) + "\n");
  } catch {
    /* the CLI closed our stdout; nothing left to say */
  }
}
function reply(id, result) {
  if (id === undefined || id === null) return; // a notification has no reply
  writeStdout({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  if (id === undefined || id === null) return;
  writeStdout({ jsonrpc: "2.0", id, error: { code, message } });
}

// --- host connection ------------------------------------------------------

const address = process.env[COMPANIONS_ADDRESS_ENV] || "";
const token = process.env[COMPANIONS_TOKEN_ENV] || "";

/** callId -> { resolve } for calls waiting on the host. */
const waiting = new Map();
let nextCallId = 1;
let socket;
/** undefined while connecting, true once the host said `ready`, false if the
 *  handshake failed or the connection died. */
let ready;
/** Resolvers for calls that arrived before the handshake settled. */
const readyWaiters = [];

function settleReady(value) {
  if (ready !== undefined) return;
  ready = value;
  for (const waiter of readyWaiters.splice(0)) waiter(value);
}

function whenReady() {
  if (ready !== undefined) return Promise.resolve(ready);
  return new Promise((resolve) => readyWaiters.push(resolve));
}

/** Answer every waiting `tools/call` rather than let the CLI block for ever. */
function failAllWaiting() {
  for (const [, entry] of waiting) entry.resolve(undefined);
  waiting.clear();
}

function connect() {
  if (!address || !token) {
    settleReady(false);
    return;
  }
  socket = net.createConnection(address, () => {
    try {
      socket.write(JSON.stringify({ t: "hello", v: COMPANIONS_IPC_VERSION, token }) + "\n");
    } catch {
      settleReady(false);
    }
  });
  socket.setEncoding("utf8");
  const lines = readline.createInterface({ input: socket });
  lines.on("line", (line) => {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return; // a line we cannot read is not a reason to die
    }
    if (!isRecord(frame)) return;
    if (frame.t === "ready") {
      // The host generates the schemas from its own enums, so its copy wins the
      // moment it arrives — that is what keeps provider and effort lists out of
      // this file (D12).
      if (Array.isArray(frame.tools) && frame.tools.length) tools = frame.tools;
      if (typeof frame.instructions === "string") primer = frame.instructions;
      settleReady(true);
      return;
    }
    if (frame.t === "denied") {
      // The host does not know this token: this session's delegation is gone.
      //
      // Deliberately DIFFERENT from ask-user-server.cjs, which exits here. A
      // question server with no host has nothing left to do, but this one does:
      // the main agent's own session is still alive and still working, and
      // killing the MCP server mid-run makes the CLI report a dead server for a
      // capability the agent can simply do without. §6.4.1 sets the rule — a
      // channel that cannot come up costs the session its delegation tools and
      // nothing else. So stay up, and answer every later call with "could not
      // reach the editor; continue alone".
      settleReady(false);
      failAllWaiting();
      try { socket.destroy(); } catch { /* already gone */ }
      return;
    }
    if (frame.t === "result") {
      const entry = waiting.get(String(frame.id));
      if (!entry) return; // a duplicate or late result — deliberately inert
      waiting.delete(String(frame.id));
      entry.resolve(frame);
    }
  });
  const lost = () => {
    settleReady(false);
    failAllWaiting();
  };
  socket.on("error", lost);
  socket.on("close", lost);
}

function callHost(tool, args) {
  return whenReady().then((connected) => {
    if (!connected || !socket || socket.destroyed) return undefined;
    const id = String(nextCallId++);
    return new Promise((resolve) => {
      waiting.set(id, { resolve });
      try {
        socket.write(JSON.stringify({ t: "call", id, tool, args }) + "\n");
      } catch {
        waiting.delete(id);
        resolve(undefined);
      }
    });
  });
}

// --- argument repair ------------------------------------------------------
//
// Tolerant by design: a schema that rejects makes the model avoid the tool or
// fail the turn. The HOST re-validates everything anyway — this pass exists so
// an obviously fixable call is not bounced back at the model as an error.

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function localValidation(tool, args) {
  const record = isRecord(args) ? args : {};
  if (tool === COMPANIONS_SPAWN_TOOL) {
    if (!trimmed(record.task)) {
      return "`task` is required: say what the subagent should do, self-contained (it cannot see this conversation).";
    }
    return undefined;
  }
  if (tool === COMPANIONS_AWAIT_TOOL) {
    const ids = Array.isArray(record.ids) ? record.ids.filter((id) => trimmed(id)) : [];
    if (!ids.length) return "`ids` is required: pass the subagent ids you got back from spawn.";
    if (ids.length > COMPANIONS_MAX_AWAIT_IDS) {
      // Trimmed rather than refused — the host answers about the ids it got.
      record.ids = ids.slice(0, COMPANIONS_MAX_AWAIT_IDS);
    }
    return undefined;
  }
  return undefined;
}

// --- request handling -----------------------------------------------------

function handle(message) {
  if (!isRecord(message)) return;
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      // Served from constants so the answer is on the wire in the same tick the
      // request arrived. See property 1 in the file head. `instructions` may
      // still be empty here if the pipe has not answered yet; the host resends
      // nothing, so a CLI that reads it later gets the value from tools/list
      // time instead.
      reply(id, {
        protocolVersion: isRecord(params) && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: COMPANIONS_SERVER_NAME, version: "1.0.0" },
        ...(primer ? { instructions: primer } : {}),
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return; // notification, no reply
    case "tools/list":
      reply(id, { tools });
      return;
    case "resources/list":
      reply(id, { resources: [] });
      return;
    case "prompts/list":
      reply(id, { prompts: [] });
      return;
    case "ping":
      reply(id, {});
      return;
    case "tools/call": {
      const name = isRecord(params) ? params.name : undefined;
      if (!TOOL_NAMES.includes(name)) {
        replyError(id, -32602, "Unknown tool: " + String(name));
        return;
      }
      const args = isRecord(params) ? params.arguments : undefined;
      const problem = localValidation(name, args);
      if (problem) {
        // A tool RESULT, not a JSON-RPC error: the model reads the text and can
        // fix its call inside the same turn.
        reply(id, { content: [{ type: "text", text: problem }], isError: true });
        return;
      }
      callHost(name, args).then((frame) => {
        if (!frame) {
          reply(id, {
            content: [{
              type: "text",
              text: name + " could not reach the editor, so no subagent was started. Continue alone and tell the user why.",
            }],
          });
          return;
        }
        if (typeof frame.error === "string" && frame.error) {
          reply(id, { content: [{ type: "text", text: frame.error }], isError: true });
          return;
        }
        // JSON, not prose: these payloads carry reconciliation lists the model
        // compares field by field, and delimited fields are what make a result
        // read as data rather than as instructions (§6.7).
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(frame.payload, null, 2) }],
        });
      });
      return;
    }
    case "shutdown":
      reply(id, {});
      return;
    default:
      replyError(id, -32601, "Method not found: " + String(method));
  }
}

const stdin = readline.createInterface({ input: process.stdin });
stdin.on("line", (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return; // never crash on the CLI's input
  }
  // A batch is legal JSON-RPC and cheap to honour.
  if (Array.isArray(message)) { for (const one of message) handle(one); return; }
  handle(message);
});
stdin.on("close", () => {
  try { socket && socket.destroy(); } catch { /* already gone */ }
  process.exit(0);
});

process.on("uncaughtException", (error) => {
  // Staying up with a broken pipe would block the CLI; exiting lets it report
  // a dead MCP server, which is at least visible.
  try { process.stderr.write("[companions] " + (error && error.message) + "\n"); } catch { /* ignore */ }
  process.exit(1);
});

connect();
