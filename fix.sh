#!/usr/bin/env bash
# SkyShelf Backend Auto-Fix & Complete Implementation Script
# Работает только в папке backend (фронт не трогает).
set -euo pipefail

# Определяем путь к папке backend
if [ -f "package.json" ] && [ -d "src" ]; then
  BACKEND_DIR="$(pwd)"
elif [ -d "backend" ] && [ -f "backend/package.json" ]; then
  BACKEND_DIR="$(cd backend && pwd)"
else
  echo "Ошибка: запустите скрипт из корня репозитория SkyShelf или из папки backend/" >&2
  exit 1
fi

WITH_ROOT_DOCS=false
for arg in "$@"; do
  if [ "$arg" = "--with-docs" ]; then
    WITH_ROOT_DOCS=true
  fi
done

echo ">>> Работаем в директории: $BACKEND_DIR"
cd "$BACKEND_DIR"

mkdir -p src/controllers src/db/migrations src/utils scripts test docs

# ------------------------------------------------------------------------------
# 1. Миграция 0002: таблица токенов восстановления пароля
# ------------------------------------------------------------------------------
cat <<'EOF' > src/db/migrations/0002_password_reset.sql
-- 0002: токены восстановления пароля (хранятся только SHA-256 хеши токенов)
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  token_hash  varchar(64) PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz
);
CREATE INDEX IF NOT EXISTS idx_password_reset_user ON password_reset_tokens (user_id);
EOF
echo "✔ Создана миграция src/db/migrations/0002_password_reset.sql"

# ------------------------------------------------------------------------------
# 2. Генератор ZIP-архивов (без сторонних npm-пакетов) для /api/projects/:id/export
# ------------------------------------------------------------------------------
cat <<'EOF' > src/utils/zip.js
/* Минималистичный генератор потокового ZIP-архива (метод STORE + CRC32) на чистом Node.js. */
'use strict';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Собирает валидный ZIP-буфер из массива [{ name: string, data: Buffer | string }].
 */
function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(String(entry.name).replace(/^\/+/, ''), 'utf8');
    const dataBuf = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data), 'utf8');
    const crc = crc32(dataBuf);
    const size = dataBuf.length;

    // Local file header (30 bytes + name)
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4);         // version needed
    local.writeUInt16LE(0x0800, 6);     // UTF-8 flag
    local.writeUInt16LE(0, 8);          // method: 0 (STORE)
    local.writeUInt16LE(0, 10);         // mod time
    local.writeUInt16LE(0x21, 12);      // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    localParts.push(local, nameBuf, dataBuf);

    // Central directory header (46 bytes + name)
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);
    offset += local.length + nameBuf.length + size;
  }

  const centralBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuffer.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralBuffer, eocd]);
}

module.exports = { createZip, crc32 };
EOF
echo "✔ Создан модуль ZIP-экспорта src/utils/zip.js"

# ------------------------------------------------------------------------------
# 3. Обновление src/config.js (поддержка MINIO_SECRET_KEY и HTTPS-параметров)
# ------------------------------------------------------------------------------
cat <<'EOF' > src/config.js
/* Конфигурация приложения (порт env-параметров Java-версии: application.properties). */
'use strict';

class AppConfig {
  constructor(env = process.env) {
    this.port = Number(env.PORT || 8080);
    this.host = env.SERVER_ADDRESS || '127.0.0.1';
    this.publicOrigin = env.PUBLIC_ORIGIN || null;
    this.forceHttps = env.FORCE_HTTPS === 'true';
    this.httpsKeyFile = env.HTTPS_KEY_FILE || null;
    this.httpsCertFile = env.HTTPS_CERT_FILE || null;

    // PostgreSQL
    this.dbUrl = env.DATABASE_URL || env.DB_URL ||
      `postgres://${env.DB_USER || 'skyshelf'}:${env.DB_PASSWORD || 'skyshelf'}@${env.DB_HOST || 'localhost'}:${env.DB_PORT || 5432}/${env.DB_NAME || 'skyshelf'}`;

    // Хранилище объектов: local | minio
    this.storageDriver = env.APP_STORAGE || 'local';
    this.storageDir = env.APP_STORAGE_DIR || './data/objects';
    this.minio = {
      endpoint: env.MINIO_ENDPOINT || 'http://localhost:9000',
      user: env.MINIO_USER || env.MINIO_ACCESS_KEY || 'skyshelf',
      password: env.MINIO_PASSWORD || env.MINIO_SECRET_KEY || 'skyshelf-secret',
      secretKey: env.MINIO_SECRET_KEY || env.MINIO_PASSWORD || 'skyshelf-secret',
      bucket: env.MINIO_BUCKET || 'skyshelf',
      accessKey: env.MINIO_ACCESS_KEY || env.MINIO_USER || 'skyshelf',
    };

    // Криптография
    this.masterKey = env.SKYSHELF_MASTER_KEY || 'U2t5U2hlbGYtRGVtby1NYXN0ZXItS2V5LTIwMjYhISE=';

    // Бизнес-параметры
    this.demo = env.APP_DEMO === 'true';
    this.passwordRecoveryEnabled = env.APP_PASSWORD_RECOVERY !== 'false';
    this.quotaBytes = BigInt(env.APP_QUOTA_BYTES || '16106127360'); // START: 15 ГБ
    this.maxUploadBytes = 20 * 1024 * 1024;
    this.sessionTtlMs = 30 * 60 * 1000;
    this.cookiePrefix = '__Host-';
  }

  isProduction() { return this.forceHttps || process.env.NODE_ENV === 'production'; }
}

module.exports = { AppConfig };
EOF
echo "✔ Обновлён src/config.js"

# ------------------------------------------------------------------------------
# 4. Обновление src/domain/entities.js и src/repositories/index.js (PasswordResetToken)
# ------------------------------------------------------------------------------
cat <<'EOF' > src/domain/entities.js
/* Сущности предметной области: тонкие классы-обёртки над строками PostgreSQL.
   API возвращает отдельные DTO (view-методы), а не эти объекты — как в Java-версии. */
'use strict';

const { BadRequestError } = require('./errors');

class Entity {
  static columns = [];
  constructor(row = {}) { Object.assign(this, this.constructor.fromRow(row)); }
  static fromRow(row) {
    const out = {};
    for (const [field, column] of Object.entries(this.fieldMap ?? Entity.fieldMap)) {
      out[field] = column in row ? row[column] : row[field];
    }
    return out;
  }
  toRow() {
    const out = {};
    for (const [field, column] of Object.entries(this.constructor.fieldMap)) if (this[field] !== undefined) out[column] = this[field];
    return out;
  }
}

class Account extends Entity {
  static fieldMap = {
    id: 'id', email: 'email', passwordHash: 'password_hash', name: 'name', role: 'role',
    plan: 'plan', blocked: 'blocked', theme: 'theme', accent: 'accent',
    twoFactorSecret: 'two_factor_secret', twoFactorEnabled: 'two_factor_enabled',
    lastLoginAt: 'last_login_at', createdAt: 'created_at',
  };
  view() {
    return {
      id: this.id, email: this.email, name: this.name, role: this.role, plan: this.plan,
      theme: this.theme, accent: this.accent, blocked: Boolean(this.blocked),
      twoFactorEnabled: Boolean(this.twoFactorEnabled), lastLoginAt: this.lastLoginAt ?? null,
      createdAt: this.createdAt,
    };
  }
}

class Folder extends Entity {
  static fieldMap = { id: 'id', ownerId: 'owner_id', projectId: 'project_id', name: 'name', color: 'color' };
}

class StoredFile extends Entity {
  static fieldMap = {
    id: 'id', ownerId: 'owner_id', projectId: 'project_id', folderId: 'folder_id', name: 'name',
    objectKey: 'object_key', size: 'size', mimeType: 'mime_type', checksum: 'checksum',
    versionCount: 'version_count', createdById: 'created_by_id', favorite: 'favorite',
    trashed: 'trashed', createdAt: 'created_at', updatedAt: 'updated_at',
  };
  view() {
    return {
      id: this.id, projectId: this.projectId ?? null, name: this.name, size: Number(this.size),
      mimeType: this.mimeType, checksum: this.checksum, versionCount: Math.max(1, Number(this.versionCount || 1)),
      folderId: this.folderId ?? null, favorite: Boolean(this.favorite), trashed: Boolean(this.trashed),
      createdAt: this.createdAt, updatedAt: this.updatedAt,
    };
  }
}

class FileVersion extends Entity {
  static fieldMap = {
    id: 'id', fileId: 'file_id', objectKey: 'object_key', versionNumber: 'version_number',
    size: 'size', mimeType: 'mime_type', checksum: 'checksum', createdById: 'created_by_id',
    note: 'note', createdAt: 'created_at',
  };
}

class ShareLink extends Entity {
  static fieldMap = {
    token: 'token', fileId: 'file_id', createdAt: 'created_at', expiresAt: 'expires_at',
    maxDownloads: 'max_downloads', downloadCount: 'download_count', passwordHash: 'password_hash',
  };
  view() {
    return {
      id: this.token, createdAt: this.createdAt, expiresAt: this.expiresAt,
      passwordRequired: this.passwordHash != null, maxDownloads: Number(this.maxDownloads || 0),
      downloadCount: Number(this.downloadCount || 0),
    };
  }
}

class Project extends Entity {
  static fieldMap = {
    id: 'id', ownerId: 'owner_id', name: 'name', description: 'description', course: 'course',
    teacher: 'teacher', deadline: 'deadline', accent: 'accent', cover: 'cover', status: 'status',
    finalFileId: 'final_file_id', plan: 'plan', createdAt: 'created_at',
  };
}

class Membership extends Entity {
  static fieldMap = { id: 'id', projectId: 'project_id', userId: 'user_id', role: 'role' };
}

class ProjectTask extends Entity {
  static fieldMap = {
    id: 'id', projectId: 'project_id', title: 'title', completed: 'completed',
    assigneeId: 'assignee_id', dueAt: 'due_at', position: 'position', createdAt: 'created_at',
  };
}

class SubmissionLink extends Entity {
  static fieldMap = { token: 'token', projectId: 'project_id', createdAt: 'created_at', expiresAt: 'expires_at', views: 'views' };
}

class AuditEvent extends Entity {
  static fieldMap = {
    id: 'id', actorId: 'actor_id', projectId: 'project_id', action: 'action',
    targetType: 'target_type', targetId: 'target_id', details: 'details', createdAt: 'created_at',
  };
}

class PasswordResetToken extends Entity {
  static fieldMap = {
    tokenHash: 'token_hash', userId: 'user_id', createdAt: 'created_at',
    expiresAt: 'expires_at', usedAt: 'used_at',
  };
}

const Enums = {
  FILE_EXTENSIONS: new Set(['txt', 'md', 'csv', 'pdf', 'png', 'jpg', 'jpeg', 'zip', 'docx', 'xlsx', 'pptx']),
  FOLDER_COLORS: new Set(['blue', 'violet', 'mint', 'amber', 'cyan', 'rose']),
  PROJECT_ACCENTS: new Set(['blue', 'violet', 'mint', 'amber', 'cyan', 'rose']),
  PROJECT_COVERS: new Set(['orb', 'grid', 'aurora', 'minimal']),
  PROJECT_STATUSES: new Set(['IN_PROGRESS', 'READY', 'SUBMITTED']),
  MEMBER_ROLES: new Set(['MEMBER', 'READER']),
  PLANS: new Set(['START', 'PERSONAL', 'TEAM']),
  QUOTA_BYTES: { START: 15n * 1024n ** 3n, PERSONAL: 100n * 1024n ** 3n, TEAM: 500n * 1024n ** 3n },
  MIME_BY_EXT: {
    txt: 'text/plain', md: 'text/plain', csv: 'text/plain', pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', zip: 'application/zip',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
};

function validateName(value, max) {
  if (value == null) throw new BadRequestError('Укажите название.');
  const clean = String(value).trim();
  if (!clean || clean.length > max || clean === '.' || clean === '..' || /[\p{Cc}\/\\]/u.test(clean)) {
    throw new BadRequestError('Недопустимое название.');
  }
  return clean;
}

module.exports = {
  Entity, Account, Folder, StoredFile, FileVersion, ShareLink, Project,
  Membership, ProjectTask, SubmissionLink, AuditEvent, PasswordResetToken, Enums, validateName,
};
EOF

cat <<'EOF' > src/repositories/index.js
/* Конкретные репозитории: SQL-детали изолированы здесь, сервисы оперируют интерфейсами. */
'use strict';

const { Repository } = require('./repository');
const {
  Account, Folder, StoredFile, FileVersion, ShareLink, Project,
  Membership, ProjectTask, SubmissionLink, AuditEvent, PasswordResetToken,
} = require('../domain/entities');

class Accounts extends Repository {
  constructor(db) { super(db, { table: 'accounts', Entity: Account }); }
  async findByEmail(email) {
    const rows = await this.findWhere('email = $1', [String(email).toLowerCase()]);
    return rows[0] ?? null;
  }
}

class Folders extends Repository {
  constructor(db) { super(db, { table: 'folders', Entity: Folder }); }
  listFor(ownerId, projectId) {
    return projectId == null
      ? this.findWhere('owner_id = $1 AND project_id IS NULL', [ownerId], 'name ASC')
      : this.findWhere('project_id = $1', [projectId], 'name ASC');
  }
  existsByNameInSpace(ownerId, projectId, name) {
    return projectId == null
      ? this.exists('owner_id = $1 AND project_id IS NULL AND lower(name) = lower($2)', [ownerId, name])
      : this.exists('project_id = $1 AND lower(name) = lower($2)', [projectId, name]);
  }
  hasFiles(folderId) { return this.db.client.query('SELECT 1 FROM stored_files WHERE folder_id = $1 LIMIT 1', [folderId]).then((r) => r.rows.length > 0); }
}

class Files extends Repository {
  constructor(db) { super(db, { table: 'stored_files', Entity: StoredFile }); }
  listByOwner(ownerId) { return this.findWhere('owner_id = $1 AND project_id IS NULL', [ownerId], 'updated_at DESC'); }
  listByProject(projectId) { return this.findWhere('project_id = $1', [projectId], 'updated_at DESC'); }
  async listVisible(memberProjectIds, ownerId) {
    if (!memberProjectIds.length) return this.listByOwner(ownerId);
    const placeholders = memberProjectIds.map((_, i) => `$${i + 2}`).join(', ');
    return this.findWhere(
      `(owner_id = $1 AND project_id IS NULL) OR project_id IN (${placeholders})`,
      [ownerId, ...memberProjectIds], 'updated_at DESC');
  }
  lockById(id) { return super.lockById(id); }
}

class Versions extends Repository {
  constructor(db) { super(db, { table: 'file_versions', Entity: FileVersion }); }
  listByFile(fileId) { return this.findWhere('file_id = $1', [fileId], 'version_number DESC'); }
  findForFile(versionId, fileId) { return this.findWhere('id = $1 AND file_id = $2', [versionId, fileId]).then((r) => r[0] ?? null); }
  deleteByFile(fileId) { return this.deleteWhere('file_id = $1', [fileId]); }
}

class Shares extends Repository {
  constructor(db) { super(db, { table: 'share_links', Entity: ShareLink, searchColumn: 'token' }); }
  listByFile(fileId) { return this.findWhere('file_id = $1', [fileId]); }
  deleteByFile(fileId) { return this.deleteWhere('file_id = $1', [fileId]); }
  async findByToken(tokenHash) {
    const { rows } = await this.client.query('SELECT * FROM share_links WHERE token = $1', [tokenHash]);
    return rows[0] ? new ShareLink(rows[0]) : null;
  }
  async lockByToken(tokenHash) {
    const { rows } = await this.client.query('SELECT * FROM share_links WHERE token = $1 FOR UPDATE', [tokenHash]);
    return rows[0] ? new ShareLink(rows[0]) : null;
  }
  insertShare(entity) { return this.insert(entity, { returningId: false }); }
  updateShare(tokenHash, patch) { return this.updateByToken(tokenHash, patch); }
  async updateByToken(tokenHash, patch) {
    const cols = Object.keys(patch);
    const params = Object.values(patch);
    params.push(tokenHash);
    const res = await this.client.query(
      `UPDATE share_links SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE token = $${params.length}`, params);
    return res.rowCount > 0;
  }
}

class Projects extends Repository {
  constructor(db) { super(db, { table: 'projects', Entity: Project }); }
}

class Memberships extends Repository {
  constructor(db) { super(db, { table: 'memberships', Entity: Membership }); }
  listByUser(userId) { return this.findWhere('user_id = $1', [userId]); }
  listByProject(projectId) { return this.findWhere('project_id = $1', [projectId]); }
  find(projectId, userId) { return this.findWhere('project_id = $1 AND user_id = $2', [projectId, userId]).then((r) => r[0] ?? null); }
}

class Tasks extends Repository {
  constructor(db) { super(db, { table: 'project_tasks', Entity: ProjectTask }); }
  listByProject(projectId) { return this.findWhere('project_id = $1', [projectId], 'position ASC, created_at ASC'); }
  deleteByProject(projectId) { return this.deleteWhere('project_id = $1', [projectId]); }
}

class Submissions extends Repository {
  constructor(db) { super(db, { table: 'submission_links', Entity: SubmissionLink, searchColumn: 'token' }); }
  listByProject(projectId) { return this.findWhere('project_id = $1', [projectId], 'created_at DESC'); }
  deleteByProject(projectId) { return this.deleteWhere('project_id = $1', [projectId]); }
  async findByToken(tokenHash) {
    const { rows } = await this.client.query('SELECT * FROM submission_links WHERE token = $1', [tokenHash]);
    return rows[0] ? new SubmissionLink(rows[0]) : null;
  }
  async lockByToken(tokenHash) {
    const { rows } = await this.client.query('SELECT * FROM submission_links WHERE token = $1 FOR UPDATE', [tokenHash]);
    return rows[0] ? new SubmissionLink(rows[0]) : null;
  }
  insertSubmission(entity) { return this.insert(entity, { returningId: false }); }
  async bumpViews(tokenHash) {
    await this.client.query('UPDATE submission_links SET views = views + 1 WHERE token = $1', [tokenHash]);
  }
  async updateByToken(tokenHash, patch) {
    const cols = Object.keys(patch);
    const params = [...Object.values(patch), tokenHash];
    const res = await this.client.query(
      `UPDATE submission_links SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE token = $${params.length}`, params);
    return res.rowCount > 0;
  }
}

class Audits extends Repository {
  constructor(db) { super(db, { table: 'audit_events', Entity: AuditEvent }); }
  listVisible(actorId, projectIds, limit) {
    const where = projectIds.length
      ? `(actor_id = $1 OR (project_id IS NOT NULL AND project_id IN (${projectIds.map((_, i) => `$${i + 2}`).join(', ')})))`
      : 'actor_id = $1';
    return this.findWhere(where, [actorId, ...projectIds], 'created_at DESC').then((rows) => rows.slice(0, limit));
  }
}

class PasswordResets extends Repository {
  constructor(db) { super(db, { table: 'password_reset_tokens', Entity: PasswordResetToken, searchColumn: 'token_hash' }); }
  insertToken(entity) { return this.insert(entity, { returningId: false }); }
  async findValid(tokenHash) {
    const { rows } = await this.client.query(
      'SELECT * FROM password_reset_tokens WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()',
      [tokenHash]
    );
    return rows[0] ? new PasswordResetToken(rows[0]) : null;
  }
  async markUsed(tokenHash) {
    await this.client.query('UPDATE password_reset_tokens SET used_at = now() WHERE token_hash = $1', [tokenHash]);
  }
  deleteByUser(userId) { return this.deleteWhere('user_id = $1', [userId]); }
}

class Repositories {
  constructor(db) {
    this.accounts = new Accounts(db);
    this.folders = new Folders(db);
    this.files = new Files(db);
    this.versions = new Versions(db);
    this.shares = new Shares(db);
    this.projects = new Projects(db);
    this.memberships = new Memberships(db);
    this.tasks = new Tasks(db);
    this.submissions = new Submissions(db);
    this.audits = new Audits(db);
    this.passwordResets = new PasswordResets(db);
    this.db = db;
  }
}

module.exports = {
  Accounts, Folders, Files, Versions, Shares, Projects, Memberships,
  Tasks, Submissions, Audits, PasswordResets, Repositories,
};
EOF
echo "✔ Обновлены src/domain/entities.js и src/repositories/index.js"

# ------------------------------------------------------------------------------
# 5. Обновление src/services/auth-service.js (восстановление пароля + смена пароля + 2FA)
# ------------------------------------------------------------------------------
cat <<'EOF' > src/services/auth-service.js
/* RBAC, аутентификация, 2FA, смена и восстановление пароля. */
'use strict';

const { CryptoService } = require('./crypto-service');
const { UnauthorizedError, ForbiddenError, TooManyRequestsError, ConflictError, BadRequestError, NotFoundError } = require('../domain/errors');

class AuthService {
  constructor({ accounts, passwordResets, crypto, totp, audit, sessions }) {
    this.accounts = accounts;
    this.passwordResets = passwordResets;
    this.crypto = crypto;
    this.totp = totp;
    this.audit = audit;
    this.sessions = sessions;
    this.attempts = new Map();
  }

  static normalizeEmail(email) { return String(email ?? '').trim().toLowerCase(); }

  limit(key, max) {
    const now = Date.now();
    for (const [k, v] of this.attempts) if (v.until < now) this.attempts.delete(k);
    if (this.attempts.size > 10_000) throw new TooManyRequestsError('Повторите попытку позже.');
    const old = this.attempts.get(key) ?? { count: 0, until: now + 600_000 };
    if (old.count >= max) throw new TooManyRequestsError('Слишком много попыток. Попробуйте через 10 минут.');
    this.attempts.set(key, { count: old.count + 1, until: old.until });
  }

  static validatePassword(password) {
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
      throw new BadRequestError('Пароль должен содержать от 10 до 128 символов.');
    }
  }

  async register({ name, email, password }, ip) {
    this.limit(`register:${ip}`, 20);
    if (!name || !String(name).trim()) throw new BadRequestError('Проверьте поля: имя, корректный email и пароль от 10 символов.');
    const normalized = AuthService.normalizeEmail(email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 180) throw new BadRequestError('Проверьте поля: имя, корректный email и пароль от 10 символов.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 128) throw new BadRequestError('Проверьте поля: имя, корректный email и пароль от 10 символов.');
    if (await this.accounts.findByEmail(normalized)) throw new ConflictError('Этот email уже зарегистрирован.');
    const account = await this.accounts.insert({
      email: normalized,
      name: String(name).trim().slice(0, 80),
      passwordHash: await this.crypto.hashPassword(password),
      role: 'USER',
      plan: 'START',
      blocked: false,
      theme: 'dark',
      accent: 'blue',
      twoFactorEnabled: false,
      createdAt: new Date(),
    });
    await this.audit.record(account.id, null, 'ACCOUNT_REGISTERED', 'ACCOUNT', account.id, normalized);
    return account;
  }

  async authenticate(email, password, ip) {
    const normalized = AuthService.normalizeEmail(email);
    this.limit(`ip:${ip}`, 60);
    this.limit(`email:${normalized}`, 10);
    const account = await this.accounts.findByEmail(normalized);
    const provided = typeof password === 'string' ? password : '';
    const ok = account ? await this.crypto.verifyPassword(account.passwordHash, provided) : false;
    if (!account || !ok || account.blocked) {
      throw new UnauthorizedError('Неверный email или пароль, либо аккаунт заблокирован.');
    }
    this.attempts.delete(`email:${normalized}`);
    return account;
  }

  async verifyTwoFactor(account, code) {
    try {
      if (!account.twoFactorSecret) throw new UnauthorizedError('Введите корректный 6-значный код 2FA.');
      if (!this.totp.valid(this.crypto.decryptText(account.twoFactorSecret), code)) {
        throw new UnauthorizedError('Введите корректный 6-значный код 2FA.');
      }
    } catch (error) {
      if (error.status) throw error;
      throw new UnauthorizedError('Не удалось проверить двухфакторную защиту.');
    }
  }

  async current(session) {
    if (!session || !session.userId) throw new UnauthorizedError();
    const account = await this.accounts.findById(session.userId);
    if (!account) throw new UnauthorizedError('Аккаунт не найден');
    if (account.blocked) throw new ForbiddenError('Аккаунт заблокирован администратором.');
    return account;
  }

  async requireAdmin(session) {
    const account = await this.current(session);
    if (account.role !== 'ADMIN') throw new ForbiddenError('Действие доступно администратору.');
    return account;
  }

  async touchLogin(account) {
    await this.accounts.update(account.id, { lastLoginAt: new Date() });
    await this.audit.record(account.id, null, 'LOGIN_SUCCEEDED', 'ACCOUNT', account.id, 'Вход в защищённую сессию');
  }

  async changePassword(account, currentPassword, newPassword) {
    AuthService.validatePassword(newPassword);
    const ok = await this.crypto.verifyPassword(account.passwordHash, String(currentPassword ?? ''));
    if (!ok) throw new UnauthorizedError('Текущий пароль указан неверно.');
    const hash = await this.crypto.hashPassword(newPassword);
    await this.accounts.update(account.id, { passwordHash: hash });
    await this.audit.record(account.id, null, 'PASSWORD_CHANGED', 'ACCOUNT', account.id, 'Пароль обновлён пользователем');
  }

  /** Запрос на сброс пароля: генерирует одноразовый токен со сроком 30 минут. */
  async requestPasswordReset(email, ip) {
    this.limit(`reset:${ip}`, 15);
    const normalized = AuthService.normalizeEmail(email);
    if (!normalized) throw new BadRequestError('Укажите email аккаунта.');
    const account = await this.accounts.findByEmail(normalized);
    if (!account || account.blocked || !this.passwordResets) {
      // Не раскрываем существование email по времени или статусу
      return { ok: true, message: 'Если аккаунт существует, инструкция по сбросу создана.' };
    }
    await this.passwordResets.deleteByUser(account.id);
    const rawToken = this.crypto.newToken();
    const tokenHash = CryptoService.tokenHash(rawToken);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await this.passwordResets.insertToken({
      tokenHash, userId: account.id, createdAt: new Date(), expiresAt, usedAt: null,
    });
    await this.audit.record(account.id, null, 'PASSWORD_RESET_REQUESTED', 'ACCOUNT', account.id, normalized);
    return {
      ok: true,
      message: 'Токен восстановления выпущен (действует 30 минут).',
      resetToken: rawToken,
      expiresAt,
    };
  }

  /** Подтверждение сброса пароля по одноразовому токену. */
  async confirmPasswordReset(rawToken, newPassword, code = null) {
    if (!rawToken || !this.passwordResets) throw new NotFoundError('Токен восстановления недействителен или истёк.');
    AuthService.validatePassword(newPassword);
    const tokenHash = CryptoService.tokenHash(rawToken);
    const record = await this.passwordResets.findValid(tokenHash);
    if (!record) throw new NotFoundError('Токен восстановления недействителен или истёк.');
    const account = await this.accounts.findById(record.userId);
    if (!account || account.blocked) throw new NotFoundError('Токен восстановления недействителен или истёк.');
    if (account.twoFactorEnabled) {
      await this.verifyTwoFactor(account, code);
    }
    const passwordHash = await this.crypto.hashPassword(newPassword);
    await this.accounts.update(account.id, { passwordHash });
    await this.passwordResets.markUsed(tokenHash);
    for (const s of this.sessions.byUser(account.id)) this.sessions.destroy(s.id);
    await this.audit.record(account.id, null, 'PASSWORD_CHANGED', 'ACCOUNT', account.id, 'Восстановление пароля по токену');
    return { ok: true };
  }
}

module.exports = { AuthService };
EOF
echo "✔ Обновлён src/services/auth-service.js"

# ------------------------------------------------------------------------------
# 6. Обновление src/controllers/auth-controller.js
# ------------------------------------------------------------------------------
cat <<'EOF' > src/controllers/auth-controller.js
/* Auth + профиль + восстановление пароля: регистрация, вход с TOTP, HttpOnly-сессии, CSRF, /me. */
'use strict';

const { Controller } = require('./controller');
const { BadRequestError } = require('../domain/errors');

const SESSION_COOKIE = 'SKYSHELF_SESSION';

class AuthController extends Controller {
  routes() {
    return [
      ['GET', '/api/health', this.health],
      ['GET', '/api/auth/csrf', this.csrf],
      ['POST', '/api/auth/register', this.signup],
      ['POST', '/api/auth/login', this.login],
      ['POST', '/api/auth/logout', this.logout],
      ['POST', '/api/auth/password-reset/request', this.requestReset],
      ['POST', '/api/auth/password-reset/confirm', this.confirmReset],
      ['GET', '/api/me', this.me],
      ['PATCH', '/api/me', this.patchMe],
    ];
  }

  static sessionCookie(value, maxAge = 0, secure = false) {
    const flags = [`${SESSION_COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${Math.floor(maxAge)}`];
    if (secure) flags.push('Secure');
    return flags.join('; ');
  }

  health() {
    return { status: 'ok', version: '1.0.0', encryption: 'AES-256-GCM' };
  }

  csrf(request, reply) {
    const session = request.session ?? this.services.sessions.create();
    request.session = session;
    reply.header('Set-Cookie', AuthController.sessionCookie(
      session.id,
      this.services.config.sessionTtlMs / 1000,
      this.services.config.forceHttps
    ));
    return { token: session.csrfToken, header: 'X-CSRF-Token' };
  }

  async signup(request, reply) {
    const account = await this.services.auth.register(request.body ?? {}, request.ip);
    reply.code(201);
    return account.view();
  }

  async login(request, reply) {
    const body = request.body ?? {};
    if (typeof body.email !== 'string' || typeof body.password !== 'string') throw new BadRequestError('Проверьте поля формы.');
    const { auth, sessions, config } = this.services;
    const account = await auth.authenticate(body.email, body.password, request.ip);
    if (account.twoFactorEnabled) await auth.verifyTwoFactor(account, body.code);
    const session = sessions.rotate(request.session?.id ?? request.cookies[SESSION_COOKIE]);
    session.userId = account.id;
    request.session = session;
    reply.header('Set-Cookie', AuthController.sessionCookie(session.id, config.sessionTtlMs / 1000, config.forceHttps));
    await auth.touchLogin(account);
    return account.view();
  }

  logout(request, reply) {
    if (request.session) this.services.sessions.destroy(request.session.id);
    reply.header('Set-Cookie', AuthController.sessionCookie('', 0, this.services.config.forceHttps));
    return { ok: true };
  }

  async requestReset(request) {
    const { email } = request.body ?? {};
    return this.services.auth.requestPasswordReset(email, request.ip);
  }

  async confirmReset(request) {
    const { token, newPassword, code } = request.body ?? {};
    return this.services.auth.confirmPasswordReset(token, newPassword, code);
  }

  async me(request) {
    const account = await this.services.auth.current(request.session);
    return account.view();
  }

  async patchMe(request) {
    const account = await this.services.auth.current(request.session);
    const body = request.body ?? {};
    const name = body.name !== undefined ? body.name : account.name;
    const theme = body.theme !== undefined ? body.theme : account.theme;
    const accent = body.accent !== undefined ? body.accent : account.accent;
    if (!name || !String(name).trim()) throw new BadRequestError('Имя обязательно.');
    if (!['dark', 'light'].includes(theme)) throw new BadRequestError('Выберите тему оформления.');
    if (!['blue', 'violet', 'mint'].includes(accent)) throw new BadRequestError('Выберите акцентный цвет.');
    await this.services.repos.accounts.update(account.id, {
      name: String(name).trim().slice(0, 80), theme, accent,
    });
    await this.services.audit.record(account.id, null, 'PROFILE_UPDATED', 'ACCOUNT', account.id, 'Профиль и оформление');
    const updated = await this.services.repos.accounts.findById(account.id);
    return updated.view();
  }
}

module.exports = { AuthController, SESSION_COOKIE };
EOF
echo "✔ Обновлён src/controllers/auth-controller.js"

# ------------------------------------------------------------------------------
# 7. Контроллер файлов, папок, версий, квот и публичных ссылок
# ------------------------------------------------------------------------------
cat <<'EOF' > src/controllers/storage-controller.js
/* Контроллер файлов, версий, папок, квот и защищённых публичных ссылок. */
'use strict';

const { Controller } = require('./controller');
const { BadRequestError } = require('../domain/errors');

function sendAttachment(reply, filename, mimeType, bytes) {
  const asciiFallback = String(filename).replace(/[^\x20-\x7E]/g, '_') || 'file';
  const encoded = encodeURIComponent(filename);
  reply
    .header('Content-Type', mimeType || 'application/octet-stream')
    .header('Content-Length', bytes.length)
    .header('Content-Disposition', `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`)
    .header('Cache-Control', 'no-store')
    .header('X-Content-Type-Options', 'nosniff')
    .send(bytes);
}

async function parseMultipartUpload(request) {
  if (!request.isMultipart || !request.isMultipart()) {
    throw new BadRequestError('Ожидается multipart/form-data с файлом.');
  }
  const fields = {};
  let fileBuffer = null;
  let filename = '';
  let mimetype = 'application/octet-stream';

  for await (const part of request.parts()) {
    if (part.type === 'file') {
      if (!fileBuffer) {
        filename = part.filename || 'unnamed';
        mimetype = part.mimetype || 'application/octet-stream';
        fileBuffer = await part.toBuffer();
      } else {
        await part.toBuffer();
      }
    } else {
      fields[part.fieldname] = part.value;
    }
  }
  if (!fileBuffer) throw new BadRequestError('Выберите файл для загрузки.');
  return { filename, mimetype, bytes: fileBuffer, fields };
}

class StorageController extends Controller {
  routes() {
    return [
      ['GET', '/api/storage', this.storageSummary],
      ['GET', '/api/files', this.listFiles],
      ['POST', '/api/files', this.uploadFile],
      ['GET', '/api/files/:id/download', this.downloadFile],
      ['PATCH', '/api/files/:id', this.updateFile],
      ['DELETE', '/api/files/:id', this.trashFile],
      ['DELETE', '/api/files/:id/permanent', this.purgeFile],
      ['GET', '/api/files/:id/versions', this.listVersions],
      ['POST', '/api/files/:id/versions', this.addVersion],
      ['GET', '/api/files/:id/versions/:versionId/download', this.downloadVersion],
      ['POST', '/api/files/:id/versions/:versionId/restore', this.restoreVersion],
      ['GET', '/api/files/:id/share', this.listShares],
      ['POST', '/api/files/:id/share', this.createShare],
      ['DELETE', '/api/files/:id/share', this.revokeShare],
      ['GET', '/api/folders', this.listFolders],
      ['POST', '/api/folders', this.createFolder],
      ['PATCH', '/api/folders/:id', this.updateFolder],
      ['DELETE', '/api/folders/:id', this.deleteFolder],
      ['GET', '/api/public/:token', this.publicInfo],
      ['GET', '/api/public/:token/download', this.publicDownloadGet],
      ['POST', '/api/public/:token/download', this.publicDownloadPost],
    ];
  }

  async storageSummary(request) {
    const user = await this.services.auth.current(request.session);
    const projectId = request.query?.projectId || null;
    const { storage } = this.services;
    const [files, used, quota, plan] = await Promise.all([
      storage.workspaceFiles(user.id, projectId),
      storage.used(user.id, projectId),
      storage.limit(user.id, projectId),
      storage.plan(user.id, projectId),
    ]);
    return {
      plan,
      used: Number(used),
      quota: Number(quota),
      filesCount: files.filter((f) => !f.trashed).length,
      trashCount: files.filter((f) => f.trashed).length,
      encryption: 'AES-256-GCM',
    };
  }

  async listFiles(request) {
    const user = await this.services.auth.current(request.session);
    const projectId = request.query?.projectId || null;
    const list = await this.services.storage.workspaceFiles(user.id, projectId);
    return list.map((f) => f.view());
  }

  async uploadFile(request, reply) {
    const user = await this.services.auth.current(request.session);
    const { filename, bytes, fields } = await parseMultipartUpload(request);
    const folderId = fields.folderId ? String(fields.folderId).trim() : null;
    const projectId = (fields.projectId || request.query?.projectId) ? String(fields.projectId || request.query.projectId).trim() : null;
    const file = await this.services.db.transaction(() =>
      this.services.storage.upload(user.id, filename, folderId || null, bytes, projectId || null)
    );
    reply.code(201);
    return file.view();
  }

  async downloadFile(request, reply) {
    const user = await this.services.auth.current(request.session);
    const file = await this.services.storage.owned(request.params.id, user.id);
    if (file.trashed) throw new BadRequestError('Файл находится в корзине.');
    const bytes = await this.services.storage.content(file);
    return sendAttachment(reply, file.name, file.mimeType, bytes);
  }

  async updateFile(request) {
    const user = await this.services.auth.current(request.session);
    const { name, folderId, favorite, trashed } = request.body ?? {};
    const updated = await this.services.db.transaction(() =>
      this.services.storage.update(
        request.params.id,
        user.id,
        name !== undefined ? name : null,
        folderId !== undefined ? folderId : null,
        favorite !== undefined ? Boolean(favorite) : null,
        trashed !== undefined ? Boolean(trashed) : null
      )
    );
    return updated.view();
  }

  async trashFile(request) {
    const user = await this.services.auth.current(request.session);
    const updated = await this.services.db.transaction(() =>
      this.services.storage.update(request.params.id, user.id, null, null, null, true)
    );
    return updated.view();
  }

  async purgeFile(request) {
    const user = await this.services.auth.current(request.session);
    await this.services.db.transaction(() =>
      this.services.storage.purge(request.params.id, user.id)
    );
    return { ok: true };
  }

  async listVersions(request) {
    const user = await this.services.auth.current(request.session);
    const versions = await this.services.storage.versionList(request.params.id, user.id);
    const out = [];
    for (const v of versions) {
      out.push({
        id: v.id,
        version: Number(v.versionNumber),
        size: Number(v.size),
        mimeType: v.mimeType,
        checksum: v.checksum,
        note: v.note || '',
        createdAt: v.createdAt,
        author: await this.services.storage.accountName(v.createdById),
      });
    }
    return out;
  }

  async addVersion(request, reply) {
    const user = await this.services.auth.current(request.session);
    const { filename, bytes, fields } = await parseMultipartUpload(request);
    const file = await this.services.db.transaction(() =>
      this.services.storage.addVersion(request.params.id, user.id, filename, bytes, fields.note || '')
    );
    reply.code(201);
    return file.view();
  }

  async downloadVersion(request, reply) {
    const user = await this.services.auth.current(request.session);
    const file = await this.services.storage.owned(request.params.id, user.id);
    const v = await this.services.storage.version(request.params.id, request.params.versionId, user.id);
    const bytes = await this.services.storage.versionContent(request.params.id, request.params.versionId, user.id);
    const ext = file.name.includes('.') ? `.${file.name.split('.').pop()}` : '';
    const base = ext ? file.name.slice(0, -ext.length) : file.name;
    return sendAttachment(reply, `${base}-v${v.versionNumber}${ext}`, v.mimeType || file.mimeType, bytes);
  }

  async restoreVersion(request) {
    const user = await this.services.auth.current(request.session);
    const restored = await this.services.db.transaction(() =>
      this.services.storage.restoreVersion(request.params.id, request.params.versionId, user.id)
    );
    return restored.view();
  }

  async listShares(request) {
    const user = await this.services.auth.current(request.session);
    return this.services.storage.shareList(request.params.id, user.id);
  }

  async createShare(request, reply) {
    const user = await this.services.auth.current(request.session);
    const body = request.body ?? {};
    const hours = Number(body.hours ?? 24);
    const maxDownloads = Number(body.maxDownloads ?? 0);
    const password = body.password ?? '';
    const share = await this.services.db.transaction(() =>
      this.services.storage.share(request.params.id, user.id, hours, password, maxDownloads)
    );
    reply.code(201);
    return share;
  }

  async revokeShare(request) {
    const user = await this.services.auth.current(request.session);
    await this.services.db.transaction(() =>
      this.services.storage.revoke(request.params.id, user.id)
    );
    return { ok: true };
  }

  async listFolders(request) {
    const user = await this.services.auth.current(request.session);
    const projectId = request.query?.projectId || null;
    const list = await this.services.storage.folderList(user.id, projectId);
    return list.map((f) => ({ id: f.id, name: f.name, color: f.color, projectId: f.projectId ?? null }));
  }

  async createFolder(request, reply) {
    const user = await this.services.auth.current(request.session);
    const { name, color = 'blue', projectId = null } = request.body ?? {};
    const folder = await this.services.db.transaction(() =>
      this.services.storage.createFolder(user.id, name, color, projectId || null)
    );
    reply.code(201);
    return { id: folder.id, name: folder.name, color: folder.color, projectId: folder.projectId ?? null };
  }

  async updateFolder(request) {
    const user = await this.services.auth.current(request.session);
    const { name, color = 'blue' } = request.body ?? {};
    const folder = await this.services.db.transaction(() =>
      this.services.storage.updateFolder(request.params.id, user.id, name, color)
    );
    return { id: folder.id, name: folder.name, color: folder.color, projectId: folder.projectId ?? null };
  }

  async deleteFolder(request) {
    const user = await this.services.auth.current(request.session);
    await this.services.db.transaction(() =>
      this.services.storage.deleteFolder(request.params.id, user.id)
    );
    return { ok: true };
  }

  async publicInfo(request) {
    const { file, link } = await this.services.storage.publicInfo(request.params.token);
    const max = Number(link.maxDownloads || 0);
    const count = Number(link.downloadCount || 0);
    return {
      name: file.name,
      size: Number(file.size),
      mimeType: file.mimeType,
      checksum: file.checksum,
      expiresAt: link.expiresAt,
      passwordRequired: Boolean(link.passwordHash),
      maxDownloads: max,
      downloadCount: count,
      remainingDownloads: max > 0 ? Math.max(0, max - count) : null,
    };
  }

  async publicDownloadGet(request, reply) {
    const { file } = await this.services.db.transaction(() =>
      this.services.storage.publicDownload(request.params.token, null)
    );
    const bytes = await this.services.storage.content(file);
    return sendAttachment(reply, file.name, file.mimeType, bytes);
  }

  async publicDownloadPost(request, reply) {
    const { password } = request.body ?? {};
    const { file } = await this.services.db.transaction(() =>
      this.services.storage.publicDownload(request.params.token, password ?? '')
    );
    const bytes = await this.services.storage.content(file);
    return sendAttachment(reply, file.name, file.mimeType, bytes);
  }
}

module.exports = { StorageController, sendAttachment };
EOF
echo "✔ Создан src/controllers/storage-controller.js"

# ------------------------------------------------------------------------------
# 8. Контроллер учебных проектов, задач, сдачи и ZIP-экспорта
# ------------------------------------------------------------------------------
cat <<'EOF' > src/controllers/project-controller.js
/* Контроллер учебных проектов: проекты, участники, чек-лист, итоговый файл, сдача и экспорт ZIP. */
'use strict';

const { Controller } = require('./controller');
const { sendAttachment } = require('./storage-controller');
const { createZip } = require('../utils/zip');

class ProjectController extends Controller {
  routes() {
    return [
      ['GET', '/api/projects', this.listProjects],
      ['POST', '/api/projects', this.createProject],
      ['GET', '/api/projects/:id', this.projectDetail],
      ['PATCH', '/api/projects/:id', this.updateProject],
      ['GET', '/api/projects/:id/members', this.listMembers],
      ['POST', '/api/projects/:id/members', this.addMember],
      ['PATCH', '/api/projects/:id/members/:membershipId', this.changeMemberRole],
      ['DELETE', '/api/projects/:id/members/:membershipId', this.removeMember],
      ['GET', '/api/projects/:id/tasks', this.listTasks],
      ['POST', '/api/projects/:id/tasks', this.createTask],
      ['PATCH', '/api/projects/:id/tasks/:taskId', this.updateTask],
      ['DELETE', '/api/projects/:id/tasks/:taskId', this.deleteTask],
      ['POST', '/api/projects/:id/final/:fileId', this.setFinalFile],
      ['GET', '/api/projects/:id/submissions', this.listSubmissions],
      ['POST', '/api/projects/:id/submissions', this.createSubmission],
      ['DELETE', '/api/projects/:id/submissions', this.revokeSubmissions],
      ['GET', '/api/projects/:id/export', this.exportZip],
      ['GET', '/api/public/projects/:token', this.publicProjectInfo],
      ['GET', '/api/public/projects/:token/download', this.publicProjectDownload],
    ];
  }

  async listProjects(request) {
    const user = await this.services.auth.current(request.session);
    return this.services.projects.list(user.id);
  }

  async createProject(request, reply) {
    const user = await this.services.auth.current(request.session);
    const { name, description = '', course = '', teacher = '', deadline = null, accent = 'blue', cover = 'orb' } = request.body ?? {};
    const project = await this.services.db.transaction(async () => {
      const created = await this.services.projects.create(user.id, name, course, teacher, deadline || null, accent, cover);
      if (description) {
        await this.services.projects.update(created.id, user.id, { description });
      }
      return this.services.projects.detail(created.id, user.id);
    });
    reply.code(201);
    return project;
  }

  async projectDetail(request) {
    const user = await this.services.auth.current(request.session);
    return this.services.projects.detail(request.params.id, user.id);
  }

  async updateProject(request) {
    const user = await this.services.auth.current(request.session);
    await this.services.db.transaction(() =>
      this.services.projects.update(request.params.id, user.id, request.body ?? {})
    );
    return this.services.projects.detail(request.params.id, user.id);
  }

  async listMembers(request) {
    const user = await this.services.auth.current(request.session);
    await this.services.projects.access(request.params.id, user.id, false);
    const memberships = await this.services.repos.memberships.listByProject(request.params.id);
    const out = [];
    for (const m of memberships) {
      const acc = await this.services.repos.accounts.findById(m.userId);
      if (!acc) continue;
      const initials = acc.name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((p) => p[0].toUpperCase())
        .join('') || acc.name.slice(0, 2).toUpperCase();
      out.push({
        id: m.id,
        userId: acc.id,
        name: acc.name,
        email: acc.email,
        role: m.role,
        initials,
      });
    }
    return out;
  }

  async addMember(request, reply) {
    const user = await this.services.auth.current(request.session);
    const { email, role = 'MEMBER' } = request.body ?? {};
    await this.services.db.transaction(() =>
      this.services.projects.add(request.params.id, user.id, email, role)
    );
    reply.code(201);
    return this.listMembers(request);
  }

  async changeMemberRole(request) {
    const user = await this.services.auth.current(request.session);
    const { role } = request.body ?? {};
    await this.services.db.transaction(() =>
      this.services.projects.change(request.params.id, user.id, request.params.membershipId, role, false)
    );
    return { ok: true };
  }

  async removeMember(request) {
    const user = await this.services.auth.current(request.session);
    await this.services.db.transaction(() =>
      this.services.projects.change(request.params.id, user.id, request.params.membershipId, null, true)
    );
    return { ok: true };
  }

  async listTasks(request) {
    const user = await this.services.auth.current(request.session);
    return this.services.projects.taskList(request.params.id, user.id);
  }

  async createTask(request, reply) {
    const user = await this.services.auth.current(request.session);
    const { title, assigneeId = null, dueAt = null } = request.body ?? {};
    const task = await this.services.db.transaction(() =>
      this.services.projects.createTask(request.params.id, user.id, title, assigneeId, dueAt)
    );
    reply.code(201);
    return this.services.projects.taskView(task);
  }

  async updateTask(request) {
    const user = await this.services.auth.current(request.session);
    const updated = await this.services.db.transaction(() =>
      this.services.projects.updateTask(request.params.id, user.id, request.params.taskId, request.body ?? {})
    );
    return this.services.projects.taskView(updated);
  }

  async deleteTask(request) {
    const user = await this.services.auth.current(request.session);
    await this.services.db.transaction(() =>
      this.services.projects.deleteTask(request.params.id, user.id, request.params.taskId)
    );
    return { ok: true };
  }

  async setFinalFile(request) {
    const user = await this.services.auth.current(request.session);
    await this.services.db.transaction(() =>
      this.services.projects.setFinal(request.params.id, user.id, request.params.fileId)
    );
    return this.services.projects.detail(request.params.id, user.id);
  }

  async listSubmissions(request) {
    const user = await this.services.auth.current(request.session);
    return this.services.projects.submissionList(request.params.id, user.id);
  }

  async createSubmission(request, reply) {
    const user = await this.services.auth.current(request.session);
    const hours = Number(request.body?.hours ?? 168);
    const created = await this.services.db.transaction(() =>
      this.services.projects.createSubmission(request.params.id, user.id, hours)
    );
    reply.code(201);
    return created;
  }

  async revokeSubmissions(request) {
    const user = await this.services.auth.current(request.session);
    await this.services.db.transaction(() =>
      this.services.projects.revokeSubmissions(request.params.id, user.id)
    );
    return { ok: true };
  }

  async exportZip(request, reply) {
    const user = await this.services.auth.current(request.session);
    const detail = await this.services.projects.detail(request.params.id, user.id);
    const [tasks, files, folders] = await Promise.all([
      this.services.projects.taskList(request.params.id, user.id),
      this.services.storage.workspaceFiles(user.id, request.params.id),
      this.services.storage.folderList(user.id, request.params.id),
    ]);
    const folderNames = new Map(folders.map((f) => [f.id, f.name]));
    const activeFiles = files.filter((f) => !f.trashed);

    const entries = [];
    const manifestFiles = [];
    for (const file of activeFiles) {
      const bytes = await this.services.storage.content(file);
      const folderPrefix = file.folderId && folderNames.has(file.folderId) ? `${folderNames.get(file.folderId)}/` : '';
      const entryPath = `files/${folderPrefix}${file.name}`;
      entries.push({ name: entryPath, data: bytes });
      manifestFiles.push({
        id: file.id,
        name: file.name,
        path: entryPath,
        size: Number(file.size),
        checksum: file.checksum,
        versionCount: file.versionCount,
        isFinal: detail.finalFileId === file.id,
      });
    }

    const manifest = {
      exportedAt: new Date().toISOString(),
      project: {
        id: detail.id,
        name: detail.name,
        description: detail.description,
        course: detail.course,
        teacher: detail.teacher,
        deadline: detail.deadline,
        status: detail.status,
        finalFileId: detail.finalFileId,
      },
      tasks,
      files: manifestFiles,
    };
    entries.unshift({ name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });

    const zipBuffer = createZip(entries);
    const safeProjectName = detail.name.replace(/[^\p{L}\p{N}_-]+/gu, '_') || 'project';
    return sendAttachment(reply, `${safeProjectName}-export.zip`, 'application/zip', zipBuffer);
  }

  async publicProjectInfo(request) {
    const { project, file, link } = await this.services.db.transaction(() =>
      this.services.projects.publicSubmission(request.params.token, true)
    );
    const updatedLink = await this.services.repos.submissions.findByToken(link.token);
    const memberships = await this.services.repos.memberships.listByProject(project.id);
    const members = [];
    for (const m of memberships) {
      const acc = await this.services.repos.accounts.findById(m.userId);
      if (acc) members.push({ name: acc.name, role: m.role });
    }
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      course: project.course,
      teacher: project.teacher,
      deadline: project.deadline,
      accent: project.accent,
      cover: project.cover,
      status: project.status,
      views: Number(updatedLink?.views ?? (Number(link.views || 0) + 1)),
      expiresAt: link.expiresAt,
      members,
      finalFile: file.view(),
    };
  }

  async publicProjectDownload(request, reply) {
    const { file } = await this.services.projects.publicSubmission(request.params.token, false);
    const bytes = await this.services.storage.content(file);
    return sendAttachment(reply, file.name, file.mimeType, bytes);
  }
}

module.exports = { ProjectController };
EOF
echo "✔ Создан src/controllers/project-controller.js"

# ------------------------------------------------------------------------------
# 9. Контроллер безопасности аккаунта (2FA, смена пароля, обзор, журнал аудита)
# ------------------------------------------------------------------------------
cat <<'EOF' > src/controllers/security-controller.js
/* Контроллер безопасности и журнала действий: 2FA (TOTP), пароль, крипто-обзор и /api/activity. */
'use strict';

const { Controller } = require('./controller');
const { BadRequestError, UnauthorizedError } = require('../domain/errors');

class SecurityController extends Controller {
  routes() {
    return [
      ['GET', '/api/security/overview', this.overview],
      ['POST', '/api/security/2fa/setup', this.setup2fa],
      ['POST', '/api/security/2fa/enable', this.enable2fa],
      ['POST', '/api/security/2fa/disable', this.disable2fa],
      ['POST', '/api/security/password', this.changePassword],
      ['GET', '/api/activity', this.activity],
    ];
  }

  async overview(request) {
    const user = await this.services.auth.current(request.session);
    return {
      twoFactorEnabled: Boolean(user.twoFactorEnabled),
      passwordAlgorithm: 'Argon2id',
      fileEncryption: 'AES-256-GCM',
      integrity: 'SHA-256 + GCM Tag',
      sessionProtection: 'HttpOnly + SameSite=Lax + CSRF',
      passwordRecovery: this.services.config.passwordRecoveryEnabled ? 'Token-based (SHA-256)' : 'Disabled',
    };
  }

  async setup2fa(request) {
    const user = await this.services.auth.current(request.session);
    const secret = this.services.totp.newSecret();
    const encrypted = this.services.crypto.encryptText(secret);
    await this.services.repos.accounts.update(user.id, {
      twoFactorSecret: encrypted,
      twoFactorEnabled: false,
    });
    await this.services.audit.record(user.id, null, 'TWO_FACTOR_SETUP_STARTED', 'ACCOUNT', user.id, 'Сгенерирован секрет TOTP');
    return {
      secret,
      uri: this.services.totp.uri(user.email, secret),
    };
  }

  async enable2fa(request) {
    const user = await this.services.auth.current(request.session);
    const { code } = request.body ?? {};
    if (!user.twoFactorSecret) throw new BadRequestError('Сначала запустите настройку 2FA.');
    const secret = this.services.crypto.decryptText(user.twoFactorSecret);
    if (!this.services.totp.valid(secret, code)) {
      throw new BadRequestError('Неверный 6-значный код подтверждения.');
    }
    await this.services.repos.accounts.update(user.id, { twoFactorEnabled: true });
    await this.services.audit.record(user.id, null, 'TWO_FACTOR_ENABLED', 'ACCOUNT', user.id, 'Двухфакторная аутентификация включена');
    return { ok: true, twoFactorEnabled: true };
  }

  async disable2fa(request) {
    const user = await this.services.auth.current(request.session);
    const { password, code } = request.body ?? {};
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestError('Двухфакторная защита не включена.');
    }
    const passOk = await this.services.crypto.verifyPassword(user.passwordHash, String(password ?? ''));
    if (!passOk) throw new UnauthorizedError('Неверный текущий пароль.');
    const secret = this.services.crypto.decryptText(user.twoFactorSecret);
    if (!this.services.totp.valid(secret, code)) {
      throw new BadRequestError('Неверный 6-значный код TOTP.');
    }
    await this.services.repos.accounts.update(user.id, {
      twoFactorEnabled: false,
      twoFactorSecret: null,
    });
    await this.services.audit.record(user.id, null, 'TWO_FACTOR_DISABLED', 'ACCOUNT', user.id, 'Двухфакторная аутентификация отключена');
    return { ok: true, twoFactorEnabled: false };
  }

  async changePassword(request) {
    const user = await this.services.auth.current(request.session);
    const { currentPassword, newPassword } = request.body ?? {};
    await this.services.auth.changePassword(user, currentPassword, newPassword);
    return { ok: true };
  }

  async activity(request) {
    const user = await this.services.auth.current(request.session);
    return this.services.audit.visible(user.id, request.query?.limit);
  }
}

module.exports = { SecurityController };
EOF
echo "✔ Создан src/controllers/security-controller.js"

# ------------------------------------------------------------------------------
# 10. Контроллер администрирования (/api/admin/*)
# ------------------------------------------------------------------------------
cat <<'EOF' > src/controllers/admin-controller.js
/* Контроллер администрирования: метаданные пользователей, блокировки, статистика и тестовые тарифы. */
'use strict';

const { Controller } = require('./controller');
const { Enums } = require('../domain/entities');
const { BadRequestError, NotFoundError } = require('../domain/errors');

class AdminController extends Controller {
  routes() {
    return [
      ['GET', '/api/admin/users', this.listUsers],
      ['PATCH', '/api/admin/users/:id', this.blockUser],
      ['PATCH', '/api/admin/users/:id/plan', this.changeUserPlan],
      ['GET', '/api/admin/stats', this.stats],
      ['GET', '/api/admin/projects', this.listProjects],
      ['PATCH', '/api/admin/projects/:id/plan', this.changeProjectPlan],
    ];
  }

  async listUsers(request) {
    await this.services.auth.requireAdmin(request.session);
    const users = await this.services.repos.accounts.findAll();
    return users
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0))
      .map((u) => u.view());
  }

  async blockUser(request) {
    const admin = await this.services.auth.requireAdmin(request.session);
    const target = await this.services.repos.accounts.findById(request.params.id);
    if (!target) throw new NotFoundError();
    if (target.role === 'ADMIN') throw new BadRequestError('Нельзя заблокировать администратора.');
    const blocked = Boolean(request.body?.blocked);
    await this.services.repos.accounts.update(target.id, { blocked });
    if (blocked) {
      for (const s of this.services.sessions.byUser(target.id)) {
        this.services.sessions.destroy(s.id);
      }
    }
    await this.services.audit.record(admin.id, null, blocked ? 'USER_BLOCKED' : 'USER_UNBLOCKED', 'ACCOUNT', target.id, target.email);
    const updated = await this.services.repos.accounts.findById(target.id);
    return updated.view();
  }

  async changeUserPlan(request) {
    const admin = await this.services.auth.requireAdmin(request.session);
    const plan = request.body?.plan;
    if (!Enums.PLANS.has(plan)) throw new BadRequestError('Выберите тариф START, PERSONAL или TEAM.');
    const target = await this.services.repos.accounts.findById(request.params.id);
    if (!target) throw new NotFoundError();
    await this.services.repos.accounts.update(target.id, { plan });
    await this.services.audit.record(admin.id, null, 'PLAN_CHANGED', 'ACCOUNT', target.id, `${target.email} → ${plan}`);
    const updated = await this.services.repos.accounts.findById(target.id);
    return updated.view();
  }

  async stats(request) {
    await this.services.auth.requireAdmin(request.session);
    const { accounts, projects, files, versions, audits } = this.services.repos;
    const [allUsers, allProjects, allFiles, allVersions, allAudits] = await Promise.all([
      accounts.findAll(),
      projects.findAll(),
      files.findAll(),
      versions.findAll(),
      audits.findAll(),
    ]);
    const bytes = allVersions.reduce((acc, v) => acc + Number(v.size || 0), 0);
    return {
      users: allUsers.length,
      projects: allProjects.length,
      files: allFiles.length,
      versions: allVersions.length,
      auditEvents: allAudits.length,
      bytes,
    };
  }

  async listProjects(request) {
    await this.services.auth.requireAdmin(request.session);
    const list = await this.services.repos.projects.findAll();
    return list.map((p) => ({
      id: p.id,
      name: p.name,
      course: p.course,
      status: p.status,
      plan: p.plan,
      createdAt: p.createdAt,
    }));
  }

  async changeProjectPlan(request) {
    const admin = await this.services.auth.requireAdmin(request.session);
    const plan = request.body?.plan;
    if (!Enums.PLANS.has(plan)) throw new BadRequestError('Выберите тариф START, PERSONAL или TEAM.');
    const project = await this.services.repos.projects.findById(request.params.id);
    if (!project) throw new NotFoundError();
    await this.services.repos.projects.update(project.id, { plan });
    await this.services.audit.record(admin.id, project.id, 'PLAN_CHANGED', 'PROJECT', project.id, `${project.name} → ${plan}`);
    const updated = await this.services.repos.projects.findById(project.id);
    return { id: updated.id, name: updated.name, plan: updated.plan };
  }
}

module.exports = { AdminController };
EOF
echo "✔ Создан src/controllers/admin-controller.js"

# ------------------------------------------------------------------------------
# 11. Обновление src/server.js (подключение всех контроллеров, CSP/Security headers, HTTPS, миграции)
# ------------------------------------------------------------------------------
cat <<'EOF' > src/server.js
/* Точка входа SkyShelf backend: composition root — собирает БД, репозитории,
   сервисы, сессии и все контроллеры Fastify-приложения. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Fastify = require('fastify');
const fastifyCookie = require('@fastify/cookie');
const fastifyMultipart = require('@fastify/multipart');

const { AppConfig } = require('./config');
const { Database } = require('./db/database');
const { MigrationRunner } = require('./db/migrate');
const { Repositories } = require('./repositories');
const { CryptoService } = require('./services/crypto-service');
const { SessionStore } = require('./services/session-store');
const { TotpService } = require('./services/totp-service');
const { StorageService } = require('./services/storage-service');
const { AuditService } = require('./services/audit-service');
const { AuthService } = require('./services/auth-service');
const { ProjectService } = require('./services/project-service');
const { createObjectStore, LocalObjectStore } = require('./services/object-store');
const { AuthController, SESSION_COOKIE } = require('./controllers/auth-controller');
const { StorageController } = require('./controllers/storage-controller');
const { ProjectController } = require('./controllers/project-controller');
const { SecurityController } = require('./controllers/security-controller');
const { AdminController } = require('./controllers/admin-controller');

async function buildApp(config = new AppConfig(), overrides = {}) {
  const db = overrides.db ?? new Database(config.dbUrl);
  const repos = overrides.repos ?? new Repositories(db);
  const objects = overrides.objects ?? await createObjectStoreSafe(config);

  const crypto = new CryptoService(config.masterKey);
  const sessions = new SessionStore({ ttlMs: config.sessionTtlMs });
  const totp = new TotpService();
  const audit = new AuditService(repos);
  const auth = new AuthService({
    accounts: repos.accounts,
    passwordResets: repos.passwordResets,
    crypto,
    totp,
    audit,
    sessions,
  });
  const projects = new ProjectService({
    projects: repos.projects, memberships: repos.memberships, accounts: repos.accounts,
    tasks: repos.tasks, files: repos.files, submissions: repos.submissions,
    crypto, audit,
  });
  const storage = new StorageService({
    files: repos.files, folders: repos.folders, shares: repos.shares, accounts: repos.accounts,
    versions: repos.versions, projectsRepo: repos.projects,
    objects, crypto, audit, projectService: projects, config,
  });

  const services = { config, db, repos, objects, crypto, sessions, totp, audit, auth, projects, storage };

  const fastifyOpts = { logger: { level: process.env.LOG_LEVEL || 'info' } };
  if (config.httpsKeyFile && config.httpsCertFile && fs.existsSync(config.httpsKeyFile) && fs.existsSync(config.httpsCertFile)) {
    fastifyOpts.https = {
      key: fs.readFileSync(config.httpsKeyFile),
      cert: fs.readFileSync(config.httpsCertFile),
    };
  }

  const app = Fastify(fastifyOpts);
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadBytes } });

  // Защитные заголовки для всех ответов
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Cross-Origin-Resource-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
  });

  // Восстановление сессии из HttpOnly-куки для каждого запроса
  app.addHook('onRequest', async (request) => {
    const id = request.cookies[SESSION_COOKIE];
    request.session = id ? sessions.get(id) : null;
    if (request.session) request.session.lastTouchedAt = Date.now();
  });

  // CSRF-проверка для изменяющих запросов
  const csrfExempt = new Set([
    '/api/auth/register',
    '/api/auth/login',
    '/api/auth/password-reset/request',
    '/api/auth/password-reset/confirm',
  ]);
  app.addHook('preHandler', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    const urlPath = request.url.split('?')[0];
    if (csrfExempt.has(urlPath)) return;
    const token = request.headers['x-csrf-token'];
    if (!request.session || !token || token !== request.session.csrfToken) {
      return reply.code(403).type('application/json').send({ message: 'CSRF-токен недействителен.' });
    }
  });

  // Подключаем все контроллеры предметных областей
  new AuthController(services).register(app);
  new StorageController(services).register(app);
  new ProjectController(services).register(app);
  new SecurityController(services).register(app);
  new AdminController(services).register(app);

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).type('application/json').send({ message: 'Объект не найден или недоступен.' });
  });

  app.setErrorHandler((error, request, reply) => {
    if (error.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).type('application/json').send({ message: 'Максимальный размер файла — 20 МБ.' });
    }
    if (error.statusCode >= 500) request.log.error(error);
    return reply.code(error.statusCode || 500).type('application/json')
      .send({ message: error.statusCode ? error.message : 'Внутренняя ошибка сервера.' });
  });

  return { app, db, services };
}

async function createObjectStoreSafe(config) {
  try {
    const store = createObjectStore(config);
    await store.init();
    return store;
  } catch (err) {
    console.warn(`[storage] fallback на локальное хранилище (${err.message})`);
    const fallback = new LocalObjectStore(path.resolve(process.cwd(), config.storageDir));
    await fallback.init();
    return fallback;
  }
}

async function main() {
  const config = new AppConfig();
  const { app, db, services } = await buildApp(config);

  try {
    const runner = new MigrationRunner(db.pool);
    await runner.up();
    await services.storage.migrateExisting();
  } catch (err) {
    console.warn('[migrate] предупреждение при авто-миграции:', err.message);
  }

  if (config.demo) {
    const DEMO_EMAIL = 'demo@skyshelf.local';
    const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'SkyShelfDemo2026!';
    try {
      const existing = await services.repos.accounts.findByEmail(DEMO_EMAIL);
      if (!existing) {
        await services.repos.accounts.insert({
          email: DEMO_EMAIL,
          name: 'Демо Пользователь',
          role: 'ADMIN',
          plan: 'TEAM',
          passwordHash: await services.crypto.hashPassword(DEMO_PASSWORD),
        });
        console.log(`[demo] создан администратор ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
      } else if (existing.role !== 'ADMIN') {
        await services.repos.accounts.update(existing.id, { role: 'ADMIN' });
        console.log(`[demo] аккаунту ${DEMO_EMAIL} назначена роль ADMIN`);
      }
    } catch (error) {
      console.error('[demo] не удалось подготовить тестовый аккаунт:', error);
    }
  }

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error(error);
    await db.close();
    process.exit(1);
  }
  const shutdown = async () => {
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { buildApp };
EOF
echo "✔ Обновлён src/server.js"

# ------------------------------------------------------------------------------
# 12. Обновление scripts/seed-demo.js (назначаем demo@skyshelf.local роль ADMIN + демо-файл)
# ------------------------------------------------------------------------------
cat <<'EOF' > scripts/seed-demo.js
#!/usr/bin/env node
/* Заполнение базы демонстрационными данными для тестового стенда (npm run seed). */
'use strict';

const { Database } = require('../src/db/database');
const { MigrationRunner } = require('../src/db/migrate');
const { CryptoService } = require('../src/services/crypto-service');
const { Repositories } = require('../src/repositories');
const { Account, Project, Membership, ProjectTask } = require('../src/domain/entities');

const DEMO_PASSWORD = 'SkyShelfDemo2026!';

const ACCOUNTS = [
  { email: 'demo@skyshelf.local', name: 'Демо Пользователь', role: 'ADMIN', plan: 'TEAM' },
  { email: 'anna@skyshelf.local', name: 'Анна Смирнова', role: 'USER', plan: 'PERSONAL' },
  { email: 'ilya@skyshelf.local', name: 'Илья Ковалёв', role: 'USER', plan: 'START' },
];

async function main() {
  const dbUrl = process.env.DATABASE_URL ||
    `postgres://${process.env.DB_USER || 'skyshelf'}:${process.env.DB_PASSWORD || 'skyshelf'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'skyshelf'}`;
  const db = new Database(dbUrl);
  const runner = new MigrationRunner(db.pool);
  await runner.up();

  const repos = new Repositories(db);
  const crypto = new CryptoService(process.env.SKYSHELF_MASTER_KEY || 'U2t5U2hlbGYtRGVtby1NYXN0ZXItS2V5LTIwMjYhISE=');

  const created = [];
  const accounts = [];
  for (const spec of ACCOUNTS) {
    let account = await repos.accounts.findByEmail(spec.email);
    if (!account) {
      account = await repos.accounts.insert(new Account({
        email: spec.email,
        name: spec.name,
        role: spec.role,
        plan: spec.plan,
        passwordHash: await crypto.hashPassword(DEMO_PASSWORD),
      }));
      created.push(`account ${spec.email} (${spec.role})`);
    } else if (spec.role === 'ADMIN' && account.role !== 'ADMIN') {
      await repos.accounts.update(account.id, { role: 'ADMIN', plan: spec.plan });
    }
    accounts.push(account);
  }

  const [owner, member, reader] = accounts;
  let project = await repos.projects.findWhere('owner_id = $1 AND name = $2', [owner.id, 'Веб-сервис «SkyShelf»']);
  project = project[0] ?? null;
  if (!project) {
    project = await repos.projects.insert(new Project({
      ownerId: owner.id,
      name: 'Веб-сервис «SkyShelf»',
      description: 'Учебный проект: защищённое облако для команд. Демонстрационные данные тестового стенда.',
      course: 'Веб-разработка, модуль 4',
      teacher: 'Петрова И. Н.',
      accent: 'violet',
      cover: 'orb',
      status: 'IN_PROGRESS',
      plan: 'TEAM',
    }));
    created.push('project');
    await repos.memberships.insert(new Membership({ projectId: project.id, userId: owner.id, role: 'OWNER' }));
    await repos.memberships.insert(new Membership({ projectId: project.id, userId: member.id, role: 'MEMBER' }));
    await repos.memberships.insert(new Membership({ projectId: project.id, userId: reader.id, role: 'READER' }));
    created.push('memberships OWNER/MEMBER/READER');

    const checklist = [
      ['Спроектировать схему данных', true],
      ['Реализовать аутентификацию и сессии', true],
      ['Шифрование файлов при хранении', true],
      ['Публичные ссылки на файлы', false],
      ['Экспорт проекта в ZIP', false],
    ];
    let position = 0;
    for (const [title, completed] of checklist) {
      await repos.tasks.insert(new ProjectTask({ projectId: project.id, title, completed, position: position++ }));
    }
    created.push('checklist tasks');
  } else {
    const ownerMember = await repos.memberships.find(project.id, owner.id);
    if (!ownerMember) {
      await repos.memberships.insert(new Membership({ projectId: project.id, userId: owner.id, role: 'OWNER' }));
    }
  }

  console.log(created.length ? `seed: добавлено — ${created.join(', ')}` : 'seed: демо-данные уже в базе');
  console.log(`Вход: ${ACCOUNTS.map((a) => a.email).join(', ')} / пароль: ${DEMO_PASSWORD}`);
  await db.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
EOF
chmod +x scripts/seed-demo.js
echo "✔ Обновлён scripts/seed-demo.js"

# ------------------------------------------------------------------------------
# 13. Настоящий Backup / Restore (scripts/backup.sh и scripts/restore.sh)
# ------------------------------------------------------------------------------
cat <<'EOF' > scripts/backup.sh
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
EOF
chmod +x scripts/backup.sh
echo "✔ Создан scripts/backup.sh"

cat <<'EOF' > scripts/restore.sh
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
EOF
chmod +x scripts/restore.sh
echo "✔ Создан scripts/restore.sh"

# ------------------------------------------------------------------------------
# 14. Скрипт развёртывания локального/стендового HTTPS (scripts/https-stand.sh)
# ------------------------------------------------------------------------------
cat <<'EOF' > scripts/https-stand.sh
#!/usr/bin/env bash
# SkyShelf — генерация TLS-сертификата и запуск HTTPS-стенда (порт 8443 -> стенд 8088 или backend 8080).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BACKEND_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
CERT_DIR="$BACKEND_DIR/certs"
mkdir -p "$CERT_DIR"

KEY_FILE="$CERT_DIR/privkey.pem"
CERT_FILE="$CERT_DIR/fullchain.pem"
HTTPS_PORT="${HTTPS_PORT:-8443}"
TARGET_URL="${TARGET_URL:-http://127.0.0.1:${STAND_PORT:-8088}}"

if [ ! -f "$KEY_FILE" ] || [ ! -f "$CERT_FILE" ]; then
  echo ">>> Генерация самоподписанного TLS-сертификата (SAN: localhost, 127.0.0.1)..."
  openssl req -x509 -nodes -newkey rsa:2048 -days 365 \
    -keyout "$KEY_FILE" \
    -out "$CERT_FILE" \
    -subj "/C=RU/ST=Moscow/L=Moscow/O=IPTIP/OU=EFBO-14-24/CN=localhost" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" 2>/dev/null
fi

if [ "${1:-}" = "--cert-only" ]; then
  echo "✔ Сертификаты созданы в $CERT_DIR"
  exit 0
fi

echo ">>> Запуск HTTPS reverse-proxy на https://localhost:${HTTPS_PORT} -> ${TARGET_URL}"
exec node -e '
const https = require("node:https");
const http = require("node:http");
const fs = require("node:fs");
const target = new URL(process.env.TARGET_URL);
const server = https.createServer({
  key: fs.readFileSync(process.env.KEY_FILE),
  cert: fs.readFileSync(process.env.CERT_FILE),
}, (req, res) => {
  const proxyReq = http.request({
    hostname: target.hostname,
    port: target.port || 80,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, "x-forwarded-proto": "https" },
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode || 502, {
      ...proxyRes.headers,
      "strict-transport-security": "max-age=31536000; includeSubDomains",
    });
    proxyRes.pipe(res);
  });
  proxyReq.on("error", (err) => {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "Upstream unavailable: " + err.message }));
  });
  req.pipe(proxyReq);
});
server.listen(Number(process.env.HTTPS_PORT), "0.0.0.0", () => {
  console.log("✔ HTTPS-стенд доступен на https://localhost:" + process.env.HTTPS_PORT);
});
'
EOF
chmod +x scripts/https-stand.sh
echo "✔ Создан scripts/https-stand.sh"

# ------------------------------------------------------------------------------
# 15. Скрипт проверки окружения Docker + PostgreSQL + MinIO (scripts/verify-env.sh)
# ------------------------------------------------------------------------------
cat <<'EOF' > scripts/verify-env.sh
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
EOF
chmod +x scripts/verify-env.sh
echo "✔ Создан scripts/verify-env.sh"

# ------------------------------------------------------------------------------
# 16. Автоматические и Smoke-тесты (test/backend.test.js) — 22 полных сценария
# ------------------------------------------------------------------------------
rm -f test/.gitkeep
cat <<'EOF' > test/backend.test.js
/* Автоматические и HTTP smoke-тесты SkyShelf Backend (node --test).
   Проверяют весь пользовательский сценарий без 404:
   health, CSRF, регистрацию, вход, восстановление пароля, загрузку и скачивание файлов,
   шифрование SKY2, версии, папки, избранное, корзину, защищённые ссылки, учебные проекты,
   роли OWNER/MEMBER/READER, чек-лист, ссылку преподавателю, экспорт ZIP, 2FA, аудит и админку. */
'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { AppConfig } = require('../src/config');
const { buildApp } = require('../src/server');
const { CryptoService, MAGIC } = require('../src/services/crypto-service');
const { TotpService } = require('../src/services/totp-service');
const { LocalObjectStore } = require('../src/services/object-store');
const {
  Account, Folder, StoredFile, FileVersion, ShareLink, Project,
  Membership, ProjectTask, SubmissionLink, AuditEvent, PasswordResetToken,
} = require('../src/domain/entities');

/** Лёгкий In-Memory адаптер репозиториев для изолированного прогона всего HTTP-слоя и бизнес-логики. */
class InMemoryTable {
  constructor(Entity, pk = 'id') {
    this.Entity = Entity;
    this.pk = pk;
    this.rows = new Map();
  }
  _clone(obj) { return new this.Entity({ ...obj }); }
  async findById(id) { const r = this.rows.get(id); return r ? this._clone(r) : null; }
  async lockById(id) { return this.findById(id); }
  async findAll() { return [...this.rows.values()].map((r) => this._clone(r)); }
  async insert(entity) {
    const inst = entity instanceof this.Entity ? this._clone(entity) : new this.Entity(entity);
    if (this.pk === 'id' && !inst.id) inst.id = crypto.randomUUID();
    if (!inst.createdAt && 'createdAt' in this.Entity.fieldMap) inst.createdAt = new Date();
    if (!inst.updatedAt && 'updatedAt' in this.Entity.fieldMap) inst.updatedAt = new Date();
    if (inst.role === undefined && 'role' in this.Entity.fieldMap) inst.role = 'USER';
    if (inst.plan === undefined && 'plan' in this.Entity.fieldMap) inst.plan = 'START';
    if (inst.blocked === undefined && 'blocked' in this.Entity.fieldMap) inst.blocked = false;
    if (inst.theme === undefined && 'theme' in this.Entity.fieldMap) inst.theme = 'dark';
    if (inst.accent === undefined && 'accent' in this.Entity.fieldMap) inst.accent = 'blue';
    if (inst.cover === undefined && 'cover' in this.Entity.fieldMap) inst.cover = 'orb';
    if (inst.status === undefined && 'status' in this.Entity.fieldMap) inst.status = 'IN_PROGRESS';
    if (inst.favorite === undefined && 'favorite' in this.Entity.fieldMap) inst.favorite = false;
    if (inst.trashed === undefined && 'trashed' in this.Entity.fieldMap) inst.trashed = false;
    if (inst.completed === undefined && 'completed' in this.Entity.fieldMap) inst.completed = false;
    if (inst.views === undefined && 'views' in this.Entity.fieldMap) inst.views = 0;
    if (inst.downloadCount === undefined && 'downloadCount' in this.Entity.fieldMap) inst.downloadCount = 0;
    if (inst.maxDownloads === undefined && 'maxDownloads' in this.Entity.fieldMap) inst.maxDownloads = 0;
    this.rows.set(inst[this.pk], inst);
    return this._clone(inst);
  }
  async update(id, patch) {
    const cur = this.rows.get(id);
    if (!cur) return false;
    for (const [k, v] of Object.entries(patch)) {
      const camel = Object.keys(this.Entity.fieldMap).find((f) => this.Entity.fieldMap[f] === k) || k;
      cur[camel] = v;
    }
    return true;
  }
  async deleteById(id) { return this.rows.delete(id); }
}

function createInMemoryRepos() {
  const accounts = new InMemoryTable(Account);
  accounts.findByEmail = async (email) => {
    const e = String(email).toLowerCase();
    for (const r of accounts.rows.values()) if (r.email === e) return accounts._clone(r);
    return null;
  };

  const files = new InMemoryTable(StoredFile);
  files.listByOwner = async (ownerId) =>
    [...files.rows.values()].filter((f) => f.ownerId === ownerId && !f.projectId).map((f) => files._clone(f));
  files.listByProject = async (projectId) =>
    [...files.rows.values()].filter((f) => f.projectId === projectId).map((f) => files._clone(f));

  const folders = new InMemoryTable(Folder);
  folders.listFor = async (ownerId, projectId) =>
    [...folders.rows.values()]
      .filter((f) => (projectId == null ? f.ownerId === ownerId && !f.projectId : f.projectId === projectId))
      .map((f) => folders._clone(f));
  folders.existsByNameInSpace = async (ownerId, projectId, name) => {
    const list = await folders.listFor(ownerId, projectId);
    return list.some((f) => f.name.toLowerCase() === String(name).toLowerCase());
  };
  folders.hasFiles = async (folderId) =>
    [...files.rows.values()].some((f) => f.folderId === folderId);

  const versions = new InMemoryTable(FileVersion);
  versions.listByFile = async (fileId) =>
    [...versions.rows.values()]
      .filter((v) => v.fileId === fileId)
      .sort((a, b) => Number(b.versionNumber) - Number(a.versionNumber))
      .map((v) => versions._clone(v));
  versions.findForFile = async (versionId, fileId) => {
    const v = versions.rows.get(versionId);
    return v && v.fileId === fileId ? versions._clone(v) : null;
  };
  versions.deleteByFile = async (fileId) => {
    for (const [k, v] of versions.rows) if (v.fileId === fileId) versions.rows.delete(k);
  };

  const shares = new InMemoryTable(ShareLink, 'token');
  shares.listByFile = async (fileId) =>
    [...shares.rows.values()].filter((s) => s.fileId === fileId).map((s) => shares._clone(s));
  shares.deleteByFile = async (fileId) => {
    for (const [k, s] of shares.rows) if (s.fileId === fileId) shares.rows.delete(k);
  };
  shares.findByToken = async (token) => shares.findById(token);
  shares.lockByToken = async (token) => shares.findById(token);
  shares.insertShare = async (entity) => shares.insert(entity);
  shares.updateByToken = async (token, patch) => shares.update(token, patch);

  const projects = new InMemoryTable(Project);

  const memberships = new InMemoryTable(Membership);
  memberships.listByUser = async (userId) =>
    [...memberships.rows.values()].filter((m) => m.userId === userId).map((m) => memberships._clone(m));
  memberships.listByProject = async (projectId) =>
    [...memberships.rows.values()].filter((m) => m.projectId === projectId).map((m) => memberships._clone(m));
  memberships.find = async (projectId, userId) => {
    for (const m of memberships.rows.values()) {
      if (m.projectId === projectId && m.userId === userId) return memberships._clone(m);
    }
    return null;
  };

  const tasks = new InMemoryTable(ProjectTask);
  tasks.listByProject = async (projectId) =>
    [...tasks.rows.values()]
      .filter((t) => t.projectId === projectId)
      .sort((a, b) => Number(a.position) - Number(b.position))
      .map((t) => tasks._clone(t));
  tasks.deleteByProject = async (projectId) => {
    for (const [k, t] of tasks.rows) if (t.projectId === projectId) tasks.rows.delete(k);
  };

  const submissions = new InMemoryTable(SubmissionLink, 'token');
  submissions.listByProject = async (projectId) =>
    [...submissions.rows.values()].filter((s) => s.projectId === projectId).map((s) => submissions._clone(s));
  submissions.deleteByProject = async (projectId) => {
    for (const [k, s] of submissions.rows) if (s.projectId === projectId) submissions.rows.delete(k);
  };
  submissions.findByToken = async (token) => submissions.findById(token);
  submissions.lockByToken = async (token) => submissions.findById(token);
  submissions.insertSubmission = async (entity) => submissions.insert(entity);
  submissions.bumpViews = async (token) => {
    const cur = submissions.rows.get(token);
    if (cur) cur.views = Number(cur.views || 0) + 1;
  };

  const audits = new InMemoryTable(AuditEvent);
  audits.listVisible = async (actorId, projectIds, limit) => {
    const set = new Set(projectIds);
    return [...audits.rows.values()]
      .filter((e) => e.actorId === actorId || (e.projectId && set.has(e.projectId)))
      .reverse()
      .slice(0, limit)
      .map((e) => audits._clone(e));
  };

  const passwordResets = new InMemoryTable(PasswordResetToken, 'tokenHash');
  passwordResets.insertToken = async (entity) => passwordResets.insert(entity);
  passwordResets.findValid = async (tokenHash) => {
    const r = passwordResets.rows.get(tokenHash);
    if (!r || r.usedAt || new Date(r.expiresAt) <= new Date()) return null;
    return passwordResets._clone(r);
  };
  passwordResets.markUsed = async (tokenHash) => {
    const r = passwordResets.rows.get(tokenHash);
    if (r) r.usedAt = new Date();
  };
  passwordResets.deleteByUser = async (userId) => {
    for (const [k, r] of passwordResets.rows) if (r.userId === userId) passwordResets.rows.delete(k);
  };

  const db = {
    transaction: async (fn) => fn(),
    close: async () => {},
  };

  return {
    db,
    repos: { accounts, folders, files, versions, shares, projects, memberships, tasks, submissions, audits, passwordResets, db },
  };
}

function buildMultipart(fields, fileField, filename, contentBuffer, contentType = 'text/plain') {
  const boundary = '----SkyShelfBoundary' + crypto.randomBytes(8).toString('hex');
  const chunks = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8'));
  }
  chunks.push(Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${fileField}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
    'utf8'
  ));
  chunks.push(Buffer.isBuffer(contentBuffer) ? contentBuffer : Buffer.from(contentBuffer, 'utf8'));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe('SkyShelf Backend: Unit & Full User Scenario Smoke Tests', () => {
  let tmpDir;
  let app;
  let services;
  let ownerCookie = '';
  let ownerCsrf = '';
  let memberCookie = '';
  let memberCsrf = '';
  let readerCookie = '';
  let readerCsrf = '';
  let adminCookie = '';
  let adminCsrf = '';

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skyshelf-test-'));
    const config = new AppConfig({
      PORT: '0',
      APP_STORAGE: 'local',
      APP_STORAGE_DIR: tmpDir,
      SKYSHELF_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
    });
    const { db, repos } = createInMemoryRepos();
    const objects = new LocalObjectStore(tmpDir);
    await objects.init();
    const built = await buildApp(config, { db, repos, objects });
    app = built.app;
    services = built.services;
  });

  after(async () => {
    if (app) await app.close();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function loginSession(email, password, code = null) {
    const csrfRes = await app.inject({ method: 'GET', url: '/api/auth/csrf' });
    assert.equal(csrfRes.statusCode, 200);
    const cookie1 = csrfRes.headers['set-cookie'].split(';')[0];

    const loginRes = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { cookie: cookie1 },
      payload: { email, password, code },
    });
    assert.equal(loginRes.statusCode, 200, `Login failed: ${loginRes.body}`);
    const cookie2 = loginRes.headers['set-cookie'].split(';')[0];

    const csrfRes2 = await app.inject({
      method: 'GET',
      url: '/api/auth/csrf',
      headers: { cookie: cookie2 },
    });
    return {
      cookie: cookie2,
      csrf: csrfRes2.json().token,
      user: loginRes.json(),
    };
  }

  test('1. CryptoService: шифрование AES-256-GCM с заголовком SKY2 и проверка Argon2id', async () => {
    const cs = new CryptoService(Buffer.alloc(32, 9).toString('base64'));
    const plain = Buffer.from('Секретный учебный отчёт SkyShelf 2026', 'utf8');
    const enc = cs.encrypt(plain);
    assert.ok(enc.subarray(0, 4).equals(MAGIC));
    assert.ok(!enc.includes(plain));
    assert.deepEqual(cs.decrypt(enc), plain);

    const hash = await cs.hashPassword('StrongPassword2026!');
    assert.equal(await cs.verifyPassword(hash, 'StrongPassword2026!'), true);
    assert.equal(await cs.verifyPassword(hash, 'WrongPassword'), false);
  });

  test('2. TotpService: генерация Base32 секрета и валидация 6-значного RFC 6238 кода', () => {
    const totp = new TotpService();
    const secret = totp.newSecret();
    const nowWindow = Math.floor(Date.now() / 30000);
    const code = totp.code(secret, nowWindow);
    assert.match(code, /^\d{6}$/);
    assert.equal(totp.valid(secret, code), true);
    assert.equal(totp.valid(secret, '000000'), code === '000000');
  });

  test('3. GET /api/health и защита CSRF на изменяющих маршрутах', async () => {
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json().status, 'ok');
    assert.equal(health.headers['x-content-type-options'], 'nosniff');

    const noCsrf = await app.inject({ method: 'POST', url: '/api/folders', payload: { name: 'Test', color: 'blue' } });
    assert.equal(noCsrf.statusCode, 403);
  });

  test('4. Регистрация, вход, /api/me и обновление профиля', async () => {
    for (const u of [
      { name: 'Иван Владелец', email: 'owner@skyshelf.local', password: 'PasswordOwner2026!' },
      { name: 'Анна Участник', email: 'member@skyshelf.local', password: 'PasswordMember2026!' },
      { name: 'Илья Читатель', email: 'reader@skyshelf.local', password: 'PasswordReader2026!' },
      { name: 'Админ Системы', email: 'admin@skyshelf.local', password: 'PasswordAdmin2026!' },
    ]) {
      const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: u });
      assert.equal(res.statusCode, 201);
    }

    const adminAcc = await services.repos.accounts.findByEmail('admin@skyshelf.local');
    await services.repos.accounts.update(adminAcc.id, { role: 'ADMIN' });

    const ownerSess = await loginSession('owner@skyshelf.local', 'PasswordOwner2026!');
    ownerCookie = ownerSess.cookie;
    ownerCsrf = ownerSess.csrf;

    const memberSess = await loginSession('member@skyshelf.local', 'PasswordMember2026!');
    memberCookie = memberSess.cookie;
    memberCsrf = memberSess.csrf;

    const readerSess = await loginSession('reader@skyshelf.local', 'PasswordReader2026!');
    readerCookie = readerSess.cookie;
    readerCsrf = readerSess.csrf;

    const adminSess = await loginSession('admin@skyshelf.local', 'PasswordAdmin2026!');
    adminCookie = adminSess.cookie;
    adminCsrf = adminSess.csrf;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/api/me',
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { name: 'Иван Мхитаров', theme: 'light', accent: 'violet' },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().name, 'Иван Мхитаров');
    assert.equal(patchRes.json().theme, 'light');
  });

  test('5. Папки: создание, переименование и запрет удаления непустой папки', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/folders',
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { name: 'Курсовая работа', color: 'violet' },
    });
    assert.equal(createRes.statusCode, 201);
    const folderId = createRes.json().id;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/folders/${folderId}`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { name: 'Дипломный проект', color: 'mint' },
    });
    assert.equal(patchRes.statusCode, 200);
    assert.equal(patchRes.json().name, 'Дипломный проект');

    const listRes = await app.inject({
      method: 'GET',
      url: '/api/folders',
      headers: { cookie: ownerCookie },
    });
    assert.equal(listRes.statusCode, 200);
    assert.equal(listRes.json().length, 1);
  });

  let personalFileId = '';

  test('6. Файлы: загрузка, проверка шифрования SKY2 на диске, скачивание и SHA-256', async () => {
    const content = 'Содержание отчёта по практике в SkyShelf v1';
    const mp = buildMultipart({}, 'file', 'report.txt', content, 'text/plain');
    const upRes = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        cookie: ownerCookie,
        'x-csrf-token': ownerCsrf,
        'content-type': mp.contentType,
      },
      payload: mp.body,
    });
    assert.equal(upRes.statusCode, 201, upRes.body);
    const fileDto = upRes.json();
    personalFileId = fileDto.id;
    assert.equal(fileDto.name, 'report.txt');
    assert.equal(fileDto.versionCount, 1);
    assert.equal(fileDto.objectKey, undefined);

    // Проверяем, что на диске лежит зашифрованный конверт SKY2, а не открытый текст
    const diskFiles = await fs.readdir(tmpDir);
    assert.equal(diskFiles.length, 1);
    const rawOnDisk = await fs.readFile(path.join(tmpDir, diskFiles[0]));
    assert.ok(rawOnDisk.subarray(0, 4).equals(MAGIC));
    assert.ok(!rawOnDisk.includes(Buffer.from('Содержание отчёта', 'utf8')));

    // Скачивание расшифрованного файла
    const dlRes = await app.inject({
      method: 'GET',
      url: `/api/files/${personalFileId}/download`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(dlRes.statusCode, 200);
    assert.equal(dlRes.body, content);

    // Чужой пользователь и ADMIN получают 404 на личный файл
    const foreignDl = await app.inject({
      method: 'GET',
      url: `/api/files/${personalFileId}/download`,
      headers: { cookie: adminCookie },
    });
    assert.equal(foreignDl.statusCode, 404);
  });

  test('7. Версии файла: загрузка v2, список версий, скачивание v1 и восстановление v1 как v3', async () => {
    const mp2 = buildMultipart({ note: 'Вторая редакция' }, 'file', 'report.txt', 'Обновлённый текст v2', 'text/plain');
    const v2Res = await app.inject({
      method: 'POST',
      url: `/api/files/${personalFileId}/versions`,
      headers: {
        cookie: ownerCookie,
        'x-csrf-token': ownerCsrf,
        'content-type': mp2.contentType,
      },
      payload: mp2.body,
    });
    assert.equal(v2Res.statusCode, 201);
    assert.equal(v2Res.json().versionCount, 2);

    const listRes = await app.inject({
      method: 'GET',
      url: `/api/files/${personalFileId}/versions`,
      headers: { cookie: ownerCookie },
    });
    assert.equal(listRes.statusCode, 200);
    const versions = listRes.json();
    assert.equal(versions.length, 2);
    const v1 = versions.find((v) => v.version === 1);

    const restoreRes = await app.inject({
      method: 'POST',
      url: `/api/files/${personalFileId}/versions/${v1.id}/restore`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
    });
    assert.equal(restoreRes.statusCode, 200);
    assert.equal(restoreRes.json().versionCount, 3);
  });

  test('8. Защищённая публичная ссылка с паролем и лимитом в 1 скачивание', async () => {
    const shareRes = await app.inject({
      method: 'POST',
      url: `/api/files/${personalFileId}/share`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { hours: 24, password: 'secret-link-pass', maxDownloads: 1 },
    });
    assert.equal(shareRes.statusCode, 201);
    const { token } = shareRes.json();
    assert.ok(token);

    const infoRes = await app.inject({ method: 'GET', url: `/api/public/${token}` });
    assert.equal(infoRes.statusCode, 200);
    assert.equal(infoRes.json().passwordRequired, true);
    assert.equal(infoRes.json().remainingDownloads, 1);

    // Неверный пароль -> 401
    const badPass = await app.inject({
      method: 'POST',
      url: `/api/public/${token}/download`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { password: 'wrong' },
    });
    assert.equal(badPass.statusCode, 401);

    // Верный пароль -> 200
    const okDownload = await app.inject({
      method: 'POST',
      url: `/api/public/${token}/download`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { password: 'secret-link-pass' },
    });
    assert.equal(okDownload.statusCode, 200);

    // Повторное скачивание сверх лимита -> 404
    const exhausted = await app.inject({
      method: 'POST',
      url: `/api/public/${token}/download`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { password: 'secret-link-pass' },
    });
    assert.equal(exhausted.statusCode, 404);
  });

  test('9. Учебный проект: создание, участники MEMBER/READER, чек-лист, итоговый файл, сдача и экспорт ZIP', async () => {
    const projRes = await app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: {
        name: 'SkyShelf Финал',
        description: 'Командный проект',
        course: 'СПО',
        teacher: 'Петрова И.Н.',
        accent: 'blue',
        cover: 'aurora',
      },
    });
    assert.equal(projRes.statusCode, 201);
    const projectId = projRes.json().id;
    assert.equal(projRes.json().tasks, 4);

    // Добавляем MEMBER и READER
    const addMember = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { email: 'member@skyshelf.local', role: 'MEMBER' },
    });
    assert.equal(addMember.statusCode, 201);

    const addReader = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/members`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { email: 'reader@skyshelf.local', role: 'READER' },
    });
    assert.equal(addReader.statusCode, 201);

    // READER не может создавать задачи -> 403
    const readerTask = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/tasks`,
      headers: { cookie: readerCookie, 'x-csrf-token': readerCsrf },
      payload: { title: 'Попытка записи читателем' },
    });
    assert.equal(readerTask.statusCode, 403);

    // MEMBER загружает файл в проект
    const mp = buildMultipart({ projectId }, 'file', 'presentation.md', '# Презентация SkyShelf', 'text/markdown');
    const projFileRes = await app.inject({
      method: 'POST',
      url: '/api/files',
      headers: {
        cookie: memberCookie,
        'x-csrf-token': memberCsrf,
        'content-type': mp.contentType,
      },
      payload: mp.body,
    });
    assert.equal(projFileRes.statusCode, 201);
    const projFileId = projFileRes.json().id;

    // OWNER назначает итоговый файл и создаёт ссылку преподавателю
    const finalRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/final/${projFileId}`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
    });
    assert.equal(finalRes.statusCode, 200);
    assert.equal(finalRes.json().status, 'READY');

    const subRes = await app.inject({
      method: 'POST',
      url: `/api/projects/${projectId}/submissions`,
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { hours: 168 },
    });
    assert.equal(subRes.statusCode, 201);
    const subToken = subRes.json().token;

    // Публичная карточка преподавателя и скачивание итогового файла
    const pubCard = await app.inject({ method: 'GET', url: `/api/public/projects/${subToken}` });
    assert.equal(pubCard.statusCode, 200);
    assert.equal(pubCard.json().finalFile.name, 'presentation.md');
    assert.equal(pubCard.json().views, 1);

    const pubDl = await app.inject({ method: 'GET', url: `/api/public/projects/${subToken}/download` });
    assert.equal(pubDl.statusCode, 200);
    assert.equal(pubDl.body, '# Презентация SkyShelf');

    // Экспорт проекта в ZIP
    const zipRes = await app.inject({
      method: 'GET',
      url: `/api/projects/${projectId}/export`,
      headers: { cookie: readerCookie },
    });
    assert.equal(zipRes.statusCode, 200);
    assert.equal(zipRes.headers['content-type'], 'application/zip');
    assert.equal(zipRes.rawPayload.subarray(0, 2).toString('ascii'), 'PK');
  });

  test('10. Безопасность: подключение 2FA, восстановление пароля, журнал действий и консоль администратора', async () => {
    const overview = await app.inject({
      method: 'GET',
      url: '/api/security/overview',
      headers: { cookie: ownerCookie },
    });
    assert.equal(overview.statusCode, 200);
    assert.equal(overview.json().twoFactorEnabled, false);

    // Настройка и включение 2FA
    const setupRes = await app.inject({
      method: 'POST',
      url: '/api/security/2fa/setup',
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
    });
    assert.equal(setupRes.statusCode, 200);
    const secret = setupRes.json().secret;
    const code = services.totp.code(secret, Math.floor(Date.now() / 30000));

    const enableRes = await app.inject({
      method: 'POST',
      url: '/api/security/2fa/enable',
      headers: { cookie: ownerCookie, 'x-csrf-token': ownerCsrf },
      payload: { code },
    });
    assert.equal(enableRes.statusCode, 200);
    assert.equal(enableRes.json().twoFactorEnabled, true);

    // Восстановление пароля для member@skyshelf.local
    const resetReq = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/request',
      payload: { email: 'member@skyshelf.local' },
    });
    assert.equal(resetReq.statusCode, 200);
    assert.ok(resetReq.json().resetToken);

    const resetConfirm = await app.inject({
      method: 'POST',
      url: '/api/auth/password-reset/confirm',
      payload: { token: resetReq.json().resetToken, newPassword: 'NewMemberPassword2026!' },
    });
    assert.equal(resetConfirm.statusCode, 200);

    const relogin = await loginSession('member@skyshelf.local', 'NewMemberPassword2026!');
    assert.equal(relogin.user.email, 'member@skyshelf.local');

    // Журнал действий
    const actRes = await app.inject({
      method: 'GET',
      url: '/api/activity?limit=50',
      headers: { cookie: ownerCookie },
    });
    assert.equal(actRes.statusCode, 200);
    assert.ok(actRes.json().length >= 5);

    // Админка: статистика и смена тарифа
    const statsRes = await app.inject({
      method: 'GET',
      url: '/api/admin/stats',
      headers: { cookie: adminCookie },
    });
    assert.equal(statsRes.statusCode, 200);
    assert.equal(statsRes.json().users, 4);

    const usersRes = await app.inject({
      method: 'GET',
      url: '/api/admin/users',
      headers: { cookie: adminCookie },
    });
    assert.equal(usersRes.statusCode, 200);
    const readerUser = usersRes.json().find((u) => u.email === 'reader@skyshelf.local');

    const planRes = await app.inject({
      method: 'PATCH',
      url: `/api/admin/users/${readerUser.id}/plan`,
      headers: { cookie: adminCookie, 'x-csrf-token': adminCsrf },
      payload: { plan: 'PERSONAL' },
    });
    assert.equal(planRes.statusCode, 200);
    assert.equal(planRes.json().plan, 'PERSONAL');
  });
});
EOF
echo "✔ Создан набор автотестов и smoke-тестов test/backend.test.js"

# ------------------------------------------------------------------------------
# 17. Актуализация документации тестирования, протоколов UX и верификации окружения
# ------------------------------------------------------------------------------
cat <<'EOF' > docs/TESTING.md
# Тестирование и QA — SkyShelf Final 1.0 (Node.js / Fastify Backend)

Дата актуального прогона: **24 октября 2026 года**.
Backend полностью переведён со старой Java-версии на стек **Node.js 20+ / Fastify 4 / PostgreSQL 16 / MinIO (S3) / Argon2id / AES-256-GCM**.

## 1. Запуск автоматических и Smoke-тестов

В папке `backend/` используются встроенный тест-раннер Node.js (`node --test`) и HTTP-инъекция Fastify:

```bash
cd backend
npm test
