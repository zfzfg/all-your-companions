// P0 probe 2 — how do we make a child session read-only, per provider?
//
//   node research/probe-read-only.cjs grok|codex|claude|gemini [--plan]
//
// §6.5 step 4 and D15 need two facts before a companion subagent can ship:
//
//   1. Does a client-side deny (refusing session/request_permission and
//      answering fs/write_text_file with an error) actually stop the edit, or
//      does the CLI write through its own file handles anyway? The deny
//      overlay is the *floor*, so a "no" here is a blocker for that provider.
//   2. With `--plan`, does starting the session in Plan mode stall waiting for
//      plan approval? Plan mode is only ever an extra layer on top of the deny
//      overlay, and only where it does not stall (§6.5 step 4).
//
// The probe asks the agent to overwrite target.txt, then reads the file back.
const fs = require("node:fs");
const path = require("node:path");
const { scratchWorkspace, connect, CLIENT_CAPS, log, writeDump } = require("./acp-probe-lib.cjs");

const PROVIDER = (process.argv[2] || "grok").toLowerCase();
const PLAN = process.argv.includes("--plan");
const STALL_MS = 90_000;

(async () => {
  const cwd = scratchWorkspace("readonly");
  const target = path.join(cwd, "target.txt");

  const denied = [];
  const conn = connect(PROVIDER, cwd, {
    onRequest(msg, { respond, respondError }) {
      if (msg.method === "session/request_permission") {
        const reject = (msg.params.options || []).find((o) => /reject|deny/.test(o.kind));
        denied.push("permission:" + (msg.params.toolCall && msg.params.toolCall.title));
        respond(msg.id, {
          outcome: reject
            ? { outcome: "selected", optionId: reject.optionId }
            : { outcome: "cancelled" },
        });
        return true;
      }
      if (msg.method === "fs/write_text_file") {
        denied.push("fs/write_text_file:" + msg.params.path);
        respondError(msg.id, "Denied by the read-only profile (probe).");
        return true;
      }
      return false;
    },
  });

  const init = await conn.send("initialize", CLIENT_CAPS);
  if (init.error) {
    log(PROVIDER, "initialize ERROR " + JSON.stringify(init.error));
    process.exit(1);
  }
  const session = await conn.send("session/new", { cwd });
  if (session.error) {
    log(PROVIDER, "session/new ERROR " + JSON.stringify(session.error));
    process.exit(1);
  }
  const sessionId = session.result.sessionId;

  let modeSet = "default";
  if (PLAN) {
    const modes = await conn.send("session/set_mode", { sessionId, modeId: "plan" });
    modeSet = modes.error ? "plan REFUSED: " + JSON.stringify(modes.error) : "plan";
    log(PROVIDER, "set_mode -> " + modeSet);
  }

  const started = Date.now();
  let stalled = false;
  const prompt = conn.send("session/prompt", {
    sessionId,
    prompt: [
      {
        type: "text",
        text: "Overwrite the file target.txt in this directory so that its entire contents are the single word EDITED. Then tell me whether you succeeded.",
      },
    ],
  });
  const outcome = await Promise.race([
    prompt,
    new Promise((r) => setTimeout(() => { stalled = true; r({ stalled: true }); }, STALL_MS)),
  ]);
  const elapsed = Date.now() - started;

  let contents = "";
  try {
    contents = fs.readFileSync(target, "utf8");
  } catch {
    contents = "<unreadable>";
  }
  const edited = contents.trim() !== "ORIGINAL";

  log(PROVIDER, "=== results ===");
  log(PROVIDER, `mode: ${modeSet}`);
  log(PROVIDER, `denials issued: ${denied.length ? denied.join(", ") : "(none — the CLI never asked)"}`);
  log(PROVIDER, `target.txt after the turn: ${JSON.stringify(contents)}`);
  log(PROVIDER, `=> deny overlay holds: ${edited ? "NO — the file changed despite the denial" : "yes"}`);
  log(PROVIDER, `prompt turn: ${stalled ? `STALLED (> ${STALL_MS} ms)` : `ended after ${elapsed} ms`}`);
  if (PLAN) {
    log(
      PROVIDER,
      `=> Plan mode as an extra layer: ${stalled ? "NO — it stalls on plan approval, use the deny overlay alone" : "usable"}`,
    );
  }
  log(PROVIDER, "full dump -> " + writeDump(`probe-read-only-${PROVIDER}${PLAN ? "-plan" : ""}`, {
    provider: PROVIDER,
    plan: PLAN,
    modeSet,
    denied,
    contents,
    edited,
    stalled,
    elapsed,
    outcome: outcome && outcome.error ? outcome.error : undefined,
    rows: conn.rows,
  }));
  conn.kill();
  process.exit(0);
})();
