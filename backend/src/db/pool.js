import pg from 'pg';

const { Pool } = pg;

export function createDatabasePool(config) {
  if (!config?.databaseUrl) throw new TypeError('Database URL is required');

  return new Pool({
    connectionString: config.databaseUrl,
    ssl: config.databaseSsl ? { rejectUnauthorized: true } : undefined,
    max: 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    application_name: 'sauti-yetu-api'
  });
}
