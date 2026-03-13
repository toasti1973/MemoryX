# Changelog — MemoryX

All notable changes to the MemoryX Docker stack are documented in this file.
For memcp-engine specific changes, see [memcp-engine/CHANGELOG.md](memcp-engine/CHANGELOG.md).

## [2.1.0] — 2026-03-13

### Added
- `MEMCP_BACKEND=graph` env var to force SQLite graph backend in Docker
- Graph DB schema + JSON data migration on server startup
- MCP full tool test script (`scripts/test-mcp.sh`) — tests all 24 tools
- TCP health checks for memcp (replaces HTTP GET that caused session spam)
- MCP method name extraction in auth-proxy logs (e.g. `tools/call:memcp_recall`)
- `effective_importance` column in admin-api episodes endpoint

### Changed
- **Transport**: `streamable-http` throughout all client configs (was `sse`)
- **Caddy**: `basic_auth` replaces deprecated `basicauth`, unified realm for `/api/*` and `/admin/*`
- **Admin-UI**: `credentials: 'include'` on all fetch() calls for seamless auth
- **Admin-UI**: `scoreBar()` clamps to 100%, shows text label + percentage
- **Admin-UI**: `formatDate()` supports both ISO strings and unix timestamps
- **auth-proxy**: `follow_redirects=True` for httpx (307 redirect handling)
- **admin-api**: read-write mode for memcp graph.db (WAL requires shared memory)
- **update.sh**: `--remove-orphans` flag to clean up old containers

### Removed
- `memory-service/` — legacy Node.js service, fully replaced by memcp-engine
- `config/memory-service/` — legacy configuration
- `memory-data` Docker volume — legacy, no longer referenced

### Fixed
- Empty dashboard (graph.db was never created because JSON backend was active)
- 307 redirect loop between auth-proxy and memcp
- Health check log spam (30s HTTP GET created new MCP sessions)
- SQLite WAL read failure in admin-api (`:ro` mount + readonly mode)
- "NaN" importance display in episodes page
- "Invalid Date" display for ISO timestamp format
- Re-login required on every page navigation

## [2.0.0] — 2026-03-12

### Added
- Complete v2 architecture with memcp (Python/FastMCP) replacing memory-service
- MAGMA 4-graph engine (semantic, temporal, causal, entity edges)
- 24 MCP tools across 7 phases (core, context, search, graph, retention, projects, cognitive)
- auth-proxy with API key validation, rate limiting, and access logging
- Admin dashboard with 7 pages (KPIs, keys, episodes, rules, logs, health, system)
- Scheduler with GC, distillation, backup, and decay jobs
- Caddy reverse proxy with TLS and Basic Auth
- Ollama integration for local embeddings (nomic-embed-text)
- Business-OS adapter (optional, via Docker profile)
- AI-INSTALL.md for automated project integration

### Architecture
- memcp-engine (Python 3.12, FastMCP, SQLite + WAL)
- auth-proxy (Python 3.12, FastAPI, httpx)
- admin-api (Node.js, Express, better-sqlite3)
- admin-ui (static HTML/CSS/JS, dark theme)
- scheduler (Node.js, node-cron)
- caddy (Caddy 2 Alpine)
- ollama (nomic-embed-text, 768-dim vectors)
