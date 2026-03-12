# MemoryX — Persistent AI Memory for Claude

> A fully containerized Docker stack that gives every Claude instance persistent, cross-session memory — powered by local embeddings via Ollama, MCP integration, and a modern dark web-based admin UI.

[![Docker](https://img.shields.io/badge/Docker-Compose-0DB7ED?logo=docker)](https://docs.docker.com/compose/)
[![Ollama](https://img.shields.io/badge/Ollama-nomic--embed--text-006064)](https://ollama.com)
[![MCP](https://img.shields.io/badge/MCP-Claude%20Code-1565C0)](https://modelcontextprotocol.io)
[![License](https://img.shields.io/badge/License-MIT-green)](LICENSE)

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
- **Local embeddings via Ollama** — no API costs, no cloud dependency, full data control
- **Web Admin UI** — API key management, live monitoring, and log viewer in the browser
- **Business-OS integration** — optional adapter for Nextcloud, Gitea, ERPNext, Outline, and more
- **Privacy-first** — all data stays on your local network, no external services required

### Three Memory Layers (L1 / L2 / L3)

| Layer | Name | Technology | Purpose |
| ----- | ---- | ---------- | ------- |
| L1 | Episodic memory | SQLite | Compressed experience entries (max. 200 tokens) |
| L2 | Semantic memory | Ollama embeddings | Vectors for semantic similarity search |
| L3 | Procedural memory | SQLite Key-Value | Distilled rules from recurring patterns |

---

## 2. Architecture

### Docker Stack Overview

```text
┌─────────────────────────────────────────────────────────────────┐
│  LOCAL NETWORK — VS Code · Desktop App · Browser · Business-OS  │
└──────────────────────────┬──────────────────────────────────────┘
                           │ HTTPS :443
┌──────────────────────────▼──────────────────────────────────────┐
│  CADDY  (Reverse Proxy + TLS)                                   │
│  /mcp → memory-service   /admin → admin-ui   /api → admin-api   │
└──────┬───────────┬───────────────┬───────────────┬──────────────┘
       │           │               │               │
  [memory-   [ollama]        [admin-api]      [admin-ui]
   service]   :11434          :3459            :8080
   :3457     Embedding       REST Backend     Web Dashboard

  [scheduler]               [memory-adapter]
  GC · Backup · Distill     Business-OS Bridge (optional)

┌─────────────────────────────────────────────────────────────────┐
│  DOCKER VOLUMES (persistent)                                     │
│  memory-data · ollama-models · caddy-certs · admin-data         │
└─────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```text
/opt/memory-system/
├── docker-compose.yml          # Main stack definition
├── .env                        # Secrets & configuration (never commit!)
├── config/
│   ├── caddy/Caddyfile         # Routing + TLS
│   ├── memory-service/         # Namespaces, token limits
│   └── clients/                # Config templates for all clients
├── admin-ui/
│   ├── index.html              # Dashboard
│   ├── keys.html               # API key management
│   ├── episodes.html           # Episode browser
│   ├── rules.html              # L3 rule management
│   ├── logs.html               # Live log viewer
│   ├── health.html             # Dedicated health status page
│   └── system.html             # System actions
├── scripts/
│   ├── setup.sh                # First-time setup + Ollama model pull
│   ├── update.sh               # git pull + smart Docker rebuild
│   ├── backup.sh               # Manual database backup
│   └── healthcheck.sh          # Status check for all services
└── data/                       # Mounted by Docker (memory.db)
```

---

## 3. Services

### memory-service — MCP Core

| Endpoint | Method | Function | Token Budget |
| -------- | ------ | -------- | ------------ |
| `/mcp/recall` | POST | Searches L3→L2→L1, returns formatted context | max. 450 tokens |
| `/mcp/store` | POST | Stores an episode, triggers embedding via Ollama | — |
| `/mcp/feedback` | POST | Updates the quality score of an entry | — |
| `/health` | GET | Status of all internal dependencies | — |

**Image:** `node:20-alpine` · **Port:** `3457` (internal) · **Restart:** `always` · **RAM limit:** 512 MB

### ollama — Local Embeddings

```text
Model:    nomic-embed-text  (768 dimensions, ~300 MB)
Port:     11434  (internal only, no LAN access)
Latency:  ~150 ms/embedding on a standard server CPU
Volume:   ollama-models  (persisted — no re-download after restart)
```

> **Note:** On first `docker compose up`, the model is pulled automatically via `setup.sh` (1–5 minutes).

### admin-api — REST Backend

| Group | Endpoints | Function |
| ----- | --------- | -------- |
| API Keys | `GET/POST/DELETE /api/keys` | List, create, revoke keys |
| Statistics | `GET /api/stats` | Hit rate, episode count, rule count, DB size |
| Health | `GET /api/health` | Status of all Docker services |
| Episodes | `GET/DELETE /api/episodes` | Search and delete episodes |
| Rules | `GET/POST/DELETE /api/rules` | Manage L3 rules |
| Logs | `GET /api/logs` | Access log streaming |
| Backup | `POST /api/backup` | Trigger a manual backup |
| System | `POST /api/gc` `/api/distill` | Trigger GC and distillation manually |

### admin-ui — Web Dashboard

Static HTML/CSS/JS files — no build pipeline. Served directly by Caddy.

| Page | URL | Content |
| ---- | --- | ------- |
| Dashboard | `/admin/` | KPI cards, service status lights, activity log (auto-refresh 30s) |
| API Keys | `/admin/keys` | Create, copy, revoke keys |
| Episodes | `/admin/episodes` | Search and delete episodes |
| Rules | `/admin/rules` | Review, confirm, or discard L3 rules |
| Logs | `/admin/logs` | Live log viewer with error highlighting |
| System | `/admin/system` | RAM/CPU/DB size, backup, GC, restart |

### scheduler — Background Jobs

| Job | Schedule | Action |
| --- | -------- | ------ |
| Garbage Collection | Daily 02:00 | Delete weak / outdated episodes |
| Distillation | Daily 02:30 | Generate L3 rules from ≥3 similar episodes |
| DB Backup | Daily 03:00 | SQLite VACUUM + copy to backup volume |
| Score Decay | Daily 04:00 | Apply time-based quality decay to all episodes |
| Health Report | Hourly | Write status log to stdout |

All scheduler jobs are wrapped in error handlers — a failed job is logged but does not crash the service.

### caddy — Reverse Proxy

```caddy
memory.local {
  handle /mcp* {
    reverse_proxy memory-service:3457
    # Auth: X-API-Key header, validated by memory-service
  }
  handle /admin* {
    basicauth { {env.ADMIN_USER} {env.ADMIN_PASSWORD_HASH} }
    reverse_proxy admin-ui:8080
  }
  handle /api* {
    reverse_proxy admin-api:3459
  }
  tls internal   # Automatic HTTPS with local CA
}
```

---

## 4. Client Configuration

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

**Project-specific** — `.mcp.json` in the project root:

```json
{
  "mcpServers": {
    "memory-project": {
      "url": "https://memory.local/mcp",
      "apiKey": "mc-proj-myproject-xxxx",
      "namespace": "project:myproject",
      "sharedNamespaces": ["global"],
      "autoRecall": true,
      "autoStore": true
    }
  }
}
```

**`CLAUDE.md`** in the project root:

```markdown
## Memory Instructions

At the start of every session: call memory-project:recall with a description of the current task.
At the end of every session: store completed work, insights, and open points.
Format: { task_category, outcome, context_summary, learnings }
```

### Claude Desktop App

```json
// macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
// Windows: %APPDATA%\Claude\claude_desktop_config.json
// Linux:   ~/.config/Claude/claude_desktop_config.json
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

### Importing the TLS Certificate (once per client)

```bash
# Export Caddy Root CA
docker exec caddy caddy trust

# macOS
# Double-click the .crt file → Keychain → Mark as trusted

# Windows
# certmgr.msc → Trusted Root Certification Authorities → Import

# Linux
sudo cp ca.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates
```

### Remote Access (Home Office)

WireGuard VPN on the Proxmox host — clients use the **same configuration** as on the LAN:

```text
Laptop (remote) → WireGuard :51820 → 192.168.1.50 → memory.local → memory-service
```

---

## 5. Configuration (.env)

```env
# ── Server ────────────────────────────────────────────────────────
MEMORY_HOST=memory.local
MEMORY_PORT=443

# ── Admin UI Auth ─────────────────────────────────────────────────
ADMIN_USER=admin
ADMIN_PASSWORD_HASH=           # bcrypt hash via: caddy hash-password

# ── Internal Security ─────────────────────────────────────────────
ADMIN_API_KEY=                 # generate: openssl rand -hex 32
JWT_SECRET=                    # generate: openssl rand -hex 32

# ── Memory Service ────────────────────────────────────────────────
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

> ⚠️ Never commit `.env` to Git — it contains your admin password and API keys.

---

## 6. Deployment Plan

| Phase | Duration | Goal | Acceptance Criterion |
| ----- | -------- | ---- | -------------------- |
| Phase 0 | 2–4 h | Proxmox LXC/VM + Docker | `docker compose version` runs in container |
| Phase 1 | 1 day | Core stack (service + Ollama + Caddy) | `GET /health` → `{status: ok}` |
| Phase 2 | 1 day | Admin API + Web Dashboard | Dashboard shows green status lights |
| Phase 3 | 0.5 days | Scheduler + first backup | Backup file present in volume |
| Phase 4 | 0.5 days | VS Code / Claude Code | Recall returns context in a new session |
| Phase 5 | 0.5 days | Desktop App + CLI | All three clients visible in admin logs |
| Phase 6 | 0.5 days | WireGuard VPN (optional) | Remote access works |
| Phase 7 | 2–4 days | Business-OS Adapter | Business-OS episodes visible in admin UI |
| Phase 8 | 1 week | Tuning & validation | Hit rate ≥ 60% |

### Proxmox Hardware

| Resource | Minimum | Recommended |
| -------- | ------- | ----------- |
| CPU | 4 cores | 6–8 cores |
| RAM | 8 GB | 16 GB |
| Storage (SSD) | 60 GB | 120 GB |

**LXC settings required:** `nesting=1`, `keyctl=1` (needed for Docker-in-LXC)

### DNS Resolution for `memory.local`

| Option | Effort | Setup |
| ------ | ------ | ----- |
| `/etc/hosts` | Very low | Add `192.168.1.50  memory.local` on each client |
| Router DNS | Low | Add a local DNS entry in your router |
| Pi-hole / Unbound | Medium | Run a dedicated DNS server as an LXC container |

---

## 7. Admin UI & Monitoring

### Update Procedure

\n
Automatically detects changed services and rebuilds only what is needed.

### Key Metrics

| Metric | Target | Alert when |
| ------ | ------ | ---------- |
| Hit Rate | ≥ 60% | < 40% |
| Recall Latency | < 100 ms | > 300 ms |
| DB Size | < 80% of limit | > 90% |
| Embedding Latency | < 500 ms | > 2 s |
| GC | Daily OK | Error |
| Backup | Daily OK | Error |

### API Key Attributes

| Attribute | Description |
| --------- | ----------- |
| Name | e.g. `vscode-laptop`, `desktop-app`, `business-os-adapter` |
| Scope | `recall-only` \| `store-only` \| `recall+store` \| `admin` |
| Namespace Filter | Which namespaces this key may read/write |
| Rate Limit | Max requests per minute |
| Expiry | Optional — useful for temporary agents |
| Last Used | Timestamp — makes inactive keys visible |

---

## 8. Security

| Threat | Mitigation |
| ------ | ---------- |
| Unauthorized MCP access | API key in `X-API-Key` header — no key → 401 |
| Unauthorized admin access | HTTP Basic Auth via Caddy, bcrypt hash |
| Data in transit | TLS on all connections (Caddy internal CA) |
| Sensitive data in episodes | Pre-store filter: regex blocklist for passwords, keys, PII |
| Internet exposure | No port forwarding — LAN-only by default |
| Backup exposure | Backup volume only mountable internally |

---

## 9. Resources & Cost

| Component | Cost |
| --------- | ---- |
| Proxmox VE | Free (Community Edition) |
| Docker + Docker Compose | Free |
| Ollama + nomic-embed-text | Free |
| Caddy | Free |
| External embedding API | **$0** — local Ollama only |
| Operating cost (electricity) | ~$5–15 / month |

---

## 10. Installation Checklist

### Phase 0 — Proxmox & Docker

- [ ] Create LXC or VM (Ubuntu 22.04, 4 GB RAM, 40 GB SSD)
- [ ] For LXC: enable `nesting=1` and `keyctl=1`
- [ ] Install Docker + Docker Compose
- [ ] Assign a static IP (e.g. `192.168.1.50`)
- [ ] Add `memory.local` to `/etc/hosts` or router DNS
- [ ] Create `/opt/memory-system`

### Phase 1 — Core Stack

- [ ] Create `.env` from `.env.example` and fill in secrets
- [ ] Run `./scripts/setup.sh`
- [ ] Run `docker compose up -d`
- [ ] Import Caddy Root CA on all clients
- [ ] Verify `https://memory.local/health` → `{status: ok}`

### Phase 2 — Admin UI

- [ ] Open `https://memory.local/admin/` and log in
- [ ] Create API key `vscode-global` (scope: `recall+store`)
- [ ] Create API key `desktop-app`
- [ ] All service status lights green
- [ ] Run a manual backup test

### Phase 3 — VS Code

- [ ] Add global MCP entry to `settings.json`
- [ ] Create `.mcp.json` in your first project
- [ ] Create `CLAUDE.md`
- [ ] Start a new session and test recall
- [ ] Verify episode is visible in admin UI at `/admin/episodes`

### Phase 4 — Desktop App & CLI

- [ ] Fill in `claude_desktop_config.json`, restart app
- [ ] Fill in `~/.claude/config.json` for CLI
- [ ] All three clients visible in admin UI logs

### Phase 5 — Business-OS (optional)

- [ ] Set `ADAPTER_SOURCE` and `ADAPTER_API_URL` in `.env`
- [ ] Define `ADAPTER_FILTER_FIELDS` for privacy compliance
- [ ] Run `docker compose --profile business-os up -d`
- [ ] Verify no personal data appears in episodes

---

## AI-Assisted Integration

Want to integrate MemoryX into an existing project automatically?

Ask Claude:

```text
Read the AI-INSTALL.md file from https://github.com/toasti1973/MemoryX
and integrate MemoryX into this project.
```

Claude will ask for your server URL, API key, and namespace — then create `.mcp.json` and `CLAUDE.md` automatically.

See [AI-INSTALL.md](AI-INSTALL.md) for the full step-by-step guide.

---

## License

MIT — freely adaptable for your own infrastructure.

---

*MemoryX · v1.1 · 2026 · <https://github.com/toasti1973/MemoryX>*
