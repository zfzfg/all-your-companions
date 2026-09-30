# Selective upstream 4.11–4.14 port

Fork baseline: `72788d2`. Working branch: `sync/upstream-4.14`. Upstream comparison: `4444697..27ede44` (through 4.14.1). Changes are adapted individually; this is not an upstream merge.

## Provenance

| Stage | Source commits / original work | Fork adaptation |
|---|---|---|
| Connections / process failures | `6480793`; upstream 4.13.1 existing-account flow | Consent retained, credential generation guards, coalesced checks; only authenticated warm-ups clear a new unverified account. Projects rail allows the existing refresh action. |
| Drafts / edit attachments | `d7ef9869` (mateolafalce3@gmail.com, Michael), `d2ff5dbb` (fiko942), `13e03f3`, `e2ef039`, `4695eef`, `55cd4e4` | Existing webview state gains conversation drafts and provisional IDs; existing queue restoration and host-owned attachment validation remain in use. |
| Provider switch / startup | `4fad933`, `3e866de`, `d5b1ddc`, `60874a8`, `27af0e1` | Detach prior client, reuse session generation, remember mode per provider with legacy fallback. Ordered startup frames and replay snapshot; declined starts return idle. Model preference remains the existing per-project/provider policy. |
| Muse | `b64b60e`, `a00f5ef`, `4da4534`, `0a2176a`, `cd715a1`, `8be0ec8`, `6fb0ed2`, `e860e36` | Native approvals and captured process posture; three modes with sandbox requirements. Keep fork context quality, permissions and command viewers. Omit cloud branches. Installer is host-owned and independently confirmed. |
| Markdown / native cards | `a06ec1c`, `a8230a5`, `0223c30`, `54df5f4`; upstream inline renderer and path parsing | Preserve image rendering and fork card family. Codex native children, Claude async tasks/workflows and Muse workflows normalize into native cards. Reported phases/agents are associated; at most three titles in the summary. No changes to Companion routing, Crew runner or workflow generation. |
| Public documentation | `27ede44` and upstream 4.14 provider copy | Grok 4.7, Muse description, bounded free trial copy, regenerated Marketplace README and fork-specific setup notes. |

Most upstream work above is by Paweł Huryn (`pawel.huryn@gmail.com`), original project [phuryn/grok-build-vscode](https://github.com/phuryn/grok-build-vscode). Draft work is credited to mateolafalce3@gmail.com and Michael (`265398295+lafalce-assistant@users.noreply.github.com`); edited attachment work to fiko942 (`tobellord@gmail.com`). Local port commits retain co-author trailers and the repository's existing license/attribution notices.

## Boundaries and verification

Desktop, cloud, phone and remote handoff are excluded. The extension keeps existing provider policies, consent migration, login retry ladder, unnamed command viewers, context-budget quality, Companion cards and Crew behavior. There is no version bump, publishing or installation into the user's VS Code. The isolated VS Code integration harness is a test environment.

Compile/typecheck/lint, full unit suite, provider inventory, generated shared helpers, Marketplace freshness, VS Code integration and packaged dependency graph are required. UI fixtures `upstream-*` cover native workflow/Markdown, Muse modes, installer and settings in Dark, Light and High Contrast. Real CLI smoke tests are intentionally deferred until an explicitly requested publication. Local testing covers Windows; existing CI owns the three-OS matrix.

## Recorded results — 2026-09-30

- Compile, TypeScript checks and lint passed.
- Full unit suite: 6,481 passed, zero failures. This includes regressions ensuring ordinary model refreshes also retain unverified credentials after technical failures.
- Isolated VS Code integration: 22 passed on Windows with VS Code 1.139.1.
- VSIX dependency check: both packed JavaScript entry points and six packed dependencies resolve.
- Provider inventory and generated shared helper freshness passed; Marketplace README was regenerated and freshness is covered by the unit suite.
- Twelve UI captures were reviewed: four changed surfaces in Dark, Light and High Contrast. Captures are in `.screens/ui/upstream-4.14/`.
- Real provider CLI smoke tests and the three-platform CI matrix were not run locally. No release, version change or installation into the user's VS Code was performed.
