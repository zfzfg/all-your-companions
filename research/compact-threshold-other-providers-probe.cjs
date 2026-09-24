#!/usr/bin/env node
/**
 * K-07 probe: can the compaction point of Claude, Codex and Gemini CLI be
 * moved from the spawn, the way GROK_AUTO_COMPACT_THRESHOLD_PERCENT moves
 * Grok's? COSTS CREDITS — run manually, once per candidate, and write the
 * observed result into research/compact.md § "Other providers (K-07)".
 *
 * Method (no provider reports its threshold over ACP, so it is observed):
 *   1. start the adapter with the candidate lever set to a LOW value
 *      (e.g. 20%) so compaction must happen early;
 *   2. feed a large read (huge.txt) until usage_update / the adapter's own
 *      compaction signal (`adapterCompactSignal` in src/acp-dispatch.ts) fires;
 *   3. record the context occupancy at which it fired, with and without the
 *      lever. A lever that moves the point is confirmed; one that does not is
 *      recorded as "no effect" and never lands in code.
 *
 * Candidates (unconfirmed until this probe says otherwise):
 *   claude  env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=<pct>   (possibly lower-only)
 *   codex   config model_auto_compact_token_limit=<tokens> (via CODEX_HOME/config.toml copy)
 *   gemini  settings.json chatCompression.contextPercentageThreshold=<0..1>
 *
 * Run: node research/compact-threshold-other-providers-probe.cjs <claude|codex|gemini> [pct]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const lib = require("./acp-probe-lib.cjs");

const provider = process.argv[2];
const pct = Number(process.argv[3] || 20);
if (!["claude", "codex", "gemini"].includes(provider)) {
  console.error("usage: node research/compact-threshold-other-providers-probe.cjs <claude|codex|gemini> [pct]");
  process.exit(2);
}

function applyLever(cwd) {
  if (provider === "claude") {
    process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(pct);
    return `env CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${pct}`;
  }
  if (provider === "codex") {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-home-"));
    const src = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
    for (const f of ["auth.json", "config.toml"]) {
      try { fs.copyFileSync(path.join(src, f), path.join(home, f)); } catch { /* optional */ }
    }
    const tokens = Math.round((pct / 100) * 272000);
    fs.appendFileSync(path.join(home, "config.toml"), `\nmodel_auto_compact_token_limit = ${tokens}\n`);
    process.env.CODEX_HOME = home;
    return `CODEX_HOME copy with model_auto_compact_token_limit=${tokens}`;
  }
  const settingsDir = path.join(cwd, ".gemini");
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(path.join(settingsDir, "settings.json"), JSON.stringify({ chatCompression: { contextPercentageThreshold: pct / 100 } }, null, 2));
  return `project .gemini/settings.json chatCompression.contextPercentageThreshold=${pct / 100}`;
}

(async () => {
  const cwd = lib.scratchWorkspace(`k07-${provider}`);
  fs.writeFileSync(path.join(cwd, "huge.txt"), ("k07 probe line with some words in it\n").repeat(20000));
  const lever = applyLever(cwd);
  console.log(`[${provider}] lever: ${lever}`);
  const c = lib.connect(provider, cwd);
  try {
    await c.send("initialize", lib.CLIENT_CAPS);
    const s = await c.send("session/new", { cwd, mcpServers: [] });
    const sessionId = s.result && s.result.sessionId;
    for (let i = 1; i <= 6; i++) {
      const r = await c.send("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: `Read huge.txt (part ${i}) and reply with the word OK.` }],
      });
      const usage = c.rows.filter((u) => u.sessionUpdate === "usage_update").slice(-1)[0];
      const compacted = c.rows.some((u) => /compact/i.test(JSON.stringify(u)));
      console.log(`turn ${i}: ${r.error ? "error " + JSON.stringify(r.error).slice(0, 200) : "ok"}; usage=${JSON.stringify(usage && (usage.used ?? usage.size ?? usage))}; compaction seen=${compacted}`);
      if (compacted || r.error) break;
    }
    lib.writeDump(`k07-${provider}`, { lever, rows: c.rows });
  } finally {
    c.kill();
  }
  process.exit(0);
})();
