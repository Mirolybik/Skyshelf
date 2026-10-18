/* Прикладная криптография: AES-256-GCM для объектов и секретов, SHA-256 для целостности
   и токенов ссылок, Argon2id для паролей. Порт CryptoService.java. */
'use strict';

const crypto = require('node:crypto');
const argon2 = require('argon2');

const MAGIC = Buffer.from('SKY2'); // конверт нового формата: MAGIC | nonce(12) | ciphertext+tag
const NONCE_SIZE = 12;

class CryptoService {
  constructor(masterKeyBase64) {
    const raw = Buffer.from(masterKeyBase64, 'base64');
    if (raw.length !== 32) throw new Error('SKYSHELF_MASTER_KEY must contain a Base64 encoded 32-byte key');
    this.key = raw;
  }

  encrypt(plain) {
    const nonce = crypto.randomBytes(NONCE_SIZE);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(MAGIC);
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([MAGIC, nonce, encrypted, cipher.getAuthTag()]);
  }

  /** Расшифровка конверта; объекты старого формата (без MAGIC) возвращаются как есть — порт миграции. */
  decrypt(envelope) {
    if (!this.isEncrypted(envelope)) return envelope;
    const nonce = envelope.subarray(MAGIC.length, MAGIC.length + NONCE_SIZE);
    const payload = envelope.subarray(MAGIC.length + NONCE_SIZE);
    const authTag = payload.subarray(payload.length - 16);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, nonce);
    decipher.setAAD(MAGIC);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(payload.subarray(0, payload.length - 16)), decipher.final()]);
  }

  isEncrypted(bytes) {
    return bytes.length > MAGIC.length + NONCE_SIZE + 16 && bytes.subarray(0, MAGIC.length).equals(MAGIC);
  }

  encryptText(value) { return this.encrypt(Buffer.from(value, 'utf8')).toString('base64'); }
  decryptText(value) { return this.decrypt(Buffer.from(value, 'base64')).toString('utf8'); }

  static checksum(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

  /** Токены ссылок: в БД хранится только URL-safe base64 от SHA-256. */
  static tokenHash(token) {
    return crypto.createHash('sha256').update(String(token ?? ''), 'utf8').digest('base64url');
  }

  newToken() { return crypto.randomBytes(32).toString('base64url'); }

  hashPassword(password) { return argon2.hash(password, { type: argon2.argon2id }); }
  verifyPassword(hash, password) {
    return argon2.verify(hash, password ?? '').catch(() => false);
  }

  /** Constant-time сравнение строк контрольных сумм. */
  static safeEquals(a, b) {
    const ba = Buffer.from(String(a), 'ascii'), bb = Buffer.from(String(b), 'ascii');
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }
}

module.exports = { CryptoService, MAGIC };
