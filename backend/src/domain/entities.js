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
