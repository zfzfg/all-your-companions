# Crew sessions and child sessions — control and visibility

How the host keeps every hidden child (crew stage, companion subagent, Grok's
own subagent) observable and answerable, and how a Crew run is steered.
Implements the crew/subagent improvement plan (F-01…F-23, X/C/S/E/K packages).

## Questions reach the person (X-01)

A hidden child's `permissionRequest`, `questionRequest` and `exitPlanRequest`
are mirrored into `visibleAncestorOf(child)` under an opaque route id
(`ChildRelayTable`, `relayFromChild` in `emit`). The answer comes back with the
route; `resolveRelayedAnswer` rewrites session + request id before the normal
handler runs, so all answer paths (rules, plan verdicts, question drafts) are
the ordinary ones. The first answer wins: the child's own `*Resolved` frame is
relayed up and closes the ancestor's card. The ancestor goes `needs-you` while a
relayed card is open and returns to what it was after. `closeChildRelays` drops
open cards when a child ends. With the window unfocused one OS notification is
shown (`companions.notifications.childNeedsYou`). Rule denials from a child are
relayed as a `hostNotice` with the origin label.

"Allow for this stage / subagent" is a session-scoped grant: the relayed card
offers every concrete match with scope `session`, and because the answer is
routed to the child, `addSessionAllowRule` writes it on the child only.

## Profiles are enforced by overlay (C-01, D15)

`subagentPermissionOverlay` returns role permission lines (`pathGlob` /
`commandPrefix`), appended after the role's own lines:

| profile | lines |
|---|---|
| read-only | deny edit · ask execute · allow `<readOnlyCommandAllowList>` |
| scoped-edit | ask edit · allow edit `<glob>`… · ask execute |
| inherit | none |

Deny wins over everything; among allow/ask the last match wins, so an edit in
scope is allowed without a card, one outside asks (the relayed card says
"outside the stage's scope"), and a user rule that allows all edits cannot reach
past the scope. Stages run in `agent` mode unless the workflow sets
`runMode: "plan"` (`stageRunMode`). A scope source that resolves to nothing is
empty, never "anywhere"; the gate says so and offers "Allow edits anywhere in the
workspace for this stage". `plan.files` = `filesReported` ∪ every plan step's
files (`packetFiles`, `resolveStageScope`).

## Watching a child (X-02 … X-05)

- `tapChildActivity` turns a hidden child's stream into `childActivity` frames
  (transient) on the stage row or the subagent card.
- `noteChildStarted` records the child session id at `session/new`, so "Open
  transcript" and the stage row work while it runs. A focused hidden child gets
  `childContext` (back button, steer hint).
- Text typed in a Crew session while a stage runs asks: steer the stage, or a
  note for the next gate (`childMessage`, `sendToRunningStage`). Nothing goes to
  the hidden stage silently.
- Subagent time limits pause while the child waits for the person
  (`PausableDeadline`); stages have no hard limit, only a stall warning after
  `companions.crew.stallWarningSec` without activity (Open / Nudge / Stop).
- Cards and rows carry duration, tokens, the model that actually ran; the turn
  footer adds "3 subagents · 2m 14s · 48k tokens". No money anywhere
  (`formatRunCost` renders tokens only).

## Gates (C-03 … C-18)

`finishWorkflowStage` stores the packet, applies the transition with the run's
autonomy (`shouldAutoProceed`: step / stop-on-problems / autopilot; every forced
reason, including `provider-switched` and the fixer limit, still stops) and
preselects the next target (`withGatePreselection` → `preselectGateTarget`).
`decorateWorkflowView` adds the numbers, table, stall state, finding selection,
editable plan, clarifier form, limit choices and gate-0 lineup to the view.

Host-only gate actions (`handleHostGateAction`): revise (a second turn in the
same stage session through `runAgentRole`'s `continueSession`), revert one stage
(from that stage session's own checkpoints; conflicts ask), wait and retry after
a limit, nudge / stop a stalled stage, open / copy the report. A finished run
writes `run-report.md` and shows Keep changes / Revert all / Open report.

Limits (C-16): `companions.crew.onLimit` `ask` stops at a `limit` gate
(Run on X / Wait and retry / Pause); `switch` reruns on the next provider with a
notice and marks the packet `switchedFrom`, which forces the next gate.

Per-plan-step (C-12) runs one role per plan step (scope = that step's files,
`step-NN` artefacts, optional verify after each); with `parallel: true`
independent steps share a wave in their own worktrees (`nextIndependentSteps`).
A review panel (C-13, `fanOut`) runs N read-only sessions and merges them.
Resume (C-02) reads every executed packet (`readUserEdit` first, then the
handoff file) before judging staleness; the git read is async with a timeout.

## Subagents (S-01 … S-07)

- Writers claim the files they name before they start; a held file is a
  `file-claimed` refusal. Without named files the first write claims; a file
  another writer holds always gets a card with a warning. Claims are released
  on every exit.
- `companions.subagents.writeIsolation: "worktree"` runs a writer in its own
  local worktree; the card offers Apply changes / Discard.
- The approval card (`subagentApproval`) edits task, companion, model, effort
  and a profile no wider than proposed; the tool result says `adjustedByUser`.
- The composer's Delegation switch sets `subagentsEnabled` / `spawnPolicy` for
  this session (meta); `@subagent:` / `@role:` complete from the roster.
- `await` action `continue` (and "Ask a follow-up" on the card) sends a turn
  into the finished child's live session; refused once it is gone.
- Raw replies are written as `step-NN.raw.md`, records as `subagent.json`, and
  a parent's cards are rebuilt from the run folders on restore.
- Grok's own subagents: `companions.grok.subagents.enabled` /
  `.maxConcurrent` set `GROK_SUBAGENTS` / `GROK_MAX_CONCURRENT_SUBAGENTS` on the
  spawn (unconfirmed value semantics — see `research/subagents.md`); per-type
  models live only in `config.toml` and are not offered.

## Overview (E-01, E-03)

`runningChildren` lists every running child of the window, grouped by parent,
above the history list; "N need you" jumps to the first open card. Commands:
`companions.showCrewRun`, `companions.pauseCrewAfterStage`,
`companions.jumpToWaitingApproval`.

## Open probes

The subagent probe table in `research/companion-subagents.md` (plan-mode stall,
overlay holds, child persistence) still decides whether read-only stages may add
Plan mode as an extra layer; until then they run in `agent` + overlay.
