const { createInterface } = require("node:readline");
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const request = JSON.parse(line);
  if (request.id == null) return;
  if (process.env.FAKE_AGY_PROBE === "hang") return;
  if (process.env.FAKE_AGY_PROBE === "exit") { process.exit(0); }
  if (process.env.FAKE_AGY_PROBE === "error") {
    process.stdout.write(JSON.stringify({ id: request.id, error: { code: -32000, message: "opaque diagnostic" } }) + "\n");
    return;
  }
  const result = request.method === "initialize"
    ? { protocolVersion: 1, agentInfo: { name: "fake-official", version: "fixture" },
      authMethods: [{ id: "oauth-personal", name: "Sign in" }], agentCapabilities: { loadSession: true } }
    : { sessionId: "fake-session", modes: { availableModes: [{ id: "default", name: "Default" }] } };
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n");
});
