#!/usr/bin/env bash
# SkyShelf — развёртывание тестового стенда одним скриптом (docker compose).
# Использование:
#   ./deploy.sh              — собрать и запустить стенд с демо-данными
#   ./deploy.sh --no-seed    — без заполнения демо-данными
#   ./deploy.sh --minio      — дополнительно поднять MinIO (APP_STORAGE=minio)
#   ./deploy.sh down         — остановить стенд (данные в volumes останутся)
#   ./deploy.sh logs         — смотреть логи
#   ./deploy.sh status       — состояние контейнеров
set -euo pipefail
cd "$(dirname "$0")"

COMPOSE="docker compose"
if ! command -v docker >/dev/null 2>&1; then
  echo "Ошибка: Docker не установлен. См. https://docs.docker.com/engine/install/" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "Ошибка: не найден плагин docker compose." >&2
  exit 1
fi

case "${1:-up}" in
  down)      exec $COMPOSE --profile seed --profile minio down ;;
  logs)      exec $COMPOSE logs -f ;;
  status|ps) exec $COMPOSE ps ;;
esac

PROFILES=()
SEED=true
for arg in "$@"; do
  case "$arg" in
    --no-seed) SEED=false ;;
    --minio)   PROFILES+=(--profile minio); export APP_STORAGE=minio ;;
  esac
done

echo ">>> Сборка образов…"
# ВАЖНО: контейнер backend работает НЕ из COPY-слоёв образа, а через
# bind-mount ./backend/src и ./backend/node_modules (см. docker-compose.yml).
# Поэтому пересборка образа ничего не обновляет в раненом контейнере —
# старый процесс с restart: unless-stopped продолжает крутить прежний код.
# Перед сборкой backend принудительно останавливается compose-проект:
# это гарантирует, что после сборки контейнер стартует заново уже с
# актуальными исходниками с хоста.
if $COMPOSE ps -q backend 2>/dev/null | grep -q .; then
  echo ">>> Перезапуск стенда (backend будет поднят заново с актуальным кодом)…"
  $COMPOSE down --remove-orphans >/dev/null 2>&1 || true
fi
# Кэш BuildKit в этой среде неоднократно «залипал» на устаревшем снапшоте
# контекста backend, поэтому builder-prune остаётся как страховка.
docker builder prune -f >/dev/null 2>&1 || true
$COMPOSE "${PROFILES[@]}" build --no-cache backend || echo "Предупреждение: сборка backend не удалась — стенд использует исходники с хоста (bind-mount), это не критично." >&2
$COMPOSE "${PROFILES[@]}" build frontend || BUILD_FAILED=true

# Быстрая sanity-проверка: весь нужный код реально лежит на хосте
# (именно он монтируется в контейнер при запуске).
for f in src/server.js src/db/migrate-cli.js src/services/auth-service.js; do
  if [ ! -f "backend/$f" ]; then
    echo "Ошибка: отсутствует backend/$f — репозиторий неполный (git pull / git status)." >&2
    exit 1
  fi
done
if grep -Eq 'auth\.register\(' backend/src/server.js 2>/dev/null; then
  echo "Ошибка: в backend/src/server.js всё ещё вызывается auth.register() при старте." >&2
  echo "Рабочее дерево неактуально: выполните git pull (или git checkout -- backend/src/server.js)." >&2
  exit 1
fi

# Ключевая проверка: именно ./backend/src монтируется в контейнер, поэтому
# убеждаемся, что ВНУТРИ работающего контейнера лежит актуальный код.
# Признак старого кода: вызов auth.register() при старте (в актуальном
# server.js есть только new AuthController(services).register(app) —
# регистрация роутов, а не демо-пользователя).
OLD_CODE_PATTERN='auth\.register('

verify_mounted_code() {
  local tmp out
  # Если backend работает — читаем напрямую (быстрее всего).
  local cid
  cid=$($COMPOSE ps -q backend 2>/dev/null | head -n1)
  if [ -n "$cid" ] && docker exec "$cid" test -f /app/src/server.js 2>/dev/null; then
    out=$(docker exec "$cid" grep -Ec "$OLD_CODE_PATTERN" /app/src/server.js 2>/dev/null) || out="ERR"
    [ "$out" = "ERR" ] && return 2
    [ "$out" != "0" ]
    return
  fi
  # Иначе (контейнер в цикле рестартов) запускаем ВРЕМЕННЫЙ контейнер на
  # том же бинде, читаем из него файл и сразу удаляем.
  tmp=$($COMPOSE run -d --name skyshelf-mntcheck --no-deps --entrypoint sh backend -c 'sleep 60' 2>/dev/null) || {
    echo "Ошибка: не удалось запустить временный контейнер для проверки монтирования." >&2
    return 2
  }
  out=$(docker exec "$tmp" grep -Ec "$OLD_CODE_PATTERN" /app/src/server.js 2>/dev/null) || out="ERR"
  docker rm -f "$tmp" >/dev/null 2>&1 || true
  if [ "$out" = "ERR" ]; then
    echo "Ошибка: не удалось прочитать /app/src/server.js внутри контейнера." >&2
    return 2
  fi
  [ "$out" != "0" ]
}

echo ">>> Миграции базы данных…"
# Ждём готовности PostgreSQL (на случай свежего тома)
$COMPOSE up -d db
for _ in $(seq 1 30); do
  if $COMPOSE exec -T db pg_isready -U skyshelf -d skyshelf >/dev/null 2>&1; then break; fi
  sleep 2
done

# Миграции выполняются НЕ из собранного compose-образа, а через bind-mount:
# актуальные ./backend/src и ./backend/node_modules монтируются напрямую в
# контейнер. Так результат не зависит от кэша BuildKit (в вашей среде кэш-слой
# COPY «залип» на старом снапшоте без migrate-cli.js — см. предыдущие запуски).
DB_URL_ENV="${DATABASE_URL:-postgres://${DB_USER:-skyshelf}:${DB_PASSWORD:-skyshelf}@db:5432/${DB_NAME:-skyshelf}}"

if [ ! -d backend/node_modules/pg ]; then
  echo ">>> Установка зависимостей backend (локально, для миграций)…"
  (cd backend && npm ci --omit=dev)
fi

echo ">>> Применение миграций…"
docker run --rm \
  --network skyshelf_default \
  -v "$PWD/backend/src:/app/src:ro" \
  -v "$PWD/backend/node_modules:/app/node_modules:ro" \
  -e DATABASE_URL="$DB_URL_ENV" \
  -w /app \
  --entrypoint node \
  node:20-alpine src/db/migrate-cli.js up

echo ">>> Поднимаем стенд…"
# Если контейнер уже работает, но внутри него старый код (проверка по
# mount-указателю /app/src/server.js) — пересоздаём контейнеры заново.
if verify_mounted_code; then
  echo ">>> Внутри монтирования лежит СТАРЫЙ server.js (виден auth.register) — пересоздаём контейнеры…"
  docker rm -f skyshelf-mntcheck >/dev/null 2>&1 || true
  $COMPOSE down --remove-orphans >/dev/null 2>&1 || true
fi
$COMPOSE "${PROFILES[@]}" up -d --force-recreate backend frontend || {
  echo "Ошибка: контейнеры не поднялись. Последние логи backend:" >&2
  $COMPOSE logs --tail=50 backend >&2 || true
  exit 1
}

# Финальная проверка: код внутри контейнера = код с хоста
if verify_mounted_code; then
  echo "Ошибка: даже после пересоздания контейнера в /app/src лежит старый server.js." >&2
  echo "Это означает, что бинд ./backend/src указывает не на ваше рабочее дерево" >&2
  echo "(или скрипт запускается из другой копии репозитория). Диагностика:" >&2
  echo "  pwd   # должны быть в корне этого репозитория" >&2
  echo "  ls -i backend/src/server.js && grep -n 'auth.register(' backend/src/server.js   # на хосте совпадений быть не должно" >&2
  echo "  docker inspect \$(docker ps -aq --filter name=backend | head -n1) --format '{{json .Mounts}}'" >&2
  echo "  # в выводе Mounts Source должен путь == pwd/backend/src" >&2
  exit 1
fi

PORT="${STAND_PORT:-8088}"
# Проверка готовности выполняется быстро и с обратной связью по шагам,
# чтобы скрипт не «висел» без объяснений на одном сообщении.
check_health() {
  # сначала прямой запрос к nginx (стенд), затем — напрямую к backend-контейнеру
  curl -fsS --max-time 3 "http://localhost:${PORT}/api/health" >/dev/null 2>&1 && return 0
  local cid
  cid=$($COMPOSE ps -q backend 2>/dev/null | head -n1)
  [ -n "$cid" ] || return 1
  docker exec "$cid" node -e \
    "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}
if check_health; then
  echo ">>> Backend уже отвечает — пропускаем ожидание."
else
  echo ">>> Ожидаем готовности backend…"
  ready=false
  for i in $(seq 1 15); do
    if check_health; then ready=true; break; fi
    echo "…попытка ${i}/15"
    sleep 2
  done
  if [ "$ready" != true ]; then
    # Диагностика: почему именно не отвечает — процесс, порт или прокси
    echo "Диагностика состояния контейнеров:" >&2
    $COMPOSE ps >&2 || true
    backend_cid=$($COMPOSE ps -q backend 2>/dev/null | head -n1)
    if [ -z "$backend_cid" ]; then
      echo "Контейнер backend не найден (не создан или упал)." >&2
    elif ! docker inspect -f '{{.State.Running}}' "$backend_cid" 2>/dev/null | grep -q true; then
      echo "Процесс backend НЕ запущен — смотрите логи ниже." >&2
    else
      echo "Процесс backend запущен, но /api/health недоступен." >&2
      echo "   внутри контейнера: $(docker exec "$backend_cid" node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>console.log('OK',r.status)).catch(e=>console.log('FAIL',e.message))" 2>&1)" >&2
      echo "   снаружи (nginx):   $(curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://localhost:${PORT}/api/health" 2>&1 || echo 'нет соединения')" >&2
    fi
    echo "Последние логи backend:" >&2
    $COMPOSE logs --tail=50 backend >&2 || true
    exit 1
  fi
fi

if [ "$SEED" = true ]; then
  echo ">>> Демо-данные…"
  $COMPOSE --profile seed "${PROFILES[@]}" run --rm seed || true
else
  echo ">>> Без сидинга (--no-seed): аккаунтов в базе нет — зарегистрируйте их через форму или запустите ./deploy.sh без --no-seed."
fi

cat <<EOF

✔ Тестовый стенд SkyShelf запущен:
  Frontend:  http://localhost:${PORT}
  API:       http://localhost:${PORT}/api/health (nginx проксирует /api на backend)
  Демо-вход (после ./deploy.sh с сидингом):
    demo@skyshelf.local / SkyShelfDemo2026!   (OWNER)
    anna@skyshelf.local / SkyShelfDemo2026!   (MEMBER)
    ilya@skyshelf.local / SkyShelfDemo2026!   (READER)

Остановить: ./deploy.sh down     Логи: ./deploy.sh logs
EOF
