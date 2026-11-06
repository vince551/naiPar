# Sauti Yetu backend

## Current state

The repository's frontend remains a React 18 + Vite demonstration. The navy-and-gold MCCeAS / Sauti Yetu interface and all existing frontend files are unchanged by this backend branch.

This branch adds the first runnable API foundation and a narrowly scoped child-registration request endpoint. It does **not** provide a complete or production-ready Assembly service.

### Implemented in this branch

- Isolated Node.js 22+ API package under `backend/`.
- Express API with Helmet security headers, bounded JSON bodies, request IDs and safe error responses.
- PostgreSQL connection pool and a checksum-verified migration runner protected by an advisory lock.
- AES-256-GCM field encryption for child name, school and guardian identity/contact fields.
- HMAC-SHA-256 guardian-phone lookup digest and network-address fingerprinting; raw guardian phone is not used as a database lookup key.
- Argon2id passphrase hashing.
- `POST /api/v1/auth/child/registration-requests`: creates a pending child account and pending guardian-consent record in one database transaction.
- Five-attempt / 15-minute in-memory rate limit on child registration.
- Reusable server-context role guards that deny child/delegate access until guardian consent is approved.
- Unit tests for validation, encryption/tamper detection, transactional rollback, pending consent and role checks.

### Not implemented yet

- Guardian SMS/OTP or equivalent independent consent verification.
- Login, logout, session creation/resolution, recovery or adult account registration.
- A coordinator review/approval workflow.
- A production-ready role/session middleware integration. The role guards require a trusted `req.auth` object from a future server-side session resolver; no client-provided role is accepted.
- Public concern, official sitting, motion, debate, voting, resolution or stakeholder API endpoints.
- Frontend API integration. The current React login and registration remain clearly labelled demonstration flows.
- A live PostgreSQL environment, deployment, backup/restore or production security review.

Do not collect real children's information through this API until guardian verification, session authentication, access control, safeguarding procedures and deployment controls are complete.

## Architecture

- Runtime: Node.js 22+
- HTTP: Express 5
- Database: PostgreSQL 15+
- Database driver: `pg`
- Child passphrase hashing: Argon2id
- Field encryption: AES-256-GCM using a dedicated 32-byte key
- Guardian lookup: HMAC-SHA-256 using a separate server-side pepper
- Security headers: Helmet
- Request validation: explicit server-side validation in the domain service
- Deployment model: separate API/database from the static Vite frontend; place both behind HTTPS

The API does not enable permissive CORS. Prefer a same-origin reverse proxy. If a separate API origin is selected later, add an explicit origin allowlist; never use wildcard credentialed CORS.

## Database model

Migrations in `database/migrations/` are applied in numeric order:

| Migration | Purpose |
|---|---|
| `0001_initial_schema.sql` | Users, guardian consents, sittings, attendance, motions, debates, amendments, votes, concerns, resolutions, stakeholder assignments/updates, audit log and restricted projections |
| `0002_auth_sessions.sql` | Hashed session records, login-attempt records and updated-at triggers |
| `0003_audit_integrity.sql` | Append-only audit and immutable vote triggers |
| `0004_encrypted_identity_fields.sql` | Encrypted identity/contact columns, removal of plaintext identity writes and support for multiple children under one guardian phone |
| `0005_accountability_integrity.sql` | Restricts deletion of audit actors, binds stakeholder updates to their actual assignment and makes stakeholder updates append-only |

The migration runner wraps each migration and its checksum record in one transaction. It uses a PostgreSQL advisory lock to avoid concurrent migration runs and refuses to continue if an already-applied migration's checksum changes.

**Important:** migration 0004 intentionally rejects legacy plaintext identity rows. Use a new, empty development database for this initial implementation. Do not apply it to a populated database without a reviewed data migration, backup and recovery plan.

## Local development

1. Install Node.js 22 or newer and PostgreSQL 15 or newer.
2. Create an empty local development database.
3. Copy `.env.example` to `.env` in this directory.
4. Replace the sample database URL and every secret placeholder. Generate independent random values; do not reuse a password as an encryption key or pepper.
5. Install dependencies and run the tests.

```bash
cd backend
cp .env.example .env
npm install
npm test
npm run check
npm start
```

For the encryption key, generate 32 random bytes and base64-encode them, for example:

```bash
openssl rand -base64 32
```

Generate the lookup and audit peppers separately with a cryptographically secure random generator. Keep `.env` out of source control. In production, use a managed secret store and managed database encryption; do not bake secrets into an image or frontend environment.

## API: child registration request

`POST /api/v1/auth/child/registration-requests`

Expected JSON fields:

- `fullName`
- `age` (5–17)
- `school`
- `county`
- `ward`
- `guardianName`
- `guardianPhone` (Kenyan mobile format)
- `passphrase` (at least three words, 12–120 characters)

The server selects the consent-notice version from `CONSENT_NOTICE_VERSION`; clients cannot choose an arbitrary consent text version.

A successful request returns HTTP 202 with a registration request ID and both statuses set to `pending`. The submitted passphrase is hashed with Argon2id. Child name, school, guardian name and guardian phone are encrypted with AES-256-GCM. The normalised guardian phone is also HMAC-hashed for lookup. The transaction writes the user, pending consent and audit event together; any failure rolls all three back.

**A checkbox or API request does not prove guardian consent.** The child account remains inactive. No OTP is sent or verified yet, and no login session is issued.

The endpoint is rate-limited to five requests per IP in 15 minutes using the default in-memory limiter. This is a basic single-instance control, not a distributed abuse-prevention solution.

## Role and privacy boundaries

The reusable role guards accept only an authentication context populated by a future server-side session resolver. They do not trust role names from request data or headers.

- Public children: public participation and their own permitted submissions only.
- Delegates: official participation only after delegate verification and approved guardian consent.
- Speaker/clerk: narrowly scoped presiding and record-management functions.
- Coordinator: consent and delegate verification, subject to audit.
- Stakeholder: only assigned, de-identified resolution work.
- Admin: account/configuration administration; child data remains need-to-know and audited.

A public child must not access the official hall or vote. A stakeholder must not access user profiles, guardian contacts, consent documents or raw child submissions. Hiding UI controls is not authorisation.

## Safeguarding and operational requirements

- Do not collect abuse disclosures in public forums or this registration endpoint.
- Use a separate, restricted safeguarding workflow designed with trained child-protection personnel.
- Do not publish names, phone numbers, school identifiers or unredacted narratives by default.
- Encrypt sensitive identity fields and private consent files; keep encryption keys separate from the database.
- Audit sensitive reads and writes without recording credentials, phone numbers or unredacted child content.
- Define consent withdrawal, correction, retention, deletion and legal-hold processes.
- Review the Kenya Data Protection Act, 2019 and applicable children's data obligations with qualified data-protection and safeguarding personnel before launch.
- Confirm Assembly standing orders before implementing quorum, voting eligibility, majority, abstention and tie rules.

## Verification status

The automated unit suite uses synthetic fixtures and fake database connections. It tests validation, phone normalisation, AES-GCM encryption/tamper rejection, atomic registration rollback and role guards.

The SQL migrations have **not** been executed against PostgreSQL in this run because no database server or connection is configured. The API has not been deployed or connected to the frontend. Passing unit tests does not establish production readiness.
