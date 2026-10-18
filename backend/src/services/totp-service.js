/* TOTP по RFC 6238 (порт TotpService.java): генерация секрета, проверка кода ±1 окно, otpauth URI. */
'use strict';

const crypto = require('node:crypto');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

class TotpService {
  newSecret() { return TotpService.encodeBase32(crypto.randomBytes(20)); }

  valid(secret, supplied) {
    if (!supplied || !/^\d{6}$/.test(String(supplied))) return false;
    const window = Math.floor(Date.now() / 30000);
    for (const offset of [-1, 0, 1]) {
      if (TotpService.safeEquals(this.code(secret, window + offset), String(supplied))) return true;
    }
    return false;
  }

  uri(email, secret) {
    const label = encodeURIComponent(`SkyShelf:${email}`);
    return `otpauth://totp/${label}?secret=${secret}&issuer=SkyShelf&algorithm=SHA1&digits=6&period=30`;
  }

  code(secret, counter) {
    const key = TotpService.decodeBase32(secret);
    const data = Buffer.alloc(8);
    data.writeBigUInt64BE(BigInt(counter));
    const hash = crypto.createHmac('sha1', key).update(data).digest();
    const offset = hash[hash.length - 1] & 0x0f;
    const binary = (hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
    return String(binary).padStart(6, '0');
  }

  static encodeBase32(bytes) {
    let out = '', buffer = 0, bits = 0;
    for (const value of bytes) {
      buffer = (buffer << 8) | value; bits += 8;
      while (bits >= 5) { out += BASE32_ALPHABET[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
    }
    if (bits > 0) out += BASE32_ALPHABET[(buffer << (5 - bits)) & 31];
    return out;
  }

  static decodeBase32(value) {
    const chunks = [];
    let bits = '';
    for (const ch of String(value).replace(/=/g, '').toUpperCase()) {
      const index = BASE32_ALPHABET.indexOf(ch);
      if (index < 0) throw new Error('base32');
      bits += index.toString(2).padStart(5, '0');
    }
    for (let i = 0; i + 8 <= bits.length; i += 8) chunks.push(parseInt(bits.slice(i, i + 8), 2));
    return Buffer.from(chunks);
  }

  static safeEquals(a, b) {
    const ba = Buffer.from(a), bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }
}

module.exports = { TotpService };
