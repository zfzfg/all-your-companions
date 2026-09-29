# Provider-Inventur W-16

Basis: gesicherter Einstieg f4332b3 (23 Dateien); aktueller Umfang einschließlich der drei neuen Hosts: 26 Dateien.

Direkte Provider-ID-Vergleiche und Switches: **102 → 26**. Session-Identitätsvergleiche: **20 → 20**. Keine Capability-Frage bleibt als direkte ID-Abfrage.

Reproduzierbar: `node scripts/provider-inventory.cjs`; mit `--write` wird dieser Bericht aktualisiert. Nicht inventarisierte direkte Verzweigungen brechen die Prüfung ab.

Die Capability-Matrix besitzt 25 vollständige Dimensionen für fünf Provider; Runtime-Probes und unsupported-Fallbacks bleiben getrennt. Backend-Mode-Vertrag: provider-modes.ts und AcpBackend.hostModeSequence; CLI-/Auth-/Versions-/Update-Auswahl: provider-cli.ts; Usage-Quellen: provider-usage.ts; einmalige Kopie: provider-ui.ts. Explizite Registry-Einträge sind Strategien und keine verstreuten Provider-Vergleiche.

## Verbliebene direkte Vergleiche

| Ausführende Stelle | Vergleich | Kategorie und Grund | Verhaltenstests |
|---|---|---|---|
| [sidebar.ts:7356](../src/sidebar.ts#L7356) · offerGrokRestartForCompactThreshold | `s?.provider === "grok"` | CLI-/Storage-Integration: Only idle Grok processes restart after its environment compaction threshold changes. | [grok-compaction.test.ts](../test/grok-compaction.test.ts) |
| [cli-update-host.ts:100](../src/cli-update-host.ts#L100) · updateProviderCli | `update.provider === "codex"` | CLI-/Storage-Integration: Invalidate the selected CLI version probe after its existing update workflow. | [cli-update-host.test.ts](../test/cli-update-host.test.ts) |
| [provider-session.ts:243](../src/provider-session.ts#L243) · switchModel | `oldProvider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-session.ts:251](../src/provider-session.ts#L251) · switchModel | `provider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-session.ts:254](../src/provider-session.ts#L254) · switchModel | `provider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-session.ts:260](../src/provider-session.ts#L260) · switchModel | `provider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-session.ts:1246](../src/provider-session.ts#L1246) · persistEffort | `provider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-setup.ts:206](../src/provider-setup.ts#L206) · createProviderBackend | `provider === "codex"` | Backend-Protokoll: Construct the actual adapter with provider-specific options; Grok remains the AcpClient default. | [provider-setup.test.ts](../test/provider-setup.test.ts) |
| [provider-setup.ts:207](../src/provider-setup.ts#L207) · createProviderBackend | `provider === "claude"` | Backend-Protokoll: Construct the actual adapter with provider-specific options; Grok remains the AcpClient default. | [provider-setup.test.ts](../test/provider-setup.test.ts) |
| [provider-setup.ts:224](../src/provider-setup.ts#L224) · createProviderBackend | `provider === "gemini"` | Backend-Protokoll: Construct the actual adapter with provider-specific options; Grok remains the AcpClient default. | [provider-setup.test.ts](../test/provider-setup.test.ts) |
| [provider-setup.ts:225](../src/provider-setup.ts#L225) · createProviderBackend | `provider === "muse"` | Backend-Protokoll: Construct the actual adapter with provider-specific options; Grok remains the AcpClient default. | [provider-setup.test.ts](../test/provider-setup.test.ts) |
| [provider-setup.ts:712](../src/provider-setup.ts#L712) · providerDefaultForProject | `provider === "grok"` | CLI-/Storage-Integration: Read legacy Grok defaultModel only if no per-project selection exists. | [provider-ui.test.ts](../test/provider-ui.test.ts) |
| [session-catalog.ts:605](../src/session-catalog.ts#L605) · scheduleAdapterHistoryRefresh | `provider === "codex"` | CLI-/Storage-Integration: Keep the Codex refresh entry point and its dynamic override seam. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [session-start.ts:614](../src/session-start.ts#L614) · startSessionBody | `session.provider === "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:624](../src/session-start.ts#L624) · startSessionBody | `session.provider === "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:664](../src/session-start.ts#L664) · startSessionBody | `client.provider !== "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:667](../src/session-start.ts#L667) · startSessionBody | `session.provider === "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:800](../src/session-start.ts#L800) · configureSessionEnvironment | `session.provider === "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [grok-compaction.test.ts](../test/grok-compaction.test.ts) |
| [session-start.ts:836](../src/session-start.ts#L836) · spawnSessionProcess | `session.provider === "grok"` | Backend-Protokoll: Grok handshake/version, native notifications and retry classification have a distinct wire/storage contract. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:889](../src/session-start.ts#L889) · wireSessionListeners | `session.provider === "grok"` | Backend-Protokoll: Grok handshake/version, native notifications and retry classification have a distinct wire/storage contract. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:1668](../src/session-start.ts#L1668) · handleSend | `session.provider === "grok"` | Backend-Protokoll: Grok handshake/version, native notifications and retry classification have a distinct wire/storage contract. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [sidebar-inbound.ts:575](../src/sidebar-inbound.ts#L575) · tryHandle | `session.provider === "grok"` | CLI-/Storage-Integration: Remove discarded empty Grok directories; adapter deletion belongs to its RPC lifecycle. | [session-removal.test.ts](../test/session-removal.test.ts) |
| [voice-and-mcp.ts:833](../src/voice-and-mcp.ts#L833) · reservedMcpIdentityFor | `session.provider === "grok"` | CLI-/Storage-Integration: Read native Grok MCP configuration or provider-owned media; Grok-only catalog helpers select that specific identity. | [voice-and-mcp.test.ts](../test/voice-and-mcp.test.ts) |
| [voice-and-mcp.ts:1053](../src/voice-and-mcp.ts#L1053) · findLiveGrokSession | `candidate.provider === "grok"` | CLI-/Storage-Integration: Read native Grok MCP configuration or provider-owned media; Grok-only catalog helpers select that specific identity. | [voice-and-mcp.test.ts](../test/voice-and-mcp.test.ts) |
| [voice-and-mcp.ts:1071](../src/voice-and-mcp.ts#L1071) · grokSessionForMcpList | `candidate.provider === "grok"` | CLI-/Storage-Integration: Read native Grok MCP configuration or provider-owned media; Grok-only catalog helpers select that specific identity. | [voice-and-mcp.test.ts](../test/voice-and-mcp.test.ts) |
| [voice-and-mcp.ts:1164](../src/voice-and-mcp.ts#L1164) · isServableFromDisk | `provider === "codex"` | CLI-/Storage-Integration: Read native Grok MCP configuration or provider-owned media; Grok-only catalog helpers select that specific identity. | [voice-and-mcp.test.ts](../test/voice-and-mcp.test.ts) |

## Identitätsvergleiche

Diese prüfen den konkreten Besitzer einer Session, eines Modells oder einer Rolle; sie entscheiden keine Fähigkeiten und bleiben absichtlich erhalten.

| Stelle | Vergleich |
|---|---|
| sidebar.ts:1915 · createProviderSetup | `session?.provider === provider` |
| sidebar.ts:2648 · routineModelOptions | `m.provider !== provider` |
| agent-authoring.ts:193 · resolveRoleProvider | `candidate !== caller.provider` |
| agent-authoring.ts:283 · handleAgentCommand | `provider === role.provider` |
| agent-authoring.ts:397 · runAgentRole | `role.provider === caller.provider` |
| agent-authoring.ts:725 · startHandoff | `provider === role.provider` |
| provider-session.ts:187 · pickModel | `m.provider === focused.provider` |
| provider-session.ts:221 · switchModel | `provider !== session.provider` |
| provider-session.ts:718 · resetProviderSessionsAfterLogout | `session.provider === provider` |
| provider-session.ts:720 · resetProviderSessionsAfterLogout | `focused.provider === provider` |
| provider-session.ts:721 · resetProviderSessionsAfterLogout | `focused.provider === provider` |
| provider-session.ts:1182 · adoptSessionsForConnectedProvider | `session.provider === provider` |
| provider-setup.ts:710 · providerDefaultForProject | `saved?.provider === provider` |
| session-start.ts:389 · startSessionBody | `fallback !== target.provider` |
| sidebar-inbound.ts:1620 · tryHandle | `session.provider === provider` |
| subagent-host.ts:1868 · directiveForSpawn | `directive.provider === args.provider` |
| usage-host.ts:239 · measuredFreePercent | `session?.provider !== provider` |
| usage-host.ts:254 · invalidateSubscriptionUsage | `session?.provider !== provider` |
| workflow-stage-runner.ts:492 · decorateWorkflowView | `t.provider !== run.gate!.limitProvider` |
| workflow-stage-runner.ts:948 · handleHostGateAction | `p !== provider` |
