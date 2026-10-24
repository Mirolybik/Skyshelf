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
