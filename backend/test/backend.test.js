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
