/* CLI-обёртка миграций: node src/db/migrate-cli.js up|status */
'use strict';
const { AppConfig } = require('./config');
const { Database } = require('./database');
const { MigrationRunner } = require('./migrate');

async function main() {
  const cmd = process.argv[2] || 'up';
  const config = new AppConfig();
  const db = new Database(config.dbUrl);
  const runner = new MigrationRunner(db.pool);
  try {
    if (cmd === 'status') {
      for (const s of await runner.status()) console.log(`${s.applied ? '✓' : '•'} ${s.file}`);
    } else {
      const applied = await runner.up();
      console.log(applied.length ? `применено миграций: ${applied.length}` : 'миграций не требуется');
    }
  } finally { await db.close(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
