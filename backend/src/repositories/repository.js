/* Абстрактный репозиторий (DIP): сервисы зависят от этого интерфейса, а не от SQL.
   Потомки объявляют таблицу, сущность и поле поиска; CRUD — общий. */
'use strict';

const crypto = require('node:crypto');
const { Entity } = require('../domain/entities');

class Repository {
  constructor(db, { table, Entity, searchColumn = null }) {
    this.db = db;
    this.table = table;
    this.Entity = Entity;
    this.searchColumn = searchColumn;
  }

  get client() { return this.db.client; }

  static columnsOf(Entity) { return Object.values(Entity.fieldMap); }

  /** Разрешаемые set-колонки для update(): только существующие колонки таблицы. */
  allowedColumns() { return new Set(Repository.columnsOf(this.Entity)); }

  async findById(id) {
    const { rows } = await this.client.query(`SELECT * FROM ${this.table} WHERE id = $1`, [id]);
    return rows[0] ? new this.Entity(rows[0]) : null;
  }

  async findAll() {
    const { rows } = await this.client.query(`SELECT * FROM ${this.table}`);
    return rows.map((r) => new this.Entity(r));
  }

  async count(where = null, params = []) {
    const sql = `SELECT count(*)::bigint AS c FROM ${this.table}${where ? ` WHERE ${where}` : ''}`;
    const { rows } = await this.client.query(sql, params);
    return rows[0].c;
  }

  async exists(where, params = []) {
    const { rows } = await this.client.query(`SELECT 1 FROM ${this.table} WHERE ${where} LIMIT 1`, params);
    return rows.length > 0;
  }

  async insert(entity, { returningId = true } = {}) {
    if (!(entity instanceof Entity)) entity = new this.Entity(entity); // допускаем plain-объекты
    const row = entity.toRow();
    if (!row.id && this.table !== 'share_links' && this.table !== 'submission_links') row.id = crypto.randomUUID();
    const cols = Object.keys(row);
    const values = Object.values(row);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const sql = `INSERT INTO ${this.table} (${cols.join(', ')}) VALUES (${placeholders})${returningId && row.id ? ' RETURNING id' : ''}`;
    const res = await this.client.query(sql, values);
    entity.id = row.id ?? res.rows?.[0]?.id;
    return entity;
  }

  /** Частичное обновление: поля сущности → колонки, whitelist по схеме таблицы. */
  async update(id, patch, extraWhere = '', extraParams = []) {
    const map = this.Entity.fieldMap;
    const allowed = this.allowedColumns();
    const sets = [];
    const params = [];
    for (const [field, value] of Object.entries(patch)) {
      const column = map[field] ?? field;
      if (!allowed.has(column)) throw new Error(`Unknown column "${column}" for ${this.table}`);
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    }
    if (!sets.length) return this.findById(id);
    params.push(id, ...extraParams);
    const sql = `UPDATE ${this.table} SET ${sets.join(', ')} WHERE id = $${params.length - extraParams.length}${extraWhere ? ` AND ${extraWhere}` : ''}`;
    const res = await this.client.query(sql, params);
    return res.rowCount > 0;
  }

  async deleteById(id, extraWhere = '', extraParams = []) {
    const params = [id, ...extraParams];
    const sql = `DELETE FROM ${this.table} WHERE id = $1${extraWhere ? ` AND ${extraWhere}` : ''}`;
    const res = await this.client.query(sql, params);
    return res.rowCount > 0;
  }

  async deleteWhere(where, params = []) {
    const res = await this.client.query(`DELETE FROM ${this.table} WHERE ${where}`, params);
    return res.rowCount;
  }

  async findWhere(where, params = [], orderBy = '') {
    const { rows } = await this.client.query(`SELECT * FROM ${this.table} WHERE ${where}${orderBy ? ` ORDER BY ${orderBy}` : ''}`, params);
    return rows.map((r) => new this.Entity(r));
  }

  /** Блокировка строки на время транзакции (порт @Lock(PESSIMISTIC_WRITE)). */
  async lockById(id) {
    const { rows } = await this.client.query(`SELECT * FROM ${this.table} WHERE id = $1 FOR UPDATE`, [id]);
    return rows[0] ? new this.Entity(rows[0]) : null;
  }
}

module.exports = { Repository };
