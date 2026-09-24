#!/usr/bin/env node
/**
 * Context overflow probe (K-05). COSTS CREDITS — run manually, once.
 *
 * Starts Grok with GROK_AUTO_COMPACT_THRESHOLD_PERCENT=99 and asks it to read
 * a deliberately huge file several times, so a single tool result can push
 * the context past the window before compaction runs. Records:
 *   - the prompt error (message, code, data) when the turn fails,
 *   - every _x.ai session notification (auto_compact_* kinds, summary_preview).
 *
 * Write the observed wire form into research/compact.md § "Context overflow"
 * and extend CONTEXT_OVERFLOW_PATTERNS in src/limit-errors.ts with it.
 *
 * Run: node research/context-overflow-probe.cjs
 */
const fs = require("fs");
const path = require("path");
const lib = require("./acp-probe-lib.cjs");

(async () => {
  process.env.GROK_AUTO_COMPACT_THRESHOLD_PERCENT = "99";
  const cwd = lib.scratchWorkspace("overflow");
  // ~4 MB of text: several reads of it overflow any 500k window.
  const line = "overflow-probe ".repeat(20) + "\n";
  fs.writeFileSync(path.join(cwd, "huge.txt"), line.repeat(14000));
  const c = lib.connect("grok", cwd);
  try {
    await c.send("initialize", lib.CLIENT_CAPS);
    const s = await c.send("session/new", { cwd, mcpServers: [] });
    const sessionId = s.result.sessionId;
    for (let i = 1; i <= 4; i++) {
      const r = await c.send("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Read huge.txt completely with your file tool and tell me its last word." }],
      });
      console.log(`turn ${i}:`, JSON.stringify(r.error || r.result).slice(0, 2000));
      const info = await c.send("_x.ai/session/info", { sessionId });
      console.log(`  context:`, JSON.stringify(info.result && info.result.context).slice(0, 400));
      if (r.error) break;
    }
    const compactRows = c.rows.filter((u) => String(u.sessionUpdate || "").startsWith("auto_compact"));
    console.log("compact rows:", JSON.stringify(compactRows, null, 2).slice(0, 4000));
    lib.writeDump("context-overflow", { rows: c.rows, requests: c.requests, stderr: c.stderr.join("") });
  } finally {
    c.kill();
  }
  process.exit(0);
})();
