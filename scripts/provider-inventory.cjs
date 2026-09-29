/** Reproducible W-16 inventory; no authenticated provider probes run. */
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const ts = require("typescript");
const root = path.resolve(__dirname, "..");
const ids = ["grok", "codex", "claude", "gemini", "muse"];
const files = ["sidebar.ts", ...fs.readdirSync(path.join(root, "src")).filter((name) =>
  /(?:-host|sidebar-inbound|session-start|session-catalog|provider-session|provider-setup|agent-authoring|turn-edit|voice-and-mcp|project-folders|routine-scheduler|implicit-context|workflow-stage-runner|webview-html)\.ts$/.test(name) && name !== "vscode-host.ts")];
const reviewed = JSON.parse(fs.readFileSync(path.join(__dirname, "provider-inventory-exceptions.json"), "utf8"));
function inventory(file, source) {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const rows = [];
  const name = (node) => ts.isIdentifier(node) ? node.text : ts.isPropertyAccessExpression(node) ? node.name.text : "";
  const method = (node) => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isMethodDeclaration(parent) || ts.isFunctionDeclaration(parent)) return parent.name?.getText(parsed) || "?";
    }
    return "(module)";
  };
  const add = (node, expr, category) => rows.push({ file, method: method(node), line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1, expr, category });
  function visit(node) {
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)) {
      const sides = [node.left, node.right];
      const literals = sides.filter(ts.isStringLiteral);
      if (sides.some((side) => /provider$/i.test(name(side))) && (literals.length === 0 || literals.some((literal) => ids.includes(literal.text)))) {
        add(node, node.getText(parsed), literals.length ? "specific" : "identity");
      }
    }
    if (ts.isSwitchStatement(node) && /provider$/i.test(name(node.expression))) add(node, "switch (" + node.expression.getText(parsed) + ")", "specific");
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  return rows;
}
const current = files.flatMap((file) => inventory(file, fs.readFileSync(path.join(root, "src", file), "utf8")));
let baselineFiles = 0;
const baseline = files.flatMap((file) => {
  try {
    const source = childProcess.execFileSync("git", ["show", "f4332b3:src/" + file], { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });
    baselineFiles++;
    return inventory(file, source);
  } catch { return []; } // New hosts had no baseline file.
});
const specific = current.filter((row) => row.category === "specific");
for (const row of specific) {
  if (!reviewed.some((item) => item.file === row.file && item.method === row.method && item.expr === row.expr)) throw new Error("Unreviewed provider branch: " + JSON.stringify(row));
}
const before = baseline.filter((row) => row.category === "specific").length;
const identityBefore = baseline.filter((row) => row.category === "identity").length;
const identityAfter = current.filter((row) => row.category === "identity").length;
console.log(JSON.stringify({ baselineFiles, currentFiles: files.length, before, after: specific.length, identityBefore, identityAfter }));
if (process.argv.includes("--write")) {
  const tick = String.fromCharCode(96);
  const code = (value) => tick + value + tick;
  const lines = ["# Provider-Inventur W-16", "", "Basis: gesicherter Einstieg f4332b3 (23 Dateien); aktueller Umfang einschließlich der drei neuen Hosts: 26 Dateien.", "", "Direkte Provider-ID-Vergleiche und Switches: **" + before + " → " + specific.length + "**. Session-Identitätsvergleiche: **" + identityBefore + " → " + identityAfter + "**. Keine Capability-Frage bleibt als direkte ID-Abfrage.", "", "Reproduzierbar: " + code("node scripts/provider-inventory.cjs") + "; mit " + code("--write") + " wird dieser Bericht aktualisiert. Nicht inventarisierte direkte Verzweigungen brechen die Prüfung ab.", "", "Die Capability-Matrix besitzt 25 vollständige Dimensionen für fünf Provider; Runtime-Probes und unsupported-Fallbacks bleiben getrennt. Backend-Mode-Vertrag: provider-modes.ts und AcpBackend.hostModeSequence; CLI-/Auth-/Versions-/Update-Auswahl: provider-cli.ts; Usage-Quellen: provider-usage.ts; einmalige Kopie: provider-ui.ts. Explizite Registry-Einträge sind Strategien und keine verstreuten Provider-Vergleiche.", "", "## Verbliebene direkte Vergleiche", "", "| Ausführende Stelle | Vergleich | Kategorie und Grund | Verhaltenstests |", "|---|---|---|---|"];
  for (const row of specific) {
    const item = reviewed.find((entry) => entry.file === row.file && entry.method === row.method && entry.expr === row.expr);
    lines.push("| [" + row.file + ":" + row.line + "](../src/" + row.file + "#L" + row.line + ") · " + row.method + " | " + code(row.expr) + " | " + item.category + ": " + item.reason + " | [" + item.test + "](../test/" + item.test + ") |");
  }
  lines.push("", "## Identitätsvergleiche", "", "Diese prüfen den konkreten Besitzer einer Session, eines Modells oder einer Rolle; sie entscheiden keine Fähigkeiten und bleiben absichtlich erhalten.", "", "| Stelle | Vergleich |", "|---|---|");
  for (const row of current.filter((item) => item.category === "identity")) lines.push("| " + row.file + ":" + row.line + " · " + row.method + " | " + code(row.expr) + " |");
  fs.writeFileSync(path.join(root, "docs", "provider-inventory.md"), lines.join("\n") + "\n");
}
