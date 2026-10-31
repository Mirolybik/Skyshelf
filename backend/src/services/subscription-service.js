'use strict';

const { Enums } = require('../domain/entities');
const { BadRequestError, NotFoundError } = require('../domain/errors');

const DAY = 24 * 60 * 60 * 1000;
const PAID_PLANS = new Set(['PERSONAL', 'TEAM']);

class SubscriptionService {
  constructor({
    subscriptions, accounts, projects, memberships, files, folders,
    versions, shares, submissions, tasks, quotas, objects, audit, config, projectService,
  }) {
    this.subscriptions = subscriptions;
    this.accounts = accounts;
    this.projects = projects;
    this.memberships = memberships;
    this.files = files;
    this.folders = folders;
    this.versions = versions;
    this.shares = shares;
    this.submissions = submissions;
    this.tasks = tasks;
    this.quotas = quotas;
    this.objects = objects;
    this.audit = audit;
    this.config = config;
    this.projectService = projectService;
  }

  get termDays() { return this.config.subscriptionDays ?? 30; }
  get graceDays() { return this.config.subscriptionGraceDays ?? 7; }

  static paid(plan) { return PAID_PLANS.has(plan); }

  /** ACTIVE → GRACE → EXPIRED; для отсутствующей подписки — NONE. */
  static status(row, now = Date.now()) {
    if (!row) return 'NONE';
    if (row.purgedAt) return 'EXPIRED';
    const t = now instanceof Date ? now.getTime() : Number(now);
    if (t < new Date(row.expiresAt).getTime()) return 'ACTIVE';
    if (t < new Date(row.graceUntil).getTime()) return 'GRACE';
    return 'EXPIRED';
  }

  static view(row, now = Date.now()) {
    if (!row) return null;
    const t = now instanceof Date ? now.getTime() : Number(now);
    const expires = new Date(row.expiresAt).getTime();
    const grace = new Date(row.graceUntil).getTime();
    const status = SubscriptionService.status(row, t);
    return {
      id: row.id,
      scope: row.scope,
      plan: row.plan,
      status,
      startedAt: row.startedAt ?? null,
      expiresAt: row.expiresAt ?? null,
      graceUntil: row.graceUntil ?? null,
      renewedAt: row.renewedAt ?? null,
      purgedAt: row.purgedAt ?? null,
      daysLeft: status === 'ACTIVE' ? Math.max(0, Math.ceil((expires - t) / DAY)) : 0,
      graceDaysLeft: status === 'GRACE' ? Math.max(0, Math.ceil((grace - t) / DAY)) : 0,
    };
  }

  /**
   * Создаёт/обновляет подписку. Повторное назначение того же тарифа после
   * истечения срока считается продлением; renew=true продлевает всегда.
   */
  async ensure(scope, targetId, plan, { renew = false, actorId = null, projectId = null } = {}) {
    if (!Enums.PLANS.has(plan)) throw new BadRequestError('Выберите тариф START, PERSONAL или TEAM.');
    const finder = scope === 'ACCOUNT' ? () => this.subscriptions.findByAccount(targetId) : () => this.subscriptions.findByProject(targetId);
    const existing = await finder();

    if (!SubscriptionService.paid(plan)) {
      // Бесплатный тариф не требует подписки: удаляем запись, чтобы она не мешала свипу.
      if (existing) await this.subscriptions.deleteById(existing.id);
      if (scope === 'PROJECT' && projectId) await this.quotas.deleteByProject(projectId);
      return null;
    }

    const now = new Date();
    const status = SubscriptionService.status(existing, now);
    const needsReset = !existing || renew || existing.plan !== plan || status === 'EXPIRED';
    const planChanged = existing && existing.plan !== plan;
    const expiresAt = new Date(now.getTime() + this.termDays * DAY);
    const graceUntil = new Date(expiresAt.getTime() + this.graceDays * DAY);

    if (!existing) {
      return this.subscriptions.insert({
        scope,
        accountId: scope === 'ACCOUNT' ? targetId : null,
        projectId: scope === 'PROJECT' ? targetId : null,
        plan,
        startedAt: now,
        expiresAt,
        graceUntil,
      });
    }
    if (!needsReset) return existing;

    await this.subscriptions.update(existing.id, {
      plan,
      startedAt: now,
      expiresAt,
      graceUntil,
      renewedAt: now,
      purgedAt: null,
    });
    // При смене тарифа старые доли могли превысить новый объём — сбрасываем распределение.
    if (planChanged && scope === 'PROJECT' && projectId) await this.quotas.deleteByProject(projectId);
    if (actorId) {
      await this.audit.record(actorId, projectId, 'SUBSCRIPTION_RENEWED', scope, targetId,
        `${plan} до ${expiresAt.toISOString().slice(0, 10)}`);
    }
    return this.subscriptions.findById(existing.id);
  }

  ensureAccount(accountId, plan, opts = {}) { return this.ensure('ACCOUNT', accountId, plan, opts); }
  ensureProject(projectId, plan, opts = {}) { return this.ensure('PROJECT', projectId, plan, { ...opts, projectId }); }

  async accountInfo(accountId) {
    const account = await this.accounts.findById(accountId);
    if (!account) throw new NotFoundError();
    const row = await this.subscriptions.findByAccount(accountId);
    return {
      scope: 'ACCOUNT',
      plan: account.plan,
      subscription: SubscriptionService.view(row),
      termDays: this.termDays,
      graceDays: this.graceDays,
    };
  }

  async projectInfo(projectId) {
    const project = await this.projects.findById(projectId);
    if (!project) throw new NotFoundError();
    const row = await this.subscriptions.findByProject(projectId);
    return {
      scope: 'PROJECT',
      plan: project.plan,
      subscription: SubscriptionService.view(row),
      termDays: this.termDays,
      graceDays: this.graceDays,
    };
  }

  /** Тестовая «покупка» подписки аккаунта: выбранный тариф + новый срок 30 дней. */
  async renewAccount(accountId, plan, actorId) {
    if (!SubscriptionService.paid(plan)) throw new BadRequestError('Для подписки выберите тариф PERSONAL или TEAM.');
    const account = await this.accounts.findById(accountId);
    if (!account) throw new NotFoundError();
    await this.accounts.update(accountId, { plan });
    await this.ensureAccount(accountId, plan, { renew: true, actorId });
    return this.accountInfo(accountId);
  }

  /** Тестовая «покупка» подписки проекта: только владелец проекта. */
  async renewProject(projectId, plan, actorId) {
    if (!SubscriptionService.paid(plan)) throw new BadRequestError('Для подписки выберите тариф PERSONAL или TEAM.');
    const project = await this.projects.findById(projectId);
    if (!project) throw new NotFoundError();
    await this.projectService.owner(projectId, actorId);
    await this.projects.update(projectId, { plan });
    await this.ensureProject(projectId, plan, { renew: true, actorId, projectId });
    return this.projectInfo(projectId);
  }

  /** Удаляет данные пространства, чья подписка истекла вместе с льготным периодом. */
  async sweep(now = new Date()) {
    const due = await this.subscriptions.listDue(now);
    const purged = [];
    for (const row of due) {
      try {
        if (row.scope === 'PROJECT') await this.purgeProject(row.projectId, now);
        else await this.purgeAccount(row.accountId, now);
        await this.subscriptions.update(row.id, { purgedAt: now });
        purged.push({ scope: row.scope, plan: row.plan, accountId: row.accountId, projectId: row.projectId });
      } catch (error) {
        console.error(`[subscriptions] не удалось очистить данные подписки ${row.id}:`, error.message);
      }
    }
    return purged;
  }

  async purgeProject(projectId, now) {
    const project = await this.projects.findById(projectId);
    if (!project) return;
    // Сначала снимаем ссылку на итоговый файл — иначе FK не даст удалить файл.
    await this.projects.update(projectId, { finalFileId: null, status: 'IN_PROGRESS', plan: 'START' });
    const files = await this.files.listByProject(projectId);
    for (const file of files) await this.purgeFile(file);
    await this.folders.deleteByProject(projectId);
    await this.submissions.deleteByProject(projectId);
    await this.tasks.deleteByProject(projectId);
    await this.quotas.deleteByProject(projectId);
    await this.audit.record(null, projectId, 'DATA_PURGED', 'PROJECT', projectId,
      `Подписка ${project.plan} истекла, льготный период ${this.graceDays} дн. завершён`);
    await this.audit.record(null, projectId, 'SUBSCRIPTION_EXPIRED', 'PROJECT', projectId, `Был тариф ${project.plan}`);
  }

  async purgeAccount(accountId, now) {
    const account = await this.accounts.findById(accountId);
    if (!account) return;
    await this.accounts.update(accountId, { plan: 'START' });
    const files = await this.files.listByOwner(accountId);
    for (const file of files) await this.purgeFile(file);
    const folders = await this.folders.listFor(accountId, null);
    for (const folder of folders) await this.folders.deleteById(folder.id);
    await this.audit.record(null, null, 'DATA_PURGED', 'ACCOUNT', accountId,
      `Подписка ${account.plan} истекла, льготный период ${this.graceDays} дн. завершён`);
    await this.audit.record(null, null, 'SUBSCRIPTION_EXPIRED', 'ACCOUNT', accountId, `Был тариф ${account.plan}`);
  }

  async purgeFile(file) {
    const versions = await this.versions.listByFile(file.id);
    const keys = new Set(versions.map((v) => v.objectKey));
    if (file.objectKey) keys.add(file.objectKey);
    await this.shares.deleteByFile(file.id);
    await this.versions.deleteByFile(file.id);
    await this.files.deleteById(file.id);
    for (const key of keys) {
      try { await this.objects.delete(key); }
      catch (error) { console.error(`Object cleanup required ${key}`, error.message); }
    }
  }
}

module.exports = { SubscriptionService, PAID_PLANS };
