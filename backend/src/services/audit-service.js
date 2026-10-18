/* Аудит значимых событий (порт AuditService.java). */
'use strict';

const { AuditEvent } = require('../domain/entities');

class AuditService {
  constructor({ audits, memberships, accounts }) {
    this.audits = audits;
    this.memberships = memberships;
    this.accounts = accounts;
  }

  async record(actorId, projectId, action, targetType, targetId, details) {
    const clean = details == null ? '' : String(details).trim().slice(0, 500);
    await this.audits.insert(new AuditEvent({ actorId, projectId, action, targetType, targetId, details: clean }));
  }

  async visible(userId, requested) {
    const limit = Math.max(1, Math.min(100, Number(requested) || 50));
    const memberships = await this.memberships.listByUser(userId);
    const projectIds = memberships.map((m) => m.projectId);
    const events = await this.audits.listVisible(userId, projectIds, limit);
    const names = new Map();
    for (const e of events) {
      if (e.actorId && !names.has(e.actorId)) {
        const account = await this.accounts.findById(e.actorId);
        names.set(e.actorId, account ? account.name : 'Система');
      }
    }
    return events.map((e) => ({
      id: e.id, action: e.action, targetType: e.targetType, targetId: e.targetId,
      projectId: e.projectId, details: e.details, createdAt: e.createdAt,
      actor: e.actorId ? names.get(e.actorId) ?? 'Система' : 'Система',
    }));
  }
}

module.exports = { AuditService };
