#!/usr/bin/env bash
# Health-Check aller Memory-System-Dienste
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

MEMORY_HOST=$(grep MEMORY_HOST "$PROJECT_DIR/.env" 2>/dev/null | cut -d= -f2 | tr -d ' ')
MEMORY_HOST="${MEMORY_HOST:-memory.local}"

echo "Memory System — Health-Check"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

check_container() {
  local name=$1
  local status
  status=$(docker inspect --format='{{.State.Status}}' "$name" 2>/dev/null || echo "nicht gefunden")
  local health
  health=$(docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo "—")
  if [ "$status" = "running" ]; then
    echo "  [OK]  $name ($health)"
  else
    echo "  [ERR] $name — Status: $status"
  fi
}

echo "Docker-Container:"
check_container "memory-caddy"
check_container "memory-memcp"
check_container "memory-auth-proxy"
check_container "memory-ollama"
check_container "memory-admin-api"
check_container "memory-admin-ui"
check_container "memory-scheduler"

echo ""
echo "Endpunkte:"

if curl -sf --max-time 5 -k "https://$MEMORY_HOST/health" >/dev/null 2>&1; then
  HEALTH=$(curl -sf --max-time 5 -k "https://$MEMORY_HOST/health")
  echo "  [OK]  https://$MEMORY_HOST/health — $HEALTH"
else
  echo "  [ERR] https://$MEMORY_HOST/health — nicht erreichbar"
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
