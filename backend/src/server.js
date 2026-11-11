import argon2 from 'argon2';
import { randomBytes } from 'node:crypto';
import { readConfig } from './config.js';
import { createApp } from './app.js';
import { createDatabasePool } from './db/pool.js';
import { createSmsGateway } from './integrations/sms-gateway.js';

const ARGON2_OPTIONS = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1
});

async function start() {
  const config = readConfig();
  const smsGateway = createSmsGateway({
    endpoint: config.smsGatewayUrl,
    apiToken: config.smsGatewayToken
  });
  const pool = createDatabasePool(config);

  try {
    // The runtime database role needs application DML only. Schema changes
    // are performed separately by the migration command and a migration role.
    await pool.query('SELECT 1');
    const schemaCheck = await pool.query("SELECT to_regclass('public.users') AS users_table");
    if (!schemaCheck.rows[0]?.users_table) {
      throw new Error('Database migrations have not been applied');
    }

    // A per-process dummy hash gives unknown accounts a comparable Argon2id
    // verification cost without keeping a reusable dummy password in source.
    const dummyCredentialHash = await argon2.hash(
      randomBytes(32).toString('hex'),
      ARGON2_OPTIONS
    );

    const app = createApp({
      pool,
      config,
      hashPassphrase: secret => argon2.hash(secret, ARGON2_OPTIONS),
      verifySecret: (encodedHash, secret) => argon2.verify(encodedHash, secret),
      dummyCredentialHash,
      smsGateway
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
