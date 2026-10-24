#!/usr/bin/env bash
# SkyShelf — восстановление PostgreSQL и зашифрованных объектов из резервной копии.
# Использование:
#   npm run restore -- [путь_к_папке_бэкапа]
#   (по умолчанию берётся backups/latest)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$BACKEND_DIR/.." && pwd)"

SOURCE_DIR="${1:-$BACKEND_DIR/backups/latest}"
if [ ! -d "$SOURCE_DIR" ]; then
  echo "Ошибка: каталог резервной копии не найден: $SOURCE_DIR" >&2
  exit 1
fi

echo ">>> [1/4] Проверка контрольных сумм SHA-256 в $SOURCE_DIR..."
(cd "$SOURCE_DIR" && sha256sum -c SHA256SUMS)

DB_USER="${DB_USER:-skyshelf}"
DB_PASSWORD="${DB_PASSWORD:-skyshelf}"
DB_NAME="${DB_NAME:-skyshelf}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

echo ">>> [2/4] Восстановление базы данных PostgreSQL..."
if command -v docker >/dev/null 2>&1 && docker compose -f "$ROOT_DIR/docker-compose.yml" ps -q db 2>/dev/null | grep -q .; then
  docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T db \
    psql -U "$DB_USER" -d "$DB_NAME" -v ON_ERROR_STOP=1 < "$SOURCE_DIR/db.sql"
elif command -v psql >/dev/null 2>&1; then
  PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -v ON_ERROR_STOP=1 < "$SOURCE_DIR/db.sql"
else
  echo "Предупреждение: ни контейнер db, ни локальный psql не запущены — пропуск SQL-импорта." >&2
fi

echo ">>> [3/4] Восстановление зашифрованных объектов..."
LOCAL_OBJECTS_DIR="${APP_STORAGE_DIR:-$BACKEND_DIR/data/objects}"
if command -v docker >/dev/null 2>&1 && docker compose -f "$ROOT_DIR/docker-compose.yml" ps -q backend 2>/dev/null | grep -q .; then
  docker compose -f "$ROOT_DIR/docker-compose.yml" exec -T backend \
    sh -c 'rm -rf /data/objects/* && tar -xzf - -C /data/objects' < "$SOURCE_DIR/objects.tar.gz"
else
  mkdir -p "$LOCAL_OBJECTS_DIR"
  rm -rf "${LOCAL_OBJECTS_DIR:?}"/*
  tar -xzf "$SOURCE_DIR/objects.tar.gz" -C "$LOCAL_OBJECTS_DIR"
fi

echo ">>> [4/4] Восстановление MinIO (если архив содержит minio.tar.gz)..."
if [ -f "$SOURCE_DIR/minio.tar.gz" ] && command -v docker >/dev/null 2>&1 && docker compose -f "$ROOT_DIR/docker-compose.yml" --profile minio ps -q minio 2>/dev/null | grep -q .; then
  docker compose -f "$ROOT_DIR/docker-compose.yml" --profile minio exec -T minio \
    sh -c 'rm -rf /data/* && tar -xzf - -C /data' < "$SOURCE_DIR/minio.tar.gz" || true
fi

echo "✔ Восстановление из $SOURCE_DIR успешно завершено."
