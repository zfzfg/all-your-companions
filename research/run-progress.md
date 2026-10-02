# Workflow / Goal / Deep Research progress (P2-10)

Design + wire notes for progress cards on the live `_x.ai/session_notification`
rail. Engines stay in the CLI; the extension only renders cards and optional
pause/resume/stop by display name.

## Slash surface (leave alone)

Advertised by the CLI and **not** in `HIDDEN_SLASH_COMMANDS`:

| Command | Role |
|---|---|
| `/deep-research <query>` | Launch a background research workflow |
| `/workflow …` | Launch / `pause` / `resume` / `stop` / `save` by display name |
| `/goal …` | Set / `status` / `pause` / `resume` / `clear` an autonomous goal |
| `/workflows` | TUI run dashboard (no ACP equivalent — cards replace the need) |

## Live rail kinds

From CLI binary symbols (0.2.111) + session_notification family:

| `sessionUpdate` | Meaning |
|---|---|
| `workflow_updated` | Rollup for a background run (phase, agents, last_event, …) |
| `goal_updated` | Rollup for `/goal` (deliverables, phase, …) |
| `workflow_started` / `_paused` / `_resumed` / `_completed` / `_failed` / `_cancelled` | Lifecycle siblings (parsed when present) |
| `goal_created` / `_paused` / `_resumed` / `_completed` / `_cleared` | Goal lifecycle siblings |

### Typical `workflow_updated` fields (snake_case)

`run_id`, `display_name` / `name`, `objective`, `current_phase` / `phase`,
`agent_budget`, `agents_used`, `current_agent_label`, `last_event`,
`last_event_detail`, `pause_message`, `result_summary`, …

### Typical `goal_updated` fields

`goal_id`, `objective`, `phase`, `total_deliverables`, `completed_deliverables`,
`current_deliverable_title`, `token_budget`, …

## Extension mapping

| Layer | Role |
|---|---|
| `src/run-progress.ts` | Pure `isRunProgressUpdate` / `parseRunProgressUpdate` / `workflowControlCommand` |
| `sidebar.ts` xaiNotification | Emit `{ type: "runProgress", update }` |
| `media/chat.js` | Upsert teal progress cards; Pause/Resume/Stop → `workflowControl` → `/workflow …` |

Cards are buffered on the session like subagent rows, so a warm re-focus
replays them. Native workflow cards show connected process rings and agents grouped by their reported phase. Completed groups fold by default; steps without a group are status markers. Pause/Resume/Stop keep their existing host messages. The process/group presentation is adapted from [Paweł Huryn's upstream workflow design](https://github.com/phuryn/grok-build-vscode/commit/54df5f4); the fork's implementation uses its existing native and Crew view data. No nested inspector for child agents (same non-goal as subagents).

## Probes

A dedicated live capture (launch `/deep-research` and dump `workflow_updated`
payloads) can be added under `research/run-progress-probe.cjs` when credit budget
allows; unit tests pin the pure parsers against synthetic shapes derived from
binary field names + user-guide semantics.
