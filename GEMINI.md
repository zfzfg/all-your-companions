---
description: Critical guidelines for Antigravity: Efficiency, Execution, and Tool Usage
always_on: true
---

# Repository Instructions & Tool Guidelines

## 1. Arbeitsweise & Token-Effizienz (STRENGSTE PRIORITÄT)

- **VERBOT von Full-Suite-Spam bei Zwischenschritten:**
  - Führe während der schrittweisen Entwicklung **NIEMALS** die komplette Testsuite (`npm test` mit >320 Dateien oder `npm run test:integration`) aus.
  - **Alte Regeln, die einen vollständigen Testlauf (`npm test` / `test:integration`) nach jedem einzelnen Teilmodul verlangten, sind hiermit ausdrücklich AUSGEHEBELT und UNGÜLTIG.**

- **Schnelle, gezielte Feedback-Schleife während der Entwicklung:**
  1. Für Typ- und Syntaxprüfungen: `npm run typecheck` oder `npm run compile` (~5 Sekunden).
  2. Für funktionale Verifikation des bearbeiteten Moduls: **NUR** die spezifische Testdatei ausführen (z. B. `npx vitest run test/<modul>.test.ts`, ~1 Sekunde).
  3. Bei Testausgaben immer kompakte Reporter nutzen oder Ausgaben kurz halten; keine seitenlangen Dateilisten in den Kontext spülen.

- **Full-Suite-Validierung ausschließlich als Meilenstein-Endabnahme:**
  - Die vollständige Suite (`npm test`, `npm run test:integration`) wird **nur einmal** am Ende eines zusammenhängenden Meilensteins ausgeführt (z. B. wenn alle verbleibenden W-15-Delegationen abgeschlossen sind oder vor der VSIX-Paketierung).

- **Entschlossenes Batching statt lähmendem Micro-Stepping:**
  - Zusammenhängende Aufgaben (wie das Delegieren der verbleibenden Host-Module) werden im Verbund zügig und entschlossen umgesetzt.
  - Zuerst die Hebel-Module mit hoher Zeilenzahl angehen (`session-inbound`, `session-start`, `session-catalog`), um das Zeilenziel direkt zu erreichen.

## 2. Cortex Tool Calling Regeln

1. **`write_to_file`**: Never include `ArtifactMetadata` when creating or modifying files in this workspace. `ArtifactMetadata` is strictly for internal brain artifacts (`<geminiHome>/brain/<conversation-id>/`).
2. **`find_by_name`**: Always provide the `Pattern` argument (e.g. `Pattern: "*"`).
3. **Paths**: Always use absolute paths for file and directory tools.
