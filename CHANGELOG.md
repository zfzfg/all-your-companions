# Changelog

## [0.3.0] - 2026-09-30

- Check existing provider authentication before offering login, coalesce Connect checks, invalidate late results on Disconnect, and handle ACP spawn failures safely.
- Preserve conversation drafts, selections and edited attachments through loading, focus changes and webview restoration using provisional draft identities.
- Dispose old clients before provider reassignment, remember modes per provider, and identify session/approval/CLI-update startup waits.
- Complete native Muse approval modes, sandbox/network/trust settings, confirmed installer, credential environments, usage windows, pending prompt/approval ownership and bounded session reopening.
- Render six Markdown heading levels, bare links, GitHub PR chips and absolute paths with spaces; normalize native Codex children and Claude/Muse workflows into existing cards.
- Update Grok 4.7 and Muse provider descriptions. Selective port provenance is recorded in [docs/upstream-4.14-port.md](docs/upstream-4.14-port.md).

- Resolve context budgets by CLI access, model and session, with independent source/usage quality. Discover native Grok/Codex catalog changes, include GPT-6.1 Sol, and apply Codex's effective factor once.
- Show unknown, estimated and stale limits honestly; remove generic Claude/Antigravity context defaults and preserve verified limits across ordinary updates. Reset context on model switches and forks.
- Route all ACP prompts through a common budget preflight. Complete verified counts can block excess requests; incomplete estimates warn. Preserve blocked drafts and attachments through context recovery and failed compaction.

## [0.2.0] - 2026-09-24

**Caught up with Grok Build 4.3–4.11 and major Companion Subagents & Crew updates.** The improvements from upstream that apply to a VS Code-only, multi-companion extension are ported. Remote, phone and desktop-app changes are left out, because this fork doesn't have those parts.

### Added

- **Crew stages and subagents ask where you are looking.** Their permission, question and plan cards appear in the Crew / Agent session with where they came from; "Allow for this stage" grants only that child. Stages and subagent cards show a live feed, "Needs you", time and tokens; a quiet stage gets a stall warning (Open / Nudge / Stop); a running-children overview sits above the history list.
- **The crew gate, rebuilt.** Companion, model and effort preselected (a review prefers a different companion and says so), an autonomy switch (Step by step / Stop on problems / Autopilot, plus "Pause after this stage"), an editable plan, finding selection, Revise, per-stage revert, a limit gate instead of a silent switch, a run table and `run-report.md`. The start panel proposes the whole lineup and a verify command. New workflows: bugfix, review-only, research, test-first, refactor-safe; per-plan-step runs and review panels work.
- **Subagents:** files claimed before a writer starts, an optional own worktree per writer, an approval card you can edit, a Delegation switch and `@subagent:` completion in the composer, follow-ups into a finished subagent, reports that survive a reload.
- **Grok compacts later.** `companions.grok.autoCompactThresholdPercent` (default 95; Grok's own is 80), shown on the context ring and popover, with a "context nearly full" offer (Compact now / Continue in a fresh session / Keep going) and a card when the context overflows.
- **Muse Code (Meta) is the fifth companion.** Connect it in Settings → Providers. It runs through its own ACP adapter. It has no Plan mode, no mode switching and no host MCP servers. Delegation to it uses the fenced-block shim.
- **Codex can be steered mid-turn.** Whether Steer is offered is now decided by what the backend reports when it starts, not by a fixed list.
- **Previous prompt.** A button above the message box jumps back to the prompt before the one you are reading and highlights it. You can turn it off with `companions.promptNav`.
- **Copy image.** The image lightbox copies the original image at full resolution.
- **Subscription usage** appears in the context popover: how much of your Grok, Claude or Codex subscription window is left. When a usage limit hits, the companion with the most room left is offered first.
- **Whole-turn diffs in Review Center.** In turn scope, "Open diff" shows one diff per file for everything the turn did, including edits made by shell commands. It needs git; without git you get the tool-call diff as before.
- **Session grants.** A permission card can allow a program for this conversation only. The grant is kept in memory, never written to disk, and is gone when the session restarts.
- **Sign-in card.** When an account's sign-in expires, a card above the composer offers to sign in again. The flag only clears once the provider has accepted the credential.
- **Speech-to-text through OpenAI** as well as xAI. It routes by companion. New settings: `companions.voiceBackend`, `companions.voiceOpenAiApiKey` and `companions.voiceOpenAiModel`.
- **Update Codex / Claude CLI** from Settings → About. The update runs in a terminal, using the same install method the CLI was installed with.
- **Provider config files.** Grok and Codex `config.toml`, Claude `settings.json` and Antigravity `settings.json` are listed under Rule files and can be opened from there.
- **Prose in code fences wraps.** Each code block also gets its own wrap toggle.

### Changed

- Crew stages are read-only / scoped by the permission overlay rather than by Plan mode, handoff packets are read back on resume, and result cards show tokens, never money.
- **Privacy (#171): an agent you have not connected is never started.** This covers refreshes, settings pages and credential probes. Saved connections start over once. No credentials are touched, and reconnecting takes one press.
- **Permission rules check each part of a chained command.** An allow rule for `npm` no longer covers `npm test && rm -rf build`.
- The Claude ACP adapter is updated to 0.76, the Codex ACP adapter to 1.11, and managed Codex to 0.153.4.

### Fixed

- **Delegation switch styling:** styled `.delegation-switch` and select options using VS Code dropdown theme tokens so options are dark and legible in dark mode.
- **Subagent host MCP collision:** excluded host-injected servers (`companions_subagents`, `companions`) from reserved identity in `reservedFromMcpInventory`, preventing false name-collision errors from blocking subagents on new sessions.
- A diff no longer closes the file you had single-clicked open (#167).
- Confirmation dialogs always appear on top.
- A question card closes when the agent stops waiting for an answer. What you had typed can be moved to the composer.
- Idle time is not counted while a card is waiting for you.
- A CLI installed in a path that contains spaces can start on Windows.
- Effort, model and mode are saved to the settings scope that is actually being read, so a picked value no longer snaps back (#162).
- An old conversation with no messages can switch companion.
- A Grok workflow whose "finished" message was missed is repaired from the run's own state file.
- The Previous-prompt and other live settings now react when they are changed under `companions.*`.

**Subagents you can keep, route and nest.** A subagent that turned out to be worth keeping can become a conversation of its own; a few keywords can steer which companion gets which kind of job; and — if you ask for it — a workflow stage or a subagent can delegate one level further.

### Added

- **Keep a subagent as its own conversation.** A finished subagent's card now offers **Keep as a session** — it has been a real conversation with its provider all along, it was only hidden from your history. Keeping it drops the "belongs to another session" marker and gives it a name that says where it came from. Its card stays in the original thread, because the delegation still happened.
- **Route work by keyword.** Settings → Agents & Crew → **Routing rules**: when a task mentions "grep" or "overview", prefer the fast companion; when it mentions "review", prefer a different one. Advice only — what the agent asks for explicitly still wins, and a rule pointing at a companion you are signed out of is simply skipped. Earlier rules win, and you can reorder them.
- **Workflow stages can delegate too**, when you want them to. Off by default, and it needs two switches to agree: **Crew stages may use subagents** in Settings, and the workflow's own stage asking for it. A subagent a stage starts shows up in the Crew conversation, labelled with the stage that started it, rather than in a hidden transcript nobody reads.
- **Two levels of delegation, if you want them.** `companions.subagents.maxDepth` now accepts `2`, letting a subagent delegate once more. Anything deeper is capped by design. A delegating subagent spends a share of its parent's remaining allowance rather than a fresh copy of it, so turning this on cannot multiply what a turn costs.

### Fixed

- **The subagent roster in Settings now actually saves.** Its controls were wired up in a place where the save function is not in scope, and every repaint discarded the handlers anyway — so switching a companion off, choosing a default model or writing notes changed nothing. Both it and the new routing table are now wired the way every other control on that page is, and there are tests for it.

**You can write and generate Crew workflows.** Settings → Agents & Crew has a **Workflows** section: every crew preset is listed with its stage graph, a default radio for new Crew sessions, and Validate / Save / Delete. **Generate workflow…** describes the pipeline in plain language; the extension drafts stages and contracts, shows a preview, and writes nothing until you press Save.

### Added

- **Workflows in Settings (AP-18).** Built-in, this-machine and this-project workflows with scope badges and override markers. A preset without a stages block still runs as the default Plan → Implement → Review → Fix graph and can gain a stages block when you ask. Saving goes through a writer that re-reads the file and refuses anything that would change meaning.
- **Generate workflow…** A hidden, read-only session drafts the JSON. If the companion can use host tools it validates and submits that way; otherwise a fenced `companions-workflow` block in the reply is accepted the same way. **Save**, **Save & set as default**, and **Run this workflow** use the copy-deck labels. Recompile from description is offered when a workflow was generated.
- **Invalid workflows never run.** Starting a Crew session on a broken graph shows the JSON pointer and the reason, and does not create a run. A paused run still uses the snapshot it started with, even if you edit the file later.

### Added (settings)

- `companions.workflows.generator.target` — optional companion / model / effort for the generator. Empty uses the first eligible target.

**Crew sessions now run a stage-gated workflow.** Pick **Crew**, describe an idea, and the default **Idea to done** pipeline plans, implements, reviews and (if needed) fixes — stopping after every stage so you choose the next companion, pause and come back later, or cancel. `/crew` typed in an Agent session no longer starts a chain in that thread; it offers to open a Crew session with that goal instead.

### Added

- **Crew sessions (AP-17).** A Crew conversation is a workflow runner, not a chat. The empty state is an idea composer plus a workflow picker (default `idea-to-done`). After each stage a gate shows what happened and asks which companion should run next: **Start**, **Stop & resume later**, or **Cancel run**. Pause writes `run.json` atomically; reopening the conversation restores the gate. A changed git HEAD or an edited file since pause requires **Continue anyway**; a deleted worktree cannot be resumed.
- **The built-in `idea-to-done` workflow.** Plan (read-only) → Implement (one session for the whole plan) → Review (prefers a different companion) → Fix if the review asks, looping at most twice. Planner and reviewer never edit; the fixer does.
- **Handoffs are structured, not transcripts.** Each stage gets a briefing of paths and the previous stage's packet, never the previous `result.md` body. Summaries, findings and verify output are capped so the next stage does not inherit a 120k conversation.
- **`/crew` in an Agent session** shows "Crew runs live in their own session." with a button to open a new Crew session with that goal. The old in-thread chain remains behind `companions.crew.inThreadCommand`.

### Added (settings)

- `companions.crew.defaultWorkflow` (default `idea-to-done`)
- `companions.crew.autoStartNextStage` (default off; failed stages still pause)
- `companions.crew.maxFixerPasses` (default 2)
- `companions.crew.inThreadCommand` (default off)
- `companions.crew.providers` — optional per-companion enable override; otherwise the crew inherits the subagent roster

**Every session now says what kind of session it is.** A new conversation opens with a **Session type** switch — **Agent** or **Crew** — sitting in the top bar next to the repository chip. Agent is what conversations have always been. Crew is the new stage-gated workflow home, arriving in a later release; picking it today changes the empty state and the composer, and the run machinery follows.

### Added

- **Session type (AP-15).** Chosen before the first message and switchable freely until then; the first thing you send locks it, and the switch becomes a small badge with a lock. The lock is enforced by the extension host, not just hidden in the UI, so it holds for remote clients too. Forking a conversation inherits its type. Crew conversations get a compact badge in the history list; Agent conversations look exactly as they always have.
- **`companions.sessionType.default`** decides what new conversations start as. It defaults to `agent`, so nothing changes unless you ask it to.
- **Every conversation you already have opens as a locked Agent session**, with nothing written to disk to make that true.

- **Companion subagents (AP-16).** In an Agent session, the companion you are chatting with can now launch a **subagent on any of your other connected companions** — a fast, cheap model to map a module while a stronger one keeps planning, or a second opinion from a different provider entirely. It picks the companion, the model, the effort and what the subagent may do, within limits you set. Each subagent runs as its own session that never sees your conversation: it gets a written brief with file paths, and hands back a report. It shows up as a card in the thread with what it was asked, what it did, and — importantly — which files the extension *watched* it change, next to the ones it says it changed.
- **Subagents are read-only unless the agent asks for more**, never get more permission than the session that started them, and are forced to read-only outright while you are in Plan mode. Every clamp, downgrade and refusal is written on the card rather than applied quietly.
- **Settings → Agents & Crew → Subagents** lists every companion with a switch, a default model, an effort ceiling, whether it may edit files, and a **Notes** field. The notes are what the agent reads when it chooses — there is no built-in table of which model is good at what.
- **A new built-in role, `inspector`** — read-only, low effort, prefers a different companion from the one that called it. For exactly the "map this for me while I keep working" job.
- **Tell it which companion to use, per message.** Type `@subagent:gemini`, `@subagent:claude effort:low`, `@role:inspector` — or `@subagent:none` to keep a message to yourself. A chip whose target has gone (logged out, turned off, model gone) turns red and blocks the send with the fix, rather than failing halfway through the turn. If the agent ignores a directive you marked as required, the turn says so.
- **The conversation stays "working" until its subagents are done**, even after the companion itself has stopped talking — with a small tray above the composer listing who is still running, on what, and a way to cancel each one. A subagent that finishes without the agent having read it produces one short line, not one per subagent.
- **Subagent sessions never appear in your history**, are never swept as empty conversations, and are cancelled when you press Stop, close the window, or the conversation that started them ends.

### Internal

- Both host IPC protocols — the question channel and the delegation channel — now share **one** named pipe per window instead of binding two. The token routes a connection to the right protocol, so neither wire format changed and both shipped MCP scripts are untouched.
- New capability dimensions `hostMcp`, `companionSubagentTarget` and `delegationShim` in the provider matrix, and three research probes (`research/probe-acp-mcp.cjs`, `research/probe-read-only.cjs`, `research/probe-child-persistence.cjs`) that fill them. Findings and open questions in `research/companion-subagents.md`.

---

Upstream releases (grok-build-vscode 4.1.8 and earlier, before this fork): see [docs/CHANGELOG-ARCHIVE.md](docs/CHANGELOG-ARCHIVE.md).
