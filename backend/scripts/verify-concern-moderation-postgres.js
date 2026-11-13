import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const fail = message => { throw new Error(message); };
const encrypted = label => Buffer.from(`synthetic encrypted ${label}`, 'utf8');

async function createCoordinator(email, county = 'Mombasa') {
  const result = await pool.query(
    `INSERT INTO users (
       full_name, full_name_ciphertext, role, status, county,
       school, school_ciphertext, email_normalized, password_hash
     ) VALUES (
       NULL, $1, 'coordinator', 'active', $2,
       NULL, NULL, $3, '$argon2id$synthetic-ci-only'
     )
     RETURNING id`,
    [encrypted('coordinator identity'), county, email]
  );
  return result.rows[0].id;
}

async function createStakeholder(email) {
  const result = await pool.query(
    `INSERT INTO users (
       full_name, full_name_ciphertext, role, status,
       school, school_ciphertext, email_normalized, password_hash
     ) VALUES (
       NULL, $1, 'stakeholder', 'active',
       NULL, NULL, $2, '$argon2id$synthetic-ci-only'
     )
     RETURNING id`,
    [encrypted('stakeholder identity'), email]
  );
  return result.rows[0].id;
}

async function createConcern(county = 'Mombasa') {
  const result = await pool.query(
    `INSERT INTO concerns (
       submitted_by, theme_ciphertext, title_ciphertext, description_ciphertext,
       county, sub_county, ward, is_public
     ) VALUES (
       NULL, $1, $2, $3, $4, 'Nyali', 'Kongowea', false
     )
     RETURNING id`,
    [
      encrypted('private theme'),
      encrypted('private title'),
      encrypted('private narrative'),
      county
    ]
  );
  return result.rows[0].id;
}

async function runAs(actorId, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.actor_user_id', $1, true)", [actorId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* preserve failure */ }
    throw error;
  } finally {
    client.release();
  }
}

async function expectRejected(work, messageFragment, label) {
  let rejected = false;
  try {
    await work();
  } catch (error) {
    rejected = String(error.message).includes(messageFragment);
  }
  if (!rejected) fail(label);
}

async function changeStatus(client, concernId, actorId, fromStatus, toStatus) {
  await client.query(
    `UPDATE concerns
     SET status = $2::concern_status,
         assigned_coordinator = COALESCE(assigned_coordinator, $3),
         last_moderated_by = $3,
         last_moderated_at = now(),
         updated_at = now()
     WHERE id = $1`,
    [concernId, toStatus, actorId]
  );
  await client.query(
    `INSERT INTO concern_moderation_events (
       concern_id, actor_user_id, event_type, from_status, to_status
     ) VALUES ($1, $2, 'status_change', $3::concern_status, $4::concern_status)`,
    [concernId, actorId, fromStatus, toStatus]
  );
}

try {
  const moderatorId = await createCoordinator('moderator-ci@example.test');
  const publisherId = await createCoordinator('publisher-ci@example.test');
  const kilifiCoordinatorId = await createCoordinator('kilifi-ci@example.test', 'Kilifi');
  const stakeholderId = await createStakeholder('stakeholder-moderation-ci@example.test');

  const concernId = await createConcern();
  await runAs(moderatorId, client =>
    changeStatus(client, concernId, moderatorId, 'submitted', 'under_review')
  );
  await runAs(moderatorId, client =>
    changeStatus(client, concernId, moderatorId, 'under_review', 'consolidated')
  );

  await runAs(publisherId, async client => {
    await client.query(
      `UPDATE concerns
       SET is_public = true,
           public_theme = 'Education access',
           public_title = 'Improve community library resources',
           published_by = $2,
           published_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [concernId, publisherId]
    );
    await client.query(
      `INSERT INTO concern_moderation_events (
         concern_id, actor_user_id, event_type, from_status, to_status
       ) VALUES ($1, $2, 'published', 'consolidated', 'consolidated')`,
      [concernId, publisherId]
    );
  });

  const publicResult = await pool.query(
    'SELECT * FROM public_concern_summary WHERE id = $1',
    [concernId]
  );
  if (publicResult.rowCount !== 1) fail('Reviewed concern was not visible in the public projection');
  const publicColumns = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'public_concern_summary'`
  );
  const exposedColumns = new Set(publicColumns.rows.map(row => row.column_name));
  for (const forbidden of ['submitted_by', 'county', 'sub_county', 'ward', 'description', 'guardian_phone']) {
    if (exposedColumns.has(forbidden)) fail(`Public concern view exposes forbidden column: ${forbidden}`);
  }

  await expectRejected(
    () => runAs(moderatorId, client => client.query(
      "UPDATE concerns SET public_title = 'Changed after publication' WHERE id = $1",
      [concernId]
    )),
    'published public wording',
    'Published public wording could be edited without unpublishing'
  );

  await expectRejected(
    () => runAs(moderatorId, client => client.query(
      `UPDATE concerns
       SET is_public = false, public_theme = NULL, public_title = NULL
       WHERE id = $1`,
      [concernId]
    )),
    'moderation event',
    'Unpublishing without an append-only event was not rejected'
  );

  const stakeholderConcernId = await createConcern();
  await expectRejected(
    () => runAs(stakeholderId, client => changeStatus(
      client, stakeholderConcernId, stakeholderId, 'submitted', 'under_review'
    )),
    'active coordinator',
    'Stakeholder was able to moderate a concern'
  );

  const kilifiConcernId = await createConcern('Kilifi');
  await expectRejected(
    () => runAs(moderatorId, client =>
      changeStatus(client, kilifiConcernId, moderatorId, 'submitted', 'under_review')
    ),
    'concern county',
    'Coordinator moderated a concern outside their county'
  );

  const sameReviewerConcernId = await createConcern();
  await runAs(moderatorId, client =>
    changeStatus(client, sameReviewerConcernId, moderatorId, 'submitted', 'under_review')
  );
  await runAs(moderatorId, client =>
    changeStatus(client, sameReviewerConcernId, moderatorId, 'under_review', 'consolidated')
  );
  await expectRejected(
    () => runAs(moderatorId, async client => {
      await client.query(
        `UPDATE concerns
         SET is_public = true,
             public_theme = 'Education access',
             public_title = 'A public summary',
             published_by = $2,
             published_at = now()
         WHERE id = $1`,
        [sameReviewerConcernId, moderatorId]
      );
    }),
    'second coordinator',
    'The same coordinator who moderated the concern was able to publish it'
  );

  const safeguardingConcernId = await createConcern();
  await runAs(moderatorId, client =>
    changeStatus(client, safeguardingConcernId, moderatorId, 'submitted', 'referred_to_safeguarding')
  );
  await expectRejected(
    () => runAs(publisherId, async client => {
      await client.query(
        `UPDATE concerns
         SET is_public = true,
             public_theme = 'Safeguarding',
             public_title = 'A sensitive child protection issue',
             published_by = $2,
             published_at = now()
         WHERE id = $1`,
        [safeguardingConcernId, publisherId]
      );
    }),
    'publication requires a second coordinator',
    'A safeguarding referral could be published'
  );

  await expectRejected(
    () => pool.query(
      `UPDATE concern_moderation_events
       SET event_type = 'published'
       WHERE concern_id = $1`,
      [concernId]
    ),
    'append-only',
    'Moderation event history could be edited'
  );

  const missingHistoryConcernId = await createConcern();
  await expectRejected(
    () => runAs(moderatorId, client => client.query(
      `UPDATE concerns
       SET status = 'under_review',
           assigned_coordinator = $2,
           last_moderated_by = $2,
           last_moderated_at = now()
       WHERE id = $1`,
      [missingHistoryConcernId, moderatorId]
    )),
    'append-only moderation event',
    'Status change without history was committed'
  );

  process.stdout.write('Concern moderation PostgreSQL integrity checks passed\n');
} finally {
  await pool.end();
}
