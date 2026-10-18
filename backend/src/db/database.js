/* Пул соединений PostgreSQL и транзакционный контекст (AsyncLocalStorage).
   Репозитории берут клиент через currentClient(): внутри транзакции — это connection,
   вне транзакции — пул. Порт JPA EntityManager + @Transactional. */
'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');
const { Pool } = require('pg');

class Database {
  constructor(connectionString, { max = 10, ssl = false } = {}) {
    this.pool = new Pool({ connectionString, max, ssl: ssl ? { rejectUnauthorized: false } : false });
    this.storage = new AsyncLocalStorage();
  }

  /** Текущий клиент БД (транзакция или пул). */
  get client() { return this.storage.getStore() || this.pool; }

  query(text, params) { return this.client.query(text, params); }

  /** Запуск кода в транзакции SELECT ... FOR UPDATE / COMMIT / ROLLBACK. */
  async transaction(fn) {
    const existing = this.storage.getStore();
    if (existing) return fn(existing); // вложенная транзакция переиспользует connection
    const connection = await this.pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await this.storage.run(connection, () => fn(connection));
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      try { await connection.query('ROLLBACK'); } catch { /* соединение уже разорвано */ }
      throw error;
    } finally {
      connection.release();
    }
  }

  async close() { await this.pool.end(); }
}

module.exports = { Database };
