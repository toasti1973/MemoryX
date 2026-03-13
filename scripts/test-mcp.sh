#!/bin/bash
# MemoryX MCP Full Tool Test
# Testet alle MCP-Tools direkt gegen memcp im Docker-Netz

set -euo pipefail

API_KEY=$(grep '^ADAPTER_MEMORY_API_KEY=' /opt/MemoryX/.env | cut -d= -f2-)
if [ -z "$API_KEY" ]; then
  echo "FEHLER: Kein API-Key (ADAPTER_MEMORY_API_KEY) in .env"
  exit 1
fi

# Test via auth-proxy innerhalb des Docker-Netzwerks
PROXY="http://auth-proxy:4000/mcp/"
SESSION=""
ID=0
PASS=0
FAIL=0
ERRORS=""

call_mcp() {
  local tool_name="$1"
  local args="$2"
  local desc="$3"

  ID=$((ID + 1))

  # Initialize session if needed
  if [ -z "$SESSION" ]; then
    INIT_RAW=$(docker exec memory-auth-proxy curl -s -D /tmp/headers "$PROXY" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "X-API-Key: $API_KEY" \
      -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' 2>/dev/null)
    SESSION=$(docker exec memory-auth-proxy cat /tmp/headers 2>/dev/null | grep -i 'mcp-session-id' | head -1 | awk '{print $2}' | tr -d '\r\n')
    if [ -z "$SESSION" ]; then
      echo "[FAIL] Session konnte nicht initialisiert werden!"
      echo "Init Response: $INIT_RAW"
      exit 1
    fi
    # Send initialized notification
    docker exec memory-auth-proxy curl -s "$PROXY" \
      -H "Content-Type: application/json" \
      -H "Accept: application/json, text/event-stream" \
      -H "X-API-Key: $API_KEY" \
      -H "Mcp-Session-Id: $SESSION" \
      -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' >/dev/null 2>&1
    echo "Session: ${SESSION:0:20}..."
    echo ""
  fi

  printf "%-4s %-28s " "[$ID]" "$desc"

  RESP=$(docker exec memory-auth-proxy curl -s "$PROXY" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "X-API-Key: $API_KEY" \
    -H "Mcp-Session-Id: $SESSION" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":$ID,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool_name\",\"arguments\":$args}}" 2>/dev/null)

  # Check for error
  if echo "$RESP" | grep -q '"isError"\s*:\s*true'; then
    FAIL=$((FAIL + 1))
    echo -e "\e[31mFAIL\e[0m"
    ERR_MSG=$(echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('result',{}).get('content',[{}])[0].get('text','?')[:120])" 2>/dev/null || echo "$RESP")
    echo "       -> $ERR_MSG"
    ERRORS="$ERRORS\n  [$ID] $desc: $ERR_MSG"
  elif echo "$RESP" | grep -q '"result"'; then
    PASS=$((PASS + 1))
    echo -e "\e[32mOK\e[0m"
  elif echo "$RESP" | grep -q '"error"'; then
    FAIL=$((FAIL + 1))
    echo -e "\e[31mFAIL\e[0m"
    ERR_MSG=$(echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('error',{}).get('message','?')[:120])" 2>/dev/null || echo "$RESP")
    echo "       -> $ERR_MSG"
    ERRORS="$ERRORS\n  [$ID] $desc: $ERR_MSG"
  else
    FAIL=$((FAIL + 1))
    echo -e "\e[33mEMPTY\e[0m"
    echo "       -> Leere Antwort"
    ERRORS="$ERRORS\n  [$ID] $desc: Leere Antwort"
  fi
}

echo "=========================================="
echo " MemoryX MCP — Vollstaendiger Tool-Test"
echo "=========================================="
echo ""

# Phase 1: Core Memory
echo "--- Phase 1: Core Memory ---"
call_mcp "memcp_ping" '{}' "PING"
call_mcp "memcp_remember" '{"content":"MCP-Tooltest: Docker graph-backend funktioniert","category":"finding","importance":"high","tags":"test,mcp","summary":"Test-Eintrag"}' "REMEMBER"
call_mcp "memcp_recall" '{"query":"Docker MCP test","limit":5}' "RECALL"
call_mcp "memcp_status" '{}' "STATUS"
call_mcp "memcp_search" '{"query":"Docker","limit":5}' "SEARCH"

echo ""
echo "--- Phase 3: Graph ---"
call_mcp "memcp_graph_stats" '{}' "GRAPH STATS"
call_mcp "memcp_related" '{"insight_id":"nonexistent","depth":1}' "RELATED"

echo ""
echo "--- Phase 2: Context & Chunking ---"
call_mcp "memcp_load_context" '{"name":"test-ctx","content":"Erster Satz. Zweiter Satz. Dritter Satz zum Testen."}' "LOAD CONTEXT"
call_mcp "memcp_list_contexts" '{}' "LIST CONTEXTS"
call_mcp "memcp_inspect_context" '{"name":"test-ctx"}' "INSPECT CONTEXT"
call_mcp "memcp_get_context" '{"name":"test-ctx"}' "GET CONTEXT"
call_mcp "memcp_chunk_context" '{"name":"test-ctx","strategy":"sentence"}' "CHUNK CONTEXT"
call_mcp "memcp_peek_chunk" '{"context_name":"test-ctx","chunk_index":0}' "PEEK CHUNK"
call_mcp "memcp_filter_context" '{"name":"test-ctx","pattern":"Satz"}' "FILTER CONTEXT"

echo ""
echo "--- Phase 6: Retention ---"
call_mcp "memcp_retention_preview" '{}' "RETENTION PREVIEW"
call_mcp "memcp_retention_run" '{"archive":true,"purge":false}' "RETENTION RUN"
call_mcp "memcp_restore" '{"name":"test-ctx"}' "RESTORE"

echo ""
echo "--- Phase 7: Projects & Sessions ---"
call_mcp "memcp_projects" '{}' "PROJECTS"
call_mcp "memcp_sessions" '{"limit":5}' "SESSIONS"

echo ""
echo "--- Step 2: Cognitive ---"
call_mcp "memcp_reinforce" '{"insight_id":"nonexistent","helpful":true,"note":"Test"}' "REINFORCE"
call_mcp "memcp_consolidation_preview" '{"limit":5}' "CONSOLIDATION PREVIEW"

echo ""
echo "--- Cleanup ---"
call_mcp "memcp_clear_context" '{"name":"test-ctx"}' "CLEAR CONTEXT"

echo ""
echo "=========================================="
printf " Ergebnis: \e[32m%d OK\e[0m / \e[31m%d FAIL\e[0m / %d Total\n" "$PASS" "$FAIL" "$((PASS + FAIL))"
if [ -n "$ERRORS" ]; then
  echo ""
  echo " Fehler:"
  echo -e "$ERRORS"
fi
echo "=========================================="
