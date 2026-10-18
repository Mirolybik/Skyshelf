# REST API SkyShelf Final 1.0

Локальный frontend: `http://localhost:5500`. Все клиентские запросы идут на тот же origin с префиксом `/api`; Java frontend-сервер проксирует их на backend `127.0.0.1:8080`.

## Сессия и CSRF

1. `GET /api/auth/csrf` создаёт сессию и возвращает `token` и имя заголовка.
2. Каждый `POST`, `PATCH` и `DELETE` должен передать токен в этом заголовке и cookie сессии.
3. После успешного входа frontend получает свежий CSRF-токен.
4. Cookie — HttpOnly и SameSite=Lax; в cloud-профиле также Secure.

```javascript
const csrf = await fetch("/api/auth/csrf", { credentials: "same-origin" }).then(r => r.json());
await fetch("/api/auth/login", {
  method: "POST",
  credentials: "same-origin",
  headers: { "Content-Type": "application/json", [csrf.header]: csrf.token },
  body: JSON.stringify({
    email: "demo@skyshelf.local",
    password: "SkyShelfDemo2026!",
    code: "123456" // только если включена 2FA
  })
});
```

Ошибки возвращаются JSON-объектом `{ "message": "…" }`. Недоступный или чужой объект обычно даёт 404, чтобы не подтверждать его существование.

## Аутентификация и профиль

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| GET | `/api/health` | `status`, версия приложения и алгоритм шифрования |
| GET | `/api/auth/csrf` | Получить CSRF-токен |
| POST | `/api/auth/register` | `name`, `email`, `password` 10–128 символов |
| POST | `/api/auth/login` | `email`, `password`, необязательный `code` TOTP |
| POST | `/api/auth/logout` | Завершить серверную сессию |
| GET | `/api/me` | Профиль без хешей и секретов |
| PATCH | `/api/me` | `name`, `theme` dark/light, `accent` blue/violet/mint |

## Личное и проектное пространство

`GET /files`, `/folders`, `/storage` без параметров работает с личным пространством. Параметр `?projectId={uuid}` переключает запрос на проект и требует членства.

### Файлы

| Метод | Маршрут | Тело / результат |
| --- | --- | --- |
| GET | `/api/files` | Список файлов, включая корзину |
| POST | `/api/files` | multipart: `file`, необязательные `folderId`, `projectId`; 201 |
| GET | `/api/files/{id}/download` | Расшифрованные байты текущей версии как attachment |
| PATCH | `/api/files/{id}` | Необязательные `name`, `folderId`, `favorite`, `trashed` |
| DELETE | `/api/files/{id}` | Переместить в корзину и отозвать ссылки |
| DELETE | `/api/files/{id}/permanent` | Физически удалить файл и все версии; только из корзины |
| GET | `/api/storage` | Тариф, квота, занятое место, число файлов и алгоритм шифрования |

DTO файла содержит: `id`, `projectId`, `name`, `size`, `mimeType`, `checksum`, `versionCount`, `folderId`, `favorite`, `trashed`, `createdAt`, `updatedAt`. Внутренний ключ объекта никогда не отдаётся клиенту.

Одна загрузка — до 20 МБ. Сервер проверяет расширение и базовую сигнатуру. Разрешены TXT, MD, CSV, PDF, PNG, JPG/JPEG, ZIP, DOCX, XLSX и PPTX.

### Версии

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| GET | `/api/files/{id}/versions` | История сверху вниз: номер, автор, заметка, SHA‑256 и дата |
| POST | `/api/files/{id}/versions` | multipart: `file`, необязательный `note`; расширение должно совпасть |
| GET | `/api/files/{id}/versions/{versionId}/download` | Скачать конкретную версию |
| POST | `/api/files/{id}/versions/{versionId}/restore` | Создать новую текущую версию из выбранной старой |

Все версии шифруются независимо и учитываются в квоте. Восстановление не удаляет историю.

### Папки

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| GET | `/api/folders` | Папки пространства |
| POST | `/api/folders` | `name`, `color`, необязательный `projectId` |
| PATCH | `/api/folders/{id}` | `name`, `color` |
| DELETE | `/api/folders/{id}` | Удалить только пустую папку |

Цвета: `blue`, `violet`, `mint`, `amber`, `cyan`, `rose`.

## Защищённые ссылки на файл

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| GET | `/api/files/{id}/share` | Метаданные активной ссылки без исходного токена |
| POST | `/api/files/{id}/share` | `hours` 1–720, `password` 4–64 или пусто, `maxDownloads` 0–1000 |
| DELETE | `/api/files/{id}/share` | Отозвать ссылки файла |
| GET | `/api/public/{token}` | Публичные метаданные файла |
| GET | `/api/public/{token}/download` | Скачать файл, если у ссылки нет пароля |
| POST | `/api/public/{token}/download` | `{ "password": "…" }` для защищённой ссылки |

`POST /share` возвращает исходный `token` **только один раз**. Поле `id` — его SHA‑256-представление, сохранённое в БД. После достижения `maxDownloads`, истечения срока, отзыва или перемещения файла в корзину публичный запрос получает 404.

## Учебные проекты

### Проект и роли

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| GET | `/api/projects` | Доступные проекты и роль текущего пользователя |
| GET | `/api/projects/{id}` | Полная карточка проекта |
| POST | `/api/projects` | Создать: `name`, `description`, `course`, `teacher`, `deadline`, `accent`, `cover` |
| PATCH | `/api/projects/{id}` | Изменить поля и `status`; только OWNER |
| GET | `/api/projects/{id}/members` | Команда проекта |
| POST | `/api/projects/{id}/members` | `email`, роль MEMBER/READER; только OWNER |
| PATCH | `/api/projects/{id}/members/{membershipId}` | Изменить роль |
| DELETE | `/api/projects/{id}/members/{membershipId}` | Отозвать доступ |

Обложки: `orb`, `grid`, `aurora`, `minimal`. Статусы: `IN_PROGRESS`, `READY`, `SUBMITTED`. Базовый проект допускает до пяти участников с владельцем; тариф TEAM — до 25.

### Чек‑лист и сдача

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| GET | `/api/projects/{id}/tasks` | Чек‑лист проекта |
| POST | `/api/projects/{id}/tasks` | `title`, необязательные `assigneeId`, `dueAt` |
| PATCH | `/api/projects/{id}/tasks/{taskId}` | `title`, `completed`, `assigneeId`, `dueAt` |
| DELETE | `/api/projects/{id}/tasks/{taskId}` | Удалить пункт |
| POST | `/api/projects/{id}/final/{fileId}` | Назначить итоговый файл; только OWNER |
| GET | `/api/projects/{id}/submissions` | Активная ссылка преподавателю без исходного токена |
| POST | `/api/projects/{id}/submissions` | `{ "hours": 168 }`; возвращает токен один раз |
| DELETE | `/api/projects/{id}/submissions` | Отозвать преподавательскую ссылку |
| GET | `/api/projects/{id}/export` | ZIP проекта с манифестом |
| GET | `/api/public/projects/{token}` | Публичная карточка проекта; увеличивает счётчик просмотров |
| GET | `/api/public/projects/{token}/download` | Скачать только итоговый файл |

## Безопасность аккаунта и аудит

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| GET | `/api/security/overview` | Активные механизмы защиты и состояние 2FA |
| POST | `/api/security/2fa/setup` | Создать TOTP-секрет и `otpauth://` URI |
| POST | `/api/security/2fa/enable` | Проверить `{ "code": "123456" }` и включить 2FA |
| POST | `/api/security/2fa/disable` | `{ "password": "…", "code": "…" }` |
| POST | `/api/security/password` | `currentPassword`, `newPassword` |
| GET | `/api/activity?limit=100` | Видимые события пользователя и его проектов |

TOTP-секрет хранится в БД только в зашифрованном виде. API никогда не возвращает его после завершения настройки.

## Администрирование

Маршруты требуют системной роли ADMIN. Эта роль не даёт автоматического доступа к чужим файлам.

| Метод | Маршрут | Назначение |
| --- | --- | --- |
| GET | `/api/admin/users` | Аккаунты без хешей и 2FA-секретов |
| PATCH | `/api/admin/users/{id}` | `{ "blocked": true/false }` |
| GET | `/api/admin/stats` | Агрегаты пользователей, проектов, файлов, версий и аудита |
| GET | `/api/admin/projects` | Метаданные проектов |
| PATCH | `/api/admin/users/{id}/plan` | Назначить START/PERSONAL/TEAM |
| PATCH | `/api/admin/projects/{id}/plan` | Назначить тариф проекту |

## Коды ответа

- `200/201` — успешно;
- `400` — нарушено бизнес-правило или формат;
- `401` — нет входа, неверный пароль или TOTP;
- `403` — роль не разрешает действие или не прошёл CSRF;
- `404` — объект не существует либо скрыт политикой доступа;
- `409` — конфликт уникальности;
- `413` — файл/запрос превышает лимит;
- `429` — превышен лимит попыток входа;
- `500` — например, не прошла криптографическая проверка целостности.
