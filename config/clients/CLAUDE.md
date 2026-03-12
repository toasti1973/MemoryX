# Memory-System Anweisungen

## Zu Beginn jeder Sitzung

- Ruf `memory-project:recall` mit einer Beschreibung der aktuellen Aufgabe auf
- Lies die zurückgegebenen Regeln und Episoden sorgfältig
- Beachte besonders Episoden mit `outcome: failure` — sie enthalten wichtige Warnungen

## Während der Arbeit

- Wenn du ein Problem löst, das du zuvor noch nicht gesehen hast: speichere die Lösung
- Wenn du eine Entscheidung triffst, die das Projekt langfristig betrifft: speichere sie
- Wenn ein Ansatz fehlschlägt: speichere auch das mit `outcome: failure`

## Am Ende jeder Sitzung

Speichere eine abschließende Episode:

```json
{
  "task_category": "session-summary",
  "outcome": "success",
  "context_summary": "Was wurde heute erledigt",
  "learnings": "Wichtige Erkenntnisse und offene Punkte"
}
```

## Feedback geben

Nach einem erfolgreichen Recall: Gib Feedback via `memory-project:feedback` mit `success: true`
Nach einem schlechten Treffer: `success: false` — das verbessert zukünftige Recalls
