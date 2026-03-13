#!/bin/bash
# MemoryX MCP Full Tool Test
# Fuehrt ein Python-Testscript im memcp-Container aus (httpx vorhanden)

set -euo pipefail
cd "$(dirname "$0")/.."

echo "=========================================="
echo " MemoryX MCP — Vollstaendiger Tool-Test"
echo "=========================================="
echo ""

# Python test script direkt in den Container pipen
docker exec -i memory-memcp python3 -u - <<'PYEOF'
import httpx
import json
import sys
import time

BASE = "http://127.0.0.1:3457/mcp/"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
}

session_id = None
msg_id = 0
passed = 0
failed = 0
errors = []

def init_session():
    global session_id
    resp = httpx.post(BASE, headers=HEADERS, json={
        "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1.0"},
        },
    }, follow_redirects=True, timeout=30)
    session_id = resp.headers.get("mcp-session-id", "")
    if not session_id:
        print(f"[FAIL] Keine Session-ID! Status={resp.status_code}")
        print(f"       Headers: {dict(resp.headers)}")
        print(f"       Body: {resp.text[:300]}")
        sys.exit(1)
    # Send initialized notification
    httpx.post(BASE, headers={**HEADERS, "Mcp-Session-Id": session_id}, json={
        "jsonrpc": "2.0", "method": "notifications/initialized",
    }, follow_redirects=True, timeout=10)
    print(f"Session: {session_id[:24]}...")
    print()

def call_tool(name, args, desc):
    global msg_id, passed, failed
    msg_id += 1
    tag = f"[{msg_id:2d}]"
    print(f"{tag} {desc:30s}", end="", flush=True)
    try:
        resp = httpx.post(BASE, headers={**HEADERS, "Mcp-Session-Id": session_id}, json={
            "jsonrpc": "2.0", "id": msg_id,
            "method": "tools/call",
            "params": {"name": name, "arguments": args},
        }, follow_redirects=True, timeout=30)
        # SSE response: parse "data: {...}" lines
        data = None
        for line in resp.text.splitlines():
            if line.startswith("data: "):
                data = json.loads(line[6:])
                break
        if data is None:
            raise ValueError(f"No SSE data in response: {resp.text[:100]}")

        if "error" in data:
            failed += 1
            err = data["error"].get("message", "?")[:120]
            print(f"\033[31mFAIL\033[0m  {err}")
            errors.append(f"  {tag} {desc}: RPC error: {err}")
        elif data.get("result", {}).get("isError"):
            # Tool returned error
            text = data["result"]["content"][0]["text"][:150] if data["result"].get("content") else "?"
            # Some tools legitimately return "not found" — treat as OK if it's a known case
            if any(x in text.lower() for x in ["not found", "keine", "no node", "no archived"]):
                passed += 1
                print(f"\033[32mOK\033[0m    (not found — expected)")
            else:
                failed += 1
                print(f"\033[31mFAIL\033[0m  {text[:100]}")
                errors.append(f"  {tag} {desc}: {text[:100]}")
        elif "result" in data:
            passed += 1
            # Extract brief info from result
            content = data["result"].get("content", [{}])
            if content and content[0].get("text"):
                text = content[0]["text"]
                # Show first line or brief summary
                first_line = text.split("\n")[0][:80]
                print(f"\033[32mOK\033[0m    {first_line}")
            else:
                print(f"\033[32mOK\033[0m")
        else:
            failed += 1
            print(f"\033[33mUNKNOWN\033[0m  {resp.text[:100]}")
            errors.append(f"  {tag} {desc}: Unexpected response")
    except Exception as e:
        failed += 1
        print(f"\033[31mERROR\033[0m {e}")
        errors.append(f"  {tag} {desc}: {e}")

# ── Start ──────────────────────────────────────────────
init_session()

print("--- Phase 1: Core Memory ---")
call_tool("memcp_ping", {}, "PING")
call_tool("memcp_remember", {
    "content": "MCP-Tooltest: Docker graph-backend funktioniert korrekt nach Migration",
    "category": "finding", "importance": "high",
    "tags": "test,mcp,docker", "summary": "Automatischer MCP Tool-Test"
}, "REMEMBER")
call_tool("memcp_recall", {"query": "Docker MCP test", "limit": 5}, "RECALL")
call_tool("memcp_status", {}, "STATUS")
call_tool("memcp_search", {"query": "Docker", "limit": 5}, "SEARCH")

print()
print("--- Phase 3: Graph ---")
call_tool("memcp_graph_stats", {}, "GRAPH STATS")
call_tool("memcp_related", {"insight_id": "nonexistent", "depth": 1}, "RELATED")

print()
print("--- Phase 2: Context & Chunking ---")
call_tool("memcp_load_context", {
    "name": "test-ctx",
    "content": "Erster Satz zum Testen. Zweiter Satz mit Details. Dritter Satz als Abschluss."
}, "LOAD CONTEXT")
call_tool("memcp_list_contexts", {}, "LIST CONTEXTS")
call_tool("memcp_inspect_context", {"name": "test-ctx"}, "INSPECT CONTEXT")
call_tool("memcp_get_context", {"name": "test-ctx"}, "GET CONTEXT")
call_tool("memcp_chunk_context", {"name": "test-ctx", "strategy": "sentence"}, "CHUNK CONTEXT")
call_tool("memcp_peek_chunk", {"context_name": "test-ctx", "chunk_index": 0}, "PEEK CHUNK")
call_tool("memcp_filter_context", {"name": "test-ctx", "pattern": "Satz"}, "FILTER CONTEXT")

print()
print("--- Phase 6: Retention ---")
call_tool("memcp_retention_preview", {}, "RETENTION PREVIEW")
call_tool("memcp_retention_run", {"archive": True, "purge": False}, "RETENTION RUN")
call_tool("memcp_restore", {"name": "nonexistent"}, "RESTORE")

print()
print("--- Phase 7: Projects & Sessions ---")
call_tool("memcp_projects", {}, "PROJECTS")
call_tool("memcp_sessions", {"limit": 5}, "SESSIONS")

print()
print("--- Step 2: Cognitive ---")
call_tool("memcp_reinforce", {"insight_id": "nonexistent", "helpful": True, "note": "Test"}, "REINFORCE")
call_tool("memcp_consolidation_preview", {"limit": 5}, "CONSOLIDATION PREVIEW")

print()
print("--- Cleanup ---")
call_tool("memcp_clear_context", {"name": "test-ctx"}, "CLEAR CONTEXT")

# ── Summary ────────────────────────────────────────────
total = passed + failed
print()
print("==========================================")
print(f" Ergebnis: \033[32m{passed} OK\033[0m / \033[31m{failed} FAIL\033[0m / {total} Total")
if errors:
    print()
    print(" Fehler:")
    for e in errors:
        print(e)
print("==========================================")
PYEOF
