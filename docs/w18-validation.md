# W-18 validation — 2026-09-30

Scope: B-17 duplicate message arrays, host slash catalogue, slash query/pick/ranking,
skill detection, chip labels/titles/byte formatting, explicit visible chips and queue
text. `src/webview-shared.ts` re-exports pure canonical definitions. Chip and queue
presentation live in `src/shared/`; host imports stay compatible. Browser input
normalization remains in the entry, with no second algorithm implementation.
No persistence keys, protocol discriminants or chat entry changed. W-17 standalone
`---` / setext handling is untouched.

The browser IIFE is checked in. CommonJS callers load it through the old helpers;
browser consumers retain `GrokWebviewHelpers` and `GrokVoiceSettings`. Chat,
Settings and projects rail HTML use the same nonce/CSP for the preceding generated
script. The DOM harness, standalone voice/rail loaders and three screenshot loaders
were audited and updated. No additional loader exists in `test-support/`.
The screenshot harness now obtains markup from the existing `webview-html.ts`.

## Checks

- Focused initial helper/slash/chip/queue/markdown pass: 357 tests.
- Extended protocol/rail/voice pass: 410 tests; focused slash/skills/queue/HTML pass: 112 tests.
- Compile, typecheck and lint: exit 0. Lint required removing the unused
  `isAntigravityCli` import already present at entry commit `f8d8d8d`; no behavior change.
- Full `npm test`: 327 files, 6,286 passed, four existing skips; final run exit 0.
  The first full run passed all assertions but caught one delayed Handoff timer
  exception (`focused.suppressContent`); the unchanged full rerun had no unhandled
  errors. This intermittent pre-existing lifecycle behavior was not modified by W-18.
- `npm run test:integration`: 22/22 passed, VS Code 1.139.1, exit 0.
- Read-only freshness check detects stale output (also observed after the final source declaration edit); after regeneration, byte equality, no absolute-path output or external imports;
  source graph limited to protocol, slash-filter, shared chip/queue and browser entry.
- Chromium: 33 Dark frames, no page errors. Dedicated W-18 composer interaction
  passes in Dark, Light and HC (three frames): mid-prompt skill autocomplete/pick,
  diagnostics and terminal chips, queue paragraph text, `<hr>` and setext `<h2>`.
  Ten Settings frames with the generated loader also pass without page errors.
  Dark composer screenshot visually inspected; output in ignored `.screens/ui/`.

## Package and installation

The entry VSIX was copied outside the project before packaging:
`C:/Users/zfzfg/Documents/HammerMegaProjekte/GitHub-fetches/.vsix-backups/w18/all-your-companions-before-w18.vsix`
(6,824,665 bytes, SHA-256 `95212CE53B52C9C26F3227E6CCAA22BAFE6098C9F48515BDF892B772E90D4E8F`).
`npm run package` includes the required `check:vsix` gate (two packed host JS
files, six runtime dependencies resolve). ZIP verification checks the generated
IIFE, helpers, unbundled chat and both host bundles against the current files, plus
manifest version `0.2.0` and entry `out/extension.js`.

Installation uses `scripts/install.ps1 -VsixPath` with the absolute package path
`C:/Users/zfzfg/Documents/HammerMegaProjekte/GitHub-fetches/grok-build-vscode/all-your-companions-0.2.0.vsix`.
The script selects the native VS Code CLI and reports successful installation of
`zfzfg.all-your-companions@0.2.0`. Installed generated/helper/chat/bundle bytes
are compared with the checkout. Reloading an already-open IDE window is necessary.
Final package size/hash and local stage commits are recorded in the workspace plans.
No paid live probes, push, tag, merge, release or version change. Installed-window
click-through and authenticated provider turns remain unverified; Chromium fixtures
and the Extension Host smoke do not establish user acceptance. W-19 is separate.
