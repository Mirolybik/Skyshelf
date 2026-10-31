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
const { SubscriptionService } = require('./services/subscription-service');
const { createObjectStore, LocalObjectStore } = require('./services/object-store');
const { AuthController, SESSION_COOKIE } = require('./controllers/auth-controller');
const { StorageController } = require('./controllers/storage-controller');
const { ProjectController } = require('./controllers/project-controller');
const { SecurityController } = require('./controllers/security-controller');
const { AdminController } = require('./controllers/admin-controller');
const { SubscriptionController } = require('./controllers/subscription-controller');

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
    tasks: repos.tasks, files: repos.files, versions: repos.versions, quotas: repos.quotas,
    submissions: repos.submissions, crypto, audit,
  });
  const subscriptions = new SubscriptionService({
    subscriptions: repos.subscriptions, accounts: repos.accounts, projects: repos.projects,
    memberships: repos.memberships, files: repos.files, folders: repos.folders,
    versions: repos.versions, shares: repos.shares, submissions: repos.submissions,
    tasks: repos.tasks, quotas: repos.quotas, objects, audit, config, projectService: projects,
  });
  const storage = new StorageService({
    files: repos.files, folders: repos.folders, shares: repos.shares, accounts: repos.accounts,
    versions: repos.versions, projectsRepo: repos.projects,
    objects, crypto, audit, projectService: projects, config,
  });

  const services = {
    config, db, repos, objects, crypto, sessions, totp, audit, auth,
    projects, storage, subscriptions,
  };

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
  new SubscriptionController(services).register(app);

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

async function seedDemoAccounts(services) {
  const password = process.env.DEMO_PASSWORD || 'SkyShelfDemo2026!';
  const demoUsers = [
    { email: 'demo@skyshelf.local', name: 'Демо Администратор', role: 'ADMIN', plan: 'TEAM' },
    { email: 'anna@skyshelf.local', name: 'Анна Смирнова', role: 'USER', plan: 'PERSONAL' },
    { email: 'ilya@skyshelf.local', name: 'Илья Ковалёв', role: 'USER', plan: 'START' },
  ];
  for (const user of demoUsers) {
    try {
      let account = await services.repos.accounts.findByEmail(user.email);
      if (!account) {
        account = await services.repos.accounts.insert({
          email: user.email,
          name: user.name,
          role: user.role,
          plan: user.plan,
          passwordHash: await services.crypto.hashPassword(password),
        });
        console.log(`[demo] создан аккаунт ${user.email} (${user.role})`);
      } else if (account.role !== user.role) {
        await services.repos.accounts.update(account.id, { role: user.role });
        console.log(`[demo] обновлена роль для ${user.email} на ${user.role}`);
      }
      if (SubscriptionService.paid(account.plan ?? user.plan)) {
        const existing = await services.repos.subscriptions.findByAccount(account.id);
        if (!existing) await services.subscriptions.ensureAccount(account.id, account.plan ?? user.plan);
      }
    } catch (error) {
      console.error(`[demo] не удалось подготовить аккаунт ${user.email}:`, error);
    }
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

  if (config.demo) await seedDemoAccounts(services);

  const purgeExpired = async () => {
    try {
      const purged = await services.subscriptions.sweep();
      if (purged.length) console.log(`[subscriptions] очищено пространств: ${purged.length}`);
    } catch (error) {
      console.error('[subscriptions] плановая очистка не выполнена:', error.message);
    }
  };
  await purgeExpired();
  const sweepTimer = setInterval(purgeExpired, config.subscriptionSweepIntervalMs);
  if (sweepTimer.unref) sweepTimer.unref();

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error(error);
    await db.close();
    process.exit(1);
  }

  const shutdown = async () => {
    clearInterval(sweepTimer);
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) main();

module.exports = { buildApp };
