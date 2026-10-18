/* Ролевой доступ к проектам (порт ProjectService.java): OWNER/MEMBER/READER, лимиты тарифов,
   чек-лист задач, итоговый файл, публичные ссылки преподавателю. */
'use strict';

const { Enums, validateName } = require('../domain/entities');
const { BadRequestError, ForbiddenError, NotFoundError } = require('../domain/errors');

class ProjectService {
  constructor({ projects, memberships, accounts, tasks, files, submissions, crypto, audit }) {
    this.projects = projects;
    this.memberships = memberships;
    this.accounts = accounts;
    this.tasks = tasks;
    this.files = files;
    this.submissions = submissions;
    this.crypto = crypto;
    this.audit = audit;
  }

  static clean(value, max) { return value == null ? '' : String(value).trim().slice(0, max); }
  static validRole(role) { if (!Enums.MEMBER_ROLES.has(role)) throw new BadRequestError('Выберите роль участника или читателя.'); }
  static validAccent(value) { const v = value ?? 'blue'; if (!Enums.PROJECT_ACCENTS.has(v)) throw new BadRequestError('Неизвестный акцент проекта.'); return v; }
  static validCover(value) { const v = value ?? 'orb'; if (!Enums.PROJECT_COVERS.has(v)) throw new BadRequestError('Неизвестный стиль обложки.'); return v; }
  static validStatus(value) { if (!Enums.PROJECT_STATUSES.has(value)) throw new BadRequestError('Неизвестный статус проекта.'); return value; }
  memberLimit(project) { return project.plan === 'TEAM' ? 25 : 5; }

  /** Роль пользователя в проекте; проект/blocked-владелец недоступны → 404 (как в Java-версии). */
  async role(projectId, userId) {
    const project = await this.projects.findById(projectId);
    if (!project) throw new NotFoundError();
    const owner = await this.accounts.findById(project.ownerId);
    if (!owner || owner.blocked) throw new NotFoundError();
    const membership = await this.memberships.find(projectId, userId);
    if (!membership) throw new NotFoundError();
    return membership.role;
  }

  async access(projectId, userId, write) {
    const role = await this.role(projectId, userId);
    if (write && role === 'READER') throw new ForbiddenError('Читатель может только просматривать и скачивать файлы.');
  }

  async owner(projectId, userId) {
    if ((await this.role(projectId, userId)) !== 'OWNER') throw new ForbiddenError('Действие доступно владельцу проекта.');
  }

  async create(userId, name, course = '', teacher = '', deadline = null, accent = 'blue', cover = 'orb') {
    const project = await this.projects.insert({
      ownerId: userId, name: validateName(name, 120), course: ProjectService.clean(course, 120),
      teacher: ProjectService.clean(teacher, 120), deadline, accent: ProjectService.validAccent(accent),
      cover: ProjectService.validCover(cover),
    });
    await this.memberships.insert({ projectId: project.id, userId, role: 'OWNER' });
    await this.seedTasks(project.id);
    await this.audit.record(userId, project.id, 'PROJECT_CREATED', 'PROJECT', project.id, project.name);
    return project;
  }

  async update(id, actorId, { name, description, course, teacher, deadline, accent, cover, status }) {
    await this.projects.lockById(id);
    await this.owner(id, actorId);
    const patch = {};
    if (name != null) patch.name = validateName(name, 120);
    if (description != null) patch.description = ProjectService.clean(description, 700);
    if (course != null) patch.course = ProjectService.clean(course, 120);
    if (teacher != null) patch.teacher = ProjectService.clean(teacher, 120);
    patch.deadline = deadline === undefined ? undefined : deadline;
    if (accent != null) patch.accent = ProjectService.validAccent(accent);
    if (cover != null) patch.cover = ProjectService.validCover(cover);
    if (status != null) patch.status = ProjectService.validStatus(status);
    for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
    await this.projects.update(id, patch);
    const project = await this.projects.findById(id);
    await this.audit.record(actorId, id, 'PROJECT_UPDATED', 'PROJECT', id, project.name);
    return project;
  }

  async add(projectId, actorId, email, role) {
    const project = await this.projects.lockById(projectId);
    if (!project) throw new NotFoundError();
    await this.owner(projectId, actorId);
    ProjectService.validRole(role);
    if (!email) throw new BadRequestError('Укажите email участника.');
    const account = await this.accounts.findByEmail(email);
    if (!account || account.blocked) throw new BadRequestError('Пользователь должен сначала зарегистрироваться в SkyShelf.');
    if (await this.memberships.find(projectId, account.id)) throw new BadRequestError('Пользователь уже в проекте.');
    const members = await this.memberships.listByProject(projectId);
    if (members.length >= this.memberLimit(project)) throw new BadRequestError('Лимит участников для текущего тарифа исчерпан.');
    await this.memberships.insert({ projectId, userId: account.id, role });
    await this.audit.record(actorId, projectId, 'MEMBER_ADDED', 'MEMBERSHIP', account.id, `${account.email} · ${role}`);
  }

  async change(projectId, actorId, membershipId, role, remove) {
    await this.projects.lockById(projectId);
    await this.owner(projectId, actorId);
    const membership = await this.memberships.findById(membershipId);
    if (!membership || membership.projectId !== projectId) throw new NotFoundError();
    if (membership.role === 'OWNER') throw new BadRequestError('Владельца нельзя удалить или изменить его роль.');
    if (remove) {
      await this.memberships.deleteById(membershipId);
      await this.audit.record(actorId, projectId, 'MEMBER_REMOVED', 'MEMBERSHIP', membershipId, membership.userId);
    } else {
      ProjectService.validRole(role);
      await this.memberships.update(membershipId, { role });
      await this.audit.record(actorId, projectId, 'MEMBER_ROLE_CHANGED', 'MEMBERSHIP', membershipId, role);
    }
  }

  async list(userId) {
    const memberships = await this.memberships.listByUser(userId);
    const out = [];
    for (const m of memberships) {
      const project = await this.projects.findById(m.projectId);
      if (!project) continue;
      const owner = await this.accounts.findById(project.ownerId);
      if (!owner || owner.blocked) continue;
      out.push(await this.projectView(project, m.role));
    }
    return out;
  }

  async detail(id, userId) {
    const role = await this.role(id, userId);
    return this.projectView(await this.projects.findById(id), role);
  }

  async projectView(project, role) {
    const projectTasks = await this.tasks.listByProject(project.id);
    const members = await this.memberships.listByProject(project.id);
    return {
      id: project.id, name: project.name, description: project.description, course: project.course,
      teacher: project.teacher, deadline: project.deadline, accent: project.accent, cover: project.cover,
      status: project.status, finalFileId: project.finalFileId, role, plan: project.plan,
      members: members.length, memberLimit: this.memberLimit(project),
      tasks: projectTasks.length, completedTasks: projectTasks.filter((t) => t.completed).length,
      createdAt: project.createdAt,
    };
  }

  async taskList(projectId, actorId) {
    await this.access(projectId, actorId, false);
    const tasks = await this.tasks.listByProject(projectId);
    return Promise.all(tasks.map((t) => this.taskView(t)));
  }

  async createTask(projectId, actorId, title, assigneeId, dueAt) {
    await this.access(projectId, actorId, true);
    const existing = await this.tasks.listByProject(projectId);
    const task = await this.tasks.insert({
      projectId, title: validateName(title, 180),
      assigneeId: await this.validAssignee(projectId, assigneeId), dueAt: dueAt ?? null, position: existing.length,
    });
    await this.audit.record(actorId, projectId, 'TASK_CREATED', 'TASK', task.id, task.title);
    return task;
  }

  async updateTask(projectId, actorId, id, { title, completed, assigneeId, dueAt }) {
    await this.access(projectId, actorId, true);
    const task = await this.tasks.findById(id);
    if (!task || task.projectId !== projectId) throw new NotFoundError();
    const patch = { dueAt: dueAt === undefined ? task.dueAt : dueAt };
    if (title != null) patch.title = validateName(title, 180);
    if (completed != null) patch.completed = completed;
    if (assigneeId != null) patch.assigneeId = await this.validAssignee(projectId, assigneeId === '' ? null : assigneeId);
    await this.tasks.update(id, patch);
    const updated = await this.tasks.findById(id);
    await this.audit.record(actorId, projectId, updated.completed ? 'TASK_COMPLETED' : 'TASK_UPDATED', 'TASK', id, updated.title);
    return updated;
  }

  async deleteTask(projectId, actorId, id) {
    await this.access(projectId, actorId, true);
    const task = await this.tasks.findById(id);
    if (!task || task.projectId !== projectId) throw new NotFoundError();
    await this.tasks.deleteById(id);
    await this.audit.record(actorId, projectId, 'TASK_DELETED', 'TASK', id, task.title);
  }

  async validAssignee(projectId, id) {
    if (!id) return null;
    const membership = await this.memberships.find(projectId, id);
    if (!membership) throw new BadRequestError('Исполнитель должен состоять в проекте.');
    return membership.userId;
  }

  async taskView(task) {
    let assignee = null;
    if (task.assigneeId) {
      const account = await this.accounts.findById(task.assigneeId);
      assignee = account ? account.name : 'Участник';
    }
    return {
      id: task.id, title: task.title, completed: task.completed, assigneeId: task.assigneeId,
      assignee, dueAt: task.dueAt, position: task.position,
    };
  }

  async setFinal(projectId, actorId, fileId) {
    await this.projects.lockById(projectId);
    await this.owner(projectId, actorId);
    const file = await this.files.findById(fileId);
    if (!file || file.projectId !== projectId || file.trashed) throw new NotFoundError();
    await this.projects.update(projectId, { finalFileId: fileId, status: 'READY' });
    await this.audit.record(actorId, projectId, 'FINAL_FILE_SELECTED', 'FILE', fileId, file.name);
    return this.projects.findById(projectId);
  }

  async clearFinalIf(projectId, fileId) {
    if (!projectId) return;
    const project = await this.projects.findById(projectId);
    if (project && project.finalFileId === fileId) {
      await this.projects.update(projectId, { finalFileId: null, status: 'IN_PROGRESS' });
    }
  }

  async createSubmission(projectId, actorId, hours) {
    const project = await this.projects.lockById(projectId);
    if (!project) throw new NotFoundError();
    await this.owner(projectId, actorId);
    if (!project.finalFileId) throw new BadRequestError('Сначала отметьте итоговый файл проекта.');
    if (hours < 1 || hours > 720) throw new BadRequestError('Срок ссылки — от 1 до 720 часов.');
    await this.submissions.deleteByProject(projectId);
    const raw = this.crypto.newToken();
    const link = await this.submissions.insertSubmission({
      token: this.constructor.tokenHash(raw), projectId,
      expiresAt: new Date(Date.now() + hours * 3600_000),
    });
    await this.projects.update(projectId, { status: 'SUBMITTED' });
    await this.audit.record(actorId, projectId, 'SUBMISSION_LINK_CREATED', 'PROJECT', projectId, `Срок ${hours} ч.`);
    return { token: raw, id: link.token, expiresAt: link.expiresAt ?? null };
  }

  static tokenHash(raw) {
    // делегируем статике CryptoService, чтобы не дублировать логику
    const { CryptoService } = require('./crypto-service');
    return CryptoService.tokenHash(raw);
  }

  async submissionList(projectId, actorId) {
    await this.owner(projectId, actorId);
    const links = await this.submissions.listByProject(projectId);
    return links.map((s) => ({ id: s.token, createdAt: s.createdAt, expiresAt: s.expiresAt, views: s.views }));
  }

  async revokeSubmissions(projectId, actorId) {
    await this.owner(projectId, actorId);
    await this.submissions.deleteByProject(projectId);
    await this.audit.record(actorId, projectId, 'SUBMISSION_LINK_REVOKED', 'PROJECT', projectId, '');
  }

  /** Публичная карточка преподавателя; countView=true блокирует строку и увеличивает просмотры. */
  async publicSubmission(rawToken, countView) {
    const hash = this.constructor.tokenHash(rawToken ?? '');
    const link = countView ? await this.submissions.lockByToken(hash) : await this.submissions.findByToken(hash);
    if (!link || new Date(link.expiresAt) <= new Date()) throw new NotFoundError();
    const project = await this.projects.findById(link.projectId);
    if (!project) throw new NotFoundError();
    const owner = await this.accounts.findById(project.ownerId);
    if (!owner || owner.blocked || !project.finalFileId) throw new NotFoundError();
    const file = await this.files.findById(project.finalFileId);
    if (!file || file.trashed) throw new NotFoundError();
    if (countView) await this.submissions.bumpViews(hash);
    return { project, file, link };
  }

  async seedTasks(projectId) {
    const titles = ['Собрать материалы проекта', 'Проверить роли участников', 'Отметить итоговый файл', 'Создать ссылку преподавателю'];
    for (const [position, title] of titles.entries()) {
      await this.tasks.insert({ projectId, title, position });
    }
  }
}

module.exports = { ProjectService };
