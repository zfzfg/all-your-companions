// Screenshot harness for the fork's chat and settings surfaces.
//
// Boots the SHIPPED media/ scripts in a real Chromium (Playwright's Electron
// mode — Electron is already a devDependency, so no browser download), drives
// each scenario in fixtures.mjs with the frames the host really posts, and
// leaves PNGs plus a contact sheet behind for a person to look at. happy-dom
// has no layout engine, so none of this is visible to `npm test`.
//
// The chat body is lifted out of getHtml() in src/sidebar.ts at run time, so
// the harness paints the markup that ships rather than a copy that can drift.
//
//   npm run ui:screens                        every scenario, every theme
//   npm run ui:screens -- --only gate         scenarios whose name contains "gate"
//   npm run ui:screens -- --theme dark        one theme
//   npm run ui:screens -- --label before      write under .screens/ui/before/
//
// Frames land in .screens/ui/<label>/ (gitignored); open index.html there.
import { _electron as electron } from "playwright";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { THEMES, themeCss } from "./themes.mjs";
import { CHAT_SCENARIOS, SETTINGS_SCENARIOS } from "./fixtures.mjs";

const root = process.cwd();
const media = path.join(root, "media");
const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const only = flag("only", "");
const themeNames = flag("theme", "") ? [flag("theme", "")] : Object.keys(THEMES);
const label = flag("label", "current");
const OUT = path.join(root, ".screens", "ui", label);
const log = (m) => console.log(`[ui-harness] ${m}`);
const url = (p) => pathToFileURL(p).href;

// ------------------------------------------------------------- chat page --

function chatBody() {
  const src = fs.readFileSync(path.join(root, "src", "sidebar.ts"), "utf8");
  const fn = src.indexOf("private getHtml(webview: HostWebview)");
  const start = src.indexOf('<header class="top-bar">', fn);
  const end = src.indexOf("</footer>", start) + "</footer>".length;
  if (fn < 0 || start < 0 || end < start) throw new Error("could not find the chat body in getHtml()");
  // VS Code, not desktop: canSwitchWorkspaceFolder is false, so the desktop-
  // only branches drop out and the VS Code-only ones stay.
  return src.slice(start, end)
    .replace(/\$\{this\.host\.canSwitchWorkspaceFolder \? "" : `([^`]*)`\}/g, "$1")
    .replace(/\$\{this\.host\.canSwitchWorkspaceFolder \? `[^`]*` : ""\}/g, "")
    .replace(/\$\{resourceUri\("([^"]+)"\)\}/g, (_, f) => url(path.join(root, "resources", f)))
    .replace(/\$\{[^}]*\}/g, "");
}

const THEME_BOOT = `
<script>
  window.__themes = ${JSON.stringify(Object.fromEntries(Object.keys(THEMES).map((t) => [t, { css: themeCss(t), kind: THEMES[t].kind }])))};
  (function () {
    var name = new URLSearchParams(location.search).get("theme") || "dark";
    var theme = window.__themes[name];
    var style = document.createElement("style");
    style.id = "harness-theme";
    style.textContent = theme.css;
    document.head.appendChild(style);
    window.__themeKind = theme.kind;
  })();
</script>`;

function chatPage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
${THEME_BOOT}
<style>
  html, body { margin: 0; height: 100%; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
</style>
<link rel="stylesheet" href="${url(path.join(media, "chat.css"))}">
<link rel="stylesheet" href="${url(path.join(media, "settings.css"))}">
</head><body class="desk thinking-hidden" style="--chat-zoom: 1">
<script>
  document.body.classList.add(window.__themeKind);
  window.__posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__posted.push(m),
    setState: () => {},
    getState: () => undefined,
  });
</script>
${chatBody()}
<script src="${url(path.join(media, "webview-helpers.js"))}"></script>
<script src="${url(path.join(media, "settings.js"))}"></script>
<script src="${url(path.join(media, "chat.js"))}"></script>
</body></html>`;
}

// --------------------------------------------------------- settings page --

function settingsPage() {
  return `<!doctype html><html lang="en" class="settings-page"><head><meta charset="utf-8">
${THEME_BOOT}
<style>
  html, body { margin: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground);
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }
</style>
<link rel="stylesheet" href="${url(path.join(media, "settings.css"))}">
</head><body class="settings-page">
<script>document.body.classList.add(window.__themeKind);</script>
<div id="settings-root"></div>
<script src="${url(path.join(media, "settings.js"))}"></script>
<script>
  window.__posted = [];
  window.__mount = function (snapshot, category) {
    var api = window.GrokSettings;
    window.__surface = api.mount(document.getElementById("settings-root"), {
      snapshot: api.defaultSnapshot(snapshot),
      env: api.defaultEnv({ isRemote: false, isDesktop: false, providersKnown: true,
        hostCaps: { settingsEditor: true, mcpSettings: true } }),
      post: function (m) { window.__posted.push(m); },
      standalone: true,
      category: category,
      onClose: function () {},
    });
  };
</script>
</body></html>`;
}

// ------------------------------------------------------------------ run --

const initialState = {
  type: "initialState",
  effort: "", cwd: "/repo", useCtrlEnter: false, extVersion: "0.1.0",
  showThinking: false, expandCommandOutputs: false, steerByDefault: false,
  soundNotifications: false, processingSound: false, readRepliesAloud: false,
  appPurpose: "coding", hostKind: "extension", hostName: "Harness",
  capabilities: { settingsEditor: true, relocateView: true },
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
// Inside the repo, not os.tmpdir(): main.js requires "electron", which only
// resolves from a path under this node_modules.
const tmp = fs.mkdtempSync(path.join(root, ".screens", "harness-"));
const chatFile = path.join(tmp, "chat.html");
const settingsFile = path.join(tmp, "settings.html");
fs.writeFileSync(chatFile, chatPage());
fs.writeFileSync(settingsFile, settingsPage());
const mainJs = path.join(tmp, "main.js");
fs.writeFileSync(mainJs, `
const { app, BrowserWindow } = require("electron");
app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 360, height: 760, show: true, x: -3000, y: 0,
    webPreferences: { contextIsolation: false, nodeIntegration: false } });
  w.loadURL("about:blank");
});
app.on("window-all-closed", () => app.quit());
`);

const electronExe = createRequire(path.join(root, "x.js"))("electron");
// A VS Code extension host exports ELECTRON_RUN_AS_NODE=1; inherited, Electron
// runs as plain Node and never opens a window.
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({
  executablePath: electronExe,
  args: [mainJs, `--user-data-dir=${path.join(tmp, "udata")}`],
  env,
  timeout: 60000,
});

const results = [];
try {
  const page = await app.firstWindow({ timeout: 60000 });
  let errors = [];
  page.on("pageerror", (e) => errors.push(String((e && e.message) || e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  const send = (msg) =>
    page.evaluate((m) => window.dispatchEvent(new MessageEvent("message", { data: m })), msg);

  for (const theme of themeNames) {
    fs.mkdirSync(path.join(OUT, theme), { recursive: true });

    for (const [name, scenario] of Object.entries(CHAT_SCENARIOS)) {
      if (only && !name.includes(only)) continue;
      errors = [];
      await page.setViewportSize({ width: 360, height: scenario.height || 760 });
      await page.goto(`${url(chatFile)}?theme=${theme}`);
      await page.waitForSelector("#input", { timeout: 30000 });
      await send(initialState);
      await send({ type: "providerState", providers: [{ id: "grok", connected: true }, { id: "claude", connected: true }, { id: "codex", connected: true }, { id: "gemini", connected: true }] });
      await send({ type: "initialized", info: { provider: "grok", version: "1.0.5" } });
      await send({ type: "setBusy", value: false });
      await scenario.run({ send, page });
      await page.waitForTimeout(250);
      // Where a user would be looking: the newest end of the transcript.
      await page.evaluate(() => { const m = document.getElementById("messages"); if (m) m.scrollTop = m.scrollHeight; });
      await page.waitForTimeout(50);
      const file = path.join(OUT, theme, `${name}.png`);
      await page.screenshot({ path: file });
      results.push({ theme, name, surface: "chat", file, errors });
      log(`${theme}/${name}${errors.length ? `  (${errors.length} page error(s))` : ""}`);
    }

    for (const [name, scenario] of Object.entries(SETTINGS_SCENARIOS)) {
      if (only && !name.includes(only)) continue;
      errors = [];
      await page.setViewportSize({ width: 820, height: 900 });
      await page.goto(`${url(settingsFile)}?theme=${theme}`);
      await page.waitForFunction(() => !!window.GrokSettings, null, { timeout: 30000 });
      await page.evaluate(([s, c]) => window.__mount(s, c), [scenario.snapshot || {}, scenario.category]);
      if (scenario.run) await scenario.run({ page, send });
      await page.waitForTimeout(200);
      // The page scrolls inside its own pane, so a full-page shot would stop at
      // the fold. Grow the window to the tallest scroller instead.
      const tall = await page.evaluate(() => Math.max(
        ...[...document.querySelectorAll("*")].map((el) => el.scrollHeight - el.clientHeight + innerHeight),
      ));
      await page.setViewportSize({ width: 820, height: Math.min(Math.max(900, tall), 6000) });
      await page.waitForTimeout(100);
      const file = path.join(OUT, theme, `${name}.png`);
      await page.screenshot({ path: file });
      results.push({ theme, name, surface: "settings", file, errors });
      log(`${theme}/${name}${errors.length ? `  (${errors.length} page error(s))` : ""}`);
    }
  }
} finally {
  await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

// A contact sheet, so a run is one page to look at rather than ninety files.
const names = [...new Set(results.map((r) => r.name))];
const cell = (theme, name) => {
  const r = results.find((x) => x.theme === theme && x.name === name);
  if (!r) return "<td></td>";
  const rel = path.relative(OUT, r.file).split(path.sep).join("/");
  const err = r.errors.length ? `<div class="err">${r.errors.map((e) => e.replace(/</g, "&lt;")).join("<br>")}</div>` : "";
  return `<td><a href="${rel}"><img loading="lazy" src="${rel}"></a>${err}</td>`;
};
fs.writeFileSync(path.join(OUT, "index.html"), `<!doctype html><meta charset="utf-8"><title>UI harness — ${label}</title>
<style>body{font:13px system-ui;margin:16px;background:#111;color:#ddd}table{border-collapse:collapse}
td,th{vertical-align:top;padding:6px;border-bottom:1px solid #333}img{max-width:380px;border:1px solid #333}
.err{color:#f66;max-width:380px;font:11px monospace}</style>
<h1>UI harness — ${label}</h1><table><tr><th>scenario</th>${themeNames.map((t) => `<th>${t}</th>`).join("")}</tr>
${names.map((n) => `<tr><th>${n}</th>${themeNames.map((t) => cell(t, n)).join("")}</tr>`).join("\n")}</table>`);

const failing = results.filter((r) => r.errors.length);
log(`${results.length} frames → ${path.relative(root, OUT)}${path.sep}index.html`);
if (failing.length) {
  for (const r of failing) log(`page errors in ${r.theme}/${r.name}: ${r.errors.join(" | ")}`);
  process.exitCode = 1;
}
