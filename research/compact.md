# /compact over ACP — dispatch rules, `_meta.totalTokens` semantics, async rewrite

> **v1.6.1 update (grok 0.2.101) — the donut sections below are SUPERSEDED.** The
> host now **strips** `totalTokens: 0` (`gateZeroTokenMeta`) rather than "letting
> the 0 through", and the post-/compact donut count rides the live
> `_x.ai/session_notification` → `auto_compact_completed.tokens_after`
> (`contextUsedFromCompactNotification`) as PRIMARY, with the hidden `/session-info`
> scrape only a fallback for pre-rail CLIs. See `research/grok-build-oss-findings.md`
> and `docs/internal/ACP-feedback.md` §2.3. The position-0 dispatch rule and the async-rewrite
> sections remain accurate.

Probe: `research/compact-probe.cjs` (needs a logged-in grok; `VARIANT=`,
`POST_COMPACT_WAIT_MS=`, `FILLER_BYTES=`, `GROK_BIN=` env knobs). All findings
verified against **grok 0.2.87** on 2026-07-07, model `grok-composer-2.5-fast`.

## The dispatch rule: position 0 of the text block, verbatim

Each variant seeds ~40KB of filler, sends a compact-shaped prompt, then sends a
trivial "after" turn. `_meta.totalTokens` per turn, plus the on-disk
`chat_history.jsonl` line/byte counts, tell the two outcomes apart:

| variant | prompt text shape | compact turn | dispatched? |
|---|---|---|---|
| A-bare | `/compact` | totalTokens **0**, zero updates, empty reply | **yes** |
| B-enveloped | `<vscode-context>…</vscode-context>\n\n/compact` | totalTokens **117688** (6x growth!), full agentic turn — grok *chats about* compact and explores | **no** |
| C-trailing | `/compact\n\n<vscode-context>…` | totalTokens 0, zero updates, empty reply | **yes** |
| D-trailing-block | `/compact\n\n<envelope>\n\n<selection block>` | totalTokens 0, zero updates, empty reply | **yes** |

So the CLI recognizes a slash command **only at position 0** of the prompt's
text block — but tolerates arbitrary trailing content after the command line.
That's the fix shape the extension uses (`buildPrompt`/`buildPromptWithImages`
with `slashCommand: true` flip to `<text>\n\n<context>`): the pre-fix builder
put the envelope FIRST, so with the implicit active-editor chip present, every
typed slash command (`/compact`, `/help`, custom skill commands…) silently
degraded into an ordinary LLM turn. `matchSlashCommand` (src/slash-filter.ts)
is the gate: token shape `^\/([A-Za-z0-9][\w.:-]*)(?:\s|$)` (rejects Unix paths
like `/tmp/foo` — no boundary after `tmp`) checked against the CLI's advertised
`availableCommands` (shape-only before the list arrives).

## `_meta.totalTokens` around a native compact

- The **compact turn's own response** reports `totalTokens: 0` — "context
  reset", not a real count. Its `inputTokens`/`outputTokens`/`cachedReadTokens`
  are a stale replay of the *previous* turn's numbers; only `totalTokens` is
  meaningful (as the reset marker).
- The **next turn** reports the true post-compact size. The webview must let
  the 0 through (`!= null`, not truthy — media/chat.js promptComplete): the old
  truthy gate froze the donut at the pre-compact value, which is exactly the
  "did /compact even work?" user report.
- Compact keeps a recency window: in the probe the 40KB filler was the most
  recent user message, so `after` came back ≈ the seeded size (19980 → 20209).
  A long multi-turn session compacts much better; don't read the probe's flat
  numbers as "compact does nothing".
- The compact turn also streams **no agent content** — the turn ends with an
  empty bubble and no on-screen sign it worked. The extension paints a
  live-only **"Compacted."** into that bubble when the prompt resolves
  (`messageChunk` emit in sidebar.ts, right before `agentEnd`). It rides the
  session buffer (survives re-focus) but is deliberately absent from grok's
  history, so a disk restore doesn't replay it — it confirms the *action*,
  not the conversation.

## The disk rewrite is async (~15s observed)

`chat_history.jsonl` is untouched when the compact turn's response returns
(5 lines before == right after) and is rewritten **~15s later** (5 → 4 lines,
a summary line replacing older turns). Implications:

- A probe (or test) that checks the file immediately after the response sees
  a false "no-op". Wait or poll.
- Killing the process (extension update teardown, window close, reaping)
  inside that window loses the compaction — the session reloads from the
  un-compacted history. Known, unguarded edge: cheap to re-run `/compact`,
  not worth a teardown delay.
- The live process is consistent with itself: an immediate next prompt uses
  the compacted context even if the file hasn't flushed yet.

## No `usage_update` (yet)

grok 0.2.87 emitted **zero** ACP `usage_update` notifications across every
variant (`usageUpdates: 0`), despite the RFD
(https://agentclientprotocol.com/rfds/session-usage) making it the standard
channel for session-level context usage (compact/restore/model-switch all
change it). Today the donut runs entirely off the prompt response's
`_meta.totalTokens`. **Future work:** when grok starts emitting `usage_update`,
route it through `acp-dispatch`/`acp.ts`/`sidebar.ts` and prefer `used/size`
over `_meta.totalTokens` for the donut — the per-turn accounting and the
session-level usage are different quantities and the donut really wants the
latter.

## Legacy primer interaction

A native compact can fold a primer written by an older extension build into its
summary. Current builds do not send or re-send a primer after `/compact` (or on
restore); native `exit_plan_mode` outcomes carry the verdict. The legacy
`isPrimerText`/`isPrimerSummary` readers and replay filters remain so historical
primer turns and primer-derived titles stay hidden when old sessions are loaded.

Note on `available_commands_update`: the CLI re-broadcasts it at ordinary turn
boundaries (the probe saw one during the seed turn and one as the after turn
started), so command-list churn is NOT a compact tell. The only reliable
dispatch signals are the compact turn itself being empty (zero updates, empty
reply, `totalTokens: 0`) and the async history rewrite.

## Threshold: when Grok compacts (K-01, grok 1.0.41)

xAI's model catalog (`~/.grok/models_cache.json`) pins
`auto_compact_threshold_percent: 80` per model, and that beats the documented
`[session]` default of 85. Probe `research/compact-threshold-probe.cjs`
(free — no prompt) against grok 1.0.41 on native Windows:

| Start condition | `session/info` threshold |
|---|---|
| nothing set | 80 |
| `GROK_AUTO_COMPACT_THRESHOLD_PERCENT=95` | 95 |
| `…=99` / `…=100` | 99 / 100 |
| `…=150` (invalid) | 80 (ignored) |
| `GROK_CONFIG='{"session":{"auto_compact_threshold_percent":95}}'` | 80 (overlay does not pass `session`) |

The extension sets the env on every Grok spawn from
`companions.grok.autoCompactThresholdPercent` (default 95, 0 = leave Grok's
default, max 99), never over a user-set variable (shell or workspace `.env`).
Every Grok process — main sessions, crew stages, companion subagents, and
Grok's own subagents inside that process — inherits it. The first
`session/info` of each process is compared with the requested value; a
mismatch is logged and shown once per window.

Why not 100: compaction is itself a model call over the whole history; the
threshold is checked before a sampling step, so one large tool result between
two checks can overflow; the memory flush and two-pass compaction also run
before it.

### Plan B (not built)

Only if a future CLI stops honouring the env: opt-in, confirmed, backed-up
writes of `[model."<id>"] auto_compact_threshold_percent = N` into
`~/.grok/config.toml` for the ids in `models_cache.json`. Table keys with a
dot MUST be quoted — `[model.grok-4.7]` parses as nested tables `grok-4` → `7`.

## Context overflow (K-05)

`isContextOverflowError` (`src/limit-errors.ts`) matches only documented API
wordings (`context_length_exceeded`, "maximum context length is N",
"maximum prompt length is N", Anthropic's "prompt is too long: N tokens > M").
Grok's own wire form for an overflow is **not captured yet**:
`research/context-overflow-probe.cjs` provokes one (costs credits, run once,
manually) and records the prompt error and every `auto_compact_*` row. Add
what it prints here and to the pattern list.

## Lifecycle notifications

`auto_compact_started` (auto path only), `auto_compact_completed`
(`tokens_after`; `summary_preview` per the 1.0.41 binary — shown as a
collapsed "what was kept" row when present), `auto_compact_failed`, and
`auto_compact_cancelled` (binary string; shown as "Compaction cancelled.").

## Other providers (K-07) — not built, probe first

Same idea for Claude, Codex and Gemini CLI, but only a lever the probe
`research/compact-threshold-other-providers-probe.cjs` confirms may land in
code (a `probe` cell is missing knowledge, not a soft yes):

| Provider | Candidate | Status |
|---|---|---|
| Claude (claude-agent-acp) | env `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | unconfirmed; possibly lower-only |
| Codex (codex-acp) | `model_auto_compact_token_limit` in a `CODEX_HOME` config copy | unconfirmed |
| Gemini CLI | project `.gemini/settings.json` `chatCompression.contextPercentageThreshold` | unconfirmed |
| Antigravity | none (compacts in the background) | — |
| Muse | none known | — |

Once confirmed, the setting becomes `companions.context.autoCompactThresholdPercent`
with per-provider overrides; `companions.grok.autoCompactThresholdPercent` stays
as the Grok alias. The near-full prompt (K-04) and the overflow card (K-05)
already work for every provider that reports its context.
