# All your Companions - in one Place!

### *All your Companions — in one place!*

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](LICENSE)
[![Companions](https://img.shields.io/badge/Companions-Antigravity%20(Gemini)%20%C2%B7%20Grok%20%C2%B7%20Codex%20%C2%B7%20Claude%20%C2%B7%20Muse-000000)](https://github.com/zfzfg/all-your-companions)
[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com)
[![Cursor](https://badgen.net/badge/Cursor/Extension/007ACC)](https://cursor.com)

> **Local-first sidebar for five AI coding companions** — Google Antigravity, Grok Build, OpenAI Codex, Anthropic Claude Code, and Meta Muse Code. Parallel sessions, fork/join crews, per-message subagents, native context windows, net diff review, fail-closed worktrees, and voice.
>
> **Maintainer:** Collin Lerche (zfzfg) | STERRA ([https://sterra.online](https://sterra.online))  
> **Community Fork:** An independent community fork of *Grok Build for VS Code* (upstream v4.1.8 by Paweł Huryn), with a selective port of upstream 4.11–4.14. Remote, phone, and desktop-app work stays out.

---

## The Vision of All your Companions

### 1. 100% Local-First: Complete Purge of Remote Relay Bloat
Earlier upstream versions were tethered to an external "AFK Pilot" remote-control relay architecture designed to mirror sessions to mobile devices via external cloud relays (`afkpilot.com`). This introduced network uplinks, external relay server dependencies, device-pairing ceremony, and sleep-prevention locks that compromised privacy and performance.

**All your Companions is an independent fork that completely purges remote relay bloat.**  
By stripping away the remote-control overhead and dead relay pathways, we refocus 100% of our engineering energy directly where it belongs: **inside your local editor**. This delivers:
- **Zero external relay dependencies:** Fully local-first, instantaneous startup, and zero outbound socket relay baggage.
- **Maximum local privacy:** Your code, diffs, sessions, and credentials never touch a third-party relay infrastructure.
- **Massive headroom for editor-native development:** Pure focus on worktree isolation, multi-companion orchestration, deep editor integration, and real-time diff manipulation.

### 2. Five companions on equal footing
No companion is treated as a second-class citizen. All five coding command-line interfaces sit on equal footing within a single sidebar:
- **Google Antigravity CLI (`agy`)**: The Gemini models your installed CLI reports. Pasted screenshots are staged for native vision. Plan mode can surface an implementation-plan review card. Skills are discovered in the workspace and in your user directory, and each file read is bounded. Windows child processes stay hidden until exit is confirmed.
- **xAI Grok Build (`grok`)**: Grok 4.7 and the models the CLI reports, with streaming reasoning traces. A Grok session can select its native context window. That window is separate from an optional input budget.
- **OpenAI Codex CLI (`codex`)**: ACP bridge. Request usage is kept. Catalog size estimates stay in Settings and the context popover. They are not written into the chat as verified occupancy.
- **Meta Muse Code (`muse`)**: Native approval modes, shell sandbox settings, account usage windows, and native workflow cards. A resume snapshot keeps the context provenance it was saved with. See [Muse setup](docs/muse.md).
- **Anthropic Claude Code CLI (`claude`)**: ACP integration with terminal tooling, checkpointing, and permissions. Cumulative usage stays apart from the current context window.

Change the model of the companion you are already talking to. A model switch or a fork starts a fresh context window. To change companions after the first turn, start a new conversation. One message can still name another companion, and a specific model, for a subagent.

Antigravity uses the installed `agy` CLI through our ACP adapter. Its tools run
server-side with native permissions bypassed; per-tool approval cards are not an
Antigravity enforcement boundary. Review the applicable
[Google Antigravity terms](https://antigravity.google/terms) for your account before
connecting through a third-party client. Admission and idle watchdog are optional,
off by default, and configured under `companions.antigravity.*`; they are local
operating controls, not Google account limits. See
[Antigravity settings and compatibility](research/agy-acp-stability.md).

### 3. Universal Diff Inspection & Single-Edit Revert
Every AI provider proposes code edits differently, but **All your Companions** unifies them under one cohesive, safety-first review system:
- **Universal Diff Review:** Prefers native provider diffs and reconstructs missing before-content from captured baselines. Turn and session reviews show net changes; unavailable historical comparisons are explicit. A file's line count is the net diff of the whole edit chain, not the sum of every incremental patch. Relative and absolute paths for the same file count once.
- **Native VS Code Diff Preview:** When any companion proposes an edit, click **Open diff →** to inspect full-file changes directly in VS Code's native side-by-side diff editor before granting permission.
- **Full Control:** Choose *Allow once*, *Always allow for this session*, or *Reject*. Providers that emit permission requests wait for your approval; Antigravity executes tools server-side.
- **One-Click Revert (`revert edit ↶`):** Revert any completed edit directly from the card in chat across Antigravity, Grok, Codex, Claude, and Muse.

---

## Why use this?

If you live in your editor, this puts five companions next to your code: **native diff preview** and **net review counts**, **open files and selection as context**, **parallel sessions**, **fork/join crews** with per-message subagents, **fail-closed worktrees**, **native context windows**, and **voice dictation**.

### Features & capabilities

_Click any feature to expand._

<details>
<summary><strong>Permission cards with diff preview & revert</strong> — see every edit in VS Code's native diff before you approve</summary>

When any companion proposes an edit, hit **open diff →** to review the whole file in VS Code's native diff editor, focused on the first changed line, then *Allow once / always* or *Reject*. The file is written only **after** you approve. Completed edits provide an instant one-click **revert edit ↶** action synthesized across all five companions.

![Permission card with a native VS Code diff preview before approval](docs/screenshots/permission_diff.png)

</details>

<details>
<summary><strong>Universal Multi-Companion Support</strong> — Antigravity (Gemini), Grok, Codex, Claude & Muse</summary>

Connect any of the five companions in **Settings → Providers**. Each session uses the models its installed CLI reports. Muse adds native approval modes, a shell sandbox, and account usage windows. The gear under the composer shows the selected model and reasoning effort. Change models on the current companion; start a new conversation to change companions after a turn. A message can still pin a subagent model with `@subagent:` or a composer chip. The model is checked against that provider's cached roster before send, and the directive stays with the draft, a queued send, and a replay.

</details>

<details>
<summary><strong>Google Antigravity & Gemini</strong> — vision, plan reviews, and skills</summary>

What the Antigravity adapter adds:
- **Multimodal Vision & Screenshot Ingestion:** Paste or drop images directly into the composer. Images are auto-staged to `~/.gemini/staging` and provided to Gemini via native `view_file`, bypassing stream-JSON limits and search loops.
- **Plan Mode Review Workflow:** Intercepts `implementation_plan.md` generation in Plan mode and surfaces the interactive "Approve & implement" review card (`x.ai/exit_plan_mode`).
- **Skills:** Commands discovered under the workspace and your user Antigravity directories are available to the session. Each file read is bounded.
- **Turn lifetime:** Stopping a turn cancels it through finalization. A hidden child process is retained until exit is confirmed, so a spawn is not treated as finished while it is still running.
- **Optional operating controls:** `companions.antigravity.toolRules`, `watchdogIdleTimeoutMs`, `maxActiveTurns`, and `minStartSpacingMs`. Admission and the idle watchdog default to off. They do not enforce a Google account limit.

</details>

<details>
<summary><strong>Context & cost</strong> — native windows, estimates as text, and compaction when it is supported</summary>

Click the **context donut** for the window the companion actually reported, plus input, cache, and output tokens when that provider sent them. A percentage ring is drawn only from a fresh native observation that matches the active model. Estimates, stale figures, billing totals, and Codex catalog sizes stay as text in the popover or in Settings. They are not drawn as occupancy and they are not pasted into the chat. Compact stays available when occupancy is unknown. A verified count can block a prompt that would exceed the window. An incomplete estimate warns and keeps the draft, including its attachments.

![The context popover — window usage, billed totals, and Compact](docs/screenshots/context.png)

</details>

<details>
<summary><strong>Modes — Agent, Plan & Auto accept</strong></summary>

Switch from the bottom toolbar — even mid-turn, so you can flip to **Auto accept** to stop approving cards without stopping the agent. **Plan** mode blocks workspace writes and non-read-only commands on companions that honor the client gate, until you approve the plan. Antigravity executes tools server-side, so this switch is not its enforcement boundary.

![The mode picker — Agent, Plan, and Auto accept](docs/screenshots/agent_modes.png)

</details>

<details>
<summary><strong>Agents &amp; Crew</strong> — pick who answers for each role, and how a crew walks a plan</summary>

**Settings → Agents & Crew** is where roles and crew flows are configured; you no longer have to hand-write YAML for either.

A **role** is a session recipe — which companion answers, on which model, at which effort, in which mode, and the prose saying when to reach for it. `/agent <role> <task>` runs one in its own session. The five shipped roles (`planner`, `implementer`, `reviewer`, `researcher`, `fixer`) work out of the box; editing one writes a file that takes over from it.

Pointing each role at its own companion is the point rather than a detail: a `reviewer` on a different model from the `implementer` is what makes a review worth having, and a review by the same model in the same thread finds nothing while looking like it did. A model the chosen companion does not carry is refused rather than quietly replaced with its default.

A **crew flow** is how `/crew` walks a plan: which roles may be assigned and in what order, a command to run after each writing step (a red check splices in a `fixer`), how often to stop and review, and whether independent steps may run at once in their own worktrees.

Both are stored as plain Markdown files you can read, diff and review — **this project** (`.companions/`, versionable and shared with your team) or **all projects** (`~/.companions/`, this machine only). A project file wins over an all-projects one of the same name, and the page says which file is actually in force.

A workflow file stays schema 1 unless it sets `schemaVersion: 2`. Schema 2 is what adds an explicit fork/join graph. A schema 1 file that contains a fork is rejected rather than run with the fork dropped. The Crew panel follows the run with a stepper, collapses finished steps, and can pause or resume in place. Notes between a parent and a child, and between stages, go through one mailbox, so a repeated note is not delivered twice. A rate limit backs the run off. The run switches companion only when that account's quota is exhausted. A full writer pool waits instead of starting another writer. Non-overlapping edits to the same text file can merge. Overlapping edits stay a conflict.

</details>

<details>
<summary><strong>Worktree sessions</strong> — isolate code edits in a git worktree</summary>

**Companions: New Worktree Session** creates an isolated git worktree under `~/.grok/worktrees/` and opens a fresh session whose cwd is that checkout — so agent edits don't touch your main tree until you **Apply worktree**. Works for all five companions: a live Grok session uses Grok's worktree RPCs (including clone mode); otherwise the host runs `git worktree add` itself (linked worktrees only). If a crew stage or subagent asked for a worktree and that worktree cannot be created, the writer does not start in your shared checkout. `companions.subagents.isolationFallback` can allow a visible shared fallback. A parallel wave never falls back silently. **Apply worktree** includes uncommitted changes and still refuses to overwrite a file you changed in the main checkout since the branch. The same file reached by two path spellings is one claim.

`/crew [flow]` walks a step list as a team: each step is a fresh session with a compact briefing, assigned to a role by host rules (you are asked when that is unclear). Sequential is the default; a flow can run independent writers at the same time, each in its own worktree. The Crew panel above the composer shows every step's role, status, duration and cost. **Companions: Run Crew** is the same action from the Command Palette.

</details>

<details>
<summary><strong>Voice control</strong> — hands-free dictation with live transcription</summary>

The **microphone button** dictates speech via Speech-to-Text — words appear live as you talk. Say **"companion send"** to submit hands-free and keep dictating; messages spoken while the companion responds queue and flush when it finishes.

![Voice control with live transcription in the composer](docs/screenshots/voice_mode.png)

</details>

<details>
<summary><strong>File chips & smart relative paths</strong> — your editor and selection as <code>@file</code> context</summary>

The active editor rides along automatically; add more by **typing `@` in the composer**, dragging from the Explorer, right-click → **Companions: Send File**, **Alt+G**, or the **+** button. Relative file links in chat automatically resolve across parent directories and nested subprojects (`findInSubtree`).

![Composer with an image, a file, and a selection chip attached](docs/screenshots/file_chips.png)

</details>

<details>
<summary><strong>Session history & transcript replay</strong> — parallel sessions with status dots; resume, rename, search & clear</summary>

Sessions run in **parallel**: start a new one with **+** while another is mid-turn and switch between them instantly. Each row's **status dot** reflects its state (🔵 Blue: working, 🟡 Yellow: waiting for approval, 🟢 Green: finished unread, 🔴 Red: error unread, ⚪ Gray: idle). Sessions persist across restarts, restoring conversation IDs and replaying transcripts. An unsent draft, its selection, and edited attachments survive loading, focus changes, and a webview restore. Connect checks an existing sign-in before it offers login.

![Session history dropdown with status dots](docs/screenshots/session_history.png)

</details>

<details>
<summary><strong>Queue or steer</strong> — type while companion works, without interrupting</summary>

Messages sent mid-turn queue smoothly at the end of the chat. Hit **Steer** on a queued message to redirect the companion immediately without losing tool work in flight.

![A queued message with the Steer button](docs/screenshots/steer.png)

</details>

<details>
<summary><strong>Math & LaTeX rendering</strong> — equations render as typeset math</summary>

LaTeX in answers — inline `\(…\)`, display `\[…\]`, matrices, integrals — renders as real typeset math via MathJax, bundled offline.

![LaTeX expressions rendered as typeset math](docs/screenshots/v1.4.5%20LaTeX%20expressions.png)

</details>

<details>
<summary><strong>Mermaid diagrams</strong> — flowcharts and architecture render visually</summary>

` ```mermaid ` blocks render as interactive diagrams matching your VS Code theme.

![Mermaid diagram rendered inline in the chat](docs/screenshots/v1.4.6%20Mermaid%20diagrams.png)

</details>

<details>
<summary><strong>Markdown</strong> — headings, alerts, nested quotes, and links</summary>

Answers render six heading levels, bare links, GitHub PR chips, and paths that contain spaces. Nested blockquotes and the body of a GitHub alert render with the surrounding quote. Quote borders follow text direction and high-contrast colors.

</details>

---

## Requirements

- **VS Code** 1.106+ (or a compatible editor on the same base, e.g. Cursor 3.x).
- **At least one Companion CLI installed:**
  - **Google Antigravity CLI** (`agy` / `antigravity`) with Gemini access, OR
  - **Grok Build CLI** (`grok`) with an X or Grok account (free trial with usage limits), SuperGrok / X Premium+ or an xAI API key, OR
  - **OpenAI Codex CLI** (`codex`), OR
  - **Anthropic Claude Code CLI** (`claude`), OR
  - **Meta Muse Code CLI** (`muse`).
- **Voice control** (optional): requires [`ffmpeg`](https://ffmpeg.org) on PATH to record audio.

---

## Install

**1. Install the extension.** In VS Code or Cursor, open **Extensions** (`Ctrl/Cmd+Shift+X`) and search **"All your Companions"** (or install the `.vsix` package).

**2. Open Companions and sign in.** Press `Ctrl/Cmd+;`. The sidebar walks you through choosing your companion and getting started in one click.

Companions opens in the **Secondary Side Bar** by default. Gear → **Config & debug** → **Move view** relocates it to the Panel or Primary Side Bar in one click.

---

## Quick start

1. **Open** Companions: `Ctrl/Cmd+;` (or Command Palette: `Companions: Open`).
2. **Type a prompt** and press **Enter**. Your companion streams its response and displays live reasoning traces.
3. **Approve actions.** Preview file edits with the native VS Code diff editor, then *Allow once*, *Always allow*, or *Reject*.
4. **Pick your mode** (Agent / Plan / Auto accept). The gear under the composer shows the selected model and reasoning effort.
5. **Resume anytime** — the clock icon lists past sessions.

---

## Configuration

Open VS Code Settings and search for `companions` (legacy `grok.*` settings are also supported as aliases):

| Setting | Default | Notes |
|---|---|---|
| `companions.cliPath` | `""` | Path to companion CLI binary. Empty = auto-discover. |
| `companions.defaultModel` | `""` | Model ID for new sessions. Empty = provider default. |
| `companions.defaultEffort` | `""` | Reasoning effort (`none` / `low` / `medium` / `high` / `xhigh`). |
| `companions.askTimeout` | `"off"` | Auto-continue an unanswered question card after `60s` / `5m` / `10m`. Timer runs in the editor, not the panel. |
| `companions.defaultMode` | `""` | Default mode for fresh sessions (`Agent`, `Auto accept`). |
| `companions.includeActiveFileByDefault` | `true` | Auto-add the active editor as a context chip. |
| `companions.mentionIndexLimit` | `5000` | How many workspace files `@` autocomplete indexes. |
| `companions.showThinking` | `false` | Show reasoning traces in chat. |
| `companions.expandCommandOutputs` | `false` | Auto-expand tool details and inline diffs. |
| `companions.steerByDefault` | `false` | Steer straight into running turns instead of queueing. |
| `companions.soundNotifications` | `false` | Audible chime when a background companion finishes. |
| `companions.voiceStreaming` | `true` | Stream live voice transcription as you speak. |
| `companions.voiceSendPhrase` | `"companion send"` | Spoken phrase to submit hands-free. |
| `companions.antigravity.toolRules` | `prompt` | Antigravity tool guidance. `prompt` adds temporary instructions, `off` disables them, `global` seeds missing files under `~/.gemini` and never overwrites existing ones. |
| `companions.antigravity.watchdogIdleTimeoutMs` | `0` | Idle watchdog in milliseconds. `0` disables it. An enabled value must be at least 30000. Permission, question, and plan waits pause it. |
| `companions.antigravity.maxActiveTurns` | `0` | Simultaneous Antigravity turns in this window, including Crew and subagents. `0` disables admission. This is not an account-wide limit. |
| `companions.antigravity.minStartSpacingMs` | `2000` | Minimum spacing between Antigravity turn starts when admission is enabled. |
| `companions.subagents.writeIsolation` | `shared` | `shared` edits your tree and claims files first. `worktree` gives each writing subagent its own checkout. |
| `companions.subagents.isolationFallback` | `fail` | When a requested worktree cannot be created, `fail` does not start the writer. `shared` says so and uses the shared checkout. A parallel wave never falls back silently. |

---

## Commands & keybindings

| Command | What it does | Keybinding |
|---|---|---|
| `Companions: Open` | Open the All your Companions sidebar | `Ctrl+;` / `Cmd+;` |
| `Companions: New Session` | Start a fresh companion session | — |
| `Companions: Pick Model` | Select active model / companion | — |
| `Companions: Toggle Plan / Agent Mode` | Switch between Agent, Plan, and Auto accept | — |
| `Companions: Send File` | Add file to composer | — |
| `Companions: Insert @-Mention` | Insert `@`-mention for active file | `Alt+G` |
| `Companions: Compact Conversation` | Compact conversation to reclaim context | — |
| `Companions: New Worktree Session` | Spawn an isolated git worktree session | — |
| `Companions: Run Crew` | Walk a plan as a chain of roles (`/crew`). Sequential by default | — |
| `Companions: Show Logs` | Open output channel (ACP JSON-RPC logs) | — |

*(Legacy `Grok:*` commands remain registered as aliases for backward compatibility.)*

---

## Development

Building, testing, and contribution conventions live in **[docs/development.md](docs/development.md)**.
Google Antigravity and Gemini integration architecture: **[docs/ANTIGRAVITY_INTEGRATION_COMPLETE_DOCUMENTATION.md](docs/ANTIGRAVITY_INTEGRATION_COMPLETE_DOCUMENTATION.md)**.
PowerShell release helpers: `scripts/bump-version.ps1`, `scripts/compile.ps1`, `scripts/package.ps1`, and `scripts/release-ovsx.ps1`.

---

## Known limits

- **Diff preview semantics:** Full-file side-by-side diff tabs are reconstructed from memory and the disk state. Providers that emit permission requests write the file only after you approve. Antigravity executes tools server-side, so those approval cards are not its enforcement boundary.
- **View placement:** Homed in the Secondary Side Bar by default; relocate anytime via gear → **Config & debug** → **Move view**.

---

## Privacy

**Privacy by design** — no message content, code, or file paths leave your machine through external relays.
- All AI communication is conducted locally over standard I/O (`stdio`) directly to your locally installed CLIs.
- Completely free of third-party remote relay servers or external device mirroring dependencies.
- Anonymous, opt-out telemetry honors VS Code's global `telemetry.telemetryLevel` setting.
- Voice transcription sends audio strictly to your chosen STT provider.

More details: **[docs/privacy.md](docs/privacy.md)**.

---

## License & attribution

Licensed under the **Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)** — see [LICENSE](LICENSE).  
This project is an independent community fork derived from *Grok Build for VS Code* (upstream v4.1.8) © Paweł Huryn, with a selective port of upstream 4.11–4.14. Remote, phone, and desktop-app changes are not part of this fork.  
Fork maintained and evolved by Collin Lerche (zfzfg) | STERRA ([https://sterra.online](https://sterra.online)).

Not affiliated with or endorsed by SpaceXAI, xAI, Google, Anthropic, or OpenAI. Grok and xAI are trademarks of xAI.


Grok Build can be tried with any X or Grok account, subject to usage limits. Sustained use may require SuperGrok, X Premium+ or an xAI API key. This is not a promise of unlimited usage.
