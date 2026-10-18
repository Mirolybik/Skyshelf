/* Личное и командное хранилище (порт StorageService.java): загрузка с прикладным шифрованием,
   версии файлов, папки, квоты тарифов, публичные ссылки, корзина и полная очистка. */
'use strict';

const crypto = require('node:crypto');
const { Enums, validateName } = require('../domain/entities');
const { CryptoService } = require('./crypto-service');
const {
  BadRequestError, UnauthorizedError, NotFoundError, ConflictError,
  PayloadTooLargeError, IntegrityError,
} = require('../domain/errors');

class StorageService {
  constructor({ files, folders, shares, accounts, versions, projectsRepo, objects, crypto: enc, audit, projectService, config }) {
    this.files = files;
    this.folders = folders;
    this.shares = shares;
    this.accounts = accounts;
    this.versions = versions;
    this.projectsRepo = projectsRepo;
    this.objects = objects;
    this.crypto = enc;
    this.audit = audit;
    this.projects = projectService;
    this.config = config;
  }

  /** Токены ссылок: в БД хранится только SHA-256 (base64url) от публичного токена. */
  static tokenHash(raw) { return CryptoService.tokenHash(raw); }
  static safeEquals(a, b) {
    const ba = Buffer.from(String(a), 'ascii'), bb = Buffer.from(String(b), 'ascii');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }

  static ext(name) { const dot = String(name).lastIndexOf('.'); return dot < 0 ? '' : name.slice(dot + 1).toLowerCase(); }
  static mime(name) { return Enums.MIME_BY_EXT[StorageService.ext(name)] ?? 'application/octet-stream'; }

  /** Магические байты против расширения (порт validateFile). */
  static validateFile(name, bytes) {
    const ext = StorageService.ext(name);
    if (!Enums.FILE_EXTENSIONS.has(ext)) throw new BadRequestError('Разрешены TXT, MD, CSV, PDF, PNG, JPG, ZIP, DOCX, XLSX, PPTX.');
    if (bytes.length === 0) throw new BadRequestError('Пустой файл нельзя загрузить.');
    if (bytes.length > 20 * 1024 * 1024) throw new PayloadTooLargeError();
    const starts = (arr) => bytes.length >= arr.length && bytes.subarray(0, arr.length).equals(Buffer.from(arr));
    const valid = (() => {
      switch (ext) {
        case 'pdf': return starts([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-
        case 'png': return starts([137, 80, 78, 71, 13, 10, 26, 10]);
        case 'jpg': case 'jpeg': return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        case 'zip': case 'docx': case 'xlsx': case 'pptx': return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [3, 5, 7].includes(bytes[2]);
        default: return !bytes.includes(0); // текст: без нулевых байтов
      }
    })();
    if (!valid) throw new BadRequestError('Содержимое файла не соответствует расширению.');
  }

  async accountName(id) {
    if (!id) return 'Участник';
    const account = await this.accounts.findById(id);
    return account ? account.name : 'Участник';
  }

  async access(actualOwner, projectId, actor, write) {
    if (projectId != null) await this.projects.access(projectId, actor, write);
    else if (actualOwner !== actor) throw new NotFoundError();
  }

  async owned(id, actor) {
    const file = await this.files.findById(id);
    if (!file) throw new NotFoundError();
    await this.access(file.ownerId, file.projectId, actor, false);
    return file;
  }

  async folder(id, actor) {
    const folder = await this.folders.findById(id);
    if (!folder) throw new NotFoundError();
    await this.access(folder.ownerId, folder.projectId, actor, false);
    return folder;
  }

  async workspaceFiles(user, projectId) {
    if (projectId != null) {
      await this.projects.access(projectId, user, false);
      return this.files.listByProject(projectId);
    }
    return this.files.listByOwner(user);
  }

  async folderList(user, projectId) {
    if (projectId != null) await this.projects.access(projectId, user, false);
    return this.folders.listFor(user, projectId);
  }

  async used(user, projectId) {
    const list = await this.workspaceFiles(user, projectId);
    let total = 0n;
    for (const f of list) {
      const versions = await this.versions.listByFile(f.id);
      total += versions.length
        ? versions.reduce((s, v) => s + BigInt(v.size), 0n)
        : BigInt(f.size);
    }
    return total;
  }

  async plan(user, projectId) {
    if (projectId == null) {
      const account = await this.accounts.findById(user);
      if (!account) throw new NotFoundError();
      return account.plan;
    }
    const project = await this.projectsRepo.findById(projectId);
    if (!project) throw new NotFoundError();
    return project.plan;
  }

  async limit(user, projectId) {
    const plan = await this.plan(user, projectId);
    return Enums.QUOTA_BYTES[plan] ?? this.config.quotaBytes;
  }

  /** Блокировка владельца/проекта на время транзакции (порт lock()). */
  async lock(user, projectId) {
    if (projectId == null) {
      const account = await this.accounts.lockById(user);
      if (!account) throw new NotFoundError();
    } else {
      const project = await this.projectsRepo.lockById(projectId);
      if (!project) throw new NotFoundError();
      await this.projects.access(projectId, user, true);
    }
  }

  async putEncrypted(key, plain) { await this.objects.put(key, this.crypto.encrypt(plain)); }

  async readObject(key, checksum) {
    const plain = this.crypto.decrypt(await this.objects.get(key));
    if (checksum && !StorageService.safeEquals(checksum, CryptoService.checksum(plain))) throw new IntegrityError();
    return plain;
  }

  async content(file) { return this.readObject(file.objectKey, file.checksum); }

  async saveVersion(file, actor, note, key, size, sum, mime, number) {
    const clean = note == null ? '' : String(note).trim().slice(0, 240);
    return this.versions.insert({
      fileId: file.id, createdById: actor, note: clean, objectKey: key,
      size: String(size), checksum: sum, mimeType: mime, versionNumber: number,
    });
  }

  /** Историческим файлам без записи версии создаём v1 (порт ensureVersionRow). */
  async ensureVersionRow(file) {
    const existing = await this.versions.listByFile(file.id);
    if (existing.length) return;
    await this.saveVersion(file, file.createdById ?? file.ownerId, 'Импортированная первая версия',
      file.objectKey, file.size, file.checksum, file.mimeType ?? StorageService.mime(file.name), 1);
    await this.files.update(file.id, { versionCount: 1 });
    file.versionCount = 1;
  }

  async upload(owner, filename, folderId, bytes, projectId = null) {
    await this.lock(owner, projectId);
    const clean = validateName(filename, 180);
    StorageService.validateFile(clean, bytes);
    if (folderId) {
      const folder = await this.folder(folderId, owner);
      if (folder.projectId !== projectId) throw new BadRequestError('Папка находится в другом пространстве.');
    } else folderId = null;
    const used = await this.used(owner, projectId);
    if (used + BigInt(bytes.length) > await this.limit(owner, projectId)) throw new BadRequestError('Недостаточно места в хранилище.');
    const objectKey = crypto.randomUUID();
    await this.putEncrypted(objectKey, bytes); // при откате транзакции объект останется осиротевшим — как in-memory cleanup у Spring
    const file = await this.files.insert({
      ownerId: owner, createdById: owner, projectId, name: clean, folderId,
      size: String(bytes.length), mimeType: StorageService.mime(clean),
      checksum: CryptoService.checksum(bytes), objectKey, versionCount: 1,
    });
    await this.saveVersion(file, owner, 'Первая версия', objectKey, bytes.length, file.checksum, file.mimeType, 1);
    await this.audit.record(owner, projectId, 'FILE_UPLOADED', 'FILE', file.id, `${clean} · SHA-256 ${file.checksum.slice(0, 12)}`);
    return file;
  }

  async addVersion(id, actor, incomingName, bytes, note) {
    const file = await this.owned(id, actor);
    await this.lock(actor, file.projectId);
    await this.access(file.ownerId, file.projectId, actor, true);
    if (file.trashed) throw new BadRequestError('Сначала восстановите файл из корзины.');
    const clean = validateName(incomingName, 180);
    if (StorageService.ext(clean) !== StorageService.ext(file.name)) throw new BadRequestError('Новая версия должна иметь то же расширение.');
    StorageService.validateFile(clean, bytes);
    const used = await this.used(actor, file.projectId);
    if (used + BigInt(bytes.length) > await this.limit(actor, file.projectId)) throw new BadRequestError('Недостаточно места: версии файлов учитываются в квоте.');
    await this.ensureVersionRow(file);
    const number = Math.max(1, file.versionCount) + 1;
    const key = crypto.randomUUID();
    const sum = CryptoService.checksum(bytes);
    await this.putEncrypted(key, bytes);
    await this.saveVersion(file, actor, note, key, bytes.length, sum, StorageService.mime(clean), number);
    await this.files.update(file.id, { objectKey: key, size: String(bytes.length), checksum: sum, mimeType: StorageService.mime(clean), versionCount: number, updatedAt: new Date() });
    await this.audit.record(actor, file.projectId, 'FILE_VERSION_ADDED', 'FILE', file.id, `${file.name} · версия ${number}`);
    return this.files.findById(file.id);
  }

  async versionList(id, actor) {
    const file = await this.owned(id, actor);
    await this.ensureVersionRow(file);
    return this.versions.listByFile(id);
  }

  async version(fileId, versionId, actor) {
    await this.owned(fileId, actor);
    const version = await this.versions.findForFile(versionId, fileId);
    if (!version) throw new NotFoundError();
    return version;
  }

  async versionContent(fileId, versionId, actor) {
    const v = await this.version(fileId, versionId, actor);
    return this.readObject(v.objectKey, v.checksum);
  }

  async restoreVersion(fileId, versionId, actor) {
    const v = await this.version(fileId, versionId, actor);
    const bytes = await this.readObject(v.objectKey, v.checksum);
    const file = await this.owned(fileId, actor);
    return this.addVersion(fileId, actor, file.name, bytes, `Восстановлена версия ${v.versionNumber}`);
  }

  async update(id, owner, newName, targetFolder, favorite, trashed) {
    const file = await this.owned(id, owner);
    await this.lock(owner, file.projectId);
    await this.access(file.ownerId, file.projectId, owner, true);
    if (file.trashed && trashed !== false) throw new BadRequestError('Сначала восстановите файл из корзины.');
    const patch = {};
    if (newName != null) {
      const clean = validateName(newName, 180);
      if (StorageService.ext(clean) !== StorageService.ext(file.name)) throw new BadRequestError('При переименовании сохраните расширение файла.');
      patch.name = clean;
      patch.mimeType = StorageService.mime(clean);
    }
    if (targetFolder != null) {
      if (targetFolder === '') patch.folderId = null;
      else {
        const folder = await this.folder(targetFolder, owner);
        if (folder.projectId !== file.projectId) throw new BadRequestError('Папка находится в другом пространстве.');
        patch.folderId = targetFolder;
      }
    }
    if (favorite != null) patch.favorite = favorite;
    if (trashed != null) {
      patch.trashed = trashed;
      if (trashed) await this.shares.deleteByFile(file.id);
      await this.audit.record(owner, file.projectId, trashed ? 'FILE_TRASHED' : 'FILE_RESTORED', 'FILE', file.id, file.name);
    }
    patch.updatedAt = new Date();
    await this.files.update(file.id, patch);
    return this.files.findById(file.id);
  }

  static validColor(color) { if (!Enums.FOLDER_COLORS.has(color)) throw new BadRequestError('Выберите цвет папки.'); }

  async createFolder(owner, folderName, color, projectId = null) {
    await this.lock(owner, projectId);
    const clean = validateName(folderName, 120);
    StorageService.validColor(color);
    if (await this.folders.existsByNameInSpace(owner, projectId, clean)) throw new ConflictError('Папка с таким названием уже существует.');
    const folder = await this.folders.insert({ ownerId: owner, projectId, name: clean, color });
    await this.audit.record(owner, projectId, 'FOLDER_CREATED', 'FOLDER', folder.id, clean);
    return folder;
  }

  async updateFolder(id, owner, newName, color) {
    const folder = await this.folder(id, owner);
    await this.lock(owner, folder.projectId);
    await this.access(folder.ownerId, folder.projectId, owner, true);
    const clean = validateName(newName, 120);
    const siblings = await this.folders.listFor(owner, folder.projectId);
    if (siblings.some((x) => x.id !== id && x.name.toLowerCase() === clean.toLowerCase())) throw new BadRequestError('Такая папка уже существует.');
    StorageService.validColor(color);
    await this.folders.update(id, { name: clean, color });
    return this.folders.findById(id);
  }

  async deleteFolder(id, owner) {
    const folder = await this.folder(id, owner);
    await this.lock(owner, folder.projectId);
    await this.access(folder.ownerId, folder.projectId, owner, true);
    if (await this.folders.hasFiles(id)) throw new BadRequestError('Папка не пуста. Переместите файлы, в том числе из корзины, в другую папку.');
    await this.folders.deleteById(id);
    await this.audit.record(owner, folder.projectId, 'FOLDER_DELETED', 'FOLDER', id, folder.name);
  }

  async share(id, owner, hours, password, maxDownloads) {
    const file = await this.owned(id, owner);
    if (file.trashed) throw new BadRequestError('Файл в корзине.');
    await this.lock(owner, file.projectId);
    if (file.projectId != null) await this.projects.owner(file.projectId, owner);
    if (hours < 1 || hours > 720) throw new BadRequestError('Срок ссылки — от 1 до 720 часов.');
    if (maxDownloads < 0 || maxDownloads > 1000) throw new BadRequestError('Лимит скачиваний — от 0 до 1000.');
    const pass = password == null ? '' : String(password).trim();
    if (pass && (pass.length < 4 || pass.length > 64)) throw new BadRequestError('Пароль ссылки: от 4 до 64 символов.');
    await this.shares.deleteByFile(id);
    const raw = this.crypto.newToken();
    const link = await this.shares.insertShare({
      token: this.constructor.tokenHash(raw), fileId: id,
      expiresAt: new Date(Date.now() + hours * 3600_000), maxDownloads,
      passwordHash: pass ? await this.crypto.hashPassword(pass) : null,
    });
    await this.audit.record(owner, file.projectId, 'SHARE_CREATED', 'FILE', file.id,
      `Срок ${hours} ч., лимит ${maxDownloads === 0 ? 'без ограничений' : maxDownloads}`);
    return { token: raw, id: link.token, expiresAt: link.expiresAt, passwordRequired: !!link.passwordHash, maxDownloads: link.maxDownloads, downloadCount: 0 };
  }

  async shareList(id, owner) {
    const file = await this.owned(id, owner);
    if (file.projectId != null) await this.projects.owner(file.projectId, owner);
    const links = await this.shares.listByFile(id);
    return links.map((s) => s.view());
  }

  async revoke(id, owner) {
    const file = await this.owned(id, owner);
    await this.lock(owner, file.projectId);
    if (file.projectId != null) await this.projects.owner(file.projectId, owner);
    await this.shares.deleteByFile(id);
    await this.audit.record(owner, file.projectId, 'SHARE_REVOKED', 'FILE', id, file.name);
  }

  async publicInfo(rawToken) {
    const link = await this.publicLink(rawToken, false, null);
    return { file: await this.availableSharedFile(link), link };
  }

  async publicDownload(rawToken, password) {
    const link = await this.publicLink(rawToken, true, password);
    const file = await this.availableSharedFile(link);
    await this.shares.updateByToken(link.token, { download_count: link.downloadCount + 1 });
    return { file, link };
  }

  async publicLink(raw, download, password) {
    const hash = this.constructor.tokenHash(raw ?? '');
    const link = download ? await this.shares.lockByToken(hash) : await this.shares.findByToken(hash);
    if (!link || new Date(link.expiresAt) <= new Date()) throw new NotFoundError();
    if (link.maxDownloads > 0 && link.downloadCount >= link.maxDownloads) throw new NotFoundError();
    if (download && link.passwordHash && !(await this.crypto.verifyPassword(link.passwordHash, password ?? ''))) {
      throw new UnauthorizedError('Неверный пароль ссылки.');
    }
    return link;
  }

  async availableSharedFile(link) {
    const file = await this.files.findById(link.fileId);
    if (!file || file.trashed) throw new NotFoundError();
    let ownerId = file.ownerId;
    if (file.projectId != null) {
      const project = await this.projectsRepo.findById(file.projectId);
      if (!project) throw new NotFoundError();
      ownerId = project.ownerId;
    }
    const owner = await this.accounts.findById(ownerId);
    if (!owner || owner.blocked) throw new NotFoundError();
    return file;
  }

  /** Полная очистка файла из корзины: версии, ссылки, объекты после коммита (порт purge). */
  async purge(id, actor) {
    const file = await this.owned(id, actor);
    await this.lock(actor, file.projectId);
    if (file.projectId != null) await this.projects.owner(file.projectId, actor);
    if (!file.trashed) throw new BadRequestError('Сначала переместите файл в корзину.');
    await this.shares.deleteByFile(id);
    const keys = new Set((await this.versions.listByFile(id)).map((v) => v.objectKey));
    keys.add(file.objectKey);
    await this.versions.deleteByFile(id);
    await this.files.deleteById(id);
    await this.projects.clearFinalIf(file.projectId, id);
    await this.audit.record(actor, file.projectId, 'FILE_PURGED', 'FILE', id, file.name);
    for (const key of keys) {
      try { await this.objects.delete(key); }
      catch (e) { console.error(`Object cleanup required ${key}`, e.message); }
    }
  }

  /** Портовый эквивалент migrateExisting(): дошифровка старых объектов и создание v1. */
  async migrateExisting() {
    for (const file of await this.files.findAll()) {
      let stored;
      try { stored = await this.objects.get(file.objectKey); } catch { continue; }
      const plain = this.crypto.decrypt(stored);
      const patch = {};
      if (!this.crypto.isEncrypted(stored)) await this.objects.put(file.objectKey, this.crypto.encrypt(plain));
      if (!file.checksum) patch.checksum = CryptoService.checksum(plain);
      if (!file.mimeType) patch.mimeType = StorageService.mime(file.name);
      if (!file.createdById) patch.createdById = file.ownerId;
      if (file.versionCount < 1) patch.versionCount = 1;
      if (Object.keys(patch).length) await this.files.update(file.id, patch);
      await this.ensureVersionRow(Object.assign(file, patch));
    }
  }
}

module.exports = { StorageService };
