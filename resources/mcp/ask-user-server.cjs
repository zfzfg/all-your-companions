#!/usr/bin/env node
"use strict";
/**
 * AP-05 — the `ask_user` MCP server the CLI spawns.
 *
 * The CLI owns this process's stdin/stdout and speaks MCP JSON-RPC over them.
 * The answer, though, has to come from the VS Code extension host, which is a
 * different process entirely — so this script keeps a second connection open on
 * a named pipe (Windows) or unix socket (POSIX) whose address and token arrive
 * through the ENVIRONMENT. Not argv: the process list is readable by anything
 * on the machine, and a Windows named pipe has no permissions of its own.
 *
 * Three properties are load-bearing and easy to break:
 *
 * 1. **It answers immediately.** `initialize` and `tools/list` are served from
 *    constants, before and regardless of the pipe. Codex kills an MCP server
 *    that is slow to start (`startup_timeout_sec`), so nothing on the startup
 *    path may wait for I/O.
 * 2. **No dependencies and no build step.** It is plain CommonJS, shipped as-is
 *    in the VSIX and run by `process.execPath` with `ELECTRON_RUN_AS_NODE=1`.
 *    It cannot import `src/ask-user-protocol.ts`, so the shared constants are
 *    restated below and `test/ask-user-server.test.ts` pins the two copies
 *    against each other.
 * 3. **It never leaves a `tools/call` hanging.** If the host goes away, every
 *    in-flight call is answered here rather than left for a CLI that has no
 *    timeout of its own.
 */
const net = require("node:net");
const readline = require("node:readline");

// --- shared with src/ask-user-protocol.ts (kept in step by a test) ---------
const ASK_USER_SERVER_NAME = "companions";
const ASK_USER_TOOL_NAME = "ask_user";
const ASK_USER_ADDRESS_ENV = "COMPANIONS_ASK_USER_ADDRESS";
const ASK_USER_TOKEN_ENV = "COMPANIONS_ASK_USER_TOKEN";
const ASK_USER_IPC_VERSION = 1;
const ASK_USER_HEADER_MAX = 12;
const ASK_USER_MAX_QUESTIONS = 4;
const ASK_USER_MAX_OPTIONS = 4;

const TOOL = {
  name: ASK_USER_TOOL_NAME,
  description:
    "Ask the user a question with predefined options. Use ONLY when the answer changes what you do next.",
  inputSchema: {
    type: "object",
    properties: {
      questions: {
        type: "array",
        minItems: 1,
        maxItems: ASK_USER_MAX_QUESTIONS,
        description: "One to four questions to put to the user at once.",
        items: {
          type: "object",
          properties: {
            question: { type: "string", description: "The question, as the user will read it." },
            header: {
              type: "string",
              maxLength: ASK_USER_HEADER_MAX,
              description: "Short label for the question. Derived from the question if omitted.",
            },
            multiSelect: { type: "boolean", description: "Allow more than one option to be chosen." },
            options: {
              type: "array",
              minItems: 2,
              maxItems: ASK_USER_MAX_OPTIONS,
              description: "Choices to offer. Omit for a free-text answer.",
              items: {
                type: "object",
                properties: { label: { type: "string" }, description: { type: "string" } },
                required: ["label"],
              },
            },
          },
          required: ["question"],
        },
      },
    },
    required: ["questions"],
  },
};

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

function deriveHeader(question, max) {
  const clean = question.replace(/\s+/g, " ").trim().replace(/[?:.!]+$/, "");
  if (!clean) return "";
  if (clean.length <= max) return clean;
  let out = "";
  for (const word of clean.split(" ")) {
    const next = out ? out + " " + word : word;
    if (next.length > max) break;
    out = next;
  }
  return out || clean.slice(0, max);
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of value) {
    if (out.length >= ASK_USER_MAX_OPTIONS) break;
    const label = typeof raw === "string" ? raw.trim() : trimmed(isRecord(raw) ? raw.label : undefined);
    if (!label) continue;
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = trimmed(isRecord(raw) ? raw.description : undefined);
    out.push(description ? { label, description } : { label });
  }
  return out.length >= 2 ? out : [];
}

/** Tolerant by design — see the head of src/ask-user-protocol.ts. */
function normalizeArguments(args) {
  if (!isRecord(args)) return { ok: false, error: "ask_user needs an object with a `questions` array." };
  const rawList = Array.isArray(args.questions)
    ? args.questions
    : args.question !== undefined
      ? [args]
      : undefined;
  if (!rawList) return { ok: false, error: "ask_user needs a non-empty `questions` array." };
  const questions = [];
  for (const raw of rawList) {
    if (questions.length >= ASK_USER_MAX_QUESTIONS) break;
    const item = typeof raw === "string" ? { question: raw } : isRecord(raw) ? raw : undefined;
    if (!item) continue;
    const question = trimmed(item.question);
    if (!question) continue;
    const header = trimmed(item.header).slice(0, ASK_USER_HEADER_MAX) || deriveHeader(question, ASK_USER_HEADER_MAX);
    questions.push({
      question,
      header,
      multiSelect: item.multiSelect === true,
      options: normalizeOptions(item.options),
    });
  }
  if (!questions.length) {
    return { ok: false, error: "Every entry in `questions` needs a non-empty `question` string." };
  }
  return { ok: true, questions };
}

function formatResult(frame) {
  if (!frame || frame.outcome !== "accepted") {
    return {
      content: [{
        type: "text",
        text: frame && frame.auto
          ? "The question timed out and was continued automatically without an answer. Proceed with your best judgement and say which assumption you made."
          : "The user dismissed the question without answering. Proceed with your best judgement and say which assumption you made.",
      }],
    };
  }
  const lines = Object.entries(frame.answers || {}).map(([q, a]) => q + ": " + a);
  const notes = Object.entries(frame.annotations || {})
    .map(([q, ann]) => (ann && ann.notes ? q + " — note: " + ann.notes : ""))
    .filter(Boolean);
  const body = lines.concat(notes).join("\n");
  if (!body) return { content: [{ type: "text", text: "The user answered without selecting anything." }] };
  return {
    content: [{
      type: "text",
      text: frame.auto
        ? "The question was continued automatically with the selection already marked:\n" + body
        : body,
    }],
  };
}

// --- stdio JSON-RPC -------------------------------------------------------

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

const address = process.env[ASK_USER_ADDRESS_ENV] || "";
const token = process.env[ASK_USER_TOKEN_ENV] || "";

/** rpcId -> { resolve } for calls waiting on the host. */
const waiting = new Map();
let nextAskId = 1;
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
      socket.write(JSON.stringify({ t: "hello", v: ASK_USER_IPC_VERSION, token }) + "\n");
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
    if (frame.t === "ready") { settleReady(true); return; }
    if (frame.t === "denied") {
      // The host does not know this token: the session it belonged to is gone.
      // Exit rather than sit on the CLI's process table doing nothing.
      settleReady(false);
      failAllWaiting();
      try { socket.destroy(); } catch { /* already gone */ }
      process.exit(0);
      return;
    }
    if (frame.t === "answer") {
      const entry = waiting.get(String(frame.id));
      if (!entry) return; // a duplicate or late answer — deliberately inert
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

function ask(questions) {
  return whenReady().then((connected) => {
    if (!connected || !socket || socket.destroyed) return undefined;
    const id = String(nextAskId++);
    return new Promise((resolve) => {
      waiting.set(id, { resolve });
      try {
        socket.write(JSON.stringify({ t: "ask", id, questions }) + "\n");
      } catch {
        waiting.delete(id);
        resolve(undefined);
      }
    });
  });
}

// --- request handling -----------------------------------------------------

function handle(message) {
  if (!isRecord(message)) return;
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      // Served from constants so the answer is on the wire in the same tick the
      // request arrived. See property 1 in the file head.
      reply(id, {
        protocolVersion: isRecord(params) && typeof params.protocolVersion === "string"
          ? params.protocolVersion
          : "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: ASK_USER_SERVER_NAME, version: "1.0.0" },
      });
      return;
    case "notifications/initialized":
    case "initialized":
      return; // notification, no reply
    case "tools/list":
      reply(id, { tools: [TOOL] });
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
      if (name !== ASK_USER_TOOL_NAME) {
        replyError(id, -32602, "Unknown tool: " + String(name));
        return;
      }
      const normalized = normalizeArguments(isRecord(params) ? params.arguments : undefined);
      if (!normalized.ok) {
        // A tool RESULT, not a JSON-RPC error: the model reads the text and can
        // fix its call inside the same turn.
        reply(id, { content: [{ type: "text", text: normalized.error }], isError: true });
        return;
      }
      ask(normalized.questions).then((frame) => {
        if (!frame) {
          reply(id, {
            content: [{
              type: "text",
              text: "The question could not be shown to the user (the editor is not reachable). Proceed with your best judgement and say which assumption you made.",
            }],
          });
          return;
        }
        reply(id, formatResult(frame));
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
  try { process.stderr.write("[ask_user] " + (error && error.message) + "\n"); } catch { /* ignore */ }
  process.exit(1);
});

connect();
