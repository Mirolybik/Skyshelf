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
