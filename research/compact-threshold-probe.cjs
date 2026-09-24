#!/usr/bin/env node
/**
 * Compaction threshold probe (K-01). FREE: no prompt, only
 * initialize → session/new → _x.ai/session/info.
 *
 * Reports `context.autoCompactThresholdPercent` with and without
 * GROK_AUTO_COMPACT_THRESHOLD_PERCENT. Expectation (grok 1.0.41):
 *   default 500000 80
 *   env95   500000 95
 *
 * Run: node research/compact-threshold-probe.cjs
 */
const fs = require("fs");
const lib = require("./acp-probe-lib.cjs");

async function run(label, extraEnv) {
  Object.assign(process.env, extraEnv);
  const cwd = lib.scratchWorkspace("compact");
  const c = lib.connect("grok", cwd);
  try {
    await c.send("initialize", lib.CLIENT_CAPS);
    const s = await c.send("session/new", { cwd, mcpServers: [] });
    const info = await c.send("_x.ai/session/info", { sessionId: s.result.sessionId });
    const ctx = (info.result && info.result.context) || {};
    console.log(label, ctx.total, ctx.autoCompactThresholdPercent, ctx.compactionCount ?? "-");
  } finally {
    c.kill();
    for (const k of Object.keys(extraEnv)) delete process.env[k];
    try { fs.rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

(async () => {
  await run("default", {});
  await run("env95", { GROK_AUTO_COMPACT_THRESHOLD_PERCENT: "95" });
  await run("env150-invalid", { GROK_AUTO_COMPACT_THRESHOLD_PERCENT: "150" });
  process.exit(0);
})();
