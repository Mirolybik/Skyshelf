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
