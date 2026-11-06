import argon2 from 'argon2';
import { readConfig } from './config.js';
import { createApp } from './app.js';
import { createDatabasePool } from './db/pool.js';

async function start() {
  const config = readConfig();
  const pool = createDatabasePool(config);

  try {
    // The runtime database role needs application DML only. Schema changes
    // are performed separately by the migration command and a migration role.
    await pool.query('SELECT 1');

    const app = createApp({
      pool,
      config,
      hashPassphrase: secret => argon2.hash(secret, {
        type: argon2.argon2id,
        memoryCost: 19_456,
        timeCost: 2,
        parallelism: 1
      })
    });

    const server = app.listen(config.port, '0.0.0.0', () => {
      console.log(JSON.stringify({
        event: 'api_started',
        port: config.port,
        environment: config.nodeEnv
      }));
    });

    const shutdown = signal => {
      console.log(JSON.stringify({ event: 'api_shutdown_requested', signal }));
      server.close(async () => {
        await pool.end();
        process.exit(0);
      });
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  } catch (error) {
    await pool.end();
    throw error;
  }
}

start().catch(error => {
  console.error(JSON.stringify({
    event: 'api_start_failed',
    errorType: error?.name || 'Error'
  }));
  process.exitCode = 1;
});
