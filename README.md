# AllYourCompanions

### *All your Companions — in one place!*

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](LICENSE)
[![Companions](https://img.shields.io/badge/Companions-Antigravity%20(Gemini)%20%C2%B7%20Grok%20%C2%B7%20Codex%20%C2%B7%20Claude-000000)](https://github.com/zfzfg/all-your-companions)
[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com)
[![Cursor](https://badgen.net/badge/Cursor/Extension/007ACC)](https://cursor.com)

> **Unified GUI for AI Coding Companions** — Google Antigravity, Grok Build, OpenAI Codex, and Anthropic Claude Code.
>
> **Maintainer:** Collin Lerche (zfzfg) | STERRA ([https://sterra.online](https://sterra.online))  
> **Community Fork:** Derived from *Grok Build for VS Code* (upstream v4.1.8 by Paweł Huryn).

---

## The Vision of AllYourCompanions

### *All your Companions — in one place!*

### 1. Decoupling from Remote Control Bloat
Earlier versions were tethered to an external "AFK Pilot" remote-control relay architecture designed to mirror sessions to mobile devices via external cloud relays (`afkpilot.com`). While ambitious, this introduced complex network uplinks, external relay server dependencies, device-pairing ceremony, and sleep-prevention locks that distracted from the core editor experience.

**AllYourCompanions consciously departs from remote relay control.**  
By stripping away the remote-control overhead and dead relay pathways, we refocus 100% of our engineering energy directly where it matters most: **inside VS Code and Cursor**. This delivers:
- **Zero external relay dependencies:** Fully local-first, blazing-fast startup, and zero outbound socket relay baggage.
- **Maximum local privacy:** Your code, diffs, sessions, and credentials never touch a third-party relay infrastructure.
- **Massive headroom for editor-native development:** Unlocks freedom to innovate on worktree isolation, multi-companion orchestration, deep editor integration, and real-time diff manipulation.

### 2. Equal Multi-Companion Focus
No companion is treated as a second-class citizen. All leading AI coding command-line interfaces sit on equal footing within a single, elegant sidebar:
- **Google Antigravity CLI (`agy`)**: Native ACP adapter integration bringing Gemini 2.5 Pro, Gemini 2.5 Flash, and Gemini 3 directly into your workflow with zero proxy friction and full reasoning traces.
- **xAI Grok Build**: Full support for Grok 4.6, SuperGrok, and xAI API.
- **OpenAI Codex**: High-speed ACP JSON-RPC bridge for Codex CLI.
- **Anthropic Claude Code**: Deep ACP integration with Claude CLI.

Switch models or companion providers on the fly in any conversation — context carries forward seamlessly.

### 3. Universal Diff Inspection & One-Click Revert
Every AI provider proposes code edits differently, but **AllYourCompanions** unifies them under one cohesive, safety-first review system:
- **Native VS Code Diff Preview:** When any companion proposes an edit, click **Open diff →** to inspect full-file changes directly in VS Code's native side-by-side diff editor before granting permission.
- **Full Control:** Choose *Allow once*, *Always allow for this session*, or *Reject*. Changes hit your disk **only after your explicit approval**.
- **Cross-Provider Rollback & Revert:** Revert changes per-file or roll back entire conversational turns with safety confirmation snapshots, regardless of whether Antigravity, Grok, Codex, or Claude performed the edits.

---

## Why use this?

If you live in your editor, this puts your AI companions right next to your code in a unified graphical workflow: **native diff preview** on every proposed edit with **one-click revert**, **open files and selection as context**, **parallel sessions** with status dots, **resumable history**, **inline images & video**, and **voice dictation**.

### Features & capabilities

_Click any feature to expand._

<details>
<summary><strong>Permission cards with diff preview & revert</strong> — see every edit in VS Code's native diff before you approve</summary>

When any companion proposes an edit, hit **open diff →** to review the whole file in VS Code's native diff editor, focused on the first changed line, then *Allow once / always* or *Reject*. The file is written only **after** you approve. Completed edits provide an instant one-click **Revert** action.

![Permission card with a native VS Code diff preview before approval](docs/screenshots/permission_diff.png)

</details>

<details>
<summary><strong>Universal Multi-Companion Support</strong> — Antigravity, Grok, Codex & Claude</summary>

Connect any leading AI companion in **Settings → Providers**. Antigravity CLI (`agy`) brings Gemini 2.5/3 Pro & Flash with full streaming reasoning; Grok Build brings Grok 4.6; Codex and Claude Code run over ACP stdio. Switch companions or models anytime mid-thread.

</details>

<details>
<summary><strong>Modes — Agent, Plan & Auto accept</strong></summary>

Switch from the bottom toolbar — even mid-turn, so you can flip to **Auto accept** to stop approving cards without stopping the agent. **Plan** mode enforces client-side safety: workspace writes and non-read-only commands are genuinely blocked until you approve the plan.

![The mode picker — Agent, Plan, and Auto accept](docs/screenshots/agent_modes.png)

</details>

<details>
<summary><strong>Worktree sessions</strong> — isolate code edits in a git worktree</summary>

**Companions: New Worktree Session** creates an isolated git worktree under `~/.companions/worktrees/` and opens a fresh session whose cwd is that checkout — so agent edits don't touch your main tree until you **Apply worktree**.

</details>

<details>
<summary><strong>Voice control</strong> — hands-free dictation with live transcription</summary>

The **microphone button** dictates speech via Speech-to-Text — words appear live as you talk. Say **"companion send"** to submit hands-free and keep dictating; messages spoken while the companion responds queue and flush when it finishes.

![Voice control with live transcription in the composer](docs/screenshots/voice_mode.png)

</details>

<details>
<summary><strong>File chips</strong> — your editor and selection as <code>@file</code> context</summary>

The active editor rides along automatically; add more by **typing `@` in the composer**, dragging from the Explorer, right-click → **Companions: Send File**, **Alt+G**, or the **+** button.

![Composer with an image, a file, and a selection chip attached](docs/screenshots/file_chips.png)

</details>

<details>
<summary><strong>Session history</strong> — parallel sessions with status dots; resume, rename, search & clear</summary>

Sessions run in **parallel**: start a new one with **+** while another is mid-turn and switch between them instantly. Each row's **status dot** reflects its state (🔵 Blue: working, 🟡 Yellow: waiting for approval, 🟢 Green: finished unread, 🔴 Red: error unread, ⚪ Gray: idle).

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
<summary><strong>Context & cost</strong> — what's in the window, and what turns actually bill</summary>

Click the **context donut** for exact window usage, input/cache/output tokens, and cost tracking.

![The context popover — window usage, billed totals, and Compact](docs/screenshots/context.png)

</details>

---

## Requirements

- **VS Code** 1.106+ (or a compatible editor on the same base, e.g. Cursor 3.x).
- **At least one Companion CLI installed:**
  - **Google Antigravity CLI** (`agy` / `antigravity`) with Gemini access, OR
  - **Grok Build CLI** (`grok`) with SuperGrok / X Premium+ or xAI API key, OR
  - **OpenAI Codex CLI** (`codex`), OR
  - **Anthropic Claude Code CLI** (`claude`).
- **Voice control** (optional): requires [`ffmpeg`](https://ffmpeg.org) on PATH to record audio.

---

## Install

**1. Install the extension.** In VS Code or Cursor, open **Extensions** (`Ctrl/Cmd+Shift+X`) and search **"AllYourCompanions"** (or install the `.vsix` package).

**2. Open Companions and sign in.** Press `Ctrl/Cmd+;`. The sidebar walks you through choosing your companion and getting started in one click.

Companions opens in the **Secondary Side Bar** by default. Gear → **Config & debug** → **Move view** relocates it to the Panel or Primary Side Bar in one click.

---

## Quick start

1. **Open** Companions: `Ctrl/Cmd+;` (or Command Palette: `Companions: Open`).
2. **Type a prompt** and press **Enter**. Your companion streams its response and displays live reasoning traces.
3. **Approve actions.** Preview file edits with the native VS Code diff editor, then *Allow once*, *Always allow*, or *Reject*.
4. **Pick your mode** (Agent / Plan / Auto accept) and **model** from the bottom toolbar.
5. **Resume anytime** — the clock icon lists past sessions.

---

## Configuration

Open VS Code Settings and search for `companions` (legacy `grok.*` settings are also supported as aliases):

| Setting | Default | Notes |
|---|---|---|
| `companions.cliPath` | `""` | Path to companion CLI binary. Empty = auto-discover. |
| `companions.defaultModel` | `""` | Model ID for new sessions. Empty = provider default. |
| `companions.defaultEffort` | `""` | Reasoning effort (`none` / `low` / `medium` / `high` / `xhigh`). |
| `companions.defaultMode` | `""` | Default mode for fresh sessions (`Agent`, `Auto accept`). |
| `companions.includeActiveFileByDefault` | `true` | Auto-add the active editor as a context chip. |
| `companions.mentionIndexLimit` | `5000` | How many workspace files `@` autocomplete indexes. |
| `companions.showThinking` | `false` | Show reasoning traces in chat. |
| `companions.expandCommandOutputs` | `false` | Auto-expand tool details and inline diffs. |
| `companions.steerByDefault` | `false` | Steer straight into running turns instead of queueing. |
| `companions.soundNotifications` | `false` | Audible chime when a background companion finishes. |
| `companions.voiceStreaming` | `true` | Stream live voice transcription as you speak. |
| `companions.voiceSendPhrase` | `"companion send"` | Spoken phrase to submit hands-free. |

---

## Commands & keybindings

| Command | What it does | Keybinding |
|---|---|---|
| `Companions: Open` | Open the AllYourCompanions sidebar | `Ctrl+;` / `Cmd+;` |
| `Companions: New Session` | Start a fresh companion session | — |
| `Companions: Pick Model` | Select active model / companion | — |
| `Companions: Toggle Plan / Agent Mode` | Switch between Agent, Plan, and Auto accept | — |
| `Companions: Send File` | Add file to composer | — |
| `Companions: Insert @-Mention` | Insert `@`-mention for active file | `Alt+G` |
| `Companions: Compact Conversation` | Compact conversation to reclaim context | — |
| `Companions: New Worktree Session` | Spawn an isolated git worktree session | — |
| `Companions: Show Logs` | Open output channel (ACP JSON-RPC logs) | — |

*(Legacy `Grok:*` commands remain registered as aliases for backward compatibility.)*

---

## Development

Building, testing, and contribution conventions live in **[docs/development.md](docs/development.md)**.
Google Antigravity and Gemini integration architecture: **[docs/ANTIGRAVITY_INTEGRATION_COMPLETE_DOCUMENTATION.md](docs/ANTIGRAVITY_INTEGRATION_COMPLETE_DOCUMENTATION.md)**.

### Grok Build Desktop (Legacy Standalone)

The upstream project provided a standalone Grok Build Desktop client (`afkpilot.com/desktop`, packaged as `Grok-Build-Desktop-<version>-mac-arm64.dmg` or `Grok-Build-Desktop-<version>-win-x64.exe`). For AllYourCompanions, all development focuses on the VS Code extension.

---

## Known limits

- **Diff preview semantics:** Full-file side-by-side diff tabs are reconstructed from memory and the disk state. Edits are applied to disk only after explicit approval.
- **View placement:** Homed in the Secondary Side Bar by default; relocate anytime via gear → **Config & debug** → **Move view**.

---

## Privacy

**Privacy by design** — no message content, code, or file paths leave your machine through external relays.
- All AI communication is conducted locally over standard I/O (`stdio`) directly to your locally installed CLIs.
- Anonymous, opt-out telemetry honors VS Code's global `telemetry.telemetryLevel` setting.
- Voice transcription sends audio strictly to your chosen STT provider.

More details: **[docs/privacy.md](docs/privacy.md)**.

---

## License & attribution

Licensed under the **Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)** — see [LICENSE](LICENSE).  
Portions derived from *Grok Build for VS Code* (upstream v4.1.8) © Paweł Huryn.  
Fork maintained and evolved by Collin Lerche (zfzfg) | STERRA ([https://sterra.online](https://sterra.online)).

Not affiliated with or endorsed by SpaceXAI, xAI, Google, Anthropic, or OpenAI. Grok and xAI are trademarks of xAI.
