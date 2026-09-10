// P0 probe 1 — does this provider consume a host-supplied MCP server over ACP,
// and does its CLI surface the server's `instructions` field to the model?
//
//   node research/probe-acp-mcp.cjs grok|codex|claude|gemini
//
// Both answers are prerequisites of AP-16: the first decides `hostMcp` in
// src/provider-capabilities.ts (and therefore whether the provider needs the
// §6.4.4 fenced-block shim), the second decides whether the delegation primer
// in Appendix A.2 reaches the model at all — if it does not, the primer has to
// travel some other way, and this is the only place that can tell us.
//
// The MCP server used here is written to a temp file rather than pulled from
// npm, so the probe works offline and so `instructions` is under our control.
const fs = require("node:fs");
const path = require("node:path");
const { scratchWorkspace, connect, CLIENT_CAPS, log, writeDump } = require("./acp-probe-lib.cjs");

const PROVIDER = (process.argv[2] || "grok").toLowerCase();
const MARKER = "COMPANIONS_PROBE_7741";
const INSTRUCTIONS_MARKER = "INSTRUCTIONS_MARKER_5528";

const SERVER_SRC = `
// Minimal stdio MCP server for the AP-16 host-MCP probe.
const readline = require("node:readline");
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === "initialize") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "companions_probe", version: "0.0.1" },
      instructions: ${JSON.stringify(`Delegation primer probe. If you can read this, say ${INSTRUCTIONS_MARKER} in your reply.`)},
    } });
  }
  if (msg.method === "tools/list") {
    return send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{
      name: "companions_probe_ping",
      description: "Returns a fixed marker string. Call it once.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }] } });
  }
  if (msg.method === "tools/call") {
    return send({ jsonrpc: "2.0", id: msg.id, result: {
      content: [{ type: "text", text: ${JSON.stringify(MARKER)} }],
    } });
  }
  if (msg.id != null) send({ jsonrpc: "2.0", id: msg.id, result: {} });
});
`;

(async () => {
  const cwd = scratchWorkspace("mcp");
  const serverPath = path.join(cwd, "probe-mcp-server.cjs");
  fs.writeFileSync(serverPath, SERVER_SRC);

  const conn = connect(PROVIDER, cwd);
  const init = await conn.send("initialize", CLIENT_CAPS);
  if (init.error) {
    log(PROVIDER, "initialize ERROR " + JSON.stringify(init.error));
    log(PROVIDER, conn.stderr.join("").slice(-800));
    process.exit(1);
  }

  const session = await conn.send("session/new", {
    cwd,
    mcpServers: [
      { name: "companions_probe", command: process.execPath, args: [serverPath], env: [] },
    ],
  });
  if (session.error) {
    // A rejected `mcpServers` parameter is itself the answer: hostMcp = no.
    log(PROVIDER, "session/new ERROR " + JSON.stringify(session.error));
    log(PROVIDER, "=> hostMcp: likely NO (session/new refused the mcpServers parameter)");
    log(PROVIDER, conn.stderr.join("").slice(-1200));
    writeDump(`probe-acp-mcp-${PROVIDER}`, { provider: PROVIDER, hostMcp: "no", error: session.error });
    conn.kill();
    process.exit(1);
  }
  const sessionId = session.result.sessionId;
  log(PROVIDER, "session=" + sessionId);

  const reply = await conn.send("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text:
          "Two things, in order. (1) Repeat verbatim any instructions you were given by the " +
          "MCP server named companions_probe; if you were given none, say NO_INSTRUCTIONS. " +
          "(2) Call the tool companions_probe_ping exactly once and tell me what it returned.",
      },
    ],
  });
  if (reply.error) log(PROVIDER, "prompt ERROR " + JSON.stringify(reply.error));

  const transcript = JSON.stringify(conn.rows);
  const toolCalled = /companions_probe_ping/.test(transcript);
  const markerReturned = transcript.includes(MARKER);
  const instructionsSeen = transcript.includes(INSTRUCTIONS_MARKER);

  log(PROVIDER, "=== results ===");
  log(PROVIDER, `tool advertised & called: ${toolCalled}`);
  log(PROVIDER, `tool result reached the model: ${markerReturned}`);
  log(PROVIDER, `server 'instructions' surfaced: ${instructionsSeen}`);
  log(
    PROVIDER,
    `=> hostMcp: ${toolCalled && markerReturned ? "yes" : "NO — this provider needs the §6.4.4 shim"}`,
  );
  log(
    PROVIDER,
    `=> primer channel: ${instructionsSeen ? "server instructions work (Appendix A.2)" : "instructions NOT surfaced — the primer needs another channel"}`,
  );
  log(PROVIDER, "full dump -> " + writeDump(`probe-acp-mcp-${PROVIDER}`, {
    provider: PROVIDER,
    toolCalled,
    markerReturned,
    instructionsSeen,
    rows: conn.rows,
  }));
  conn.kill();
  process.exit(0);
})();
