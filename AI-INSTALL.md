# MemoryX — AI-Installationsanleitung

> **Diese Datei ist für Claude bestimmt.**
> Wenn ein Nutzer dich bittet, MemoryX in sein Projekt zu integrieren,
> folge dieser Anleitung Schritt für Schritt. Jeder Schritt ist exakt ausführbar.
> Überspringe keine Schritte. Frage nur, wenn ein Wert wirklich unklar ist.

---

## Was du tun wirst

Du integrierst das **MemoryX**-System in ein bestehendes Projekt. Das bedeutet:

1. Du erzeugst eine `.mcp.json` im Projektordner → verbindet Claude Code mit dem Memory-Server
2. Du erzeugst oder erweiterst eine `CLAUDE.md` → gibt dir (Claude) Anweisungen für jede Sitzung
3. Du prüfst, ob der Memory-Server erreichbar ist → Health-Check
4. Optional: Du fügst einen projektspezifischen API-Key im Admin-Dashboard an

Du veränderst **keinen** bestehenden Code. Du fügst nur Konfigurationsdateien hinzu.

---

## Voraussetzungen — Zuerst prüfen

Bevor du irgendetwas schreibst, stelle diese Fragen an den Nutzer (alle auf einmal, in einer Nachricht):

```
Ich benötige drei kurze Informationen für die MemoryX-Integration:

1. Unter welcher URL läuft der Memory-Server?
   (Standard: https://memory.local — oder eine andere IP/Domain)

2. Welchen API-Key soll ich für dieses Projekt verwenden?
   (Aus dem Admin-Dashboard unter https://memory.local/admin/keys.html)

3. Wie soll der Namespace für dieses Projekt heißen?
   (Beispiel: "project:meinprojekt" — empfohlen: "project:" + Projektname in Kleinbuchstaben)
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
      "url": "<URL_VOM_NUTZER>/mcp",
      "apiKey": "<API_KEY_VOM_NUTZER>",
      "namespace": "<NAMESPACE_VOM_NUTZER>",
      "sharedNamespaces": ["global"],
      "autoRecall": true,
      "autoStore": true
    }
  }
}
```

**Fall B — Datei existiert bereits:**

Lies die Datei. Füge unter `mcpServers` einen neuen Eintrag `"memory"` hinzu.
Überschreibe keinen bestehenden Eintrag.

---

## Schritt 2 — CLAUDE.md erstellen oder erweitern

Prüfe, ob im Projektverzeichnis bereits eine `CLAUDE.md` existiert.

**Fall A — Datei existiert nicht:**

Erstelle `CLAUDE.md` mit folgendem Inhalt (passe `<NAMESPACE>` an):

```markdown
# Projekt-Anweisungen für Claude

## Memory-System (MemoryX)

### Zu Beginn jeder Sitzung
- Rufe `memory:recall` mit einer kurzen Beschreibung der aktuellen Aufgabe auf
- Lies die zurückgegebenen Regeln und Episoden
- Beachte besonders `outcome: failure`-Einträge — sie enthalten Warnungen

### Während der Arbeit
- Lösung für ein neues Problem gefunden → speichern
- Architekturentscheidung getroffen → speichern
- Ansatz ist fehlgeschlagen → mit `outcome: failure` speichern

### Am Ende jeder Sitzung
Speichere eine Abschlussepisode:
```json
{
  "task_category": "session-summary",
  "outcome": "success",
  "context_summary": "Was wurde erledigt",
  "learnings": "Wichtige Erkenntnisse und offene Punkte"
}
```

### Feedback
- Recall-Treffer war nützlich → `memory:feedback` mit `success: true`
- Recall-Treffer war irrelevant → `memory:feedback` mit `success: false`

### Namespace
Dieses Projekt verwendet Namespace: `<NAMESPACE>`
Globales Wissen (Namespace `global`) wird automatisch mitgelesen.
```

**Fall B — Datei existiert bereits:**

Lies die Datei zuerst. Füge den Memory-Abschnitt am Ende der Datei hinzu.
Füge eine Trennlinie (`---`) vor dem neuen Abschnitt ein.

---

## Schritt 3 — Health-Check

Führe diesen Check aus, um zu prüfen, ob der Server erreichbar ist:

```bash
curl -sk <URL_VOM_NUTZER>/health
```

**Erwartete Antwort:**
```json
{"status":"ok","db":"ok","ollama":"ok","uptime":13682,"version":"1.0.0"}
```

> Hinweis: `db: ok` = SQLite erreichbar, `ollama: ok` = Embedding-Modell geladen.
> Wenn `status: ok`, läuft der gesamte Stack korrekt.

**Wenn `status: ok`:** Schreib dem Nutzer: "Server ist erreichbar, Integration abgeschlossen."

**Wenn der Aufruf fehlschlägt:**

Prüfe folgende Ursachen und kommuniziere sie:

| Fehler | Mögliche Ursache | Lösung |
|--------|-----------------|--------|
| `curl: (6) Could not resolve host` | DNS-Eintrag fehlt | `memory.local` in `/etc/hosts` oder DNS eintragen |
| `curl: (60) SSL certificate problem` | Caddy CA nicht importiert | Root-CA-Zertifikat importieren (siehe unten) |
| `curl: (7) Failed to connect` | Stack läuft nicht | `docker compose ps` auf dem Server prüfen |
| `tlsv1 alert internal error` | Falscher Hostname | Nicht `localhost` verwenden — nur `memory.local` |
| `{"status":"degraded"}` | Ollama lädt noch | 2 Minuten warten, erneut prüfen |

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

Wenn der Health-Check erfolgreich war, führe einen Test-Recall durch:

```bash
curl -sk -X POST <URL_VOM_NUTZER>/mcp/recall \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <API_KEY_VOM_NUTZER>" \
  -d '{"task_description": "Installationstest", "namespace": "<NAMESPACE_VOM_NUTZER>"}'
```

**Erwartete Antwort bei leerem Memory:**
```json
{"context":"","episodeCount":0,"ruleCount":0,"tokenEstimate":0,"namespace":"..."}
```

Das ist korrekt — das Memory ist neu und noch leer. Nach der ersten Arbeitssitzung werden Episoden gespeichert.

---

## Schritt 5 — Erste Episode speichern (Bootstrapping)

Speichere eine Bootstrap-Episode, damit das Memory nicht leer beginnt:

```bash
curl -sk -X POST <URL_VOM_NUTZER>/mcp/store \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <API_KEY_VOM_NUTZER>" \
  -d '{
    "namespace": "<NAMESPACE_VOM_NUTZER>",
    "experience": {
      "task_category": "setup",
      "outcome": "success",
      "context_summary": "MemoryX wurde in dieses Projekt integriert. MCP-Verbindung konfiguriert.",
      "learnings": "Namespace: <NAMESPACE_VOM_NUTZER>. Memory-Server: <URL_VOM_NUTZER>. Integration abgeschlossen am <HEUTIGES_DATUM>."
    }
  }'
```

---

## Schritt 6 — Abschlussbericht an den Nutzer

Berichte dem Nutzer nach der Integration:

```
MemoryX wurde erfolgreich in dein Projekt integriert.

Erstellte Dateien:
- .mcp.json        → MCP-Verbindung zu <URL_VOM_NUTZER>/mcp
- CLAUDE.md        → Anweisungen für jede Sitzung

Konfiguration:
- Namespace:       <NAMESPACE>
- Shared:          global
- Auto-Recall:     aktiviert
- Auto-Store:      aktiviert

Nächste Schritte:
1. VS Code neu laden (Ctrl+Shift+P → "Reload Window")
2. Neue Sitzung starten → erster automatischer Recall läuft
3. Nach der Sitzung: Admin-Dashboard prüfen unter <URL_VOM_NUTZER>/admin/episodes.html
```

---

## Fehlerbehandlung — Sonderfälle

### Der Nutzer hat noch keinen API-Key

Anleitung geben:
```
1. Öffne https://memory.local/admin/keys.html
2. Klicke "+ Neuer Key"
3. Name: "project-<projektname>"
4. Scope: "recall+store"
5. Namespaces: "project:<projektname>,global"
6. Erstellen → Key kopieren und mir mitteilen
```

### API-Key funktioniert nicht (401 oder leere Antwort)

API-Keys werden im Admin-Dashboard erstellt (`admin.db`) und müssen in `memory.db` synchronisiert werden.
Falls die Synchronisation fehlschlägt (z.B. weil das Volume read-only war), Key manuell synchen:

```bash
docker exec memory-admin-api node -e "
const Database = require('better-sqlite3');
const adminDb = new Database('/data/admin.db');
const memDb = new Database('/memory/memory.db');
const rows = adminDb.prepare('SELECT id, name, key_value, scope, namespaces, rate_limit, expires_at FROM api_keys WHERE active = 1').all();
rows.forEach(r => {
  memDb.prepare('INSERT OR REPLACE INTO api_keys (id, name, key_hash, scope, namespaces, rate_limit, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(r.id, r.name, r.key_value, r.scope, r.namespaces, r.rate_limit, r.expires_at);
  console.log('Synced:', r.name);
});
adminDb.close(); memDb.close();
"
```

Falls `SQLITE_READONLY`-Fehler: Container neu erstellen (nicht nur restart):

```bash
docker compose up -d --force-recreate admin-api
```

### Recall gibt 0 Episoden zurück obwohl welche gespeichert sind

Ursache: `SIMILARITY_THRESHOLD` in der `.env` auf dem Server ist zu hoch (Default war 0.75).
Für das Embedding-Modell `nomic-embed-text` ist 0.35 optimal:

```bash
# Auf dem Server prüfen und anpassen
grep SIMILARITY /opt/MemoryX/.env
sed -i 's/SIMILARITY_THRESHOLD=0.75/SIMILARITY_THRESHOLD=0.35/' /opt/MemoryX/.env

# WICHTIG: "docker compose up -d" statt "restart" — restart liest .env NICHT neu ein!
docker compose up -d memory-service
```

### Das Admin-Passwort funktioniert nicht

Das Admin-Passwort wird als Bcrypt-Hash in der `.env` gespeichert. Vorgehen:

```bash
# Neuen Hash generieren
docker run --rm caddy:2-alpine caddy hash-password --plaintext 'MeinPasswort'
# Ausgabe z.B.: $2a$14$...

# In .env eintragen (mit einfachen Anführungszeichen — wichtig für Sonderzeichen!)
ADMIN_PASSWORD_HASH='$2a$14$...'

# Stack neu starten
docker compose restart caddy
```

> **Wichtig:** Einfache Anführungszeichen `'...'` in der `.env` verwenden.
> Doppelte Anführungszeichen können `$`-Zeichen im Hash falsch interpretieren.

### Der Nutzer möchte mehrere Projekte verbinden

Für jedes Projekt:
- Eigener Namespace: `project:<name>`
- Eigener API-Key (aus Sicherheitsgründen getrennt)
- Eigene `.mcp.json` im jeweiligen Projektordner

Der Namespace `global` wird in allen Projekten geteilt — globales Wissen ist überall verfügbar.

### Der Nutzer möchte das Memory auch in der Desktop App nutzen

Zeige folgende Konfiguration:

```json
// macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
// Windows: %APPDATA%\Claude\claude_desktop_config.json
// Linux:   ~/.config/Claude/claude_desktop_config.json
{
  "mcpServers": {
    "memory-desktop": {
      "url": "https://memory.local/mcp",
      "apiKey": "<DESKTOP_API_KEY>",
      "namespace": "desktop",
      "sharedNamespaces": ["global"],
      "autoRecall": true,
      "autoStore": true
    }
  }
}
```

### Der Nutzer möchte das Memory auch in der CLI nutzen

```json
// ~/.claude/config.json (oder claude settings --add-mcp)
{
  "mcpServers": {
    "memory-cli": {
      "url": "https://memory.local/mcp",
      "apiKey": "<CLI_API_KEY>",
      "namespace": "cli",
      "sharedNamespaces": ["global"],
      "autoRecall": true,
      "autoStore": true
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
Bei lokalen Änderungen zuerst stashen:

```bash
git stash && ./scripts/update.sh
```

---

## Admin-Dashboard — Seiten-Übersicht

Das Dashboard ist erreichbar unter `https://memory.local/admin/` (mit Trailing-Slash).

| Seite | URL | Inhalt |
| ----- | --- | ------ |
| Übersicht | `/admin/` | Statistiken, Systemstatus, Quick-Actions |
| API-Keys | `/admin/keys.html` | Keys erstellen, anzeigen, löschen |
| Episoden | `/admin/episodes.html` | Memory-Einträge durchsuchen und löschen |
| Regeln | `/admin/rules.html` | Destillierte Regeln verwalten |
| Health | `/admin/health.html` | Detaillierter Systemstatus aller Services |
| System | `/admin/system.html` | Logs, Backup, GC, Destillierung |

> Hinweis: Die URL muss mit `/admin/` (Trailing-Slash) aufgerufen werden.
> `/admin` ohne Slash kann zu leeren Seiten führen.

---

## Deaktivierung und Deinstallation

### Nur für ein Projekt deaktivieren (MCP-Verbindung trennen)

Entferne den `memory`-Eintrag aus der `.mcp.json` im Projektordner:

```json
// Vorher:
{
  "mcpServers": {
    "memory": { ... }
  }
}

// Nachher (Eintrag entfernt):
{
  "mcpServers": {}
}
```

Alternativ: die gesamte `.mcp.json` löschen, falls keine anderen MCP-Server konfiguriert sind.

Danach VS Code neu laden (`Ctrl+Shift+P → "Reload Window"`).

Die gespeicherten Episoden und Regeln bleiben auf dem Server erhalten.

---

### API-Key für ein Projekt deaktivieren

```text
1. Öffne https://memory.local/admin/keys.html
2. Klicke auf den Key, der deaktiviert werden soll
3. Klicke "Löschen" — der Key ist sofort ungültig
```

Alle MCP-Verbindungen, die diesen Key verwenden, schlagen danach fehl.

---

### Memory-Daten eines Projekts löschen (Namespace bereinigen)

```bash
# Alle Episoden eines Namespace löschen
curl -sk -X DELETE "https://memory.local/api/episodes?namespace=project:meinprojekt" \
  -H "X-Admin-Key: <ADMIN_API_KEY>"

# Alle Regeln eines Namespace löschen
curl -sk -X DELETE "https://memory.local/api/rules?namespace=project:meinprojekt" \
  -H "X-Admin-Key: <ADMIN_API_KEY>"
```

Alternativ über das Admin-Dashboard unter `/admin/episodes.html` und `/admin/rules.html`
mit dem Namespace-Filter und der Löschen-Funktion.

---

### Vollständige Deinstallation des Servers

```bash
# 1. Stack stoppen und Container entfernen
cd /opt/MemoryX
docker compose down

# 2. Alle Daten und Volumes löschen (UNWIDERRUFLICH)
docker compose down -v

# 3. Docker-Images entfernen (optional, gibt Speicher frei)
docker rmi $(docker images | grep memory | awk '{print $3}')

# 4. Projektverzeichnis löschen
rm -rf /opt/MemoryX

# 5. Hosts-Eintrag entfernen (Linux/macOS)
sudo sed -i '/memory.local/d' /etc/hosts
```

> **Warnung:** `docker compose down -v` löscht alle gespeicherten Episoden, Regeln
> und API-Keys unwiderruflich. Vorher ein Backup erstellen:

```bash
./scripts/backup.sh /tmp/memoryx-final-backup
```

---

## MCP-Tool Referenz (für dich als Claude)

Sobald die Integration aktiv ist, stehen dir diese Tools zur Verfügung:

### `memory:recall`
```json
{
  "task_description": "Beschreibung der aktuellen Aufgabe",
  "namespace": "project:meinprojekt",
  "shared_namespaces": ["global"]
}
```
Gibt zurück: `context` (formatierter Text), `episodeCount`, `ruleCount`, `tokenEstimate`

### `memory:store`
```json
{
  "namespace": "project:meinprojekt",
  "experience": {
    "task_category": "bug-fix | feature | refactor | architecture | session-summary | setup",
    "outcome": "success | failure | partial",
    "context_summary": "Was war die Aufgabe und der Kontext (max. 300 Zeichen)",
    "learnings": "Was wurde gelernt, was war die Lösung (max. 500 Zeichen)"
  }
}
```

### `memory:feedback`
```json
{
  "episode_id": "<id-aus-recall>",
  "success": true
}
```

---

## Qualitätskriterien — Was eine gute Episode ausmacht

| Kriterium | Gut | Schlecht |
|-----------|-----|----------|
| `task_category` | Konkret: `"auth-bug-jwt"` | Zu allgemein: `"bug"` |
| `context_summary` | Enthält das Problem: `"JWT-Token wurde nach 1h ungültig obwohl 24h gesetzt"` | Zu vage: `"Auth-Problem"` |
| `learnings` | Enthält die Lösung: `"CLOCK_SKEW Umgebungsvariable auf 60 gesetzt"` | Zu vage: `"Einstellung geändert"` |
| `outcome` | Korrekt gesetzt: `failure` wenn der Ansatz fehlschlug | Immer `success` auch bei Fehlern |

---

*MemoryX · AI-Installationsanleitung · v1.3 · 2026-03-12*
*Quelle: https://github.com/toasti1973/MemoryX*
