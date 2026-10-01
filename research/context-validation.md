# Context integration validation — 2026-10-01

Implemented directly on the fork's `main`; no upstream PR, push or release.

## Evidence and compatibility

- Grok's previously verified native Windows 1.0.46 context-window selection remains intact: `session/set_model` with `_meta.contextWindow`, reasoning-effort preservation, session-info confirmation, resume, catalog refresh and shrinking. The selected active window is separate from an unknown effective input budget.
- Codex ACP 1.11.0's shipped `TokenCount` mapping subtracts cached input before exporting separate ACP cache tokens; adding these partitions once is correct. Its `usage_update.used` is last-call total, not a current-context snapshot.
- Claude ACP 0.76.0 exports accumulated turn usage and can synthesize post-compact zero when `post_tokens` is missing. Neither is promoted to native occupancy.
- Muse SDK 1.3.0's `SessionContextUsageParams` specifies counted-once occupancy and an optional effective window. Its resume snapshot is reapplied after model initialization. Subscription notifications remain separate.
- Antigravity stream-json totals have no verified current-context meaning. Static capacities and synthetic billing-based session-info are removed.

The versioned fixtures are schema/source examples from installed dependencies, not new live captures. No dependency or CLI was upgraded, and no paid model or overflow probe was run.

## Verification

- `npm test`: **6,537 passed**, 341 files, four pre-existing skips unchanged.
- `npm run test:integration`: **22 passed** in the real VS Code Extension Host using fake CLIs.
- `npm run compile`, `npm run typecheck`, `npm run lint`, and `node scripts/provider-inventory.cjs`: passed.
- After the narrow-sidebar text correction: 221 affected DOM tests passed; additional runtime metadata was checked with provider/dispatch tests and typecheck.
- `npm run ui:screens -- --only context- --label context-confidence`: 15 Electron-rendered frames across Dark, Light and High Contrast. Native selection, estimated text, unknown occupancy and pending selection were inspected; text remains visible in narrow composers.

Local screenshots and full logs are ignored artifacts under `.screens/ui/context-confidence` and `.verification/context-*.log`.
