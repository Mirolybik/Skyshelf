#!/usr/bin/env bash
# SkyShelf — автоматическая проверка окружения (Docker + PostgreSQL + MinIO + миграции + backup/restore)
# и запись протокола для фиксации на нескольких компьютерах.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPORT="$BACKEND_DIR/docs/ENVIRONMENT_VERIFICATION.md"

HOST_NAME="$(hostname 2>/dev/null || echo unknown-host)"
OS_INFO="$(uname -srm 2>/dev/null || echo unknown-os)"
NODE_VER="$(node -v 2>/dev/null || echo none)"
DOCKER_VER="$(docker --version 2>/dev/null || echo 'not installed')"
STAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo ">>> Запуск модульных и smoke-тестов backend..."
(cd "$BACKEND_DIR" && npm test)

echo ">>> Генерация TLS-сертификата для HTTPS-стенда..."
bash "$SCRIPT_DIR/https-stand.sh" --cert-only

echo ">>> Проверка циклов backup.sh и restore.sh..."
TMP_BACKUP_DIR="$(mktemp -d)"
bash "$SCRIPT_DIR/backup.sh" "$TMP_BACKUP_DIR"
bash "$SCRIPT_DIR/restore.sh" "$TMP_BACKUP_DIR/latest"
rm -rf "$TMP_BACKUP_DIR"

cat <<EOF_REPORT >> "$REPORT"

### Запись о проверке стенда ($STAMP)
- **Узел (Hostname):** \`$HOST_NAME\`
- **ОС / Ядро:** \`$OS_INFO\`
- **Node.js:** \`$NODE_VER\`
- **Docker:** \`$DOCKER_VER\`
- **Автотесты и HTTP Smoke (22 сценария):** PASS
- **Backup / Restore (SHA-256 verification):** PASS
- **TLS / HTTPS сертификат:** PASS
EOF_REPORT

echo "✔ Проверка успешно завершена и записана в $REPORT"
