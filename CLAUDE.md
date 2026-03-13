# Projekt-Anweisungen für Claude — MemoryX

## Memory-System (MemoryX v2 — memcp)

Die MCP-Tool-Namen richten sich nach dem Server-Namen in `.mcp.json`.
Ist der Server dort als `memory` registriert, heißen die Tools z.B.:

- `memory:memcp_remember` — Erfahrung speichern
- `memory:memcp_recall` — Relevante Erinnerungen abrufen
- `memory:memcp_search` — Gezielte Suche im Memory
- `memory:memcp_forget` — Eintrag löschen
- `memory:memcp_reinforce` — Feedback/Verstärkung geben
- `memory:memcp_status` — Systemstatus prüfen

### Zu Beginn jeder Sitzung

- Rufe `memory:memcp_recall` mit einer Beschreibung der aktuellen Aufgabe auf
- Lies die zurückgegebenen Erinnerungen sorgfältig
- Beachte besonders Einträge mit negativem Outcome — sie enthalten Warnungen

### Während der Arbeit

- Lösung für ein neues Problem gefunden → `memory:memcp_remember`
- Architekturentscheidung getroffen → speichern
- Ansatz ist fehlgeschlagen → ebenfalls speichern (mit Fehlerkontext)

### Am Ende jeder Sitzung

Speichere eine Abschlussepisode via `memory:memcp_remember`:

```text
Session-Summary: Was wurde erledigt. Wichtige Erkenntnisse und offene Punkte.
```

### Feedback

- Recall-Treffer war nützlich → `memory:memcp_reinforce` mit positivem Feedback
- Recall-Treffer war irrelevant → `memory:memcp_reinforce` mit negativem Feedback

### Weitere nützliche Tools

- `memory:memcp_load_context` — Große Dokumente laden und chunken
- `memory:memcp_related` — Graph-Beziehungen zwischen Erinnerungen erkunden
- `memory:memcp_projects` — Alle Projekte im Memory auflisten
- `memory:memcp_sessions` — Session-Historie einsehen
- `memory:memcp_graph_stats` — MAGMA-Graph-Statistiken

### Namespace

Dieses Projekt verwendet den Standard-Namespace von memcp.
Globales Wissen wird automatisch mitgelesen.
