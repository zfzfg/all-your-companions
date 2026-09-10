// Shared plumbing for the AP-16 (companion subagents) research probes.
//
// The three probes next to this file — probe-acp-mcp.cjs, probe-read-only.cjs
// and probe-child-persistence.cjs — all need the same four things: resolve a
// provider's CLI on *this* machine, speak enough ACP to open a session, answer
// the server→client requests so the CLI does not stall, and collect the
// session/update rows. That is what lives here.
//
// CLI locations are resolved from the environment first, because the older
// probes in this directory hardcode one maintainer's paths and rot. Override
// with GROK_BIN / CODEX_PATH / CLAUDE_CODE_EXECUTABLE / GEMINI_BIN.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const REPO = path.resolve(__dirname, "..");

function providerSpec(provider) {
  const home = os.homedir();
  const specs = {
    grok: {
      command: process.env.GROK_BIN || path.join(home, ".grok", "bin", process.platform === "win32" ? "grok.exe" : "grok"),
      args: ["agent", "--no-leader", "stdio"],
      env: {},
    },
    codex: {
      command: process.execPath,
      args: [path.join(REPO, "node_modules/@agentclientprotocol/codex-acp/dist/index.js")],
      env: process.env.CODEX_PATH ? { CODEX_PATH: process.env.CODEX_PATH } : {},
    },
    claude: {
      command: process.execPath,
      args: [path.join(REPO, "node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js")],
      env: process.env.CLAUDE_CODE_EXECUTABLE
        ? { CLAUDE_CODE_EXECUTABLE: process.env.CLAUDE_CODE_EXECUTABLE }
        : {},
    },
    gemini: {
      // Antigravity and Gemini CLI share the `gemini` provider id. Which one is
      // on PATH decides what this probe measures — record that in the note.
      command: process.env.GEMINI_BIN || (process.platform === "win32" ? "gemini.cmd" : "gemini"),
      args: ["--experimental-acp"],
      env: {},
    },
  };
  return specs[provider];
}

/** A scratch workspace with one readable file, so "read something" is possible. */
function scratchWorkspace(tag) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `companions-${tag}-`));
  fs.writeFileSync(path.join(cwd, "readme.md"), "probe workspace\n");
  fs.writeFileSync(path.join(cwd, "target.txt"), "ORIGINAL\n");
  return cwd;
}

/**
 * Opens an ACP connection. Returns { send, respond, rows, requests, stderr,
 * kill } — `rows` collects every session/update, `requests` every
 * server→client method name, both in arrival order.
 */
function connect(provider, cwd, { onRequest } = {}) {
  const spec = providerSpec(provider);
  if (!spec) throw new Error(`unknown provider ${provider}`);
  const proc = spawn(spec.command, spec.args, { cwd, env: { ...process.env, ...spec.env } });
  let nextId = 1;
  const waiters = new Map();
  const rows = [];
  const requests = [];
  const stderr = [];
  proc.stderr.on("data", (d) => stderr.push(String(d)));

  const write = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
  const send = (method, params) => {
    const id = nextId++;
    write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve) => waiters.set(id, resolve));
  };
  const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
  const respondError = (id, message) =>
    write({ jsonrpc: "2.0", id, error: { code: -32000, message } });

  readline.createInterface({ input: proc.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id != null) {
      requests.push(msg.method);
      // A probe may want to say "no" — that is the point of probe-read-only.
      if (onRequest && onRequest(msg, { respond, respondError }) === true) return;
      if (msg.method === "session/request_permission") {
        const allow = (msg.params.options || []).find((o) => /allow/.test(o.kind));
        return respond(msg.id, {
          outcome: { outcome: "selected", optionId: allow && allow.optionId },
        });
      }
      if (msg.method === "fs/read_text_file") {
        let content = "";
        try {
          content = fs.readFileSync(msg.params.path, "utf8");
        } catch {
          /* a missing file is an answer too */
        }
        return respond(msg.id, { content });
      }
      if (msg.method === "fs/write_text_file") {
        try {
          fs.writeFileSync(msg.params.path, msg.params.content ?? "");
        } catch {
          /* ignore */
        }
        return respond(msg.id, {});
      }
      if (msg.method === "terminal/create") return respond(msg.id, { terminalId: "t" + nextId++ });
      if (msg.method === "terminal/output")
        return respond(msg.id, { output: "", truncated: false, exitStatus: { exitCode: 0 } });
      if (msg.method === "terminal/wait_for_exit") return respond(msg.id, { exitCode: 0 });
      return respond(msg.id, {});
    }
    if (msg.method === "session/update") {
      const update = (msg.params && msg.params.update) || {};
      rows.push(update);
      return;
    }
    if (msg.id != null && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  });

  return { proc, send, respond, respondError, rows, requests, stderr, kill: () => proc.kill() };
}

const CLIENT_CAPS = {
  protocolVersion: 1,
  clientCapabilities: {
    fs: { readTextFile: true, writeTextFile: true },
    terminal: true,
  },
};

function log(provider, message) {
  process.stderr.write(`[${provider}] ${message}\n`);
}

function writeDump(name, payload) {
  const out = path.join(os.tmpdir(), `${name}.json`);
  fs.writeFileSync(out, JSON.stringify(payload, null, 2));
  return out;
}

module.exports = { REPO, providerSpec, scratchWorkspace, connect, CLIENT_CAPS, log, writeDump };
