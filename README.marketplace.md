# All your Companions - in one Place!

### *All your Companions — in one place!*

[![License: FSL-1.1-MIT](https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg)](https://github.com/phuryn/grok-build-vscode/blob/main/LICENSE) ![Agents](https://img.shields.io/badge/Agents-Antigravity%20%C2%B7%20Grok%20%C2%B7%20Codex%20%C2%B7%20Claude-000000) [![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode&logoColor=white)](https://code.visualstudio.com) [![Cursor](https://badgen.net/badge/Cursor/Extension/007ACC)](https://cursor.com)

> **Unified GUI for AI Coding Companions** — Google Antigravity, Grok Build, OpenAI Codex, and Anthropic Claude Code.
>
> **Maintainer:** Collin Lerche (zfzfg) | STERRA ([https://sterra.online](https://sterra.online))  
> **Community Fork:** An independent community fork of *Grok Build for VS Code* (upstream v4.1.8 by Paweł Huryn), redesigned and expanded as a local-first multi-companion powerhouse.

The unified, local-first GUI for your favorite AI coding companions: **Google Antigravity CLI** (Gemini 2.5/3), **Grok Build** (Grok 4.6), **OpenAI Codex**, and **Claude Code** — right inside your editor. Drop open files in as `@`-context, run **parallel sessions**, inspect **native diff previews** with **one-click revert**, keep **resumable chat history**, typeset **LaTeX & Mermaid diagrams**, and dictate by **voice**.

---

## Why use this?

If you live in your editor, this puts your AI companions right next to your code in a unified graphical workflow: **native diff preview** on every proposed edit with **one-click revert**, **open files and selection as context**, **parallel sessions** with status dots, **resumable history**, **inline images & video**, and **voice dictation**.

### Features & capabilities

_Click any feature to expand._

<details>
<summary><strong>Permission cards with diff preview & revert</strong> — see every edit in VS Code's native diff before you approve</summary>

When any companion proposes an edit, hit **open diff →** to review the whole file in VS Code's native diff editor, focused on the first changed line, then *Allow once / always* or *Reject*. The file is written only **after** you approve. Completed edits provide an instant one-click **revert edit ↶** action synthesized across all four providers.

![Permission card with a native VS Code diff preview before approval](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/permission_diff.png)

</details>

<details>
<summary><strong>Universal Multi-Companion Support</strong> — Antigravity (Gemini), Grok, Codex & Claude</summary>

Connect any leading AI companion in **Settings → Providers**. Antigravity CLI (`agy`) brings Gemini 2.5/3 Pro & Flash with full streaming reasoning; Grok Build brings Grok 4.6; Codex and Claude Code run over ACP stdio. Switch companions or models anytime mid-thread without losing context.

</details>

<details>
<summary><strong>Google Antigravity & Gemini Powerhouse</strong> — vision, auto-compaction & plan reviews</summary>

Tailored, battle-tested integration for Google Antigravity:
- **Multimodal Vision & Screenshot Ingestion:** Paste or drop images directly into the composer. Images are auto-staged to `~/.gemini/staging` and provided to Gemini via native `view_file`, bypassing stream-JSON limits and search loops.
- **Plan Mode Review Workflow:** Intercepts `implementation_plan.md` generation in Plan mode and surfaces the interactive "Approve & implement" review card (`x.ai/exit_plan_mode`).
- **Silent Background Auto-Compaction:** Recognizes Antigravity's server-side auto-compaction; the chat composer stays 100% active and unblocked, and the context popover displays an informative auto-managed notice.
- **Zero-Flicker Windows Execution:** Spawns with `windowsHide: true`, eliminating black console window flashes.

</details>

<details>
<summary><strong>Context & cost monitoring with provider-aware compaction</strong> — tokens, cost, and auto-managed context</summary>

Click the **context donut** for exact window usage, input/cache/output tokens, and cost tracking. The interface adapts intelligently to each provider: Grok/Codex/Claude trigger manual compaction, while Gemini automatically displays `"Context managed automatically by Antigravity"` or `"Context probably compacted automatically by now"`. The `/compact` slash command is gracefully intercepted for Gemini to prevent wasting prompt tokens.

![The context popover — window usage, billed totals, and Compact](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/context.png)

</details>

<details>
<summary><strong>Modes — Agent, Plan & Auto accept</strong></summary>

Switch from the bottom toolbar — even mid-turn, so you can flip to **Auto accept** to stop approving cards without stopping the agent. **Plan** mode enforces client-side safety: workspace writes and non-read-only commands are genuinely blocked until you approve the plan.

![The mode picker — Agent, Plan, and Auto accept](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/agent_modes.png)

</details>

<details>
<summary><strong>Worktree sessions</strong> — isolate code edits in a git worktree</summary>

**Companions: New Worktree Session** creates an isolated git worktree under `~/.grok/worktrees/` and opens a fresh session whose cwd is that checkout — so agent edits don't touch your main tree until you **Apply worktree**.

</details>

<details>
<summary><strong>Voice control</strong> — hands-free dictation with live transcription</summary>

The **microphone button** dictates speech via Speech-to-Text — words appear live as you talk. Say **"companion send"** to submit hands-free and keep dictating; messages spoken while the companion responds queue and flush when it finishes.

![Voice control with live transcription in the composer](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/voice_mode.png)

</details>

<details>
<summary><strong>File chips & smart relative paths</strong> — your editor and selection as <code>@file</code> context</summary>

The active editor rides along automatically; add more by **typing `@` in the composer**, dragging from the Explorer, right-click → **Companions: Send File**, **Alt+G**, or the **+** button. Relative file links in chat automatically resolve across parent directories and nested subprojects (`findInSubtree`).

![Composer with an image, a file, and a selection chip attached](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/file_chips.png)

</details>

<details>
<summary><strong>Session history & transcript replay</strong> — parallel sessions with status dots; resume, rename, search & clear</summary>

Sessions run in **parallel**: start a new one with **+** while another is mid-turn and switch between them instantly. Each row's **status dot** reflects its state (🔵 Blue: working, 🟡 Yellow: waiting for approval, 🟢 Green: finished unread, 🔴 Red: error unread, ⚪ Gray: idle). Sessions persist across restarts, restoring conversation IDs and replaying transcripts.

![Session history dropdown with status dots](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/session_history.png)

</details>

<details>
<summary><strong>Queue or steer</strong> — type while companion works, without interrupting</summary>

Messages sent mid-turn queue smoothly at the end of the chat. Hit **Steer** on a queued message to redirect the companion immediately without losing tool work in flight.

![A queued message with the Steer button](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/steer.png)

</details>

<details>
<summary><strong>Math & LaTeX rendering</strong> — equations render as typeset math</summary>

LaTeX in answers — inline `\(…\)`, display `\[…\]`, matrices, integrals — renders as real typeset math via MathJax, bundled offline.

![LaTeX expressions rendered as typeset math](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/v1.4.5%20LaTeX%20expressions.png)

</details>

<details>
<summary><strong>Mermaid diagrams</strong> — flowcharts and architecture render visually</summary>

` ```mermaid ` blocks render as interactive diagrams matching your VS Code theme.

![Mermaid diagram rendered inline in the chat](https://raw.githubusercontent.com/phuryn/grok-build-vscode/main/docs/screenshots/v1.4.6%20Mermaid%20diagrams.png)

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

**1. Install the extension.** In VS Code or Cursor, open **Extensions** (`Ctrl/Cmd+Shift+X`) and search **"All your Companions"**.

**2. Open Companions and sign in.** Press `Ctrl/Cmd+;`. The sidebar walks you through choosing your companion and getting started in one click.

Companions opens in the **Secondary Side Bar** (right side, next to other AI tools). Prefer it elsewhere? Gear → **Config & debug** → **Move view** relocates it to the Panel or Primary Side Bar in one click.

> Prefer the terminal, building from source, or installing into several IDEs at once? See the project [INSTALL docs](https://github.com/phuryn/grok-build-vscode/blob/main/docs/INSTALL.md).

---

## Quick start

1. **Open** Companions: `Ctrl/Cmd+;` (or Command Palette: **Companions: Open**).
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
| `Companions: Show Logs` | Open output channel (ACP JSON-RPC logs) | — |

*(Legacy `Grok:*` commands remain registered as aliases for backward compatibility.)*

---

## Known limits

- **Diff preview semantics:** Full-file side-by-side diff tabs are reconstructed from memory and the disk state. Edits are applied to disk only after explicit approval.
- **View placement:** Homed in the Secondary Side Bar by default; relocate anytime via gear → **Config & debug** → **Move view**.

---

## Companion apps

All your Companions is completely standalone and local-first — no external relay servers or third-party cloud brokers required. It natively coordinates:

- **Google Antigravity CLI (`agy`)** — Gemini 2.5 Pro/Flash and Gemini 3 with massive context, multimodal vision, and streaming reasoning traces.
- **xAI Grok Build (`grok`)** — Grok 4.6, SuperGrok, and xAI API integration.
- **OpenAI Codex CLI (`codex`)** — High-speed ACP JSON-RPC bridge.
- **Anthropic Claude Code CLI (`claude`)** — Full ACP terminal and session integration.

All companion communication runs 100% locally via stdio directly to your installed CLI binaries.

---

## Privacy

**Privacy by design** — no message content, code, or file paths leave your machine through external relays.
- All AI communication is conducted locally over standard I/O (`stdio`) directly to your locally installed CLIs.
- Completely free of third-party remote relay servers or external device mirroring dependencies.
- Anonymous, opt-out telemetry honors VS Code's global `telemetry.telemetryLevel` setting.
- Voice transcription sends audio strictly to your chosen STT provider.

More details: **[docs/privacy.md](https://github.com/phuryn/grok-build-vscode/blob/main/docs/privacy.md)**.

---

## License & attribution

Licensed under the **Functional Source License, Version 1.1, MIT Future License (FSL-1.1-MIT)** — see [LICENSE](https://github.com/phuryn/grok-build-vscode/blob/main/LICENSE).  
This project is an independent community fork derived from *Grok Build for VS Code* (upstream v4.1.8) © Paweł Huryn.  
Fork maintained and evolved by Collin Lerche (zfzfg) | STERRA ([https://sterra.online](https://sterra.online)).

Not affiliated with or endorsed by SpaceXAI, xAI, Google, Anthropic, or OpenAI. Grok and xAI are trademarks of xAI.

