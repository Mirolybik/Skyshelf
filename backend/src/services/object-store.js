/* Хранилище бинарных объектов (порт ObjectStore): два драйвера за общим интерфейсом —
   LocalObjectStore (файловая система, атомарная запись) и MinioObjectStore (S3 API через fetch).
   Минимизация зависимостей вместо тяжёлого SDK: подпись AWS SigV4 реализована локально. */
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { NotFoundError } = require('../domain/errors');

/** Интерфейс объектного хранилища. */
class ObjectStore {
  // eslint-disable-next-line no-unused-vars
  async put(key, buffer) { throw new Error('not implemented'); }
  async get(key) { throw new Error('not implemented'); }
  // eslint-disable-next-line no-unused-vars
  async delete(key) { throw new Error('not implemented'); }
  static validateKey(key) {
    if (!/^[a-f0-9-]{36}$/.test(String(key))) throw new NotFoundError('Объект не найден или недоступен.');
    return key;
  }
}

class LocalObjectStore extends ObjectStore {
  constructor(dir) {
    super();
    this.root = path.resolve(dir);
  }

  async init() { await fs.mkdir(this.root, { recursive: true }); }

  path(key) {
    return path.join(this.root, ObjectStore.validateKey(key));
  }

  async put(key, buffer) {
    const target = this.path(key);
    const tmp = path.join(this.root, `upload-${crypto.randomUUID()}.tmp`);
    await fs.writeFile(tmp, buffer);
    try { await fs.rename(tmp, target); } finally { await fs.rm(tmp, { force: true }); }
  }

  async get(key) {
    try { return await fs.readFile(this.path(key)); }
    catch (e) { if (e.code === 'ENOENT') throw new NotFoundError('Объект не найден или недоступен.'); throw e; }
  }

  async delete(key) { await fs.rm(this.path(key), { force: true }); }
}

/** Минимальный клиент S3 (SigV4) для MinIO: PUT/GET/HEAD/DELETE объекта и создание бакета. */
class MinioObjectStore extends ObjectStore {
  constructor({ endpoint, accessKey, secretKey, bucket }) {
    super();
    this.base = new URL(endpoint);
    this.accessKey = accessKey;
    this.secretKey = secretKey;
    this.bucket = bucket;
  }

  static hmac(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
  static sha256hex(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

  async init() {
    // HEAD bucket → при 404 создаём
    const head = await this.request('HEAD', `/${this.bucket}/`, null, true);
    if (head.status === 404) await this.request('PUT', `/${this.bucket}/`, null, true);
  }

  sign(method, objectPath, body, extraHeaders = {}) {
    const host = this.base.host;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = body == null ? MinioObjectStore.sha256hex('') : MinioObjectStore.sha256hex(body);
    const headers = { host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash, ...extraHeaders };
    const sortedNames = Object.keys(headers).sort();
    const canonicalHeaders = sortedNames.map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');
    const signedHeaders = sortedNames.join(';');
    const canonicalRequest = [method, objectPath.split('?')[0].split('/').map(encodeURIComponent).join('/'), '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const scope = `${dateStamp}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, MinioObjectStore.sha256hex(canonicalRequest)].join('\n');
    const kDate = MinioObjectStore.hmac(`AWS4${this.secretKey}`, dateStamp);
    const kRegion = MinioObjectStore.hmac(kDate, 'us-east-1');
    const kService = MinioObjectStore.hmac(kRegion, 's3');
    const kSigning = MinioObjectStore.hmac(kService, 'aws4_request');
    const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
    headers.Authorization = `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
    return headers;
  }

  async request(method, objectPath, body, silentStatuses = false) {
    const url = new URL(objectPath, this.base);
    const res = await fetch(url, { method, body: body ?? undefined, headers: this.sign(method, objectPath, body) });
    if (!res.ok && !silentStatuses && res.status !== 404) throw new Error(`MinIO ${method} ${objectPath}: HTTP ${res.status}`);
    return res;
  }

  async put(key, buffer) {
    ObjectStore.validateKey(key);
    const res = await this.request('PUT', `/${this.bucket}/${key}`, buffer);
    if (!res.ok) throw new Error(`MinIO put failed: HTTP ${res.status}`);
  }

  async get(key) {
    ObjectStore.validateKey(key);
    const res = await this.request('GET', `/${this.bucket}/${key}`, null, true);
    if (res.status === 404) throw new NotFoundError('Объект не найден или недоступен.');
    if (!res.ok) throw new Error(`MinIO get failed: HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key) {
    ObjectStore.validateKey(key);
    await this.request('DELETE', `/${this.bucket}/${key}`, null, true);
  }
}

/** Фабрика драйверов (OCP: новый драйвер = новый класс без правки остальных). */
function createObjectStore(config) {
  if (config.storageDriver === 'minio') {
    return new MinioObjectStore({
      endpoint: config.minio.endpoint, accessKey: config.minio.accessKey,
      secretKey: config.minio.password, bucket: config.minio.bucket,
    });
  }
  return new LocalObjectStore(config.storageDir);
}

module.exports = { ObjectStore, LocalObjectStore, MinioObjectStore, createObjectStore };
