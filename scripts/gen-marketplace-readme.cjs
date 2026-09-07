/**
 * One-shot / rebuild helper: regenerate README.marketplace.md from README.md
 * by taking the extension-facing body and wrapping an extension-only header.
 * Run: node scripts/gen-marketplace-readme.cjs
 *
 * Packaging always uses --readme-path README.marketplace.md; this script is
 * only for regenerating content after large README edits.
 *
 * `buildMarketplaceReadme` is exported so the suite can assert the committed
 * file still matches what this produces. That check is the point: the listing
 * is generated, so a hand-edit to the output is silently destroyed the next
 * time anyone runs the script — which is how `## Companion apps` came to exist
 * only in the output file, and would have vanished on the next regeneration.
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

const header = `# All your Companions - in one Place! (formerly Grok Build for VS Code (Community))

### *All your Companions — in one place!*

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](https://github.com/phuryn/grok-build-vscode/blob/main/LICENSE) ![Agents](https://img.shields.io/badge/Agents-Antigravity%20%C2%B7%20Grok%20%C2%B7%20Codex%20%C2%B7%20Claude-000000) [![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com) [![Cursor](https://badgen.net/badge/Cursor/Extension/007ACC)](https://cursor.com)

> **Unified GUI for AI Coding Companions** — Google Antigravity, Grok Build, OpenAI Codex, and Anthropic Claude Code.
>
> **Maintainer:** Collin Lerche (zfzfg) | STERRA ([https://sterra.online](https://sterra.online))  
> **Community Fork:** Derived from *Grok Build for VS Code* (upstream v4.1.8 by Paweł Huryn).

The unified, local-first GUI for your favorite AI coding companions: **Google Antigravity CLI** (Gemini 2.5/3), **Grok Build** (Grok 4.6), **OpenAI Codex**, and **Claude Code** — right inside your editor. Drop open files in as \`@\`-context, run **parallel sessions**, inspect **native diff previews** with **one-click revert**, keep **resumable chat history**, typeset **LaTeX & Mermaid diagrams**, and dictate by **voice**.

---

## Why use this?

If you live in your editor, this puts your AI companions right next to your code in a unified graphical workflow: **native diff preview** on every proposed edit with **one-click revert**, **open files and selection as context**, **parallel sessions** with status dots, **resumable history**, **inline images & video**, and **voice dictation**.

`;

// Install + Quick start for the marketplace: extension only. README.md's own
// pair is dual-host, so it is sliced out of the body rather than shipped —
// see buildMarketplaceReadme. Deliberately does NOT link to the Marketplace or
// Open VSX the way README.md does: this page IS the store page.
const installBlock = `## Install

**1. Install the extension.** In VS Code or Cursor, open **Extensions** (\`Ctrl/Cmd+Shift+X\`) and search **"All your Companions"**.

**2. Open Companions and sign in.** Press \`Ctrl/Cmd+;\`. The sidebar walks you through choosing your companion and getting started in one click.

Companions opens in the **Secondary Side Bar** (right side, next to other AI tools). Prefer it elsewhere? Gear → **Config & debug** → **Move view** relocates it to the Panel or Primary Side Bar in one click.

> Prefer the terminal, building from source, or installing into several IDEs at once? See the project [INSTALL docs](https://github.com/phuryn/grok-build-vscode/blob/main/docs/INSTALL.md).

---

## Quick start

1. **Open** Companions: \`Ctrl/Cmd+;\` (or Command Palette: **Companions: Open**).
2. **Type a prompt** and press **Enter**. Your companion streams its response and displays live reasoning traces.
3. **Approve actions.** Preview file edits with the native VS Code diff editor, then *Allow once*, *Always allow*, or *Reject*.
4. **Pick your mode** (Agent / Plan / Auto accept) and **model** from the bottom toolbar.
5. **Resume anytime** — the clock icon lists past sessions.

---

`;

// The companions the listing may mention.
const companionBlock = `## Companion apps

All your Companions is completely standalone and local-first — no external relay servers or third-party cloud brokers required. It natively coordinates:

- **Google Antigravity CLI (\`agy\`)** — Gemini 2.5 Pro/Flash and Gemini 3 with massive context and streaming reasoning traces.
- **xAI Grok Build (\`grok\`)** — Grok 4.6, SuperGrok, and xAI API integration.
- **OpenAI Codex CLI (\`codex\`)** — High-speed ACP JSON-RPC bridge.
- **Anthropic Claude Code CLI (\`claude\`)** — Full ACP terminal and session integration.

*(AFK Pilot remote control functions are legacy/deprecated in All your Companions in favor of local-first execution).*

---

`;

// Dual-host wording that must not drift in from README.md. Checked against the
// body-derived parts only — the blocks above are authored here and say "Grok
// Build Desktop" deliberately, so scanning the whole output would fire on our
// own text.
const BANNED_IN_BODY = [
  /Grok Build Desktop/i,
  /desktop app/i,
  /standalone Electron/i,
  /npm run dist/i,
  /dist-desktop/i,
  /electron-builder/i,
];

function buildMarketplaceReadme(githubReadme) {
  const github =
    githubReadme ?? fs.readFileSync(path.join(root, "README.md"), "utf8");

  const featIdx = github.indexOf("### Features");
  if (featIdx < 0) throw new Error("README.md missing ### Features section");

  let body = github.slice(featIdx);

  // Drop repo Development section (marketplace listing is usage-focused).
  const dev = body.indexOf("## Development");
  const known = body.indexOf("## Known limits");
  if (dev >= 0 && known > dev) {
    body = body.slice(0, dev) + body.slice(known);
  }

  // Strip dual-host install / quick-start wording if present in the body.
  body = body.replace(/\n### Grok Build Desktop[\s\S]*?(?=\n### |\n## )/m, "\n");
  body = body.replace(/\n### VS Code \/ Cursor extension\n\n/m, "\n");
  body = body.replace(
    /1\. \*\*Open\*\* Grok — in VS Code: `Ctrl\/Cmd\+;` \(Secondary Side Bar by default\); in Desktop: launch the app and add a project folder\./,
    "1. **Open** the Grok view (`Ctrl/Cmd+;`, or **Grok: Open** from the command palette) — it lives in the Secondary Side Bar by default.",
  );
  body = body.replace(
    /preview an edit \(native diff in VS Code; in-app viewer on Desktop\)/,
    "preview an edit in the native **diff editor**, with full-file context focused on the first changed line",
  );

  // Marketplace prefers absolute image/doc URLs (no local repo tree in the store).
  body = body.replace(
    /\((docs\/screenshots\/[^)]+)\)/g,
    "(https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/$1)",
  );
  body = body.replace(
    /\]\((docs\/[^)]+)\)/g,
    "](https://github.com/phuryn/grok-build-vscode/blob/main/$1)",
  );
  body = body.replace(
    /\]\(LICENSE\)/g,
    "](https://github.com/phuryn/grok-build-vscode/blob/main/LICENSE)",
  );

  // README.md order is Requirements → Install → Quick start → Configuration.
  // Keep that reading order, but swap in the extension-only Install/Quick start
  // pair by slicing the body AROUND the two sections we replace. Appending ours
  // in front of them instead is what printed both headings twice.
  const reqIdx = body.indexOf("## Requirements");
  const installIdx = body.indexOf("## Install");
  const configIdx = body.indexOf("## Configuration");
  const privacyIdx = body.indexOf("## Privacy");
  for (const [name, idx] of [
    ["## Requirements", reqIdx],
    ["## Install", installIdx],
    ["## Configuration", configIdx],
    ["## Privacy", privacyIdx],
  ]) {
    if (idx < 0) throw new Error(`README.md missing ${name}`);
  }
  if (!(reqIdx < installIdx && installIdx < configIdx && configIdx < privacyIdx)) {
    throw new Error("README.md sections are out of the expected order");
  }

  const featuresOnly = body.slice(0, reqIdx);
  const requirements = body.slice(reqIdx, installIdx);
  // Configuration .. Known limits. Install/Quick start are dropped on purpose.
  const middle = body.slice(configIdx, privacyIdx);
  const tail = body.slice(privacyIdx);

  const bodyDerived = featuresOnly + requirements + middle + tail;
  for (const re of BANNED_IN_BODY) {
    if (re.test(bodyDerived)) {
      throw new Error(`marketplace README still matches ${re}`);
    }
  }

  const out =
    header +
    featuresOnly +
    requirements +
    installBlock +
    middle +
    companionBlock +
    tail;

  // README.md is CRLF on disk while the blocks above are LF template literals,
  // so the concatenation is mixed. Markdown does not care, but a generated file
  // with two line endings in it is noise in every diff — normalise to LF and let
  // git renormalise on checkout.
  return out.replace(/\r\n/g, "\n");
}

module.exports = { buildMarketplaceReadme };

if (require.main === module) {
  const out = buildMarketplaceReadme();
  fs.writeFileSync(path.join(root, "README.marketplace.md"), out, "utf8");
  console.log("Wrote README.marketplace.md (%d bytes)", Buffer.byteLength(out, "utf8"));
}
