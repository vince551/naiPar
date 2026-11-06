import { readConfig } from './config.js';
import { createDatabasePool } from './db/pool.js';
import { runMigrations } from './db/migrate.js';

async function migrate() {
  const config = readConfig();
  if (
    config.nodeEnv === 'production' &&
    (!config.migrationDatabaseUrl || config.migrationDatabaseUrl === config.databaseUrl)
  ) {
    throw new Error('Production migrations require a separate MIGRATION_DATABASE_URL');
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
