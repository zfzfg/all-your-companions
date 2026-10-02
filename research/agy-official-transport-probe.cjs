// Optional capability spike. Never installs binaries, authenticates, or sends prompts.
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");

async function probeOfficialAgy({ binary, harness, cwd = process.cwd(), createSession = false, timeoutMs = 10000 }) {
  if (!binary || !path.isAbsolute(binary) || !fs.statSync(binary).isFile())
    throw new Error("Supply an absolute path to an installed official kernel binary");
  if (!harness || !path.isAbsolute(harness) || !fs.statSync(harness).isFile())
    throw new Error("Supply an absolute path to the installed localharness_external binary");
  const script = /\.cjs$/i.test(binary);
  const shell = process.platform === "win32" && /\.(cmd|bat)$/i.test(binary);
  const proc = spawn(script ? process.execPath : shell ? `"${binary}"` : binary, script ? [binary] : [], {
    cwd, env: { ...process.env, ANTIGRAVITY_HARNESS_PATH: harness }, shell, windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const input = createInterface({ input: proc.stdout });
  let nextId = 0;
  const pending = new Map();
  const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
  input.on("error", fail);
  proc.on("error", fail);
  proc.stdin.on("error", fail);
  proc.stdout.on("error", fail);
  proc.stderr.on("error", fail);
  proc.stderr.resume(); // Drain diagnostics without printing credentials or opaque kernel output.
  proc.on("exit", () => fail(new Error("Official kernel exited before the probe completed")));
  input.on("line", line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const item = pending.get(message.id);
    if (!item || message.method) return;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(`Official kernel RPC error ${message.error.code}`));
    else item.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", error => { if (error) fail(error); });
  });
  try {
    const initialize = await request("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "companions-transport-probe", version: "1" } });
    const report = {
      platform: process.platform, protocolVersion: initialize.protocolVersion,
      agentVersion: initialize.agentInfo?.version,
      authMethodIds: (initialize.authMethods ?? []).map(method => method.id),
      agentCapabilities: initialize.agentCapabilities, sessionCreated: false,
    };
    if (createSession) {
      const session = await request("session/new", { cwd, mcpServers: [] });
      report.sessionCreated = typeof session.sessionId === "string";
      report.modeIds = session.modes?.availableModes?.map(mode => mode.id) ?? [];
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: session.sessionId } }) + "\n");
    }
    return report;
  } finally {
    input.close();
    await new Promise(resolve => {
      let timer;
      const finish = () => { clearTimeout(timer); resolve(); };
      proc.once("exit", finish);
      timer = setTimeout(() => {
        if (process.platform === "win32" && proc.pid !== undefined) {
          const taskkill = spawn("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          taskkill.once("error", () => proc.kill());
        } else proc.kill("SIGKILL");
        finish();
      }, 3000);
      if (proc.exitCode != null || proc.signalCode != null) finish();
      else proc.stdin.end();
    });
  }
}

module.exports = { probeOfficialAgy };
if (require.main === module) {
  probeOfficialAgy({ binary: process.env.AGY_OFFICIAL_ACP_BIN, harness: process.env.AGY_OFFICIAL_HARNESS_PATH,
    createSession: process.argv.includes("--session") }).then(report => process.stdout.write(JSON.stringify(report, null, 2) + "\n"), error => {
    process.stderr.write(error.message + "\n"); process.exitCode = 1;
  });
}
