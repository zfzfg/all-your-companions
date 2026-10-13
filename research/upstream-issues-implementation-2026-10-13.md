# Umsetzung des Upstream-Issues-Plans vom 13. Oktober 2026

Lokaler Fork `zfzfg/all-your-companions`, Version weiterhin **0.3.2**. Grundlage ist `../upstream-issues-plan-2026-10-13.md` im übergeordneten Arbeitsverzeichnis. Die vorgesehenen Produktänderungen und Regressionstests sind implementiert; der echte Muse-Server-Smoke bleibt mangels installierter CLI offen. Kein Push, Release oder Versionsbump.

## Umgesetzter Umfang

| Thema | Ergebnis und Nachweis |
| --- | --- |
| #203 Disconnect | Alle fünf Provider können unabhängig von Vendor-Logout getrennt werden, auch bei abgelaufener Anmeldung. Zustimmung wird vor dem Stoppen widerrufen, Probe-Clients werden abgebrochen und ihr Ende abgewartet. Unterhaltung, Provider-Zugehörigkeit, History und Entwürfe bleiben erhalten. Persistenzfehler werden gemeldet. CLI-Abmeldung bleibt als separate bestätigte Aktion erreichbar. Tests: `provider-signout-recovery`, bestehende Consent-/Reconnect-Tests und Settings-DOM. |
| #207 Muse-Summaries | `reasoning.summary`-Snapshots und `summary.n`-Deltas werden über `agent_thought_chunk` dargestellt. Live und Replay teilen Deduplizierung, Part-Trennung und Revisionsprüfung; vorzeitige Deltas, geänderte Präfixe und unbekannte Items sind abgedeckt. Die vorhandene Thinking-Einstellung steuert die Anzeige. Tests: `muse-projection`, `muse-thinking.dom`. |
| #206 Muse-Identität | Provider-/Modellauswahl und Persistenz beim Wechsel Grok → Muse → Grok → Muse sowie Darstellung nach Webview-Neustart sind abgesichert, für einen und mehrere verbundene Provider. Bestehende Sessions behalten ihren Provider. Kein entsprechender Identitätsfehler belegt; kein zusätzlicher Produktumbau. Tests: `provider-session`, `model-picker.dom`. |
| #195 Compact/Reload | Neuer Test durchläuft echten ACP-Usage-Empfang, Compact-Invalidierung, neu aufgebauten Host und Webview sowie ein frisches kleineres Update. Dabei wurde ein Verlust der Stale-/Provenienz-Information beim Weiterreichen historischer Grok-Usage gefunden und in `UsageHost.emitContextUsage` korrigiert. Alte 80 % werden nicht als frische Occupancy gezeigt; native Kapazitätsauswahl bleibt erhalten. Test: `grok-reload-context`. |
| #199 Fensterfilter | `companions.projects.workspaceOnly` ist optional und standardmäßig aus. Multi-Root und leere Editorfenster, Windows-/POSIX-Pfade, Pins/Recent und globale Archive sind berücksichtigt. Archivierte offene Roots erscheinen in dieser Sicht; gespeicherte Archive/Pins werden durch den Filter nicht verändert. Außerhalb der Roots laufende Gespräche bleiben nutzbar und erhalten einen Hinweis. Beide Rails und die separate Settings-Ansicht aktualisieren sich bei Konfigurations-/Workspace-Änderungen. Tests: `workspace-projects`, beide Rail-DOM-Suiten, echter Extension-Host. |
| #198 Markdown | H4–H6 besitzen konsistente Styles für die gemeinsamen Renderer. Lokale Rasterbilder werden relativ zum Gespräch oder einer expliziten Dateibasis über die vorhandene autorisierte und größenbegrenzte Host-Pipeline gelesen. Leeres Alt, Leerzeichen, fehlende Dateien und veraltete Sessionantworten sind behandelt. Externe Bilder werden als Links angeboten; die CSP wird nicht geöffnet. Tests: alle bisherigen Renderer-Tests, `markdown-images`; Browserprüfung bestätigt tatsächliches Laden eines lokalen Bildes. |
| #208 Lange Befehle | Expand here/Collapse ergänzt View all. Begrenzte Inline-Höhe, vertikales und horizontales Scrollen, Plaintext, Escape und Fokusrückgabe sind implementiert. Freigabeschaltflächen bleiben außerhalb der Scrollregion. Tests: `command-details.dom` sowie reale Browser-Overflow-Prüfungen. |

## Verifikation

- Vollständige Unit-/DOM-Suite: **6.706 bestanden**, 4 übersprungen, 362 Dateien.
- Echter VS-Code-Extension-Host: **23 bestanden**, einschließlich Fensterfilter-Konfigurationswechsel.
- Typecheck, Compile einschließlich Muse-Adapter und ESLint bestanden.
- `node scripts/provider-inventory.cjs` bestanden: Provider-Verzweigungen 102 → 39 gegenüber dem bestehenden Refactor-Baseline; Identitätsreferenzen 20 → 24. Kein neuer direkter Provider-Sonderpfad außerhalb der vorgesehenen Module.
- `git diff --check` ohne Whitespace-Fehler.
- UI-Harness: `npm run ui:screens -- --only upstream-plan --label upstream-issues-2026-10-13`; neun Screenshots und Layoutprüfungen bei 360 px Breite in Dark, Light und High Contrast. Überschriften, geladenes lokales Bild, begrenzte Scrollbereiche und Freigabeschaltflächen visuell geprüft. Lokaler Index: `.screens/ui/upstream-issues-2026-10-13/index.html` (gitignoriert).
- `npm run package` einschließlich `check:vsix` bestanden: frische `all-your-companions-0.3.2.vsix`, 930 Dateien, 6,61 MB. Mit `scripts/install.ps1 -VsixPath …` erfolgreich in lokalem Microsoft VS Code neu installiert. Der Prüfbericht unter `research/` ist vom Paket ausgeschlossen.

## Verbleibende Grenze

Die lokale SDK-Schnittstelle belegt Summary-Parts und Deltas. Die Muse-CLI ist weder auf PATH noch am üblichen lokalen Installationsort verfügbar. Deshalb ist nicht live bestätigt, ob `muse serve` ohne weitere Aktivierung Summaries liefert. Im SDK ist kein entsprechender `show_reasoning`-Serve-Schalter belegt; es wurde kein spekulativer Schalter ergänzt und keine globale Muse-Konfiguration geändert. Die offiziellen [Interactive-Dokumente](https://dev.meta.ai/docs/muse-code/interactive?project_id=1775916636764246&team_id=1331104075427093) beschreiben interaktive Reasoning-Darstellung, beweisen aber keinen MSP-Serve-Schalter. Ein gezielter späterer Muse-Smoke ist ausschließlich für diese Server-Aktivierung nötig. Kein echter Muse-/Grok-Modellturn wurde für diese Umsetzung ausgeführt; die Regressionstests verwenden kontrollierte Protokollereignisse.

#202 und #196 benötigen gemäß Plan keine neue Änderung. #209, #210, #204 und der Desktop-/Debian-Umfang wurden nicht übernommen.
