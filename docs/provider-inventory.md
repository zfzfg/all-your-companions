# Provider-Inventur W-16

Basis: gesicherter Einstieg f4332b3 (23 Dateien); aktueller Umfang einschließlich der drei neuen Hosts: 26 Dateien.

Direkte Provider-ID-Vergleiche und Switches: **102 → 36**. Session-Identitätsvergleiche: **20 → 21**. Keine Capability-Frage bleibt als direkte ID-Abfrage.

Reproduzierbar: `node scripts/provider-inventory.cjs`; mit `--write` wird dieser Bericht aktualisiert. Nicht inventarisierte direkte Verzweigungen brechen die Prüfung ab.

Die Capability-Matrix besitzt 25 vollständige Dimensionen für fünf Provider; Runtime-Probes und unsupported-Fallbacks bleiben getrennt. Backend-Mode-Vertrag: provider-modes.ts und AcpBackend.hostModeSequence; CLI-/Auth-/Versions-/Update-Auswahl: provider-cli.ts; Usage-Quellen: provider-usage.ts; einmalige Kopie: provider-ui.ts. Explizite Registry-Einträge sind Strategien und keine verstreuten Provider-Vergleiche.

## Verbliebene direkte Vergleiche

| Ausführende Stelle | Vergleich | Kategorie und Grund | Verhaltenstests |
|---|---|---|---|
| [sidebar.ts:3172](../src/sidebar.ts#L3172) · displayMode | `session.provider === "muse"` | Native Muse approval/process policy: Muse displays the last CLI-confirmed approval mode, independent of the host Plan gate. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [sidebar.ts:3508](../src/sidebar.ts#L3508) · autoApprovePendingPermissions | `session.provider === "muse"` | Native Muse approval/process policy: Muse permission requests must retain CLI ownership; host YOLO cannot synthesize approval. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [sidebar.ts:7365](../src/sidebar.ts#L7365) · offerGrokRestartForCompactThreshold | `s?.provider === "grok"` | CLI-/Storage-Integration: Only idle Grok processes restart after its environment compaction threshold changes. | [grok-compaction.test.ts](../test/grok-compaction.test.ts) |
| [cli-update-host.ts:100](../src/cli-update-host.ts#L100) · updateProviderCli | `update.provider === "codex"` | CLI-/Storage-Integration: Invalidate the selected CLI version probe after its existing update workflow. | [cli-update-host.test.ts](../test/cli-update-host.test.ts) |
| [provider-session.ts:246](../src/provider-session.ts#L246) · switchModel | `oldProvider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-session.ts:254](../src/provider-session.ts#L254) · switchModel | `provider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-session.ts:257](../src/provider-session.ts#L257) · switchModel | `provider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-session.ts:265](../src/provider-session.ts#L265) · switchModel | `provider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-session.ts:293](../src/provider-session.ts#L293) · setMode | `session.provider === "muse"` | Native Muse approval/process policy: Muse native mode changes require an accepted MSP response before persistence. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [provider-session.ts:637](../src/provider-session.ts#L637) · handlePermissionRequest | `session.provider !== "muse"` | Native Muse approval/process policy: Muse never uses extension auto-accept as a fallback for its native approval policy. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [provider-session.ts:1283](../src/provider-session.ts#L1283) · persistEffort | `provider === "grok"` | CLI-/Storage-Integration: Grok stores defaults in its CLI configuration and empty conversations on disk; adapters own their history. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [provider-setup.ts:212](../src/provider-setup.ts#L212) · createProviderBackend | `provider === "codex"` | Backend-Protokoll: Construct the actual adapter with provider-specific options; Grok remains the AcpClient default. | [provider-setup.test.ts](../test/provider-setup.test.ts) |
| [provider-setup.ts:213](../src/provider-setup.ts#L213) · createProviderBackend | `provider === "claude"` | Backend-Protokoll: Construct the actual adapter with provider-specific options; Grok remains the AcpClient default. | [provider-setup.test.ts](../test/provider-setup.test.ts) |
| [provider-setup.ts:230](../src/provider-setup.ts#L230) · createProviderBackend | `provider === "gemini"` | Backend-Protokoll: Construct the actual adapter with provider-specific options; Grok remains the AcpClient default. | [provider-setup.test.ts](../test/provider-setup.test.ts) |
| [provider-setup.ts:231](../src/provider-setup.ts#L231) · createProviderBackend | `provider === "muse"` | Backend-Protokoll: Construct the actual adapter with provider-specific options; Grok remains the AcpClient default. | [provider-setup.test.ts](../test/provider-setup.test.ts) |
| [provider-setup.ts:749](../src/provider-setup.ts#L749) · providerDefaultForProject | `provider === "grok"` | CLI-/Storage-Integration: Read legacy Grok defaultModel only if no per-project selection exists. | [provider-ui.test.ts](../test/provider-ui.test.ts) |
| [session-catalog.ts:605](../src/session-catalog.ts#L605) · scheduleAdapterHistoryRefresh | `provider === "codex"` | CLI-/Storage-Integration: Keep the Codex refresh entry point and its dynamic override seam. | [provider-review-fixes.test.ts](../test/provider-review-fixes.test.ts) |
| [session-start.ts:495](../src/session-start.ts#L495) · startSessionBody | `session.provider === "muse"` | Native Muse approval/process policy: Capture Muse process posture and avoid applying generic host modes at startup. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [session-start.ts:620](../src/session-start.ts#L620) · startSessionBody | `session.provider !== "muse"` | Native Muse approval/process policy: Capture Muse process posture and avoid applying generic host modes at startup. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [session-start.ts:629](../src/session-start.ts#L629) · startSessionBody | `session.provider === "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:639](../src/session-start.ts#L639) · startSessionBody | `session.provider === "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:679](../src/session-start.ts#L679) · startSessionBody | `client.provider !== "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:682](../src/session-start.ts#L682) · startSessionBody | `session.provider === "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:817](../src/session-start.ts#L817) · configureSessionEnvironment | `session.provider === "grok"` | CLI-/Storage-Integration: Preserve Grok configuration/defaults, ignores and Windows stdio retry/auth classification; these are integration contracts. | [grok-compaction.test.ts](../test/grok-compaction.test.ts) |
| [session-start.ts:853](../src/session-start.ts#L853) · spawnSessionProcess | `session.provider === "grok"` | Backend-Protokoll: Grok handshake/version, native notifications and retry classification have a distinct wire/storage contract. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:855](../src/session-start.ts#L855) · spawnSessionProcess | `session.provider === "muse"` | Native Muse approval/process policy: Pass the captured Muse posture to its dedicated adapter process. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [session-start.ts:906](../src/session-start.ts#L906) · wireSessionListeners | `session.provider === "grok"` | Backend-Protokoll: Grok handshake/version, native notifications and retry classification have a distinct wire/storage contract. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [session-start.ts:1016](../src/session-start.ts#L1016) · wireSessionListeners | `session.provider === "muse"` | Native Muse approval/process policy: Publish native Muse mode evidence without enabling host Plan. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [session-start.ts:1510](../src/session-start.ts#L1510) · loadOrResumeSession | `session.provider !== "muse"` | Native Muse approval/process policy: The resumed Muse approval policy is authoritative; generic mode restoration is inappropriate. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [session-start.ts:1751](../src/session-start.ts#L1751) · handleSend | `session.provider === "grok"` | Backend-Protokoll: Grok handshake/version, native notifications and retry classification have a distinct wire/storage contract. | [session-start-retry.test.ts](../test/session-start-retry.test.ts) |
| [sidebar-inbound.ts:580](../src/sidebar-inbound.ts#L580) · tryHandle | `session.provider === "grok"` | CLI-/Storage-Integration: Remove discarded empty Grok directories; adapter deletion belongs to its RPC lifecycle. | [session-removal.test.ts](../test/session-removal.test.ts) |
| [sidebar-inbound.ts:1564](../src/sidebar-inbound.ts#L1564) · tryHandle | `provider === "muse"` | Native Muse approval/process policy: Muse login uses the same credential backend as its adapter on Windows/Linux. | [muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts](../test/muse-session.test.ts, muse-backend.test.ts, provider-session.test.ts) |
| [voice-and-mcp.ts:833](../src/voice-and-mcp.ts#L833) · reservedMcpIdentityFor | `session.provider === "grok"` | CLI-/Storage-Integration: Read native Grok MCP configuration or provider-owned media; Grok-only catalog helpers select that specific identity. | [voice-and-mcp.test.ts](../test/voice-and-mcp.test.ts) |
| [voice-and-mcp.ts:1053](../src/voice-and-mcp.ts#L1053) · findLiveGrokSession | `candidate.provider === "grok"` | CLI-/Storage-Integration: Read native Grok MCP configuration or provider-owned media; Grok-only catalog helpers select that specific identity. | [voice-and-mcp.test.ts](../test/voice-and-mcp.test.ts) |
| [voice-and-mcp.ts:1071](../src/voice-and-mcp.ts#L1071) · grokSessionForMcpList | `candidate.provider === "grok"` | CLI-/Storage-Integration: Read native Grok MCP configuration or provider-owned media; Grok-only catalog helpers select that specific identity. | [voice-and-mcp.test.ts](../test/voice-and-mcp.test.ts) |
| [voice-and-mcp.ts:1164](../src/voice-and-mcp.ts#L1164) · isServableFromDisk | `provider === "codex"` | CLI-/Storage-Integration: Read native Grok MCP configuration or provider-owned media; Grok-only catalog helpers select that specific identity. | [voice-and-mcp.test.ts](../test/voice-and-mcp.test.ts) |

## Identitätsvergleiche

Diese prüfen den konkreten Besitzer einer Session, eines Modells oder einer Rolle; sie entscheiden keine Fähigkeiten und bleiben absichtlich erhalten.

| Stelle | Vergleich |
|---|---|
| sidebar.ts:1917 · createProviderSetup | `session?.provider === provider` |
| sidebar.ts:2649 · routineModelOptions | `m.provider !== provider` |
| agent-authoring.ts:193 · resolveRoleProvider | `candidate !== caller.provider` |
| agent-authoring.ts:283 · handleAgentCommand | `provider === role.provider` |
| agent-authoring.ts:397 · runAgentRole | `role.provider === caller.provider` |
| agent-authoring.ts:725 · startHandoff | `provider === role.provider` |
| provider-session.ts:189 · pickModel | `m.provider === focused.provider` |
| provider-session.ts:223 · switchModel | `provider !== session.provider` |
| provider-session.ts:263 · switchModel | `session.provider !== provider` |
| provider-session.ts:745 · resetProviderSessionsAfterLogout | `session.provider === provider` |
| provider-session.ts:747 · resetProviderSessionsAfterLogout | `focused.provider === provider` |
| provider-session.ts:748 · resetProviderSessionsAfterLogout | `focused.provider === provider` |
| provider-session.ts:1219 · adoptSessionsForConnectedProvider | `session.provider === provider` |
| provider-setup.ts:747 · providerDefaultForProject | `saved?.provider === provider` |
| session-start.ts:399 · startSessionBody | `fallback !== target.provider` |
| sidebar-inbound.ts:1614 · tryHandle | `session.provider === provider` |
| subagent-host.ts:1868 · directiveForSpawn | `directive.provider === args.provider` |
| usage-host.ts:268 · measuredFreePercent | `session?.provider !== provider` |
| usage-host.ts:283 · invalidateSubscriptionUsage | `session?.provider !== provider` |
| workflow-stage-runner.ts:492 · decorateWorkflowView | `t.provider !== run.gate!.limitProvider` |
| workflow-stage-runner.ts:948 · handleHostGateAction | `p !== provider` |
