# W-15/W-16 validation — 2026-09-30

Status: code and automatic gates verified. **Final W-15/W-16 acceptance is still open until real-provider manual checks pass.** W-09 and W-17–W-19 remain separate; no version, release or remote Git action is part of this work.

| Measure | Before | Current |
|---|---:|---:|
| sidebar.ts, committed entry d62a22e | 13,376 lines | 7,606 lines |
| sidebar.ts, preserved working entry f4332b3 | 9,320 lines | 7,606 lines |
| WorkflowStageRunnerDeps | 26 | 23 |
| SessionStartLifecycleOps | 35 | 7 lifecycle + 10 usage + 18 events |
| InboundSessionOps | 39 | 22 lifecycle + 8 settings + 9 worktree |
| InboundWorkflowOps | 32 | 13 execution + 10 authoring + 9 children |
| Largest actual dependency/operations group | 39 | 25 |
| Direct provider comparisons | 102 in 23 files | 26 in 26 files |
| Session identity comparisons | 20 | 20 |
| Router string cases | 157 unique | same 157 unique |

The extra view-host extraction leaves 394 lines below the hard 8,000-line limit and 194 below the 7,800 planning reserve. Behavior and implementation comments moved with responsibilities; contract summaries stay on wrappers. There is one owner for attachment maps/promises, startup tails, catalog write serialization and refresh/sweep state. Public/test methods and injected state remain compatible.

## Automatic gates

- npm run compile: pass (including Muse adapter).
- npm run typecheck: pass (production plus test tsconfigs).
- npm run lint: pass.
- npm test: 326 files, 6,263 passing tests, 4 existing skips unchanged.
- npm run test:integration: 22/22 pass, real VS Code 1.139.1 with hermetic fake ACP.
- No additional skips or excludes. Existing W-09 DOM typecheck exclusions remain explicitly open.
- node scripts/provider-inventory.cjs: 102 → 26; every remaining branch has a reason and tests in [the inventory](provider-inventory.md).

The final Muse regression prevents a no-op mode sequence from raising a Plan gate. Sequential Codex mode failures stop the remaining steps; the existing reply-time Plan/approval guards remain tested. The integration run includes balanced failed cold replay, resume reservations, usage/rewind, restart and stale-worktree checks. Unauthenticated CLI discovery only was performed; no paid test:live probes ran.

## Manual prerequisites and acceptance

| Provider/variant | Local CLI discovery | Authentication/streaming acceptance |
|---|---|---|
| Grok | Found under .grok/bin | Credential file exists; authentication and manual flows unverified |
| Codex | Found in the Codex app installation | Credential file exists; authentication and manual flows unverified |
| Claude | Not found | Open prerequisite |
| Gemini CLI | Separate CLI not found | Open prerequisite |
| Antigravity | Found under .gemini/bin/agy.exe | Authentication unverified |
| Muse | Not found | Open prerequisite |

Credential-file presence is no validity claim. Manual sidebar/rail, provider sessions and streaming, permission/review/rewind, Crew gates, subagent relay, saved settings, worktree lifecycle and composer/attachment checks are pending. Automated DOM/fake-ACP tests do not substitute for this acceptance. Packaging backup, exact VSIX size/hash, installation and any subsequently reported manual results are recorded in the workspace PLAN/implementation/handoff documents after the local package step.
