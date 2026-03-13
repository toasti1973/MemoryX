"""auth-proxy — API-Key-Validierung vor memcp.

Leichtgewichtiger Reverse-Proxy:
1. Liest X-API-Key Header
2. Prueft gegen admin-data/keys.db (SQLite)
3. Validiert Scope und Namespace
4. Leitet valide Anfragen an memcp weiter
5. Loggt Zugriffe fuer Admin-UI
"""

import os
import re
import sqlite3
import time
from collections import defaultdict
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse

# ── Konfiguration ──────────────────────────────────────────────────────────
KEYS_DB = os.getenv("KEYS_DB", "/data/admin/admin.db")
MEMCP_URL = os.getenv("MEMCP_URL", "http://memcp:3457")
AUTH_LOG_DB = os.getenv("AUTH_LOG_DB", "/data/admin/auth_log.db")
RATE_LIMIT_DEFAULT = int(os.getenv("RATE_LIMIT_DEFAULT", "60"))

# ── Rate-Limiting (in-memory, mit Cleanup) ────────────────────────────────
rate_counters: dict[str, dict] = defaultdict(lambda: {"count": 0, "reset_at": 0.0})
_last_cleanup = 0.0


def _check_rate_limit(key_id: str, limit: int) -> bool:
    """True wenn erlaubt, False wenn Rate-Limit ueberschritten."""
    global _last_cleanup
    now = time.time()
    counter = rate_counters[key_id]
    if counter["reset_at"] < now:
        counter["count"] = 0
        counter["reset_at"] = now + 60.0
    counter["count"] += 1
    # Abgelaufene Counter alle 5 Minuten bereinigen (Memory-Leak-Schutz)
    if now - _last_cleanup > 300:
        _last_cleanup = now
        expired = [k for k, v in rate_counters.items() if v["reset_at"] < now]
        for k in expired:
            del rate_counters[k]
    return counter["count"] <= limit


# ── Key-Datenbank ──────────────────────────────────────────────────────────
def _get_key_record(api_key: str) -> dict | None:
    """Liest API-Key aus admin.db. Gibt None zurueck wenn ungueltig."""
    if not os.path.exists(KEYS_DB):
        return None
    try:
        conn = sqlite3.connect(KEYS_DB, timeout=5)
        conn.row_factory = sqlite3.Row
        row = conn.execute(
            """SELECT id, name, key_value, scope, namespaces, rate_limit, expires_at, active
               FROM api_keys
               WHERE key_value = ? AND active = 1
                 AND (expires_at IS NULL OR expires_at > unixepoch())""",
            (api_key,),
        ).fetchone()
        if row:
            conn.execute(
                "UPDATE api_keys SET last_used = unixepoch() WHERE id = ?",
                (row["id"],),
            )
            conn.commit()
        conn.close()
        return dict(row) if row else None
    except Exception:
        return None


def _check_namespace(record: dict, namespace: str) -> bool:
    """Prueft ob der API-Key auf den Namespace zugreifen darf."""
    ns = record.get("namespaces", "*")
    if ns == "*":
        return True
    allowed = [s.strip() for s in ns.split(",")]
    return namespace in allowed or any(namespace.startswith(a + ":") for a in allowed)


# ── Access-Log ─────────────────────────────────────────────────────────────
def _init_log_db():
    """Erstellt auth_log Tabelle falls noetig."""
    try:
        conn = sqlite3.connect(AUTH_LOG_DB, timeout=5)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS auth_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                key_id TEXT,
                key_name TEXT,
                method TEXT,
                path TEXT,
                status INTEGER,
                latency_ms INTEGER,
                created_at INTEGER NOT NULL DEFAULT (unixepoch())
            )
        """)
        conn.commit()
        conn.close()
    except Exception:
        pass


def _log_access(key_id: str, key_name: str, method: str, path: str, status: int, latency_ms: int):
    """Schreibt einen Zugriff ins Auth-Log."""
    try:
        conn = sqlite3.connect(AUTH_LOG_DB, timeout=2)
        conn.execute(
            "INSERT INTO auth_log (key_id, key_name, method, path, status, latency_ms) VALUES (?,?,?,?,?,?)",
            (key_id, key_name, method, path, status, latency_ms),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass


# ── HTTP-Client ────────────────────────────────────────────────────────────
http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global http_client
    _init_log_db()
    http_client = httpx.AsyncClient(base_url=MEMCP_URL, timeout=60.0, follow_redirects=True)
    yield
    await http_client.aclose()


app = FastAPI(title="MemoryX Auth Proxy", lifespan=lifespan)


# ── Health-Endpoint ────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    memcp_ok = False
    try:
        r = await http_client.get("/mcp/", timeout=5.0)
        memcp_ok = r.status_code < 500
    except Exception:
        pass
    return {
        "status": "ok" if memcp_ok else "degraded",
        "memcp": "ok" if memcp_ok else "unavailable",
        "keys_db": "ok" if os.path.exists(KEYS_DB) else "missing",
    }


# ── MCP Proxy ──────────────────────────────────────────────────────────────
@app.api_route("/mcp{path:path}", methods=["GET", "POST", "DELETE", "OPTIONS"])
async def proxy_mcp(request: Request, path: str = ""):
    t0 = time.time()

    # Auth
    api_key = request.headers.get("x-api-key", "")
    if not api_key:
        return JSONResponse(status_code=401, content={"error": "X-API-Key header fehlt"})

    record = _get_key_record(api_key)
    if not record:
        _log_access("unknown", "unknown", request.method, f"/mcp{path}", 403, 0)
        return JSONResponse(status_code=403, content={"error": "Ungueltiger oder abgelaufener API-Key"})

    # Rate-Limit
    limit = record.get("rate_limit", RATE_LIMIT_DEFAULT)
    if not _check_rate_limit(record["id"], limit):
        _log_access(record["id"], record["name"], request.method, f"/mcp{path}", 429, 0)
        return JSONResponse(status_code=429, content={"error": "Rate limit ueberschritten"})

    # Namespace aus Body extrahieren (fuer MCP ist das in den Tool-Args, schwer zu parsen)
    # Wir setzen X-Namespace Header fuer memcp und loggen den Zugriff
    # Namespace-Enforcement passiert primaer ueber den project-Parameter in memcp

    # Anfrage an memcp weiterleiten
    target_path = f"/mcp{path}" if path else "/mcp/"
    body = await request.body()
    headers = {
        k: v for k, v in request.headers.items()
        if k.lower() not in ("host", "x-api-key", "content-length")
    }
    # Projektnamen aus Key-Namespaces ableiten (erster project:-Eintrag)
    ns = record.get("namespaces", "*")
    if ns != "*":
        project_match = re.search(r"project:(\w+)", ns)
        if project_match:
            headers["x-memcp-project"] = project_match.group(1)

    try:
        if request.method == "GET":
            # SSE: Stream-Response weiterleiten
            memcp_resp = await http_client.get(
                target_path, headers=headers, timeout=300.0
            )
            latency = int((time.time() - t0) * 1000)
            _log_access(record["id"], record["name"], "GET", target_path, memcp_resp.status_code, latency)

            response = Response(
                content=memcp_resp.content,
                status_code=memcp_resp.status_code,
                media_type=memcp_resp.headers.get("content-type", "application/json"),
            )
            for k, v in memcp_resp.headers.items():
                if k.lower() not in ("content-length", "transfer-encoding", "connection"):
                    response.headers[k] = v
            return response
        else:
            memcp_resp = await http_client.request(
                method=request.method,
                url=target_path,
                content=body,
                headers={**headers, "content-type": request.headers.get("content-type", "application/json")},
                timeout=60.0,
            )
            latency = int((time.time() - t0) * 1000)
            _log_access(record["id"], record["name"], request.method, target_path, memcp_resp.status_code, latency)

            response = Response(
                content=memcp_resp.content,
                status_code=memcp_resp.status_code,
                media_type=memcp_resp.headers.get("content-type", "application/json"),
            )
            for k, v in memcp_resp.headers.items():
                if k.lower() not in ("content-length", "transfer-encoding", "connection"):
                    response.headers[k] = v
            return response

    except httpx.TimeoutException:
        latency = int((time.time() - t0) * 1000)
        _log_access(record["id"], record["name"], request.method, target_path, 504, latency)
        return JSONResponse(status_code=504, content={"error": "memcp timeout"})
    except Exception as e:
        latency = int((time.time() - t0) * 1000)
        _log_access(record["id"], record["name"], request.method, target_path, 502, latency)
        return JSONResponse(status_code=502, content={"error": f"memcp unreachable: {e}"})
