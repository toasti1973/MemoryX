#!/bin/bash
# MemoryX Update-Script
# Holt neue Version von GitHub und baut geänderte Container neu

set -e
cd "$(dirname "$0")/.."

echo "=== MemoryX Update ==="
echo ""

# Git Pull
echo "[1/4] Git Pull..."
git pull
echo ""

# Geänderte Services ermitteln
CHANGED=$(git diff HEAD@{1} HEAD --name-only 2>/dev/null || echo "")

REBUILD=""
echo "$CHANGED" | grep -q "^memory-service/"  && REBUILD="$REBUILD memory-service"
echo "$CHANGED" | grep -q "^admin-api/"        && REBUILD="$REBUILD admin-api"
echo "$CHANGED" | grep -q "^scheduler/"        && REBUILD="$REBUILD scheduler"
echo "$CHANGED" | grep -q "^memory-adapter/"   && REBUILD="$REBUILD memory-service"

# Admin-UI braucht keinen Build (Volume-Mount), nur Restart von admin-ui+caddy
RESTART_UI=false
echo "$CHANGED" | grep -q "^admin-ui/"         && RESTART_UI=true
echo "$CHANGED" | grep -q "^config/caddy/"     && RESTART_UI=true
echo "$CHANGED" | grep -q "^config/admin-ui/"  && RESTART_UI=true

# docker-compose.yml-Änderung → force-recreate aller laufenden Container
RECREATE=false
echo "$CHANGED" | grep -q "^docker-compose.yml" && RECREATE=true

echo "[2/4] Geänderte Dateien:"
if [ -z "$CHANGED" ]; then
    echo "  (keine Änderungen)"
else
    echo "$CHANGED" | sed 's/^/  /'
fi
echo ""

# Build geänderter Services
if [ -n "$REBUILD" ]; then
    echo "[3/4] Baue geänderte Services:$REBUILD"
    docker compose build --no-cache $REBUILD
    echo ""
    echo "      Starte neu:$REBUILD"
    docker compose up -d $REBUILD
else
    echo "[3/4] Kein Rebuild nötig."
fi
echo ""

# docker-compose.yml geändert → force-recreate
if [ "$RECREATE" = true ]; then
    echo "[4/4] docker-compose.yml geändert — recreate alle Container..."
    docker compose up -d --force-recreate
# Admin-UI / Caddy neu starten wenn nötig
elif [ "$RESTART_UI" = true ]; then
    echo "[4/4] Starte admin-ui und caddy neu..."
    docker compose restart admin-ui caddy
else
    echo "[4/4] Kein UI-Restart nötig."
fi
echo ""

# Status
echo "=== Status ==="
docker compose ps --format "table {{.Name}}\t{{.Status}}"
echo ""
echo "Update abgeschlossen!"
