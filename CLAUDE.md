# Projekt-Anweisungen für Claude — MemoryX

## Memory-System (MemoryX)

Die MCP-Tool-Namen richten sich nach dem Server-Namen in `.mcp.json`.
Ist der Server dort als `memory` registriert, heißen die Tools:

- `memory:recall`, `memory:store`, `memory:feedback`

### Zu Beginn jeder Sitzung

- Rufe `memory:recall` auf (POST `/mcp/recall`) mit einer kurzen Beschreibung der aktuellen Aufgabe
- Lies die zurückgegebenen Regeln und Episoden
- Beachte besonders `outcome: failure`-Einträge — sie enthalten Warnungen

### Während der Arbeit

- Lösung für ein neues Problem gefunden → `memory:store` (POST `/mcp/store`)
- Architekturentscheidung getroffen → speichern
- Ansatz ist fehlgeschlagen → mit `outcome: failure` speichern

### Am Ende jeder Sitzung
Speichere eine Abschlussepisode via `memory:store`:
```json
{
  "task_category": "session-summary",
  "outcome": "success",
  "context_summary": "Was wurde erledigt",
  "learnings": "Wichtige Erkenntnisse und offene Punkte"
}
```

### Feedback

- Recall-Treffer war nützlich → `memory:feedback` (POST `/mcp/feedback`) mit `success: true`
- Recall-Treffer war irrelevant → `memory:feedback` mit `success: false`

### Namespace
Dieses Projekt verwendet Namespace: `project:memoryx`
Globales Wissen (Namespace `global`) wird automatisch mitgelesen.
