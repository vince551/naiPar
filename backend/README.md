# Sauti Yetu backend foundation

## Current implementation status

The repository began as a React 18 + Vite frontend demonstration. The current sign-in and registration interactions are simulated; there is no deployed API, database connection, real authentication, verified delegate registry, live attendance, binding vote, or stakeholder messaging.

This branch introduces a PostgreSQL data model and implementation/security guidance. It does **not** make the frontend forms secure or production-ready.

## Architecture decision

Use a separately deployed Node.js API (Express or Fastify) with PostgreSQL. Keep the existing Vite frontend as the client. Use parameterised SQL through a small repository/data-access layer; avoid exposing database credentials to Vite/browser code.

- Database: PostgreSQL 15+
- API: Node.js LTS, Express or Fastify
- Validation: Zod at every API boundary
- Passwords/passphrases: Argon2id, unique salt per credential
- Sessions: opaque random tokens; store only a cryptographic hash server-side; secure, HttpOnly, SameSite cookies
- File uploads: private object storage, random object keys, MIME/size validation, malware scanning where available
- Video: Jitsi integration only after server-side session/room authorisation
- PDFs: generated server-side from persisted sitting/vote/resolution records
- Deployment: API and database separate from the static frontend; HTTPS everywhere

No credentials, encryption keys, guardian phone numbers, or child records belong in source control, Vite environment variables, public buckets, or client-side storage.

## Data model

Migrations in `database/migrations/` are applied in numeric order. `0001_initial_schema.sql` creates the core model and restricted projections; `0002_auth_sessions.sql` adds hashed sessions, login-attempt records and timestamp triggers; `0003_audit_integrity.sql` makes audit rows append-only and cast votes immutable. They create:

| Area | Tables |
|---|---|
| Identity and consent | `users`, `guardian_consents` |
| Assembly operations | `sittings`, `sitting_attendance`, `motions`, `debate_requests`, `motion_amendments`, `votes` |
| Public participation | `concerns`, `concern_comments` |
| Accountability | `resolutions`, `stakeholder_assignments`, `stakeholder_updates` |
| Oversight | `audit_logs` |
| Restricted projections | `stakeholder_resolution_summary`, `public_concern_summary` |

Use UUIDs for externally exposed record identifiers. Foreign keys use restrictive deletion for official records so a user cannot silently erase an adopted motion, vote, consent decision, or resolution.

## Authentication and account lifecycle

### Child and delegate accounts

1. A guardian provides consent using a reviewed, versioned consent notice.
2. A child profile is created in `pending` status.
3. The guardian phone is normalised server-side. Store its encrypted value only if operationally required, and store an HMAC-SHA-256 lookup digest using a server-side pepper for account lookup. Never store a plaintext phone as the login key.
4. Store a passphrase hash generated with Argon2id. Never log, email, or retain the three words.
5. A trained/authorised coordinator reviews the consent record. Only an approved consent can activate the child account.
6. A delegate upgrade changes the existing account's role after an authorised coordinator verifies the election/appointment and consent evidence. It must not create a duplicate account or reset credentials.
7. Guardian-initiated recovery must use a separately verified process. Do not implement a weak “phone number only” reset.

Picture passphrases are an accessibility alternative to the same secret, not a second factor. Their mapping must be private and the server must verify the same secret hash; never reveal the selected sequence in logs or analytics.

### Adult accounts

Adults use a verified work email and Argon2id password hash. Stakeholder accounts remain pending until an administrator verifies organisation and authority documents. Role changes require explicit audit events.

### Sessions and abuse controls

- Generate high-entropy opaque session tokens; persist only token hashes.
- Rotate session IDs after login and privilege changes.
- Use Secure, HttpOnly, SameSite cookies, CSRF protection for cookie-authenticated mutations, short idle expiry, absolute expiry, and revocation on logout.
- Rate-limit login and recovery by account lookup digest and network fingerprint; use progressive delays and generic error messages to prevent account enumeration.
- Do not use localStorage for authentication tokens.
- Never trust a role supplied by the browser.

## Authorisation matrix

Enforce authorisation in API middleware and again in the service/data-access layer. Hiding a button in React is not access control.

| Role | Permitted scope |
|---|---|
| Public child | Public forums, own submissions, published public outcomes |
| Delegate | Public child scope plus assigned official sittings, attendance, debate requests and one vote per eligible motion |
| Speaker | Delegate scope plus presiding controls, speaker queue and debate approvals |
| Clerk | Sitting/order-paper/motion/official-record administration |
| Coordinator | Consent review, delegate verification, concern triage and authorised escalation |
| Stakeholder | Only resolutions explicitly assigned to that stakeholder; updates on those assignments |
| Admin | Account and configuration administration; sensitive child records remain need-to-know and audited |

A public child cannot enter the official hall or vote. A stakeholder cannot query users, guardian consent records, individual child profiles, or raw concerns. Stakeholder access is scoped by an active `stakeholder_assignments` row. The supplied SQL views are projections, not a replacement for per-request authorisation.

## Child safeguarding and privacy requirements

- Collect only fields needed for participation and eligibility. Make gender optional.
- Keep safeguarding disclosures out of public forums, ordinary comments, stakeholder views and general moderation queues. A dedicated restricted workflow must be designed with trained safeguarding personnel before collecting such disclosures.
- Public concerns must be moderated and explicitly published. Never publish a child's name, guardian contact, school-level identifying detail, or unredacted narrative by default.
- Stakeholders receive only the minimum information needed to act, normally a de-identified issue summary and geographic area.
- Encrypt guardian contact details and consent documents at rest with managed keys; keep keys outside the database and repository.
- Define retention, correction, withdrawal, deletion and legal-hold procedures before production.
- Audit sensitive reads as well as writes. Do not put passwords, passphrases, access tokens, full phone numbers, consent document contents, or unredacted child narratives in audit metadata.
- Provide a clear child-friendly privacy notice and accessible consent process.
- Review compliance with Kenya's Data Protection Act, 2019 and applicable children's data requirements with qualified counsel/data-protection personnel before launch.

## Parliamentary integrity

- Enforce one vote per eligible delegate per motion with the database unique constraint.
- Validate delegate eligibility and sitting/motion voting windows on the server inside a transaction.
- Derive vote totals from persisted votes; never accept client-supplied totals or a client-side “passed” flag.
- Confirm the applicable standing orders before implementing quorum, majority, abstention and tie rules. The example “more than 50% Yes” is not yet a verified legal/procedural rule.
- Record attendance, speaking approvals, amendments, vote events and resolution approval in an append-only audit trail.
- A generated Hansard/PDF must be reproducible from persisted records and clearly marked draft until authorised approval.

## Suggested API slices

1. `POST /auth/child/register` — pending child profile; guardian consent workflow; never activates without approved consent.
2. `POST /auth/login`, `POST /auth/logout`, `POST /auth/recovery` — session lifecycle and rate limiting.
3. `POST /coordinator/children/:id/verify-delegate` — audited role upgrade on the existing account.
4. `GET/POST /public/concerns` — moderated public participation with safeguarding routing separated.
5. `GET/POST /clerk/sittings`, `GET/POST /clerk/motions` — authorised sitting administration.
6. `POST /motions/:id/debate-requests`, `POST /debate-requests/:id/decision` — queue management.
7. `POST /motions/:id/votes` — transactionally validated, unique vote.
8. `GET /stakeholder/assignments`, `POST /stakeholder/assignments/:id/updates` — assignment-scoped accountability.

## Verification checklist before production

- Apply migrations to a disposable PostgreSQL database and run schema/migration tests.
- Unit-test role and resource-level access for every endpoint, including negative tests.
- Test guardian consent pending/approved/withdrawn transitions and delegate upgrade.
- Test account enumeration resistance, rate limits, session rotation, CSRF and revocation.
- Test concurrent duplicate votes and voting-window boundaries.
- Verify public/stakeholder SQL projections cannot expose child identities or restricted narratives.
- Run dependency, secret, static-analysis and vulnerability scans.
- Complete privacy impact assessment, safeguarding review, accessibility testing, backup/restore test and incident-response plan.

## Not yet implemented

No API server, database connection, migrations runner, authentication/session endpoint, consent verification endpoint, Jitsi integration, PDF pipeline or production secrets are configured by this commit. Do not connect real child data until these controls have been implemented and independently reviewed.
