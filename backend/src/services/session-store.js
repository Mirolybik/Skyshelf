/* Серверные сессии HttpOnly + CSRF-токены (порт HttpSessionSecurityContextRepository + CsrfToken).
   Хранилище в памяти достаточно для одного стенда; интерфейс SessionStore позволяет заменить его на БД. */
'use strict';

const crypto = require('node:crypto');

class Session {
  constructor(id) {
    this.id = id;
    this.userId = null;
    this.csrfToken = crypto.randomBytes(32).toString('hex');
    this.createdAt = Date.now();
    this.lastTouchedAt = Date.now();
  }
}

class SessionStore {
  constructor({ ttlMs = 30 * 60 * 1000 } = {}) {
    this.ttlMs = ttlMs;
    this.sessions = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastTouchedAt > this.ttlMs) this.sessions.delete(id);
    }
  }

  create() {
    const session = new Session(crypto.randomUUID());
    this.sessions.set(session.id, session);
    return session;
  }

  get(id) {
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) return null;
    if (Date.now() - session.lastTouchedAt > this.ttlMs) { this.sessions.delete(session.id); return null; }
    session.lastTouchedAt = Date.now();
    return session;
  }

  destroy(id) { this.sessions.delete(id); }

  /** Смена session ID при входе (защита от фиксации сессии). */
  rotate(oldId) {
    if (oldId) this.sessions.delete(oldId);
    return this.create();
  }

  /** Все сессии пользователя (для инвалидации при блокировке/выходе). */
  byUser(userId) {
    return [...this.sessions.values()].filter((s) => s.userId === userId);
  }
}

module.exports = { SessionStore, Session };
