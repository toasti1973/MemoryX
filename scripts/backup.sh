#!/usr/bin/env bash
# Manuelles Backup der Memory-Datenbank
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_DIR="${1:-$PROJECT_DIR/backups}"

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y-%m-%dT%H-%M-%S)
DEST="$BACKUP_DIR/memory-${TS}.db"

echo "[backup] Erstelle Backup: $DEST"

# Via admin-api (Keys sicher aus .env lesen - Anker ^ verhindert Partial-Match)
ADMIN_KEY=$(grep "^ADMIN_API_KEY=" "$PROJECT_DIR/.env" | head -1 | cut -d= -f2- | tr -d "' ")
MEMORY_HOST=$(grep "^MEMORY_HOST=" "$PROJECT_DIR/.env" | head -1 | cut -d= -f2- | tr -d "' ")
MEMORY_HOST="${MEMORY_HOST:-memory.local}"

# Caddy nutzt selbstsignierte lokale CA → --cacert oder -k nötig
# CA-Zertifikat exportieren: docker cp memory-caddy:/data/caddy/pki/authorities/local/root.crt /opt/MemoryX/config/caddy/ca.crt
CA_CERT="${PROJECT_DIR}/config/caddy/ca.crt"
CURL_TLS_OPT="-k"
if [ -f "$CA_CERT" ]; then
  CURL_TLS_OPT="--cacert ${CA_CERT}"
fi

if curl -sf -X POST "https://${MEMORY_HOST}/api/backup" \
     -H "X-Admin-Key: ${ADMIN_KEY}" \
     $CURL_TLS_OPT 2>/dev/null; then
  echo "[backup] Backup via API erstellt"
else
  # Fallback: direkt aus Container
  echo "[backup] Fallback: direkte SQLite-Kopie..."
  docker exec memory-memcp sh -c "cp /data/graph.db /tmp/backup.db"
  docker cp memory-memcp:/tmp/backup.db "$DEST"
  echo "[backup] Backup erstellt: $DEST ($(du -h "$DEST" | cut -f1))"
fi
