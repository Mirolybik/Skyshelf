# SkyShelf

**SkyShelf** — защищённое облачное пространство для учебных команд. Сервис объединяет файлы, историю версий, участников, чек-лист сдачи, дедлайн и контролируемую сдачу преподавателю.

Проект подготовлен по дисциплине «Создание программного обеспечения» (группа ЭФБО-14-24). Текущая ветка — Node.js-версия backend (переписана с Java Spring Boot).

## Возможности

### Облачное хранилище
- загрузка и точное скачивание TXT, MD, CSV, PDF, PNG, JPG, ZIP, DOCX, XLSX и PPTX;
- папки, поиск, фильтры, переименование, перемещение и избранное;
- корзина, восстановление и окончательное удаление;
- версии файлов с комментарием, автором, контрольной суммой и восстановлением старой версии как новой;
- квоты 15/100/500 ГБ; история версий и корзина учитываются в занятом объёме.

### Функции для студентов
- отдельные учебные проекты с предметом, преподавателем, дедлайном, описанием, цветом и обложкой;
- роли `OWNER`, `MEMBER` и `READER`;
- чек-лист сдачи с прогрессом, исполнителями и сроками;
- выбор единственного итогового файла;
- публичная карточка для преподавателя с командой, описанием и проверяемой контрольной суммой;
- экспорт всего проекта в ZIP с манифестом и префиксом `FINAL_` у итогового файла;
- журнал действий команды.

### Защита данных
- пароли пользователей и пароли публичных ссылок — Argon2id с солью;
- файлы и секреты 2FA — AES-256-GCM, случайный 96-битный nonce на каждую операцию;
- контрольная сумма открытого файла — SHA-256, проверяется перед выдачей;
- TOTP-2FA по RFC 6238;
- случайные 256-битные публичные токены; в БД хранится только SHA-256 токена;
- срок действия, пароль, лимит скачиваний и ручной отзыв ссылок;
- серверные сессии, HttpOnly/SameSite cookie, смена session ID при входе и CSRF-токены;
- RBAC и проверка доступа на каждом серверном запросе;
- CSP, `nosniff`, запрет iframe и выдача файлов только как attachment;
- ограничение попыток входа и аудит значимых событий.

> Это **серверное шифрование данных в хранилище**, а не end-to-end encryption: после проверки сессии и прав backend расшифровывает файл для скачивания.

## Стек

| Слой | Технология |
| --- | --- |
| Frontend | HTML, CSS, JavaScript без фреймворка (статика + Node.js-сервер с прокси `/api`) |
| Backend | Node.js ≥ 20, Fastify, Argon2, pg |
| Данные | PostgreSQL 17 (миграции SQL), объектное хранилище local или MinIO |
| Безопасность | AES-256-GCM, SHA-256, Argon2id, TOTP, серверные сессии, CSRF |

## Структура репозитория

```
backend/            # Node.js backend (Fastify)
  src/
    config.js       # конфигурация через переменные окружения
    controllers/    # HTTP-контроллеры (auth и др.)
    services/       # auth, crypto, storage, projects, audit, totp, object-store
    repositories/   # слой доступа к данным
    domain/         # сущности и ошибки
    db/             # подключение к PostgreSQL и миграции (src/db/migrations)
  test/             # тесты (node --test)
frontend/           # статический фронтенд + server.js (раздача статики и прокси /api)
docs/               # документация проекта (API, архитектура, безопасность, тестирование)
```

## Быстрый старт

### Вариант 1: Docker (рекомендуется) — тестовый стенд одним скриптом

Требования: **Docker** с плагином **docker compose**.

```bash
./deploy.sh              # собрать образы, миграции, запуск + демо-данные
./deploy.sh --no-seed    # без демо-данных
./deploy.sh --minio      # дополнительно поднять MinIO (APP_STORAGE=minio)
./deploy.sh status       # состояние контейнеров
./deploy.sh logs         # логи
./deploy.sh down         # остановить (данные в volumes сохранятся)
```

Стенд доступен на `http://localhost:8088` (порт меняется через `STAND_PORT`).
Состав: PostgreSQL 16, backend (Fastify), frontend (nginx, проксирует `/api`).
Миграции и сид выполняются bind-монтированием `backend/src`, `backend/scripts`
и `backend/node_modules` из хоста — актуальный код попадает в контейнер напрямую.

### Вариант 2: локально без Docker

Требования: **Node.js ≥ 20** и **PostgreSQL** (локально или в Docker).

### 1. Backend

```bash
cd backend
npm install

# параметры подключения (по умолчанию — localhost:5432, БД skyshelf)
export DB_USER=skyshelf DB_PASSWORD=skyshelf DB_NAME=skyshelf
export SKYSHELF_MASTER_KEY='<base64-ключ 32 байта>'   # обязательно в продакшене

npm run migrate          # применить миграции (src/db/migrations)
npm start                # http://127.0.0.1:8080
```

### 2. Frontend

```bash
cd frontend
node server.js           # раздача статики и прокси /api на backend
```

Откройте `http://localhost:5500` (порт статического сервера).

### Демо-данные

```bash
cd backend
APP_DEMO=true npm run seed   # демо-проект и аккаунты
```

| Аккаунт | Пароль | Роль |
| --- | --- | --- |
| `demo@skyshelf.local` | `SkyShelfDemo2026!` | владелец демонстрационного проекта |
| `team@skyshelf.local` | `SkyShelfDemo2026!` | участник, может менять проектные файлы |
| `reader@skyshelf.local` | `SkyShelfDemo2026!` | читатель, только просмотр и скачивание |
| `admin@skyshelf.local` | `SkyShelfAdmin2026!` | администрирование без доступа к чужому содержимому |

В Docker-стенде (`./deploy.sh`) при `APP_DEMO=true` сервер сам создаёт
упрощённый тестовый аккаунт `demo@skyshelf.local` / `demo-password-123`, если его ещё нет, —
чтобы можно было проверить API даже без сидинга. По умолчанию в compose-стенде
`APP_DEMO=false`: демо-данные (аккаунты выше) создаёт seed — `./deploy.sh` без `--no-seed`.

## Конфигурация (переменные окружения)

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `PORT` / `SERVER_ADDRESS` | `8080` / `127.0.0.1` | адрес HTTP-сервера |
| `DATABASE_URL` или `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_NAME` | `postgres://skyshelf:skyshelf@localhost:5432/skyshelf` | PostgreSQL |
| `APP_STORAGE` | `local` | драйвер объектов: `local` или `minio` |
| `APP_STORAGE_DIR` | `./data/objects` | каталог локального хранилища |
| `MINIO_ENDPOINT` / `MINIO_USER` / `MINIO_PASSWORD` / `MINIO_BUCKET` | `http://localhost:9000` / `skyshelf` / — / `skyshelf` | MinIO |
| `SKYSHELF_MASTER_KEY` | демо-ключ | master-ключ AES-256-GCM (обязательно заменить) |
| `APP_DEMO` | `false` | включение демо-режима |
| `PUBLIC_ORIGIN` / `FORCE_HTTPS` | — / `false` | HTTPS-редирект стенда |

## Скрипты backend

```bash
npm run migrate        # node src/db/migrate.js up
npm run migrate:status # состояние миграций
npm run seed           # демо-данные
npm run backup         # резервная копия (scripts/backup.sh)
npm run restore        # восстановление (scripts/restore.sh)
npm test               # node --test test/
```

## Документация

Документация проекта (API, архитектура, безопасность, тестирование) находится в [`docs/`](docs/): [API.md](docs/API.md), [ARCHITECTURE.md](docs/ARCHITECTURE.md), [SECURITY.md](docs/SECURITY.md), [TESTING.md](docs/TESTING.md).

## Лицензия

Учебный проект. Все права защищены.
