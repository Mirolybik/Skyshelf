/* Точка входа SkyShelf backend: composition root — собирает БД, репозитории,
   сервисы, сессии и Fastify-приложение. */
'use strict';

const Fastify = require('fastify');
const fastifyCookie = require('@fastify/cookie');
const fastifyMultipart = require('@fastify/multipart');

const { AppConfig } = require('./config');
const { Database } = require('./db/database');
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

async function buildApp(config = new AppConfig()) {
  const db = new Database(config.dbUrl);
  const repos = new Repositories(db);

  const crypto = new CryptoService(config.masterKey);
  const sessions = new SessionStore({ ttlMs: config.sessionTtlMs });
  const totp = new TotpService();
  const audit = new AuditService(repos);
  const auth = new AuthService({ accounts: repos.accounts, crypto, totp, audit, sessions });
  const projects = new ProjectService({
    projects: repos.projects, memberships: repos.memberships, accounts: repos.accounts,
    tasks: repos.tasks, files: repos.files, submissions: repos.submissions,
    crypto, audit,
  });
  const storage = new StorageService({
    files: repos.files, folders: repos.folders, shares: repos.shares, accounts: repos.accounts,
    versions: repos.versions, projectsRepo: repos.projects,
    objects: createObjectStoreSafe(config), crypto, audit, projectService: projects, config,
  });

  const services = { config, db, repos, crypto, sessions, totp, audit, auth, projects, storage };

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, { limits: { fileSize: config.maxUploadBytes } });

  // восстановление сессии из HttpOnly-куки для каждого запроса
  app.addHook('onRequest', async (request) => {
    const id = request.cookies[SESSION_COOKIE];
    request.session = id ? sessions.get(id) : null;
    if (request.session) request.session.lastTouchedAt = Date.now();
  });

  // CSRF-проверка для изменяющих запросов (аналог Spring Security CsrfToken)
  app.addHook('preHandler', async (request, reply) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return;
    // регистрация/вход выполняются до установления сессии — CSRF здесь не применим
    if (request.url === '/api/auth/register' || request.url === '/api/auth/login') return;
    const token = request.headers['x-csrf-token'];
    if (!request.session || !token || token !== request.session.csrfToken) {
      return reply.code(403).type('application/json').send({ message: 'CSRF-токен недействителен.' });
    }
  });

  // /api/health объявляет AuthController — дубль роута роняет Fastify (FST_ERR_DUPLICATED_ROUTE)
  new AuthController(services).register(app);

  app.setErrorHandler((error, request, reply) => {
    if (error.statusCode >= 500) request.log.error(error);
    return reply.code(error.statusCode || 500).type('application/json')
      .send({ message: error.statusCode ? error.message : 'Внутренняя ошибка сервера.' });
  });

  return { app, db, services };
}

/** Драйвер хранилища объектов: local (по умолчанию) или minio. */
function createObjectStoreSafe(config) {
  try {
    return createObjectStore(config);
  } catch {
    const path = require('node:path');
    return new LocalObjectStore(path.resolve(process.cwd(), config.storageDir));
  }
}

async function main() {
  const config = new AppConfig();
  const { app, db, services } = await buildApp(config);

  // Демо-режим (APP_DEMO=true): при старте создаём тестового пользователя
  // напрямую через репозиторий — без проверки формы и rate-limit'а, которые
  // принадлежат HTTP-слою и на стартовом пути не нужны. Идемпотентно.
  if (config.demo) {
    const DEMO_EMAIL = 'demo@skyshelf.local';
    const DEMO_PASSWORD = 'demo-password-123';
    try {
      const existing = await services.repos.accounts.findByEmail(DEMO_EMAIL);
      if (!existing) {
        await services.repos.accounts.insert({
          email: DEMO_EMAIL,
          name: 'Демо пользователь',
          passwordHash: await services.crypto.hashPassword(DEMO_PASSWORD),
        });
        console.log(`[demo] создан тестовый аккаунт ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
      } else {
        console.log(`[demo] тестовый аккаунт ${DEMO_EMAIL} уже существует`);
      }
    } catch (error) {
      console.error('[demo] не удалось создать тестовый аккаунт:', error);
      await db.close();
      process.exit(1);
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
