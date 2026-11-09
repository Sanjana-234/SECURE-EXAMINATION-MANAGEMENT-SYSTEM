#!/bin/sh
# Nightly backup: consistent DB snapshot (safe while running) + uploads. Run from the repo root via cron.
# Usage:   deploy/backup.sh [output-dir]                      (single-node stack)
#          COMPOSE_FILE=docker-compose.ha.yml deploy/backup.sh  (HA stack)
set -eu
OUT="${1:-/backups}/sems-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"

# Pick a running app service by name (never the Caddy container: "ps -q | head -1" used to select it).
SVC="$(docker compose ps --services --status running | grep -E '^sems(-[0-9]+)?$' | head -n 1 || true)"
if [ -z "$SVC" ]; then
  echo "No running 'sems' service found. Start the stack first (or set COMPOSE_FILE for the HA profile)." >&2
  exit 1
fi

docker compose exec -T "$SVC" rm -f /data/snapshot.db   # backup.ts refuses to overwrite an existing file
docker compose exec -T "$SVC" node --disable-warning=ExperimentalWarning src/backup.ts /data/snapshot.db
docker compose cp "$SVC:/data/snapshot.db" "$OUT/sems.db"
docker compose cp "$SVC:/data/uploads" "$OUT/uploads" || echo "No uploads directory to copy (skipped)."
docker compose exec -T "$SVC" rm -f /data/snapshot.db
echo "Backup written to $OUT"
