/* Простой версионируемый миграционный движок (аналог Flyway): файлы src/db/migrations/*.sql
   применяются по порядку и записываются в таблицу schema_migrations. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

class MigrationRunner {
  constructor(pool, dir = path.join(__dirname, 'migrations')) {
    this.pool = pool;
    this.dir = dir;
  }

  files() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.sql')).sort();
  }

  async applied() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await this.pool.query('SELECT name FROM schema_migrations ORDER BY name');
    return new Set(rows.map((r) => r.name));
  }

  /** Применяет все ещё не выполненные миграции. Возвращает список применённых файлов. */
  async up() {
    const done = await this.applied();
    const pending = this.files().filter((f) => !done.has(f));
    for (const file of pending) {
      const sql = fs.readFileSync(path.join(this.dir, file), 'utf8');
      const connection = await this.pool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(sql);
        await connection.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await connection.query('COMMIT');
        console.log(`migrated: ${file}`);
      } catch (error) {
        await connection.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${error.message}`);
      } finally {
        connection.release();
      }
    }
    return pending;
  }

  async status() {
    const done = await this.applied();
    return this.files().map((f) => ({ file: f, applied: done.has(f) }));
  }
}

module.exports = { MigrationRunner };
