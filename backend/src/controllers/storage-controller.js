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
