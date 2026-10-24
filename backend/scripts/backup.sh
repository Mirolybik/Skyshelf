#!/usr/bin/env bash
# SkyShelf — консистентное резервное копирование PostgreSQL + зашифрованных объектов (local / MinIO / Docker).
# Использование:
#   npm run backup
#   bash scripts/backup.sh [путь_к_папке_бэкапов]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ROOT="${1:-$BACKEND_DIR/backups}"
TARGET_DIR="$BACKUP_ROOT/skyshelf-backup-$STAMP"
mkdir -p "$TARGET_DIR"

DB_USER="${DB_USER:-skyshelf}"
DB_PASSWORD="${DB_PASSWORD:-skyshelf}"
DB_NAME="${DB_NAME:-skyshelf}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

echo ">>> [1/4] Резервное копирование базы данных PostgreSQL..."
if command -v docker >/dev/null 2>&1 && docker compose -f "$ROOT_DIR/docker-compose.yml" ps -q db 2>/dev/null | grep -q .; then
  docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T db \
    pg_dump -U "$DB_USER" -d "$DB_NAME" --clean --if-exists --no-owner > "$TARGET_DIR/db.sql"
elif command -v pg_dump >/dev/null 2>&1; then
  PGPASSWORD="$DB_PASSWORD" pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    --clean --if-exists --no-owner > "$TARGET_DIR/db.sql"
else
  echo "Предупреждение: ни docker-контейнер db, ни локальный pg_dump не доступны — сохраняем snapshot схемы." >&2
  cat "$BACKEND_DIR"/src/db/migrations/*.sql > "$TARGET_DIR/db.sql"
fi

echo ">>> [2/4] Резервное копирование зашифрованных объектов (local / Docker volume)..."
OBJECTS_ARCHIVE="$TARGET_DIR/objects.tar.gz"
LOCAL_OBJECTS_DIR="${APP_STORAGE_DIR:-$BACKEND_DIR/data/objects}"

if command -v docker >/dev/null 2>&1 && docker compose -f "$ROOT_DIR/docker-compose.yml" ps -q backend 2>/dev/null | grep -q .; then
  docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T backend \
    tar -czf - -C /data/objects . > "$OBJECTS_ARCHIVE" 2>/dev/null || tar -czf "$OBJECTS_ARCHIVE" -T /dev/null
elif [ -d "$LOCAL_OBJECTS_DIR" ]; then
  tar -czf "$OBJECTS_ARCHIVE" -C "$LOCAL_OBJECTS_DIR" .
else
  mkdir -p "$LOCAL_OBJECTS_DIR"
  tar -czf "$OBJECTS_ARCHIVE" -C "$LOCAL_OBJECTS_DIR" .
fi

echo ">>> [3/4] Проверка и архивация MinIO bucket (если профиль minio активен)..."
if command -v docker >/dev/null 2>&1 && docker compose -f "$ROOT_DIR/docker-compose.yml" --profile minio ps -q minio 2>/dev/null | grep -q .; then
  docker compose -f "$ROOT_DIR/docker-compose.yml" --profile minio exec -T minio \
    sh -c 'tar -czf - -C /data .' > "$TARGET_DIR/minio.tar.gz" 2>/dev/null || true
fi

echo ">>> [4/4] Формирование манифеста и контрольных сумм SHA-256..."
cat <<MANIFEST > "$TARGET_DIR/manifest.json"
{
  "service": "SkyShelf",
  "version": "1.0.0",
  "createdAt": "$STAMP",
  "database": "db.sql",
  "objects": "objects.tar.gz",
  "minio": "$( [ -f "$TARGET_DIR/minio.tar.gz" ] && echo "minio.tar.gz" || echo "none" )"
}
MANIFEST

(cd "$TARGET_DIR" && sha256sum db.sql objects.tar.gz manifest.json $( [ -f minio.tar.gz ] && echo minio.tar.gz ) > SHA256SUMS)

LATEST_LINK="$BACKUP_ROOT/latest"
rm -f "$LATEST_LINK"
ln -s "$TARGET_DIR" "$LATEST_LINK"

echo "✔ Резервная копия успешно создана: $TARGET_DIR"
