// Manual telemetry probe — fires real `session_start` events to the **DEV**
// Aptabase project so you can confirm the pipe end-to-end and watch them land.
// It reuses the REAL compiled builder (`out/telemetry.js`) so what it sends is
// byte-for-byte what the extension would. NOT part of `npm test` (that suite is
// network-free); run on demand:  npm run telemetry:probe
const https = require("node:https");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const telemetryModPath = fs.existsSync(path.resolve(__dirname, "../out-modules/telemetry.js"))
  ? path.resolve(__dirname, "../out-modules/telemetry.js")
  : path.resolve(__dirname, "../out/telemetry.js");
const { buildSessionStartEvent, aptabaseHost, APTABASE_APP_KEY_DEV } = require(telemetryModPath);

// Defaults to the DEV project; override with APTABASE_KEY=... to test another key
// (e.g. a deliberately-wrong one to confirm graceful failure).
const key = process.env.APTABASE_KEY || APTABASE_APP_KEY_DEV;
const host = aptabaseHost(key);
if (!host) {
  // Mirrors the extension: a key with no resolvable region is a silent no-op.
  console.log(`no region host for key ${key} — the extension would skip sending (no-op).`);
  process.exit(0);
}

const sys = {
  appVersion: require("../package.json").version,
  osName: process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux",
  osVersion: os.release(),
  locale: "en",
  isDebug: true,
};

// Two distinct installs (one of them repeated) → 3 events, 2 unique installIds,
// so you can verify the export → distinct-`installId` = unique-users flow.
const samples = [
  { installId: "dev-probe-A", mode: "agent", model: "grok-build", effort: "high", showThinking: false, expandToolDetails: false, steerByDefault: false, chatFontScale: 100, readRepliesAloud: false, soundNotifications: false, sessionOrigin: "local", clientDevice: "desktop", hostKind: "vscode", appPurpose: "knowledge", voiceConfigured: false, voiceStreaming: true, voiceLanguageSet: false, grokConnected: true, codexConnected: false },
  { installId: "dev-probe-A", mode: "yolo", model: "grok-build", effort: "high", showThinking: true, expandToolDetails: true, steerByDefault: true, chatFontScale: 125, readRepliesAloud: true, soundNotifications: true, remoteFontScale: 140, remoteReadRepliesAloud: false, sessionOrigin: "remote", clientDevice: "mobile", hostKind: "desktop", appPurpose: "coding", voiceConfigured: true, voiceStreaming: true, voiceLanguageSet: true, grokConnected: true, codexConnected: true },
  { installId: "dev-probe-B", mode: "plan", model: "grok-code", effort: "low", showThinking: false, expandToolDetails: false, steerByDefault: false, chatFontScale: 90, readRepliesAloud: false, soundNotifications: false, sessionOrigin: "remote", clientDevice: "desktop", hostKind: "vscode", appPurpose: "knowledge", voiceConfigured: false, voiceStreaming: false, voiceLanguageSet: false, grokConnected: false, codexConnected: true },
];

function send(event) {
  return new Promise((resolve) => {
    const body = JSON.stringify(event);
    const req = https.request(
      new URL(`${host}/api/v0/event`),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "App-Key": key,
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve({ status: res.statusCode, body: d.trim() }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, body: e.message }));
    req.write(body);
    req.end();
  });
}

(async () => {
  console.log(`telemetry probe → DEV project ${key} (${host})`);
  let ok = 0;
  for (const s of samples) {
    const event = buildSessionStartEvent(s, sys, randomUUID(), new Date().toISOString());
    const r = await send(event);
    const good = r.status >= 200 && r.status < 300;
    if (good) ok++;
    console.log(`  ${good ? "OK  " : "FAIL"} ${s.installId} mode=${s.mode} model=${s.model} → ${r.status}${r.body ? " " + r.body : ""}`);
  }
  console.log(`done — ${ok}/${samples.length} accepted. Check the DEV Aptabase project (expect 3 events, 2 unique installIds).`);
  process.exit(ok === samples.length ? 0 : 1);
})();
