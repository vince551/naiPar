import { readConfig } from './config.js';
import { createDatabasePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';

async function migrate() {
  const config = readConfig();
  if (config.nodeEnv === 'production' && !config.migrationDatabaseUrl) {
    throw new Error('MIGRATION_DATABASE_URL is required for production migrations');
  }

  const pool = createDatabasePool({
    ...config,
    databaseUrl: config.migrationDatabaseUrl || config.databaseUrl
  });

  try {
    const applied = await runMigrations(pool);
    console.log(JSON.stringify({
      event: 'database_migrations_complete',
      appliedCount: applied.length,
      applied
    }));
  } finally {
    await pool.end();
  }
}

migrate().catch(error => {
  console.error(JSON.stringify({
    event: 'database_migration_failed',
    errorType: error?.name || 'Error'
  }));
  process.exitCode = 1;
});
