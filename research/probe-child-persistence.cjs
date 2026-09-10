// P0 probe 3 — what does a provider do with a short-lived child session?
//
//   node research/probe-child-persistence.cjs grok|codex|claude|gemini
//
// §6.6 point 4 asks whether a provider offers a genuinely non-persisting
// session, and whether the transcript stays readable for the card's "Open
// transcript" action. The answer decides, per provider, between "ask the CLI
// not to persist" and "let it persist and rely on the host-side hide rule".
//
// The probe opens a session, sends one prompt, closes the connection, and then
// looks for the session in the CLI's own store: it lists the store directory
// before and after, and reports what appeared. It does not delete anything.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { scratchWorkspace, connect, CLIENT_CAPS, log, writeDump } = require("./acp-probe-lib.cjs");

const PROVIDER = (process.argv[2] || "grok").toLowerCase();
const MARKER = "CHILD_PERSISTENCE_3310";

// Where each CLI keeps its own session store, as far as this repo knows it.
// A path that does not exist is reported as such rather than guessed around.
function storeRoots() {
  const home = os.homedir();
  return {
    grok: [path.join(home, ".grok", "sessions")],
    codex: [path.join(home, ".codex", "sessions")],
    claude: [path.join(home, ".claude", "projects")],
    gemini: [path.join(home, ".gemini", "tmp"), path.join(home, ".antigravity")],
  }[PROVIDER] || [];
}

function snapshot(roots) {
  const seen = [];
  for (const root of roots) {
    if (!fs.existsSync(root)) {
      seen.push({ root, exists: false, entries: [] });
      continue;
    }
    const entries = [];
    const walk = (dir, depth) => {
      if (depth > 3) return;
      let names = [];
      try {
        names = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const name of names) {
        const full = path.join(dir, name.name);
        entries.push(full);
        if (name.isDirectory()) walk(full, depth + 1);
      }
    };
    walk(root, 0);
    seen.push({ root, exists: true, entries });
  }
  return seen;
}

const flatten = (snap) => new Set(snap.flatMap((s) => s.entries));

(async () => {
  const roots = storeRoots();
  const before = snapshot(roots);
  const cwd = scratchWorkspace("childpersist");

  const conn = connect(PROVIDER, cwd);
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
  log(PROVIDER, "session=" + sessionId);

  await conn.send("session/prompt", {
    sessionId,
    prompt: [{ type: "text", text: `Reply with exactly this word and nothing else: ${MARKER}` }],
  });

  // Can the same session be loaded again? That is what "Open transcript"
  // during the parent's lifetime would rely on if it went through the CLI.
  const reload = await conn.send("session/load", { sessionId, cwd });
  const loadable = !reload.error;
  log(PROVIDER, `session/load: ${loadable ? "supported" : "refused — " + JSON.stringify(reload.error)}`);

  conn.kill();
  await new Promise((r) => setTimeout(r, 1500));

  const after = snapshot(roots);
  const beforeSet = flatten(before);
  const added = [...flatten(after)].filter((p) => !beforeSet.has(p));
  const carriesMarker = added.filter((p) => {
    try {
      return fs.statSync(p).isFile() && fs.readFileSync(p, "utf8").includes(MARKER);
    } catch {
      return false;
    }
  });

  log(PROVIDER, "=== results ===");
  for (const s of before) if (!s.exists) log(PROVIDER, `store root missing: ${s.root}`);
  log(PROVIDER, `paths added to the CLI store: ${added.length}`);
  for (const p of added.slice(0, 20)) log(PROVIDER, "  + " + p);
  log(PROVIDER, `files containing the turn's text: ${carriesMarker.length}`);
  log(
    PROVIDER,
    `=> child persistence: ${carriesMarker.length ? "PERSISTS — rely on the host-side hide rule (§6.6 points 1-3)" : "no transcript found on disk — check whether Open transcript can still work"}`,
  );
  log(PROVIDER, "full dump -> " + writeDump(`probe-child-persistence-${PROVIDER}`, {
    provider: PROVIDER,
    sessionId,
    loadable,
    added,
    carriesMarker,
  }));
  process.exit(0);
})();
