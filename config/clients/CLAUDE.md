# Memory-System Anweisungen

Die MCP-Tool-Namen richten sich nach dem Server-Namen in `.mcp.json`.
Ist der Server dort als `memory-project` registriert, heißen die Tools:

- `memory-project:recall` (POST `/mcp/recall`)
- `memory-project:store` (POST `/mcp/store`)
- `memory-project:feedback` (POST `/mcp/feedback`)

## Zu Beginn jeder Sitzung

- Ruf `memory-project:recall` mit einer Beschreibung der aktuellen Aufgabe auf
- Lies die zurückgegebenen Regeln und Episoden sorgfältig
- Beachte besonders Episoden mit `outcome: failure` — sie enthalten wichtige Warnungen

## Während der Arbeit

- Wenn du ein Problem löst, das du zuvor noch nicht gesehen hast: speichere via `memory-project:store`
- Wenn du eine Entscheidung triffst, die das Projekt langfristig betrifft: speichere sie
- Wenn ein Ansatz fehlschlägt: speichere auch das mit `outcome: failure`

## Am Ende jeder Sitzung

Speichere eine abschließende Episode via `memory-project:store`:

```json
{
  "task_category": "session-summary",
  "outcome": "success",
  "context_summary": "Was wurde heute erledigt",
  "learnings": "Wichtige Erkenntnisse und offene Punkte"
}
```

## Feedback geben

- Recall-Treffer war nützlich → `memory-project:feedback` mit `success: true`
- Recall-Treffer war irrelevant → `memory-project:feedback` mit `success: false` — das verbessert zukünftige Recalls
