# MemoryX — AI-Installationsanleitung

> **Diese Datei ist für Claude bestimmt.**
> Wenn ein Nutzer dich bittet, MemoryX in sein Projekt zu integrieren,
> folge dieser Anleitung Schritt für Schritt. Jeder Schritt ist exakt ausführbar.
> Überspringe keine Schritte. Frage nur, wenn ein Wert wirklich unklar ist.

---

## Was du tun wirst

Du integrierst das **MemoryX v2.2**-System (basierend auf **memcp**) in ein bestehendes Projekt. Das bedeutet:

1. Du erzeugst eine `.mcp.json` im Projektordner → verbindet Claude Code mit dem MCP-Memory-Server
2. Du erzeugst oder erweiterst eine `CLAUDE.md` → gibt dir (Claude) Anweisungen für jede Sitzung
3. Du prüfst, ob der Memory-Server erreichbar ist → Health-Check
4. Optional: Du fügst einen projektspezifischen API-Key im Admin-Dashboard an

Du veränderst **keinen** bestehenden Code. Du fügst nur Konfigurationsdateien hinzu.

---

## Architektur-Überblick

```text
Option A (HTTPS via Caddy):
Claude Code ──HTTPS──▶ Caddy ──▶ auth-proxy (API-Key) ──▶ memcp (FastMCP)
                         │                                       │
                         ▼                                       ▼
                    Admin-UI/API                          graph.db + Ollama

Option B (Direkt HTTP — empfohlen bei lokalen CAs):
Claude Code ──HTTP──▶ memcp:3457 (FastMCP, mit API-Key-Header)
```

- **memcp**: Python MCP-Server (FastMCP), 24 Tools, MAGMA-Graph, 5-Tier-Suche, HNSW-Index
- **auth-proxy**: API-Key-Validierung, Rate-Limiting, Access-Logging
- **Caddy**: TLS-Terminierung, Reverse-Proxy, Basic-Auth für Admin
- **Ollama**: Lokales Embedding (nomic-embed-text)
- **scheduler**: Cron-Jobs für Backup, Destillierung (gewichtetes Scoring), Key-Cleanup

---

## Voraussetzungen — Zuerst prüfen

Bevor du irgendetwas schreibst, stelle diese Fragen an den Nutzer (alle auf einmal, in einer Nachricht):

```text
Ich benötige drei kurze Informationen für die MemoryX-Integration:

1. Unter welcher URL läuft der Memory-Server?
   (Standard: https://memory.local — oder eine andere IP/Domain)

2. Welchen API-Key soll ich für dieses Projekt verwenden?
   (Aus dem Admin-Dashboard unter https://memory.local/admin/keys.html)

3. Wie soll der Projektname heißen?
   (Beispiel: "meinprojekt" — wird als MCP-Kontext verwendet)
```

Warte auf die Antworten. Fahre erst dann fort.

---

## Schritt 1 — .mcp.json erstellen

Prüfe, ob im Projektverzeichnis bereits eine `.mcp.json` existiert.

**Fall A — Datei existiert nicht:**

Erstelle `.mcp.json` im Projektroot:

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "<URL_VOM_NUTZER>/mcp",
      "headers": {
        "X-API-Key": "<API_KEY_VOM_NUTZER>"
      }
    }
  }
}
```

> **Wichtig:**
> - Die URL muss mit `/mcp` enden (**ohne** Trailing-Slash — `/mcp/` verursacht 307-Redirect).
> - `type` muss `"http"` sein (nicht `"streamable-http"` — Claude Code verwendet intern Streamable HTTP).
> - Bei lokalen CAs (Caddy) kann es zu SSL-Problemen kommen. Alternative: Direkt-URL `http://<SERVER_IP>:3457/mcp`.

**Fall B — Datei existiert bereits:**

Lies die Datei. Füge unter `mcpServers` einen neuen Eintrag `"memory"` hinzu.
Überschreibe keinen bestehenden Eintrag.

---

## Schritt 2 — CLAUDE.md erstellen oder erweitern

Prüfe, ob im Projektverzeichnis bereits eine `CLAUDE.md` existiert.

**Fall A — Datei existiert nicht:**

Erstelle `CLAUDE.md` mit folgendem Inhalt:

```markdown
# Projekt-Anweisungen für Claude

## Memory-System (MemoryX)

### Zu Beginn jeder Sitzung
- Rufe `memory:memcp_recall` mit einer Beschreibung der aktuellen Aufgabe auf
- Lies die zurückgegebenen Erinnerungen sorgfältig
- Beachte besonders Einträge mit negativem Outcome — sie enthalten Warnungen

### Während der Arbeit
- Lösung für ein neues Problem gefunden → `memory:memcp_remember`
- Architekturentscheidung getroffen → speichern
- Ansatz ist fehlgeschlagen → ebenfalls speichern (mit Fehlerkontext)

### Am Ende jeder Sitzung
Speichere eine Zusammenfassung via `memory:memcp_remember`.

### Feedback
- Recall-Treffer war nützlich → `memory:memcp_reinforce` mit positivem Feedback
- Recall-Treffer war irrelevant → `memory:memcp_reinforce` mit negativem Feedback
```

**Fall B — Datei existiert bereits:**

Lies die Datei zuerst. Füge den Memory-Abschnitt am Ende der Datei hinzu.
Füge eine Trennlinie (`---`) vor dem neuen Abschnitt ein.

---

## Schritt 2b — Auto-Hooks installieren (empfohlen)

Die Hooks automatisieren drei kritische Verhaltensweisen, die das Memory-System zum Lernen braucht:

1. **Auto-Reinforce** — Nach jedem `recall` wird Claude erinnert, die Treffer zu bewerten
2. **Session-Summary** — Nach 15+ Turns fordert ein Hook die Speicherung einer Session-Zusammenfassung
3. **Summary-Tracker** — Erkennt, ob ein Summary gespeichert wurde, und unterdrückt weitere Reminder

Kopiere die Hook-Dateien aus dem MemoryX-Repository in das Projekt:

```bash
# Zielverzeichnis erstellen
mkdir -p .claude/hooks

# Hook-Dateien aus dem MemoryX-Repository kopieren (vom Server oder Git)
# Variante A: Aus geklontem Repo
cp /opt/MemoryX/.claude/hooks/*.py .claude/hooks/

# Variante B: Einzeln erstellen (siehe Dateien im MemoryX-Repository unter .claude/hooks/)
```

**Benötigte Dateien:**

| Datei | Zweck |
|-------|-------|
| `pre-compact-save.py` | Erzwingt Speichern vor `/compact` |
| `auto-save-reminder.py` | Progressive Erinnerungen bei 10/20/30+ Turns |
| `reset-counter.py` | Setzt Turn-Counter nach Speichern zurück |
| `post-recall-reinforce.py` | Erinnert nach `recall`: bewerte die Treffer |
| `session-end-summary.py` | Fordert Session-Summary nach 15/25+ Turns |
| `track-summary.py` | Erkennt gespeicherte Summaries |

Dann in `.claude/settings.local.json` (im Projektroot) registrieren:

```json
{
  "hooks": {
    "PreCompact": [
      {"matcher": "", "hooks": [{"type": "command", "command": "python .claude/hooks/pre-compact-save.py"}]}
    ],
    "Notification": [
      {"matcher": "", "hooks": [
        {"type": "command", "command": "python .claude/hooks/auto-save-reminder.py"},
        {"type": "command", "command": "python .claude/hooks/session-end-summary.py"}
      ]}
    ],
    "PostToolUse": [
      {"matcher": "mcp__memory__memcp_remember", "hooks": [
        {"type": "command", "command": "python .claude/hooks/reset-counter.py"},
        {"type": "command", "command": "python .claude/hooks/track-summary.py"}
      ]},
      {"matcher": "mcp__memory__memcp_load_context", "hooks": [
        {"type": "command", "command": "python .claude/hooks/reset-counter.py"}
      ]},
      {"matcher": "mcp__memory__memcp_recall", "hooks": [
        {"type": "command", "command": "python .claude/hooks/post-recall-reinforce.py"}
      ]}
    ]
  }
}
```

> **Hinweis:** Der `matcher`-Wert muss dem MCP-Tool-Prefix entsprechen. Wenn der Server in `.mcp.json` als `"memory"` registriert ist, heißt das Tool intern `mcp__memory__memcp_recall`.

---

## Schritt 3 — Health-Check

Führe diesen Check aus, um zu prüfen, ob der Server erreichbar ist:

```bash
curl -sk <URL_VOM_NUTZER>/health
```

**Erwartete Antwort:**

```json
{"status":"ok","memcp":"ok","keys_db":"ok"}
```

> `memcp: ok` = MCP-Server erreichbar, `keys_db: ok` = API-Key-Datenbank vorhanden.

**Wenn `status: ok`:** Schreib dem Nutzer: "Server ist erreichbar, Integration abgeschlossen."

**Wenn der Aufruf fehlschlägt:**

| Fehler | Mögliche Ursache | Lösung |
|--------|-----------------|--------|
| `curl: (6) Could not resolve host` | DNS-Eintrag fehlt | `memory.local` in `/etc/hosts` oder DNS eintragen |
| `curl: (60) SSL certificate problem` | Caddy CA nicht importiert | Root-CA-Zertifikat importieren (siehe unten) |
| `curl: (7) Failed to connect` | Stack läuft nicht | `docker compose ps` auf dem Server prüfen |
| `tlsv1 alert internal error` | Falscher Hostname | Nicht `localhost` verwenden — nur `memory.local` |
| `{"status":"degraded"}` | memcp oder Ollama nicht bereit | 2 Minuten warten, erneut prüfen |

**Hosts-Eintrag setzen (einmalig pro Client-Rechner):**

```bash
# Linux / macOS
echo "192.168.x.x  memory.local" | sudo tee -a /etc/hosts

# Windows (PowerShell als Administrator)
Add-Content -Path C:\Windows\System32\drivers\etc\hosts -Value "192.168.x.x  memory.local"
```

**CA-Zertifikat exportieren und importieren (einmalig):**

```bash
# Auf dem Server: CA-Zertifikat aus Caddy-Container exportieren
docker cp memory-caddy:/data/caddy/pki/authorities/local/root.crt /opt/MemoryX/config/caddy/ca.crt

# Dann auf dem Client importieren:
# Windows: Doppelklick auf root.crt → "Vertrauenswürdige Stammzertifizierungsstellen"
# macOS:   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain root.crt
# Linux:   sudo cp root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

---

## Schritt 4 — Ersten Recall testen (optional aber empfohlen)

Wenn der Health-Check erfolgreich war, teste die MCP-Verbindung.
Da memcp echtes MCP-Protokoll (JSON-RPC 2.0) spricht, ist ein einfacher curl-Test nicht direkt möglich.

Stattdessen: VS Code neu laden und prüfen, ob die MCP-Tools verfügbar sind:

1. `Ctrl+Shift+P` → "Reload Window"
2. In einer neuen Claude-Sitzung: `memory:memcp_ping` aufrufen
3. Wenn eine Antwort kommt, ist die Verbindung aktiv

---

## Schritt 5 — Erste Erinnerung speichern (Bootstrapping)

Speichere eine Bootstrap-Erinnerung über das MCP-Tool:

Rufe `memory:memcp_remember` auf mit:

```text
MemoryX wurde in dieses Projekt integriert. MCP-Verbindung konfiguriert am <HEUTIGES_DATUM>.
```

---

## Schritt 6 — Abschlussbericht an den Nutzer

Berichte dem Nutzer nach der Integration:

```text
MemoryX v2.2 wurde erfolgreich in dein Projekt integriert.

Erstellte Dateien:
- .mcp.json                → MCP-Verbindung zu <URL_VOM_NUTZER>/mcp
- CLAUDE.md                → Anweisungen für jede Sitzung
- .claude/hooks/*.py       → Auto-Hooks (Reinforce, Session-Summary, Save-Reminder)
- .claude/settings.local.json → Hook-Registrierung

Konfiguration:
- Transport:       MCP über HTTP (Streamable HTTP)
- Auth:            API-Key via X-API-Key Header
- Memory-Engine:   memcp (MAGMA-Graph, HNSW-Index, 24 Tools)
- Auto-Hooks:      Reinforce nach Recall, Session-Summary, Progressive Save-Reminder

Nächste Schritte:
1. VS Code neu laden (Ctrl+Shift+P → "Reload Window")
2. Neue Sitzung starten → erster automatischer Recall läuft
3. Nach der Sitzung: Admin-Dashboard prüfen unter <URL_VOM_NUTZER>/admin/
```

---

## Fehlerbehandlung — Sonderfälle

### Der Nutzer hat noch keinen API-Key

Anleitung geben:

```text
1. Öffne https://memory.local/admin/keys.html
2. Klicke "+ Neuer Key"
3. Name: "project-<projektname>"
4. Scope: "recall+store"
5. Namespaces: "*" (oder einschränken auf project:<projektname>)
6. Erstellen → Key kopieren und mir mitteilen
```

### API-Key funktioniert nicht (401 oder 403)

Der auth-proxy validiert API-Keys gegen die `admin.db`. Prüfen:

```bash
# Auf dem Server: Prüfen ob der Key in der DB existiert und aktiv ist
docker exec memory-admin-api node -e "
const Database = require('better-sqlite3');
const db = new Database('/data/admin.db');
const keys = db.prepare('SELECT name, active, expires_at FROM api_keys').all();
console.table(keys);
db.close();
"
```

### MCP-Tools erscheinen nicht in VS Code

1. Prüfe `.mcp.json` — URL muss mit `/mcp` enden (**ohne** Trailing-Slash)
2. Prüfe ob `type: "http"` gesetzt ist (nicht `"streamable-http"`)
3. VS Code komplett neu laden (nicht nur Fenster)
4. Health-Check erneut prüfen: `curl -sk https://memory.local/health`

### Der Nutzer möchte mehrere Projekte verbinden

Für jedes Projekt:

- Eigener API-Key (aus Sicherheitsgründen getrennt)
- Eigene `.mcp.json` im jeweiligen Projektordner
- memcp unterstützt Multi-Project nativ (Tool: `memory:memcp_projects`)

### Der Nutzer möchte das Memory auch in der Desktop App nutzen

Zeige folgende Konfiguration:

```json
// macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
// Windows: %APPDATA%\Claude\claude_desktop_config.json
// Linux:   ~/.config/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "https://memory.local/mcp",
      "headers": {
        "X-API-Key": "<DESKTOP_API_KEY>"
      }
    }
  }
}
```

### Der Stack soll aktualisiert werden

```bash
cd /opt/MemoryX
./scripts/update.sh
```

Das Skript erkennt automatisch, welche Services geändert wurden, und baut nur diese neu.

---

## Admin-Dashboard — Seiten-Übersicht

Das Dashboard ist erreichbar unter `https://memory.local/admin/` (mit Trailing-Slash).

| Seite | URL | Inhalt |
| ----- | --- | ------ |
| Übersicht | `/admin/` | KPIs (Insights, Regeln, Hit-Rate, Graph-Edges, DB-Größe, Ø Importance), Service-Status, Letzte Aktivität |
| API-Keys | `/admin/keys.html` | Keys erstellen, anzeigen, löschen |
| Episoden | `/admin/episodes.html` | Memory-Einträge durchsuchen und löschen |
| Regeln | `/admin/rules.html` | Destillierte Regeln verwalten (gewichtetes Scoring: access_count, feedback_score, importance) |
| Health | `/admin/health.html` | Detaillierter Systemstatus aller Services |
| System | `/admin/system.html` | Logs, Backup, GC, Destillierung |

> Hinweis: Die URL muss mit `/admin/` (Trailing-Slash) aufgerufen werden.

---

## MCP-Tool Referenz (für dich als Claude)

Sobald die Integration aktiv ist, stehen dir 24 memcp-Tools zur Verfügung.
Die wichtigsten für den Alltag:

### Kern-Tools

| Tool | Beschreibung |
| ------ | ------------- |
| `memory:memcp_ping` | Verbindungstest |
| `memory:memcp_remember` | Erfahrung/Wissen speichern |
| `memory:memcp_recall` | Relevante Erinnerungen abrufen |
| `memory:memcp_search` | Gezielte Suche (keyword, BM25, fuzzy, semantic, hybrid) |
| `memory:memcp_forget` | Eintrag löschen |
| `memory:memcp_reinforce` | Feedback geben (verbessert zukünftige Recalls) |
| `memory:memcp_status` | Systemstatus und Statistiken |

### Kontext-Tools

| Tool | Beschreibung |
| ------ | ------------- |
| `memory:memcp_load_context` | Große Dokumente laden und chunken |
| `memory:memcp_inspect_context` | Geladenen Kontext inspizieren |
| `memory:memcp_get_context` | Kontext abrufen |
| `memory:memcp_chunk_context` | Kontext in Chunks aufteilen |
| `memory:memcp_peek_chunk` | Einzelnen Chunk ansehen |
| `memory:memcp_filter_context` | Kontext filtern |
| `memory:memcp_list_contexts` | Alle geladenen Kontexte auflisten |
| `memory:memcp_clear_context` | Kontext freigeben |

### Graph- und Projekt-Tools

| Tool | Beschreibung |
| ------ | ------------- |
| `memory:memcp_related` | Graph-Beziehungen erkunden (MAGMA) |
| `memory:memcp_graph_stats` | Graph-Statistiken |
| `memory:memcp_projects` | Alle Projekte auflisten |
| `memory:memcp_sessions` | Session-Historie |

### Lifecycle-Tools

| Tool | Beschreibung |
| ------ | ------------- |
| `memory:memcp_retention_preview` | Vorschau: was würde bereinigt |
| `memory:memcp_retention_run` | Retention-Policy ausführen |
| `memory:memcp_restore` | Gelöschten Eintrag wiederherstellen |
| `memory:memcp_consolidation_preview` | Vorschau: Konsolidierung |
| `memory:memcp_consolidate` | Erinnerungen konsolidieren |

---

## Deaktivierung und Deinstallation

### Nur für ein Projekt deaktivieren

Entferne den `memory`-Eintrag aus der `.mcp.json` im Projektordner.
Danach VS Code neu laden (`Ctrl+Shift+P → "Reload Window"`).

Die gespeicherten Erinnerungen bleiben auf dem Server erhalten.

### API-Key deaktivieren

```text
1. Öffne https://memory.local/admin/keys.html
2. Klicke auf den Key, der deaktiviert werden soll
3. Klicke "Löschen" — der Key ist sofort ungültig
```

### Vollständige Deinstallation des Servers

```bash
# 1. Stack stoppen und Container entfernen
cd /opt/MemoryX
docker compose down

# 2. Alle Daten und Volumes löschen (UNWIDERRUFLICH)
docker compose down -v

# 3. Docker-Images entfernen (optional)
docker rmi $(docker images | grep memory | awk '{print $3}')

# 4. Projektverzeichnis löschen
rm -rf /opt/MemoryX

# 5. Hosts-Eintrag entfernen (Linux/macOS)
sudo sed -i '/memory.local/d' /etc/hosts
```

> **Warnung:** `docker compose down -v` löscht alle Erinnerungen, Regeln
> und API-Keys unwiderruflich. Vorher ein Backup erstellen:

```bash
./scripts/backup.sh /tmp/memoryx-final-backup
```

---

*MemoryX v2.2 · AI-Installationsanleitung · 2026-03-13*
*Quelle: <https://github.com/toasti1973/MemoryX>*
*MCP-Engine: memcp (MAGMA-Graph, HNSW-Index, FastMCP, 5-Tier-Hybrid-Search)*
