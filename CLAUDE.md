# Projekt-Anweisungen für Claude — MemoryX

## Memory-System (MemoryX v2 — memcp)

Dieses Projekt nutzt ein MCP-basiertes persistentes Memory-System.
Der MCP-Server ist in `.mcp.json` als `memory` registriert.

## Session-Startup (PFLICHT)

Zu Beginn JEDER Sitzung:

1. `memcp_recall(importance="critical")` — Kritische Regeln und Entscheidungen laden
2. `memcp_status()` — Speicher-Statistiken prüfen
3. `memcp_recall(project="memoryx", limit=20)` — Projektkontext laden

## Wann speichern?

Rufe `memcp_remember()` auf bei:

| Kategorie | Wann | Beispiel |
|-----------|------|---------|
| `decision` | Architekturentscheidung getroffen | "SQLite statt PostgreSQL für Graph-Backend gewählt" |
| `fact` | Systemgrenzen, API-Limits, Konfigurationswerte | "API Rate-Limit ist 100/min" |
| `preference` | User-Vorlieben, Coding-Stil, Tool-Präferenzen | "User bevorzugt deutsche Kommentare" |
| `finding` | Bug-Entdeckungen, Performance-Insights, Edge-Cases | "WAL-Modus braucht read-write Mount" |
| `todo` | Offene Aufgaben, Follow-ups | "HNSW-Index für Vektor-Suche testen" |
| `general` | Alles andere, was sich zu merken lohnt | Session-Zusammenfassungen |

## Importance-Level

- `critical` — Darf NIEMALS vergessen werden (z.B. "Nie force-push auf main")
- `high` — Wichtiger Kontext (z.B. "Client verlangt WCAG 2.1 AA Compliance")
- `medium` — Nützliches Wissen (z.B. "API Rate-Limit ist 100/min")
- `low` — Nice-to-have (z.B. "Ansatz X hat nicht funktioniert")

## Tags

Immer relevante Tags für besseres Retrieval hinzufügen:
```
memcp_remember("...", tags="api,auth,jwt,security")
```

## Tool-Kurzreferenz

### Phase 1: Memory Tools
| Tool | Zweck |
|------|-------|
| `memcp_ping()` | Health-Check + Statistiken |
| `memcp_remember(content, category, importance, tags)` | Insight speichern (Graph-Node + Auto-Edges) |
| `memcp_recall(query, category, importance, limit, max_tokens)` | Intent-aware Graph-Retrieval |
| `memcp_forget(insight_id)` | Insight + Edges entfernen |
| `memcp_status(project, session)` | Speicher-Statistiken |

### Phase 2: Context + Chunking + Search
| Tool | Zweck |
|------|-------|
| `memcp_load_context(name, content, file_path)` | Inhalt als Disk-Variable speichern |
| `memcp_inspect_context(name)` | Metadata + Preview ohne Laden |
| `memcp_get_context(name, start, end)` | Inhalt oder Zeilenbereich lesen |
| `memcp_chunk_context(name, strategy, chunk_size, overlap)` | In nummerierte Chunks aufteilen |
| `memcp_peek_chunk(context_name, chunk_index, start, end)` | Einen bestimmten Chunk lesen |
| `memcp_filter_context(name, pattern, invert)` | Regex-Filter innerhalb Context |
| `memcp_list_contexts(project)` | Alle Variablen auflisten |
| `memcp_clear_context(name)` | Variable löschen |
| `memcp_search(query, limit, source, max_tokens)` | Suche über Memory + Contexts |

### Phase 3: Graph Memory
| Tool | Zweck |
|------|-------|
| `memcp_related(insight_id, edge_type, depth)` | Graph traversieren — verbundene Insights finden |
| `memcp_graph_stats(project)` | Graph-Statistiken: Nodes, Edges, Top-Entities |

### Phase 4: Cognitive Memory
| Tool | Zweck |
|------|-------|
| `memcp_reinforce(insight_id, helpful, note)` | Feedback — Insight als hilfreich/irreführend markieren |
| `memcp_consolidation_preview(threshold, limit)` | Preview ähnlicher Insight-Gruppen (Dry-Run) |
| `memcp_consolidate(group_ids, keep_id, merged_content)` | Ähnliche Insights zusammenführen |

### Phase 6: Retention Lifecycle
| Tool | Zweck |
|------|-------|
| `memcp_retention_preview(archive_days, purge_days)` | Dry-Run — was würde archiviert/gelöscht |
| `memcp_retention_run(archive, purge)` | Archivierung/Löschung ausführen |
| `memcp_restore(name, item_type)` | Archivierten Context oder Insight wiederherstellen |

### Phase 7: Multi-Project & Session
| Tool | Zweck |
|------|-------|
| `memcp_projects()` | Alle Projekte mit Statistiken auflisten |
| `memcp_sessions(project, limit)` | Sessions nach Projekt durchsuchen |

## RLM Sub-Agents

MemCP bietet 4 Claude Code Sub-Agents, die als unabhängige Sessions laufen (eigenes Context-Window, kein Verbrauch des Hauptkontexts):

| Sub-Agent | Model | Zweck |
|-----------|-------|-------|
| `memcp-analyzer` | Haiku | Single-Chunk-Analyse mit Peek-Identify-Load-Analyze |
| `memcp-mapper` | Haiku | MAP-Phase — einen Chunk parallel verarbeiten |
| `memcp-synthesizer` | Sonnet | REDUCE-Phase — Mapper-Ergebnisse kombinieren |
| `memcp-entity-extractor` | Haiku | Entities + Beziehungen aus Inhalten extrahieren |

### Pattern 1: Single-Chunk-Analyse

Wenn du eine Frage zu gespeichertem Context beantworten musst, ohne alles zu laden:

1. `memcp_search(query)` — relevante Contexts finden
2. `memcp-analyzer` starten mit Context-Name und Frage
3. Analyzer folgt dem RLM-Pattern: Inspect → Identify → Load (nur Relevantes) → Analyze

### Pattern 2: Map-Reduce (große Contexts)

Wenn ein Context zu groß für einen einzelnen Durchlauf ist:

1. `memcp_chunk_context(name, strategy="auto")` — Context partitionieren
2. N `memcp-mapper` im **Hintergrund** starten (einer pro Chunk)
3. Alle Mapper-Ergebnisse sammeln
4. `memcp-synthesizer` im **Vordergrund** mit Frage + allen Mapper-Ergebnissen starten

### Pattern 3: Entity-Enrichment

Nach dem Speichern neuer Inhalte — Entities für reichere Graph-Kanten extrahieren:

1. `memcp_remember(content, ...)` oder `memcp_load_context(name, content)`
2. `memcp-entity-extractor` im Hintergrund starten
3. Extrahierte Entities sammeln
4. Insight aktualisieren: `memcp_remember(content, entities="entity1,entity2,...")`

### Wann Sub-Agents vs. direkte Tools?

**Sub-Agents nutzen bei:**
- Große Contexts (>4000 Tokens) — Hauptkontext nicht überlasten
- Komplexe Fragen mit Cross-Referencing über Chunks
- Parallele Chunk-Verarbeitung für Geschwindigkeit
- Entity-Extraktion aus langen Texten

**Direkte Tools nutzen bei:**
- Einfacher Recall: `memcp_recall(query)` — schnell und optimiert
- Schnelles Speichern: `memcp_remember(content)` — ein Aufruf
- Status prüfen: `memcp_status()`, `memcp_graph_stats()`
- Kleine Context-Operationen: Inspect, Peek, Filter

## Auto-Hooks (laufen automatisch)

| Hook | Trigger | Aktion |
|------|---------|--------|
| **PreCompact** | Vor `/compact` | Blockiert — speichere zuerst allen Kontext |
| **Progressive Reminders** | 10/20/30+ Turns bei ≥55% Context | Stufen: bedenke → empfohlen → Pflicht |
| **Reset Counter** | Nach `memcp_remember()` / `memcp_load_context()` | Turn-Counter zurückgesetzt |
| **Auto-Reinforce** | Nach jedem `memcp_recall()` | Erinnert: bewerte Treffer mit `memcp_reinforce()` |
| **Session-Summary Tracker** | Nach `memcp_remember()` mit `session-summary` Tag | Markiert Summary als gespeichert |
| **Session-End Reminder** | 15+ Turns ohne Summary | Stufen: empfohlen (15+) → Pflicht (25+) |

## Am Ende jeder Sitzung

Speichere eine Abschlussepisode (wird automatisch eingefordert nach 15+ Turns):
```
memcp_remember(
    content="Session-Zusammenfassung: Was wurde erledigt, wichtige Erkenntnisse, offene Punkte",
    category="general",
    importance="medium",
    tags="session-summary,<relevante-tags>"
)
```

## Feedback (automatisch eingefordert nach Recall)

Nach jedem `memcp_recall()` wirst du erinnert, die Treffer zu bewerten:
- Insight war hilfreich → `memcp_reinforce(insight_id, helpful=True)`
- Insight war irrelevant → `memcp_reinforce(insight_id, helpful=False, note="Grund")`

Das ist der stärkste Hebel für die Lernkurve — bewertete Insights werden bei der Destillierung bevorzugt.
