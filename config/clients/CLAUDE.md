# Memory-System Anweisungen

Die MCP-Tool-Namen richten sich nach dem Server-Namen in `.mcp.json`.
Ist der Server dort als `memory` registriert, heißen die Tools z.B.:

- `memory:memcp_remember` — Erfahrung speichern
- `memory:memcp_recall` — Relevante Erinnerungen abrufen
- `memory:memcp_search` — Gezielte Suche im Memory
- `memory:memcp_forget` — Eintrag löschen
- `memory:memcp_reinforce` — Feedback/Verstärkung geben

## Zu Beginn jeder Sitzung

- Ruf `memory:memcp_recall` mit einer Beschreibung der aktuellen Aufgabe auf
- Lies die zurückgegebenen Erinnerungen sorgfältig
- Beachte besonders Einträge mit negativem Outcome — sie enthalten wichtige Warnungen

## Während der Arbeit

- Wenn du ein Problem löst, das du zuvor noch nicht gesehen hast: speichere via `memory:memcp_remember`
- Wenn du eine Entscheidung triffst, die das Projekt langfristig betrifft: speichere sie
- Wenn ein Ansatz fehlschlägt: speichere auch das mit Fehlerkontext

## Am Ende jeder Sitzung

Speichere eine abschließende Zusammenfassung via `memory:memcp_remember`:

```text
Session-Summary: Was wurde heute erledigt. Wichtige Erkenntnisse und offene Punkte.
```

## Feedback geben

- Recall-Treffer war nützlich → `memory:memcp_reinforce` mit positivem Feedback
- Recall-Treffer war irrelevant → `memory:memcp_reinforce` mit negativem Feedback — das verbessert zukünftige Recalls
