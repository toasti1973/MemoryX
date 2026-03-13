#!/usr/bin/env bash
# MemoryX Setup-Script
# Führe dieses Script auf dem Proxmox-Host (im LXC/VM) aus.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "╔══════════════════════════════════════════════════╗"
echo "║       MemoryX — Setup                           ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# ── .env prüfen ──────────────────────────────────────────────────────────────
if [ ! -f "$PROJECT_DIR/.env" ]; then
  echo "[setup] .env nicht gefunden, kopiere .env.example..."
  cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
  echo "[setup] WICHTIG: .env bearbeiten und Secrets setzen!"
  echo "        nano $PROJECT_DIR/.env"
  exit 1
fi

# ── Docker prüfen ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "[setup] Docker nicht gefunden. Installiere Docker..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
fi

echo "[setup] Docker Version: $(docker --version)"

# ── DNS-Eintrag prüfen ───────────────────────────────────────────────────────
MEMORY_HOST=$(grep MEMORY_HOST "$PROJECT_DIR/.env" | cut -d= -f2 | tr -d ' ')
MEMORY_HOST="${MEMORY_HOST:-memory.local}"

if ! getent hosts "$MEMORY_HOST" &>/dev/null; then
  HOST_IP=$(hostname -I | awk '{print $1}')
  echo "[setup] DNS-Eintrag fehlt für $MEMORY_HOST"
  echo "[setup] Füge $HOST_IP $MEMORY_HOST zu /etc/hosts hinzu..."
  echo "$HOST_IP $MEMORY_HOST" >> /etc/hosts
  echo "[setup] Auf CLIENTS ebenfalls eintragen: $HOST_IP $MEMORY_HOST"
fi

# ── Images bauen ─────────────────────────────────────────────────────────────
echo "[setup] Baue Docker-Images..."
cd "$PROJECT_DIR"
docker compose build

# ── Stack starten ─────────────────────────────────────────────────────────────
echo "[setup] Starte Stack..."
docker compose up -d

# ── Warte auf Ollama ──────────────────────────────────────────────────────────
echo "[setup] Warte auf Ollama (max. 60s)..."
for i in $(seq 1 12); do
  if docker exec memory-ollama curl -sf http://localhost:11434/api/tags &>/dev/null; then
    echo "[setup] Ollama ist bereit"
    break
  fi
  echo "[setup] Warte... ($((i*5))s)"
  sleep 5
done

# ── Embedding-Modell herunterladen ────────────────────────────────────────────
OLLAMA_MODEL=$(grep OLLAMA_MODEL "$PROJECT_DIR/.env" | cut -d= -f2 | tr -d ' ')
OLLAMA_MODEL="${OLLAMA_MODEL:-nomic-embed-text}"

echo "[setup] Lade Embedding-Modell: $OLLAMA_MODEL"
docker exec memory-ollama ollama pull "$OLLAMA_MODEL" || echo "[setup] Modell-Pull fehlgeschlagen (retry via scheduler)"

# ── Warte auf memcp ──────────────────────────────────────────────────────────
echo "[setup] Warte auf memcp (max. 30s)..."
for i in $(seq 1 6); do
  if docker exec memory-memcp python -c "import urllib.request; urllib.request.urlopen('http://localhost:3457/mcp/')" &>/dev/null; then
    echo "[setup] memcp ist bereit"
    break
  fi
  sleep 5
done

# ── Caddy Root-CA exportieren ─────────────────────────────────────────────────
echo "[setup] Exportiere Caddy Root-CA..."
sleep 3
CA_FILE="$PROJECT_DIR/caddy-root-ca.crt"
docker cp memory-caddy:/data/caddy/pki/authorities/local/root.crt "$CA_FILE" 2>/dev/null || \
  echo "[setup] CA-Export nicht möglich (Caddy noch nicht gestartet, manuell nachholen)"

echo ""
echo "╔══════════════════════════════════════════════════╗"
echo "║  Setup abgeschlossen!                           ║"
echo "╠══════════════════════════════════════════════════╣"
echo "║                                                  ║"
echo "║  Dashboard: https://$MEMORY_HOST/admin        ║"
echo "║  Health:    https://$MEMORY_HOST/health        ║"
echo "║                                                  ║"
echo "║  Naechste Schritte:                              ║"
echo "║  1. CA-Zertifikat auf Clients importieren        ║"
echo "║     Datei: caddy-root-ca.crt                     ║"
echo "║  2. Ersten API-Key im Dashboard erstellen        ║"
echo "║  3. VS Code / Desktop App konfigurieren          ║"
echo "║     (siehe config/clients/)                      ║"
echo "╚══════════════════════════════════════════════════╝"
