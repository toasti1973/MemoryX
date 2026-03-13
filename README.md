# MemoryX — Persistent AI Memory for Claude

> A fully containerized Docker stack that gives every Claude instance persistent, cross-session memory — powered by memcp (MAGMA graph engine), local embeddings via Ollama, MCP protocol integration, and a modern dark web-based admin UI.

[![Docker](https://img.shields.io/badge/Docker-Compose-0DB7ED?logo=docker)](https://docs.docker.com/compose/)
[![Ollama](https://img.shields.io/badge/Ollama-nomic--embed--text-006064)](https://ollama.com)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-1565C0)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-GPLv3-blue)](LICENSE)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Services](#3-services)
4. [Client Configuration](#4-client-configuration)
5. [Configuration (.env)](#5-configuration-env)
6. [Deployment Plan](#6-deployment-plan)
7. [Admin UI & Monitoring](#7-admin-ui--monitoring)
8. [Security](#8-security)
9. [Resources & Cost](#9-resources--cost)
10. [Installation Checklist](#10-installation-checklist)

---

## 1. Overview

MemoryX runs as a fully containerized Docker stack on a Proxmox server in your local network. All Claude instances — VS Code, Desktop App, CLI — connect via a shared MCP interface and draw from the same memory pool.

### What it does

- **Persistent memory** — experiences survive sessions, reboots, and restarts
- **Cross-client** — VS Code, Desktop App, and CLI share one knowledge pool
- **MAGMA Graph Engine** — 4-graph architecture (semantic/temporal/causal/entity edges) with 5-tier search
- **Local embeddings via Ollama** — no API costs, no cloud dependency, full data control
- **Native MCP Protocol** — JSON-RPC 2.0 over Streamable HTTP via FastMCP
- **Web Admin UI** — API key management, live monitoring, and log viewer in the browser
- **Business-OS integration** — optional adapter for Nextcloud, Gitea, ERPNext, Outline, and more
- **Privacy-first** — all data stays on your local network, no external services required

### Memory Architecture

| Component | Technology | Purpose |
| --------- | ---------- | ------- |
| Nodes | SQLite (graph.db) | Knowledge entries with importance, category, project, tags |
| Edges | SQLite (graph.db) | Semantic, temporal, causal, and entity relationships |
| Entity Index | SQLite (graph.db) | Fast entity lookup across the graph |
| Embeddings | Ollama (nomic-embed-text) | 768-dim vectors for semantic similarity search |
| Rules | SQLite (admin.db) | Distilled rules from recurring patterns |

---

## 2. Architecture

### Docker Stack Overview

```text
+-------------------------------------------------------------------+
|  LOCAL NETWORK -- VS Code / Desktop App / Browser / Business-OS    |
+------------------------------+------------------------------------+
                               | HTTPS :443
+------------------------------v------------------------------------+
|  CADDY  (Reverse Proxy + TLS + Basic Auth)                        |
|  /mcp -> auth-proxy -> memcp   /admin -> admin-ui  /api -> admin  |
+------+----------+---------------+----------------+----------------+
       |          |               |                |
  [auth-proxy] [memcp]     [admin-api]       [admin-ui]
   :4000       :3457        :3459             :8080
   API-Key     MCP Server   REST Backend      Web Dashboard
   Validation  MAGMA Graph

  [ollama]     [scheduler]                [memory-adapter]
  :11434       GC / Backup / Distill      Business-OS Bridge (opt.)
  Embedding

+-------------------------------------------------------------------+
|  DOCKER VOLUMES (persistent)                                       |
|  memcp-data / ollama-models / caddy-certs / admin-data / backup   |
+-------------------------------------------------------------------+
```

### Directory Structure

```text
/opt/MemoryX/
|-- docker-compose.yml          # Main stack definition
|-- .env                        # Secrets & configuration (never commit!)
|-- memcp-engine/               # Python MCP server (FastMCP + MAGMA)
|-- auth-proxy/                 # FastAPI reverse proxy (API-Key auth, rate-limiting)
|-- admin-api/                  # Node.js REST backend for admin UI
|-- admin-ui/                   # Static HTML/CSS/JS dashboard
|   |-- index.html              # Dashboard (KPIs, status)
|   |-- keys.html               # API key management
|   |-- episodes.html           # Insight browser
|   |-- rules.html              # Rule management
|   |-- logs.html               # Live log viewer
|   |-- health.html             # Dedicated health status page
|   +-- system.html             # System actions (backup, GC)
|-- scheduler/                  # Node.js cron jobs
|-- memory-adapter/             # Business-OS bridge (optional)
|-- config/
|   |-- caddy/Caddyfile         # Routing + TLS + Basic Auth
|   +-- clients/                # Config templates for all clients
|-- scripts/
|   |-- setup.sh                # First-time setup + Ollama model pull
|   |-- update.sh               # git pull + smart Docker rebuild
|   |-- backup.sh               # Manual database backup
|   |-- healthcheck.sh          # Status check for all services
|   +-- test-mcp.sh             # Full MCP tool test (all 24 tools)
+-- data/                       # Mounted by Docker (graph.db, admin.db)
```

---

## 3. Services

### memcp — MCP Core (Python/FastMCP)

The MCP server implements the full Model Context Protocol via JSON-RPC 2.0 over Streamable HTTP. It provides 24 tools:

| Category | Tools |
| -------- | ----- |
| Core | `memcp_ping`, `memcp_remember`, `memcp_recall`, `memcp_forget`, `memcp_status` |
| Context | `memcp_load_context`, `memcp_inspect_context`, `memcp_get_context`, `memcp_chunk_context`, `memcp_peek_chunk`, `memcp_filter_context`, `memcp_list_contexts`, `memcp_clear_context` |
| Search | `memcp_search`, `memcp_related` |
| Graph | `memcp_graph_stats`, `memcp_projects`, `memcp_sessions` |
| Maintenance | `memcp_retention_preview`, `memcp_retention_run`, `memcp_restore`, `memcp_reinforce`, `memcp_consolidation_preview`, `memcp_consolidate` |

**Image:** Python 3.12 | **Port:** `3457` (internal) | **Transport:** Streamable HTTP | **Backend:** SQLite (graph.db)

### auth-proxy — API Key Validation (Python/FastAPI)

Validates `X-API-Key` headers against admin.db, enforces per-key rate limits, extracts MCP method names for readable logs, and logs all access to auth_log.db.

**Image:** Python 3.12 | **Port:** `4000` (internal)

### ollama — Local Embeddings

```text
Model:    nomic-embed-text  (768 dimensions, ~300 MB)
Port:     11434  (internal only, no LAN access)
Volume:   ollama-models  (persisted — no re-download after restart)
```

### admin-api — REST Backend

| Group | Endpoints | Function |
| ----- | --------- | -------- |
| API Keys | `GET/POST/DELETE /api/keys` | List, create, revoke keys |
| Statistics | `GET /api/stats` | Insight count, edge count, rule count, DB size |
| Health | `GET /api/health` | Status of memcp, ollama, admin-api |
| Insights | `GET/DELETE /api/insights` | Search and delete insights (nodes) |
| Rules | `GET/POST/DELETE /api/rules` | Manage distilled rules |
| Logs | `GET /api/logs` | Access log viewer |
| Backup | `POST /api/backup` | Trigger a manual backup |
| System | `POST /api/gc` `/api/distill` | Trigger GC and distillation manually |

### admin-ui — Web Dashboard

Static HTML/CSS/JS files — no build pipeline. Served by Caddy under `/admin/`.

| Page | URL | Content |
| ---- | --- | ------- |
| Dashboard | `/admin/` | KPI cards, service status, activity log (auto-refresh 30s) |
| API Keys | `/admin/keys.html` | Create, copy, revoke keys |
| Insights | `/admin/episodes.html` | Search and delete insights |
| Rules | `/admin/rules.html` | Review, confirm, or discard rules |
| Logs | `/admin/logs.html` | Live log viewer with error highlighting |
| Health | `/admin/health.html` | Dedicated health status page |
| System | `/admin/system.html` | DB size, backup, GC, restart |

### scheduler — Background Jobs

| Job | Schedule | Action |
| --- | -------- | ------ |
| Garbage Collection | Daily 02:00 | Delete low-importance nodes + orphaned edges |
| Distillation | Daily 02:30 | Generate rules from recurring node patterns |
| DB Backup | Daily 03:00 | SQLite VACUUM + copy to backup volume |
| Importance Decay | Daily 04:00 | Apply time-based importance decay to all nodes |
| Health Report | Hourly | Write status log to stdout |

### caddy — Reverse Proxy + Auth

Routes `/mcp/*` through auth-proxy to memcp, serves admin-ui under `/admin/`, and proxies `/api/*` to admin-api. Unified HTTP Basic Auth for `/admin/*` and `/api/*`. Automatic HTTPS with internal CA.

---

## 4. Client Configuration

### Claude Code in VS Code

**Global** — `settings.json`:

```json
{
  "claude.mcpServers": {
    "memory": {
      "type": "http",
      "url": "https://memory.local/mcp/",
      "headers": {
        "X-API-Key": "YOUR_API_KEY_HERE"
      }
    }
  }
}
```

**Project-specific** — `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "https://memory.local/mcp/",
      "headers": {
        "X-API-Key": "YOUR_PROJECT_API_KEY"
      }
    }
  }
}
```

**`CLAUDE.md`** in the project root — see `config/clients/CLAUDE.md` for a template with memcp tool instructions.

### Claude Desktop App

```json
{
  "mcpServers": {
    "memory": {
      "type": "http",
      "url": "https://memory.local/mcp/",
      "headers": {
        "X-API-Key": "YOUR_DESKTOP_API_KEY"
      }
    }
  }
}
```

Config file locations:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

### Importing the TLS Certificate (once per client)

```bash
# Export Caddy Root CA
docker cp memory-caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root-ca.crt

# macOS — Double-click the .crt file -> Keychain -> Mark as trusted

# Windows — certmgr.msc -> Trusted Root Certification Authorities -> Import

# Linux
sudo cp caddy-root-ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

### Remote Access (Home Office)

WireGuard VPN on the Proxmox host — clients use the **same configuration** as on the LAN:

```text
Laptop (remote) -> WireGuard :51820 -> 192.168.x.x -> memory.local -> memcp
```

---

## 5. Configuration (.env)

```env
# -- Server ---------------------------------------------------------
MEMORY_HOST=memory.local

# -- Admin UI Auth --------------------------------------------------
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=           # bcrypt hash via: caddy hash-password

# -- Internal Security ----------------------------------------------
ADMIN_API_KEY=                 # generate: openssl rand -hex 32

# -- memcp ----------------------------------------------------------
MEMCP_BACKEND=graph            # always use SQLite graph backend
MEMCP_EMBEDDING_PROVIDER=ollama
MEMCP_SEARCH=hybrid
MEMCP_MAX_INSIGHTS=10000

# -- Embedding ------------------------------------------------------
OLLAMA_MODEL=nomic-embed-text
OLLAMA_URL=http://ollama:11434

# -- Scheduler ------------------------------------------------------
GC_SCHEDULE=0 2 * * *
DISTILL_SCHEDULE=30 2 * * *
BACKUP_SCHEDULE=0 3 * * *
DECAY_SCHEDULE=0 4 * * *

# -- Business-OS Adapter (optional) ---------------------------------
ADAPTER_MEMORY_API_KEY=        # MCP API key for adapter
ADAPTER_SOURCE=nextcloud
ADAPTER_API_URL=https://nextcloud.local
ADAPTER_API_KEY=

# -- Resource Limits ------------------------------------------------
MEM_LIMIT_SERVICE=512m
MEM_LIMIT_OLLAMA=2g
CPU_LIMIT_SERVICE=1.0
CPU_LIMIT_OLLAMA=2.0
```

> Never commit `.env` to Git — it contains your admin password and API keys.

---

## 6. Deployment Plan

| Phase | Goal | Acceptance Criterion |
| ----- | ---- | -------------------- |
| Phase 0 | Proxmox LXC/VM + Docker | `docker compose version` runs |
| Phase 1 | Core stack (memcp + Ollama + Caddy + auth-proxy) | `GET /health` -> `{status: ok}` |
| Phase 2 | Admin API + Web Dashboard | Dashboard shows green status lights |
| Phase 3 | Scheduler + first backup | Backup file present in volume |
| Phase 4 | VS Code / Claude Code | Recall returns context in a new session |
| Phase 5 | Desktop App + CLI | All clients visible in admin logs |
| Phase 6 | WireGuard VPN (optional) | Remote access works |
| Phase 7 | Business-OS Adapter | Business insights visible in admin UI |
| Phase 8 | Tuning & validation | `./scripts/test-mcp.sh` — all 24 tools pass |

### Proxmox Hardware

| Resource | Minimum | Recommended |
| -------- | ------- | ----------- |
| CPU | 4 cores | 6-8 cores |
| RAM | 8 GB | 16 GB |
| Storage (SSD) | 60 GB | 120 GB |

**LXC settings required:** `nesting=1`, `keyctl=1` (needed for Docker-in-LXC)

### DNS Resolution for `memory.local`

| Option | Effort | Setup |
| ------ | ------ | ----- |
| `/etc/hosts` | Very low | Add `192.168.x.x  memory.local` on each client |
| Router DNS | Low | Add a local DNS entry in your router |
| Pi-hole / Unbound | Medium | Run a dedicated DNS server as an LXC container |

---

## 7. Admin UI & Monitoring

### Update Procedure

Run `./scripts/update.sh` — automatically detects changed services and rebuilds only what is needed.

### Testing

Run `./scripts/test-mcp.sh` — tests all 24 MCP tools via Python/httpx inside the memcp container and reports pass/fail with colored output.

### Key Metrics

| Metric | Target | Alert when |
| ------ | ------ | ---------- |
| Recall Latency | < 100 ms | > 300 ms |
| DB Size | < 80% of limit | > 90% |
| Embedding Latency | < 500 ms | > 2 s |
| GC | Daily OK | Error |
| Backup | Daily OK | Error |

### API Key Attributes

| Attribute | Description |
| --------- | ----------- |
| Name | e.g. `vscode-global`, `desktop-app`, `business-adapter` |
| Scope | `recall-only` \| `store-only` \| `recall+store` \| `admin` |
| Namespaces | Which projects this key may access (`*` = all) |
| Rate Limit | Max requests per minute (default: 60) |
| Expiry | Optional — useful for temporary agents |
| Last Used | Timestamp — makes inactive keys visible |

---

## 8. Security

| Layer | Mechanism |
| ----- | --------- |
| MCP access | API key in `X-API-Key` header, validated by auth-proxy |
| Rate limiting | Per-key rate limits enforced by auth-proxy |
| Admin access | HTTP Basic Auth via Caddy (unified for `/admin/*` and `/api/*`) |
| Data in transit | TLS on all connections (Caddy internal CA) |
| Access logging | All requests logged to auth_log.db with MCP method names |
| Internet exposure | No port forwarding — LAN-only by default |
| Database separation | graph.db (memcp), admin.db (keys/rules), auth_log.db (logs) |
| Health checks | TCP port checks (no HTTP session spam) |

---

## 9. Resources & Cost

| Component | Cost |
| --------- | ---- |
| Proxmox VE | Free (Community Edition) |
| Docker + Docker Compose | Free |
| Ollama + nomic-embed-text | Free |
| Caddy | Free |
| External embedding API | **$0** — local Ollama only |
| Operating cost (electricity) | ~$5-15 / month |

---

## 10. Installation Checklist

### Phase 0 — Proxmox & Docker

- [ ] Create LXC or VM (Ubuntu 22.04, 4 GB RAM, 40 GB SSD)
- [ ] For LXC: enable `nesting=1` and `keyctl=1`
- [ ] Install Docker + Docker Compose
- [ ] Assign a static IP (e.g. `192.168.x.x`)
- [ ] Add `memory.local` to `/etc/hosts` or router DNS

### Phase 1 — Core Stack

- [ ] Clone repository to `/opt/MemoryX`
- [ ] Create `.env` from `.env.example` and fill in secrets
- [ ] Run `./scripts/setup.sh`
- [ ] Import Caddy Root CA on all clients
- [ ] Verify `https://memory.local/health` -> `{status: ok}`

### Phase 2 — Admin UI

- [ ] Open `https://memory.local/admin/` and log in
- [ ] Create API key `vscode-global` (scope: `recall+store`)
- [ ] Create API key `desktop-app`
- [ ] All service status lights green
- [ ] Run `./scripts/test-mcp.sh` — all 24 tools pass

### Phase 3 — VS Code

- [ ] Add MCP entry to `settings.json` (see config/clients/vscode-settings.json)
- [ ] Create `.mcp.json` in your first project
- [ ] Create `CLAUDE.md` (see config/clients/CLAUDE.md)
- [ ] Start a new session and test recall
- [ ] Verify insight is visible in admin UI

### Phase 4 — Desktop App

- [ ] Fill in `claude_desktop_config.json` (see config/clients/claude-desktop-config.json)
- [ ] Restart the Desktop App
- [ ] All clients visible in admin UI logs

### Phase 5 — Business-OS (optional)

- [ ] Set `ADAPTER_SOURCE` and `ADAPTER_API_URL` in `.env`
- [ ] Define `ADAPTER_FILTER_FIELDS` for privacy compliance
- [ ] Run `docker compose --profile business-os up -d`
- [ ] Verify no personal data appears in insights

---

## AI-Assisted Integration

Want to integrate MemoryX into an existing project automatically?

Ask Claude:

```text
Read the AI-INSTALL.md file from https://github.com/toasti1973/MemoryX
and integrate MemoryX into this project.
```

Claude will ask for your server URL, API key, and project name — then create `.mcp.json` and `CLAUDE.md` automatically.

See [AI-INSTALL.md](AI-INSTALL.md) for the full step-by-step guide.

---

## License

GPLv3 — see [LICENSE](LICENSE) for details.

---

*MemoryX v2.1 / 2026-03-13 / <https://github.com/toasti1973/MemoryX>*
