# 🧠 Claude Memory System

> Persistentes, bereichsübergreifendes Gedächtnis für Claude — Docker-Stack auf Proxmox mit lokalem Embedding, MCP-Integration und Web-Admin-UI.

[![Docker](https://img.shields.io/badge/Docker-Compose-0DB7ED?logo=docker)](https://docs.docker.com/compose/)
[![Ollama](https://img.shields.io/badge/Ollama-nomic--embed--text-006064)](https://ollama.com)
[![MCP](https://img.shields.io/badge/MCP-Claude%20Code-1565C0)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/Lizenz-MIT-green)](LICENSE)

---

## Inhaltsverzeichnis

1. [Überblick](#1-überblick)
2. [Gesamt-Architektur](#2-gesamt-architektur)
3. [Dienste im Detail](#3-dienste-im-detail)
4. [Client-Konfiguration](#4-client-konfiguration)
5. [Konfiguration (.env)](#5-konfiguration-env)
6. [Implementierungsplan](#6-implementierungsplan)
7. [Admin-UI & Monitoring](#7-admin-ui--monitoring)
8. [Sicherheit](#8-sicherheit)
9. [Ressourcen & Kosten](#9-ressourcen--kosten)
10. [Installations-Checkliste](#10-installations-checkliste)

---

## 1. Überblick

Das Memory System läuft als vollständig containerisierter Docker-Stack auf einem Proxmox-Server im lokalen Netzwerk. Alle Claude-Instanzen (VS Code, Desktop App, CLI) verbinden sich über dasselbe MCP-Interface und teilen einen gemeinsamen Gedächtnispool.

### Was dieses System leistet

- **Persistentes Gedächtnis** — Erfahrungen überleben Sitzungen, Reboots und Neustarts
- **Bereichsübergreifend** — VS Code, Desktop App und CLI teilen denselben Wissenspool
- **Lokales Embedding via Ollama** — keine API-Kosten, keine Cloud-Abhängigkeit, volle Datenkontrolle
- **Web-Admin-UI** — API-Key-Verwaltung, Live-Monitoring und Log-Viewer direkt im Browser
- **Business-OS-Integration** — optionaler Adapter für Nextcloud, ERPNext, Gitea, Outline u.a.
- **DSGVO-konform** — alle Daten bleiben im lokalen Netz, keine externen Dienste notwendig

### Drei Gedächtnisschichten (L1/L2/L3)

| Schicht | Name | Technologie | Zweck |
|---------|------|-------------|-------|
| L1 | Episodisches Gedächtnis | SQLite | Komprimierte Erfahrungseinträge (max. 200 Tokens) |
| L2 | Semantisches Gedächtnis | sqlite-vec | Vektoren für semantische Ähnlichkeitssuche |
| L3 | Prozedurales Gedächtnis | SQLite Key-Value | Destillierte Regeln aus wiederkehrenden Mustern |

---

## 2. Gesamt-Architektur

### Docker-Stack Übersicht

```
┌─────────────────────────────────────────────────────────────────┐
│  LOKALES NETZ — VS Code · Desktop App · Browser · Business-OS   │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS :443
┌──────────────────────────▼──────────────────────────────────────┐
│  CADDY  (Reverse Proxy + TLS)                                   │
│  /mcp → memory-service   /admin → admin-ui   /api → admin-api   │
└──────┬───────────┬───────────────┬───────────────┬──────────────┘
       │           │               │               │
  [memory-   [ollama]        [admin-api]      [admin-ui]
   service]   :11434          :3459            :8080
   :3457     Embedding       REST-Backend     Web-Dashboard

  [scheduler]               [memory-adapter]
  GC·Backup·Destillierung   Business-OS Bridge (optional)

┌─────────────────────────────────────────────────────────────────┐
│  DOCKER VOLUMES (persistent)                                     │
│  memory-data · ollama-models · caddy-certs · admin-data         │
└─────────────────────────────────────────────────────────────────┘
```

### Verzeichnis-Struktur

```
/opt/memory-system/
├── docker-compose.yml          # Haupt-Stack
├── .env                        # Secrets & Konfiguration (nicht im Git!)
├── config/
│   ├── caddy/Caddyfile         # Routing + TLS
│   ├── memory-service/         # Namespaces, Token-Limits
│   └── scheduler/              # Cron-Zeitpläne
├── admin-ui/
│   ├── index.html              # Dashboard
│   ├── keys.html               # API-Key-Verwaltung
│   ├── episodes.html           # Episoden-Browser
│   ├── rules.html              # Regelmanagement (L3)
│   ├── logs.html               # Live-Log-Viewer
│   └── system.html             # System-Aktionen
├── scripts/
│   ├── setup.sh                # Ersteinrichtung + Ollama-Modell-Pull
│   ├── backup.sh               # Manuelles Backup
│   └── healthcheck.sh          # Status aller Dienste
└── data/                       # Von Docker gemountet (memory.db)
```

---

## 3. Dienste im Detail

### memory-service — MCP-Kern

| Endpunkt | Methode | Funktion | Token-Budget |
|----------|---------|----------|--------------|
| `/mcp/recall` | POST | Sucht L3→L2→L1, gibt formatierten Kontext zurück | max. 450 Tokens |
| `/mcp/store` | POST | Speichert Episode, triggert Embedding bei Ollama | — |
| `/mcp/feedback` | POST | Aktualisiert Quality-Score eines Eintrags | — |
| `/health` | GET | Status aller internen Abhängigkeiten | — |

- **Image:** `node:20-alpine` · **Port:** `3457` (intern) · **Restart:** `always` · **RAM:** 512 MB

### ollama — Lokales Embedding

```
Modell:  nomic-embed-text  (768 Dimensionen, ~300 MB)
Port:    11434  (nur intern, kein LAN-Zugriff)
Latenz:  ~150 ms/Embedding auf Standard-Server-CPU
Volume:  ollama-models  (persistiert, kein Re-Download nach Neustart)
```

> **Hinweis:** Beim ersten `docker compose up` wird das Modell automatisch via `setup.sh` gepullt (1–5 Minuten).

### admin-api — REST-Backend

| Gruppe | Endpunkte | Funktion |
|--------|-----------|----------|
| API-Keys | `GET/POST/DELETE /api/keys` | Schlüssel auflisten, erstellen, widerrufen |
| Statistiken | `GET /api/stats` | Hit-Rate, Episoden, Regeln, DB-Größe |
| Gesundheit | `GET /api/health` | Status aller Docker-Services |
| Episoden | `GET/DELETE /api/episodes` | Episoden suchen und löschen |
| Regeln | `GET/POST/DELETE /api/rules` | L3-Regeln verwalten |
| Logs | `GET /api/logs` | Log-Streaming aus Containern |
| Backup | `POST /api/backup` | Manuelles Backup anstoßen |
| System | `POST /api/gc` `/api/distill` | GC und Destillierung auslösen |

### admin-ui — Web-Dashboard

Statische HTML/CSS/JS-Dateien ohne Build-Pipeline. Caddy liefert sie direkt aus.

| Seite | URL | Inhalt |
|-------|-----|--------|
| Dashboard | `/admin/` | KPI-Karten, Service-Ampeln, Aktivitätsgraph (Auto-Refresh 30s) |
| API-Keys | `/admin/keys` | Keys erstellen, kopieren, widerrufen |
| Episoden | `/admin/episodes` | Suchen und löschen |
| Regeln | `/admin/rules` | L3-Regeln prüfen, bestätigen, verwerfen |
| Logs | `/admin/logs` | Live-Log-Viewer mit Fehler-Hervorhebung |
| System | `/admin/system` | RAM/CPU/DB-Größe, Backup, GC, Restart |

### scheduler — Hintergrundjobs

| Job | Zeitplan | Aktion |
|-----|----------|--------|
| Garbage Collection | Täglich 02:00 | Veraltete/schwache Episoden löschen |
| Destillierung | Täglich 02:30 | L3-Regeln aus ≥3 ähnlichen Episoden erzeugen |
| DB-Backup | Täglich 03:00 | SQLite VACUUM + Kopie ins Backup-Volume |
| Score-Decay | Täglich 04:00 | Zeitlichen Abwertungsfaktor anwenden |
| Health-Report | Stündlich | Status-Log in admin-api schreiben |

### caddy — Reverse Proxy

```caddy
memory.local {
  handle /mcp* {
    reverse_proxy memory-service:3457
    # Auth: X-API-Key Header, validiert vom memory-service
  }
  handle /admin* {
    basicauth { {env.ADMIN_USER} {env.ADMIN_PASSWORD_HASH} }
    reverse_proxy admin-ui:8080
  }
  handle /api* {
    reverse_proxy admin-api:3459
  }
  tls internal   # Automatisches HTTPS mit lokaler CA
}
```

---

## 4. Client-Konfiguration

### Claude Code in VS Code

**Global** — `settings.json`:
```json
{
  "claude.mcpServers": {
    "memory-global": {
      "url": "https://memory.local/mcp",
      "apiKey": "mc-global-xxxxxxxxxxxx",
      "namespace": "global",
      "autoRecall": true,
      "autoStore": true
    }
  }
}
```

**Projektspezifisch** — `.mcp.json` im Projektordner:
```json
{
  "mcpServers": {
    "memory-project": {
      "url": "https://memory.local/mcp",
      "apiKey": "mc-proj-meinprojekt-xxxx",
      "namespace": "project:meinprojekt",
      "autoRecall": true,
      "autoStore": true
    }
  }
}
```

**`CLAUDE.md`** im Projektordner:
```markdown
## Memory-Anweisungen

Zu Beginn jeder Sitzung: memory-project:recall('aktueller Kontext') aufrufen.
Am Ende jeder Sitzung: erledigte Aufgaben, Erkenntnisse und offene Punkte speichern.
Format: { task_category, outcome, context_summary, learnings }
```

### Claude Desktop App

```json
// macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
// Windows: %APPDATA%\Claude\claude_desktop_config.json
{
  "mcpServers": {
    "memory-desktop": {
      "url": "https://memory.local/mcp",
      "apiKey": "mc-desktop-xxxxxxxxxxxx",
      "namespace": "desktop",
      "sharedNamespaces": ["global"],
      "autoRecall": true
    }
  }
}
```

### Claude Code CLI

```json
// ~/.claude/config.json
{
  "mcpServers": {
    "memory-cli": {
      "url": "https://memory.local/mcp",
      "apiKey": "mc-cli-xxxxxxxxxxxx",
      "namespace": "cli",
      "sharedNamespaces": ["global"],
      "autoRecall": true,
      "autoStore": true
    }
  }
}
```

### TLS-Zertifikat importieren (einmalig pro Client)

```bash
# Caddy Root-CA exportieren
docker exec caddy caddy trust

# macOS
# Doppelklick auf .crt → Schlüsselbund → Als vertrauenswürdig markieren

# Windows
# certmgr.msc → Vertrauenswürdige Stammzertifizierungsstellen → Importieren

# Linux
sudo cp ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

### Remote-Zugriff (Homeoffice)

WireGuard VPN auf dem Proxmox-Host — Clients verwenden **identische Konfiguration** wie im LAN:

```
Laptop (extern) → WireGuard :51820 → 192.168.1.50 → memory.local → Memory-Service
```

---

## 5. Konfiguration (.env)

```env
# ── Server ────────────────────────────────────────────────────────
MEMORY_HOST=memory.local
MEMORY_PORT=443

# ── Admin-UI Auth ─────────────────────────────────────────────────
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=           # bcrypt-Hash via: caddy hash-password

# ── Memory-Service ────────────────────────────────────────────────
MAX_RECALL_TOKENS=450
SIMILARITY_THRESHOLD=0.75
MAX_RESULTS_L2=3
MAX_RULES_L3=5

# ── Embedding ─────────────────────────────────────────────────────
OLLAMA_MODEL=nomic-embed-text
OLLAMA_URL=http://ollama:11434

# ── Scheduler ─────────────────────────────────────────────────────
GC_SCHEDULE=0 2 * * *
DISTILL_SCHEDULE=30 2 * * *
BACKUP_SCHEDULE=0 3 * * *
DECAY_SCHEDULE=0 4 * * *
RULE_MIN_EPISODES=3
DECAY_FACTOR=0.002
MAX_DB_SIZE_MB=500

# ── Business-OS Adapter (optional) ───────────────────────────────
ADAPTER_SOURCE=nextcloud
ADAPTER_API_URL=https://nextcloud.local
ADAPTER_API_KEY=
ADAPTER_SYNC_SCHEDULE=0 */6 * * *
ADAPTER_NAMESPACES=business:projects,business:docs
ADAPTER_MAX_AGE_DAYS=90

# ── Resource Limits ───────────────────────────────────────────────
MEM_LIMIT_SERVICE=512m
MEM_LIMIT_OLLAMA=2g
MEM_LIMIT_ADMIN=256m
CPU_LIMIT_SERVICE=1.0
CPU_LIMIT_OLLAMA=2.0
```

> ⚠️ `.env` niemals ins Git committen — enthält Admin-Passwort und API-Keys.

---

## 6. Implementierungsplan

| Phase | Dauer | Ziel | Abnahmekriterium |
|-------|-------|------|-----------------|
| Phase 0 | 2–4 Std. | Proxmox LXC/VM + Docker | `docker compose version` läuft |
| Phase 1 | 1 Tag | Core-Stack (Service + Ollama + Caddy) | `GET /health` → `{status: ok}` |
| Phase 2 | 1 Tag | Admin-API + Web-Dashboard | Dashboard zeigt grüne Ampeln |
| Phase 3 | 0,5 Tage | Scheduler + erstes Backup | Backup-Datei im Volume vorhanden |
| Phase 4 | 0,5 Tage | VS Code / Claude Code | Recall liefert Kontext in neuer Sitzung |
| Phase 5 | 0,5 Tage | Desktop App + CLI | Alle drei Clients in Admin-Logs sichtbar |
| Phase 6 | 0,5 Tage | WireGuard VPN (optional) | Remote-Zugriff funktioniert |
| Phase 7 | 2–4 Tage | Business-OS Adapter | Episoden aus Business-OS in Admin-UI |
| Phase 8 | 1 Woche | Tuning & Validierung | Hit-Rate ≥ 60% |

### Proxmox Hardware

| Ressource | Minimum | Empfohlen |
|-----------|---------|-----------|
| CPU | 4 Kerne | 6–8 Kerne |
| RAM | 8 GB | 16 GB |
| Storage (SSD) | 60 GB | 120 GB |

**LXC-Einstellungen:** `nesting=1`, `keyctl=1` (notwendig für Docker-in-LXC)

### DNS-Auflösung für `memory.local`

| Option | Aufwand | Vorgehen |
|--------|---------|----------|
| `/etc/hosts` | Sehr gering | `192.168.1.50  memory.local` auf jedem Client |
| Router-DNS | Gering | Lokalen DNS-Eintrag im Router anlegen |
| Pi-hole / Unbound | Mittel | Eigener DNS-Server als LXC |

---

## 7. Admin-UI & Monitoring

### Monitoring-Metriken

| Metrik | Zielwert | Alarm wenn |
|--------|----------|------------|
| Hit-Rate | ≥ 60% | < 40% |
| Recall-Latenz | < 100 ms | > 300 ms |
| DB-Größe | < 80% des Limits | > 90% |
| Embedding-Latenz | < 500 ms | > 2 Sek. |
| GC-Erfolg | Täglich OK | Fehler |
| Backup-Status | Täglich OK | Fehler |

### API-Key-Attribute

| Attribut | Beschreibung |
|----------|-------------|
| Name | z. B. `vscode-laptop`, `desktop-app`, `business-os-adapter` |
| Scope | `recall-only` \| `store-only` \| `recall+store` \| `admin` |
| Namespace-Filter | Welche Namespaces darf dieser Key lesen/schreiben |
| Rate-Limit | Max. Anfragen pro Minute |
| Ablaufdatum | Optional — für temporäre Agenten |
| Letzte Nutzung | Inaktive Keys erkennbar |

---

## 8. Sicherheit

| Bedrohung | Schutzmaßnahme |
|-----------|----------------|
| Unbefugter MCP-Zugriff | API-Key im `X-API-Key` Header; ohne Key: 401 |
| Unbefugter Admin-Zugriff | HTTP Basic Auth via Caddy, bcrypt-Hash |
| Datenübertragung | TLS auf allen Verbindungen (Caddy internal CA) |
| Sensible Daten in Episoden | Pre-Store-Filter: Regex-Blacklist für Passwörter, Keys, PII |
| Internet-Exposition | Keine Port-Weiterleitung — nur LAN erreichbar |
| Backup-Exposition | Backup-Volume nur intern mountbar |

---

## 9. Ressourcen & Kosten

| Komponente | Kosten |
|------------|--------|
| Proxmox VE | Kostenlos (Community Edition) |
| Docker + Docker Compose | Kostenlos |
| Ollama + nomic-embed-text | Kostenlos |
| Caddy | Kostenlos |
| Externe Embedding-API | **0 €** — nur lokales Ollama |
| Betriebskosten (Strom) | ca. 5–15 €/Monat |

---

## 10. Installations-Checkliste

### Phase 0 — Proxmox & Docker
- [ ] LXC oder VM erstellen (Ubuntu 22.04, 4 GB RAM, 40 GB SSD)
- [ ] Bei LXC: `nesting=1` und `keyctl=1` aktivieren
- [ ] Docker + Docker Compose installieren
- [ ] Feste IP vergeben (`192.168.1.50`)
- [ ] `memory.local` in `/etc/hosts` oder Router-DNS eintragen
- [ ] `/opt/memory-system` anlegen

### Phase 1 — Core-Stack
- [ ] `.env` erstellen und befüllen
- [ ] `docker-compose.yml` erstellen
- [ ] `setup.sh` ausführen (Ollama-Modell-Pull)
- [ ] `docker compose up -d`
- [ ] Caddy Root-CA auf Clients importieren
- [ ] `https://memory.local/health` → `{status: ok}` prüfen

### Phase 2 — Admin-UI
- [ ] `https://memory.local/admin/` öffnen und anmelden
- [ ] API-Key `vscode-global` erstellen (Scope: `recall+store`)
- [ ] API-Key `desktop-app` erstellen
- [ ] Alle Service-Ampeln grün
- [ ] Manuellen Backup-Test durchführen

### Phase 3 — VS Code
- [ ] `settings.json` mit globalem MCP-Eintrag befüllen
- [ ] `.mcp.json` im ersten Projekt anlegen
- [ ] `CLAUDE.md` anlegen
- [ ] Neue Sitzung: Recall testen
- [ ] Episode in Admin-UI `/admin/episodes` sichtbar

### Phase 4 — Desktop App & CLI
- [ ] `claude_desktop_config.json` befüllen, App neu starten
- [ ] `~/.claude/config.json` für CLI befüllen
- [ ] Alle drei Clients in Admin-UI Logs sichtbar

### Phase 5 — Business-OS (optional)
- [ ] `ADAPTER_SOURCE` und `ADAPTER_API_URL` in `.env` setzen
- [ ] `ADAPTER_FILTER_FIELDS` für Datenschutz definieren
- [ ] `docker compose --profile business-os up -d`
- [ ] DSGVO-Check: keine personenbezogenen Daten in Episoden

---

## Lizenz

MIT — Planungsdokument, anpassbar für eigene Infrastruktur.

---

*Claude Memory System · v1.0 · 2026*
