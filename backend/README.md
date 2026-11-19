# Sauti Yetu backend

## Current state

The repository uses React 18 + Vite with the navy-and-gold MCCeAS / Sauti Yetu visual identity preserved. The login, registration/guardian OTP and private concern submission forms are now connected to the API. The Assembly Hall, agenda, member register, debate, voting, Hansard and stakeholder screens remain illustrative; sitting management and motion submission/review APIs exist but are not yet connected to those screens.

The feature branch now contains a runnable API foundation for child registration, authentication, guardian verification/review and private concern intake/moderation. It does **not** provide a complete or production-ready Assembly service.

### Implemented in this branch

- Isolated Node.js 22+ API package under `backend/`.
- Express API with Helmet security headers, bounded JSON bodies, request IDs and safe error responses.
- PostgreSQL connection pool and a separate, checksum-verified migration command protected by an advisory lock; the API runtime does not apply DDL.
- AES-256-GCM field encryption for child name, school and guardian identity/contact fields.
- HMAC-SHA-256 guardian-phone lookup digest and network-address fingerprinting; raw guardian phone is not used as a database lookup key.
- Argon2id passphrase/password hashing and dummy-hash verification for unknown login identifiers.
- `POST /api/v1/auth/child/registration-requests`: creates a pending child account and pending guardian-consent record in one database transaction.
- `POST /api/v1/auth/login`: verifies child/delegate credentials against guardian-phone lookup plus passphrase, or adult work email plus password. Child sign-in is allowed only for an active account with approved, non-withdrawn consent.
- Opaque 256-bit session tokens stored only as SHA-256 digests, issued in HttpOnly, SameSite=Lax cookies; Secure is enabled in production.
- Eight-hour server-side sessions, revocation on logout or inactive account status, trusted database-backed role/consent context, CSRF token validation for mutations, JSON-only CSRF token refresh after browser reload, and login-attempt records that retain only a keyed network fingerprint and outcome.
- Account status, role and credential hash are rechecked under a user-row lock immediately before issuing a session; child consent is also rechecked under lock.
- `GET /api/v1/auth/session`, `POST /api/v1/auth/csrf` and `POST /api/v1/auth/logout`.
- Five-attempt / 15-minute in-memory rate limit on child registration and ten-attempt / 15-minute in-memory rate limit on login.
- Reusable server-context role guards that deny child/delegate access until guardian consent is approved.
- County-scoped coordinator consent review queue, restricted identity-detail access with read auditing, and approve/reject decisions tied to an append-only review record.
- Provider-neutral guardian phone OTP challenges with hashed codes, expiry, attempt limits and a fail-closed SMS gateway adapter; OTP success proves phone possession only and does not activate a child account.
- Private child concern intake with encrypted narrative fields, owner-only child retrieval and a county/location snapshot for subsequent coordinator routing.
- County-scoped coordinator concern moderation, encrypted internal notes, explicit status transitions, append-only moderation events and audit logging.
- De-identified public concern summaries with two-coordinator publication approval, a minimal public projection and unpublish support.
- Consent approval activates the pending child account only in the same transaction as the review and audit event; rejection leaves the account pending.
- Unit tests for validation, encryption/tamper detection, transactional rollback, pending consent, login, session cookies, CSRF, role checks and authentication race conditions. CI also verifies PostgreSQL migration execution and security-trigger behaviour.

### Not implemented yet

- A configured live SMS gateway and guardian self-service consent. The OTP challenge service and HTTPS gateway adapter exist, but no provider endpoint/token is configured. OTP proves phone possession only; it does not establish legal guardianship or informed consent.
- Adult account provisioning/registration, password recovery, guardian-assisted child recovery, session listing/device management or MFA.
- Motion submission, clerk review and a restricted debate speaker queue are implemented with de-identified public motion wording. Amendments, voting, resolution generation and stakeholder updates remain unfinished. A dedicated safeguarding case-management workflow is also not implemented.
- Official Assembly frontend integration for sittings, order papers, motions, debates, amendments, delegate voting, Hansard, member records and stakeholder action. The existing screens for these areas still use illustrative data.
- A persistent development/staging PostgreSQL environment, deployment, backup/restore or production security review. CI now applies the migrations to a disposable PostgreSQL 16 service.

Do not collect real children's information or real credentials through this development integration. There is no persistent staging database or production deployment, the SMS relay is not configured, and safeguarding/privacy review is still required.

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
| `0006_session_revocation.sql` | Revokes sessions after account suspension, role/credential changes or guardian-consent withdrawal; prevents deletion of consent history |
| `0007_guardian_consent_reviews.sql` | Adds append-only coordinator review records and database enforcement that only an active coordinator can approve/reject consent against a matching review |
| `0008_guardian_review_county_scope.sql` | Restricts coordinator review to the child's county in both the API service and database trigger |
| `0009_guardian_phone_otp.sql` | Adds expiring, hashed guardian phone-possession challenges and attempt controls |
| `0010_guardian_otp_binding.sql` | Binds verified phone-possession evidence to the correct guardian consent record |
| `0011_concern_intake_privacy.sql` | Encrypts private concern narratives and separates reviewed public wording from private content |
| `0012_coordinator_concern_moderation.sql` | Adds county-scoped moderation, second-coordinator publication, append-only moderation events and a location-free public projection |
| `0013_official_sitting_lifecycle.sql` | Adds sitting lifecycle events, clerk-only transitions and a narrow public sitting projection |
| `0014_motion_submission_review.sql` | Adds delegate motion submission, clerk review, immutable lifecycle events and a reviewed public motion projection |

The migration runner wraps each migration and its checksum record in one transaction. It uses a PostgreSQL advisory lock to avoid concurrent migration runs and refuses to continue if an already-applied migration's checksum changes. It runs as a separate command so the API process does not need schema-owner privileges.

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
npm run migrate
npm start
```

For the encryption key, generate 32 random bytes and base64-encode them, for example:

```bash
openssl rand -base64 32
```

Generate the lookup and audit peppers separately with a cryptographically secure random generator. Keep `.env` out of source control. In production, use a managed secret store and managed database encryption; do not bake secrets into an image or frontend environment. Give the API runtime database user only the required application DML permissions and no schema-owner privileges. Deny it `UPDATE`, `DELETE` and `TRUNCATE` on append-only audit, vote and stakeholder-update tables; grant only the inserts and reads the API actually needs. Run `npm run migrate` with a separate privileged `MIGRATION_DATABASE_URL`; production migrations refuse to fall back to the runtime URL.

## API: authentication and child registration

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

The server selects the consent-notice version identifier from `CONSENT_NOTICE_VERSION`; clients cannot choose an arbitrary version. This identifier must be aligned with the actual child-friendly notice approved by the responsible organisation. The notice text is not yet stored or served by this API.

A successful request returns HTTP 202 with a registration request ID and both statuses set to `pending`. The submitted passphrase is hashed with Argon2id. Child name, school, guardian name and guardian phone are encrypted with AES-256-GCM. The normalised guardian phone is also HMAC-hashed for lookup. The transaction writes the user, pending consent and audit event together; any failure rolls all three back.

**A checkbox or API request does not prove guardian consent.** The child account remains inactive. No OTP is sent or verified yet, no consent document is collected, and no login session is issued.

The registration endpoint is rate-limited to five requests per IP in 15 minutes. Login is limited to ten requests per IP in 15 minutes. Both use the default in-memory limiter: this is a basic single-instance control, not a distributed abuse-prevention solution. Production should use a shared rate-limit store and monitor abuse without logging credentials or raw identifiers. The current attempt table records only a keyed network fingerprint and success/failure outcome; define and enforce a short retention period before production.

### Coordinator guardian consent review

The following routes require an active server-authenticated `coordinator` role with a non-empty county assignment matching the child's county. Mutating requests also require the session CSRF token. The service and database trigger both enforce the county boundary; a coordinator from another county receives no child details.

- `GET /api/v1/coordinator/guardian-consents` — minimal review queue (consent ID, status, notice version and request date only).
- `GET /api/v1/coordinator/guardian-consents/:consentId` — decrypts child/guardian identity for a single pending or rejected request. Every detail read is written to the append-only audit log. The queue itself does not expose names, phone numbers or school details.
- `POST /api/v1/coordinator/guardian-consents/:consentId/review` — records an approval or rejection.

Example decision body:

```json
{
  "decision": "approved",
  "verificationMethod": "verified_call",
  "evidenceReference": "guardian-check-0001"
}
```

Allowed manual verification methods are `in_person`, `verified_call` and `document_review`. The evidence reference is an opaque internal record identifier; do not put a phone number, name, document URL or sensitive narrative in it. The service does not accept uploaded documents or expose a storage key. The coordinator must follow an organisation-approved safeguarding procedure and retain evidence in an appropriately protected system.

An approval is committed only when the review record, consent status update, child-account activation and audit event all succeed in one database transaction. The database trigger rejects direct approval without a matching append-only review and rejects review decisions by anyone other than an active coordinator. Rejection leaves the child account pending. A rejected request can be reviewed again after further evidence is obtained; an approved or withdrawn request cannot be re-reviewed through this endpoint.

**This is a manual coordinator attestation, not an OTP system or automated proof of guardian identity.** Do not describe a phone call or document as independently verified unless the coordinator has completed the approved procedure. Guardian SMS/OTP delivery, guardian self-service confirmation, evidence upload/storage and resubmission UX are still future work.

### Login

`POST /api/v1/auth/login`

Child/delegate request:

```json
{
  "mode": "child",
  "identifier": "0712345678",
  "secret": "sample mango river"
}
```

Adult request:

```json
{
  "mode": "adult",
  "identifier": "official@example.org",
  "secret": "synthetic adult password"
}
```

The response sets the opaque session token in an HttpOnly cookie and returns a CSRF token in the response body. The raw session token is never returned as JSON or stored in the database. Login attempt records do not store the supplied email, phone number or secret. Child login searches the guardian-phone HMAC digest and verifies the passphrase against matching child accounts. If a shared phone plus passphrase matches more than one child, login fails closed; households with multiple children should use distinct passphrases. Adult login normalises the email address and verifies the Argon2id password hash. Unknown adult identifiers incur a dummy Argon2id verification to reduce account-enumeration timing differences.

A credential match is not enough: the account must be active, and child/delegate accounts must have an approved consent record that has not been withdrawn. Failure messages are deliberately generic.

### Session and logout

- Cookie name: `sauti_yetu_session`; flags: `HttpOnly; SameSite=Lax; Path=/`; `Secure` is added in production.
- Session lifetime: eight hours. The database stores only SHA-256 hashes of the random session and CSRF tokens.
- `GET /api/v1/auth/session` returns the authenticated user ID and role, never a client-supplied role.
- `POST /api/v1/auth/logout` requires the `x-csrf-token` header and revokes the server-side session. The CSRF token is returned only at login; keep it in application memory, not localStorage.
- A session is revoked when its account is no longer active. If guardian consent is withdrawn, child/delegate authorisation is denied on subsequent protected requests.
- All future cookie-authenticated state-changing routes must use `requireSession`, `requireCsrf`, `requireAuthenticated` and the appropriate role/resource checks.

The React login form now calls these endpoints through the same-origin browser API client. After a page reload, it restores the server session and obtains a fresh CSRF token through `POST /api/v1/auth/csrf`. The frontend keeps the raw CSRF token in memory only. No production or persistent staging API is deployed; do not use real credentials until an approved staging environment is available.

## Role and privacy boundaries

The role guards accept only `req.auth` populated by the server-side session resolver. They do not trust role names from request data or headers. Login rechecks the current account status, role and credential hash inside a transaction before session creation, and rechecks child consent while holding a row lock. No business endpoint should be exposed until it is mounted behind session resolution, authentication, CSRF protection for mutations, and resource-level authorisation.

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

The automated unit suite uses synthetic fixtures and fake database connections. It tests validation, phone normalisation, AES-GCM encryption/tamper rejection, atomic registration rollback, role guards, county-scoped coordinator consent review, audited identity reads, review/activation transaction ordering, rejection and rollback behaviour, migration transaction handling/checksum-drift detection, Argon2 verification paths, generic login failures, session-token hashing, cookie flags and CSRF checks.

The SQL migrations are executed in CI against a disposable PostgreSQL 16 service, including checks for core tables/views, session-revocation triggers, append-only review history, coordinator-only consent approval and county-scope enforcement. No persistent development/staging database is configured. The API has not been deployed. Selected authentication, registration and private-concern screens are connected; official Assembly screens remain illustrative. Passing unit tests does not establish production readiness.


## Guardian phone OTP verification (migration 0009)

The API now provides a provider-neutral guardian phone possession check:

- `POST /api/v1/auth/guardian-phone-verification/request`
  - Body: `{ "registrationRequestId": "<child registration UUID>", "guardianPhone": "+2547..." }`
  - Returns the same generic `202 Accepted` response for unknown registrations, mismatched phone numbers, cooldowns and successful dispatches.
- `POST /api/v1/auth/guardian-phone-verification/verify`
  - Body: `{ "registrationRequestId": "<child registration UUID>", "guardianPhone": "+2547...", "code": "123456" }`
  - Returns success only after the latest delivered, unexpired code is verified.

Challenge controls:

- Cryptographically random six-digit code; only an HMAC-SHA-256 digest is stored, keyed with the independent `GUARDIAN_OTP_PEPPER`.
- Ten-minute expiry, five failed attempts, three challenge creations per consent per hour, and a 60-second resend cooldown.
- The database permits only one pending/sent challenge per consent at a time.
- Challenges and their verification evidence cannot be deleted or rewritten.
- Delivery failure is recorded without exposing whether a child registration exists.
- The API never returns the OTP or guardian phone number.
- OTP success records phone possession only. It does **not** approve guardian consent or activate the child account.

### SMS gateway configuration

No SMS vendor or credentials are bundled. Configure an approved HTTPS relay using both `SMS_GATEWAY_URL` and `SMS_GATEWAY_TOKEN`. The relay must accept:

- `POST` to the configured HTTPS URL
- `Authorization: Bearer <token>`
- `Content-Type: application/json`
- `Idempotency-Key: <challenge UUID>`
- JSON body: `{ "to": "+2547...", "message": "..." }`

A 2xx response means the relay accepted the message. The API uses an eight-second timeout, rejects redirects, and does not log the response body. If the gateway is not configured, OTP endpoints fail closed with `503 GUARDIAN_OTP_UNAVAILABLE`. A configured gateway delivery failure produces the generic accepted response and marks the challenge failed.

Generate `GUARDIAN_OTP_PEPPER` independently from the guardian phone lookup and audit fingerprint peppers. Keep all three secrets and the SMS gateway token in the server's secret manager, never in the frontend or repository.

### Consent and safeguarding boundary

A successful OTP is only evidence that someone can receive messages at the phone number supplied at child registration. It does not establish that the phone holder is the child's legal guardian, nor does it prove informed consent. An authorised coordinator must still complete the separate review and record an approved verification method. When `guardian_otp` is selected for that review, the database requires the successful OTP challenge to be linked to the consent record. Existing in-person and document-review methods remain available under the documented safeguarding procedure.

The OTP endpoints are now called by the React registration flow. The SMS relay is not configured in this repository, so the checked-in server will not send messages until the operator supplies a real, approved relay endpoint and secret. Do not use real child records before provider verification, coordinator training, privacy review and deployment hardening.

### Operational rate-limit note

The Express request/verification IP limiters use the default in-process store. The database also enforces per-consent resend limits, but a multi-instance production deployment must use a shared rate-limit store (for example, a managed Redis-compatible store) and provider-side spend/abuse controls.


## Private child concern intake (migration 0011)

The authenticated child participation API provides:

- `POST /api/v1/participation/concerns` — submit a private concern.
- `GET /api/v1/participation/my-concerns` — list only the signed-in child's own submissions.

Both endpoints require an active `public_child` or `delegate` account and currently approved guardian consent. Mutations also require the session CSRF token. The server derives the submitter from the authenticated session; clients cannot supply an owner, county, status, or publication flag.

Private `theme`, `title` and `description` are encrypted with the configured application field-encryption key before storage. Plaintext columns remain NULL. The audit trail stores no narrative or contact details. Obvious email, Kenyan phone-number and URL patterns are rejected at intake as an additional child-safety measure.

New concerns are always private. A public concern feed is provided only through the de-identified database view; no stakeholder endpoint exposes raw concern records. The public projection now uses only separate `public_theme` and `public_title` fields, which must be deliberately populated with reviewed, de-identified wording before publication. Safeguarding referrals are constrained to remain private.

Migration 0011 deliberately refuses to run if the concerns table already contains records: existing narrative content must be re-encrypted with the application key in a controlled data migration rather than copied in plaintext by SQL.

This slice is not a safeguarding case-management workflow. Children must not submit abuse disclosures through ordinary community concerns; the trained, restricted safeguarding channel remains a separate requirement.


PostgreSQL CI also exercises the concern privacy constraints with synthetic ciphertext: plaintext inserts are rejected, new concerns remain absent from the public view, publication requires separately supplied de-identified fields, and safeguarding referrals cannot be published. These checks do not replace a production moderation workflow or a full application-level integration test.

## Coordinator concern moderation (migration 0012)

The moderation workflow adds the following endpoints:

- `GET /api/v1/coordinator/concerns` — lists unassigned or self-assigned concerns in the authenticated coordinator's county. Queue rows contain only the concern ID, status, timestamps and whether it is assigned to the caller.
- `GET /api/v1/coordinator/concerns/:concernId` — retrieves the private narrative and location for an audited coordinator read within the caller's county, when unassigned/assigned to the caller or at the consolidated/responded second-review stage. Safeguarding referrals and closed concerns are excluded.
- `POST /api/v1/coordinator/concerns/:concernId/moderation` — assigns an unassigned concern to the coordinator and records a permitted status transition. Body: `{ "decision": "under_review", "internalNote": "Optional internal note" }`.
- `POST /api/v1/coordinator/concerns/:concernId/publish` — approves a separately written, de-identified public theme/title. Body: `{ "publicTheme": "Education access", "publicTitle": "Improve community library resources" }`.
- `POST /api/v1/coordinator/concerns/:concernId/unpublish` — removes a previously published projection.
- `GET /api/v1/public/concerns` — returns only rows from `public_concern_summary`; it does not query raw concern narratives, submitter records or location fields.

All coordinator routes require an active server-authenticated coordinator session and CSRF protection for mutations. The database and service both require the coordinator's county to match the county snapshot recorded when the child submitted the concern. The submitter, narrative and location snapshot are immutable after intake. New submissions copy county, sub-county and ward from the locked child account row; the public view exposes none of these location fields.

### Moderation and publication safeguards

- Status transitions are explicitly constrained. Closed and safeguarding-referred concerns cannot re-enter the ordinary review workflow.
- A coordinator can claim an unassigned concern; another coordinator cannot change a concern assigned to a colleague.
- Internal notes are encrypted and stored in append-only `concern_moderation_events`; the legacy plaintext `moderation_note` column is constrained to remain NULL.
- Every sensitive detail read, status change, publication and unpublication is audited without including child narratives or internal note text.
- The database requires an actor ID set transaction-locally by the API service. It validates that the actor is an active coordinator in the concern's county.
- Database constraints and deferred constraint triggers require matching append-only history events for every status or publication change.
- Publication is permitted only for `consolidated` or `responded` concerns and requires a second active coordinator in the same county, different from the coordinator who last moderated the concern. The second coordinator must first open the audited detail view within the previous 30 minutes; both the service and database enforce this requirement.
- Public theme/title are separately supplied, length-validated and screened for obvious email addresses, Kenyan mobile numbers and URLs. A coordinator must still manually verify that wording is genuinely de-identified; automated pattern checks cannot detect every name or identifying detail.
- Publishing a safeguarding referral is prohibited. Moving a published concern into a status outside the public states automatically withdraws its public projection and records both events.
- The public view contains only an opaque concern ID, reviewed public theme/title, status and creation timestamp. It excludes submitter identity, county, sub-county, ward, guardian data, internal notes and the private narrative.

The ordinary coordinator API does not expose safeguarding referral details. A dedicated safeguarding workflow, with its own trained roles, access policy, case records and response procedures, must be designed before the system collects or processes abuse disclosures.

### Verification

CI runs `verify-concern-moderation-postgres.js` against disposable PostgreSQL after all migrations. It checks county isolation, coordinator-only moderation, second-reviewer publication, safeguarding non-publication, immutable event history, public-view column minimisation and deferred enforcement that rejects status/publication changes without a matching event. Unit tests cover service validation, county scoping, audit minimisation, transition handling and public projection access.

This workflow is not yet connected to a coordinator React dashboard. The public endpoint is a minimal read-only feed; no child-facing or stakeholder-facing moderation controls have been added. A successful CI run does not constitute a safeguarding, privacy-impact or production deployment approval.


### CSRF token refresh for browser clients

After a browser reload, the HttpOnly session cookie remains available but the raw CSRF token is intentionally not recoverable from its stored hash. The client first calls `GET /api/v1/auth/session`, then sends `POST /api/v1/auth/csrf` with an `application/json` body of `{}`. This endpoint requires a live authenticated session, rotates the stored CSRF digest, and returns the new raw token once. It is rate-limited and rejects form-encoded requests; the API does not enable cross-origin CORS. Keep the returned token in application memory only. All cookie-authenticated mutations continue to require `x-csrf-token`.


## Browser integration status

The React application uses `src/api.js` for same-origin requests. The login modal calls the real login endpoint, restores an existing session on page load, refreshes the CSRF token through the JSON-only bootstrap route, and revokes the session on sign-out. Child registration creates a pending request and offers guardian OTP request/verification. The Share Your Voice form submits to the private concern endpoint only for an authenticated child/delegate account. The browser never stores the HttpOnly session token or the CSRF token in localStorage.

The Vite development server proxies `/api` to `SAUTI_YETU_API_TARGET` (default `http://127.0.0.1:4000`). Production must use a same-origin reverse proxy. The API has no permissive CORS configuration. Assembly Hall, motions, debate, voting, member register, Hansard and stakeholder pages remain demonstration data; no official parliamentary action is connected. The UI explicitly warns that this integration is development-only. The debate API is implemented but the debate and speaker-queue screens remain illustrative. Do not enter real children's data or credentials until a secured staging environment, approved SMS provider, trained coordinator workflow, safeguarding review and privacy approval exist.


## Official sitting lifecycle (migration 0013)

- `GET /api/v1/public/sittings?limit=20` — published, in-progress and concluded sitting metadata from the narrow public database view.
- `GET /api/v1/assembly/sittings` and `GET /api/v1/assembly/sittings/:sittingId` — authenticated Assembly readers. Clerks and administrators can see drafts; delegates, speakers and coordinators see published proceedings only. Stakeholders and public-child accounts use the public projection.
- `POST /api/v1/assembly/sittings` — active clerk or administrator creates a draft. Body: `{ "title": "Children’s Assembly plenary sitting", "sessionNumber": 4, "scheduledAt": "2027-02-15T09:00:00+03:00", "venue": "Mombasa County Assembly Hall" }`.
- `PATCH /api/v1/assembly/sittings/:sittingId` — edits draft title, session number, schedule or venue only.
- `POST /api/v1/assembly/sittings/:sittingId/transitions` — requests `published`, `in_progress`, `concluded` or `cancelled`.

Allowed transitions: draft → published → in progress → concluded; cancellation is allowed only from draft or published. Concluded and cancelled records are terminal. Publishing and concluding set server timestamps. Published sitting details are immutable.

Mutations require an active server-authenticated clerk/admin session, CSRF token and JSON content type. PostgreSQL validates the actor context, lifecycle transitions, immutable creator, append-only lifecycle events and matching audit records using a deferred constraint trigger. Draft reads are audited. The public view excludes creator IDs and private order-paper storage keys.

Migration 0013 backfills existing sitting rows with baseline events and normalises lifecycle timestamps. It does not deploy or alter a production database automatically. This slice is not yet connected to the Assembly Hall React pages; attendance, order-paper document storage, debate queues and voting remain future work. The motion workflow is documented in the next section.

## Delegate motion submission and clerk review (migration 0014)

- `POST /api/v1/assembly/motions` — active delegate with approved, unwithdrawn guardian consent submits a motion to a published or in-progress sitting. Body: `{ "sittingId": "<uuid>", "title": "Improve access to safe school water", "description": "..." }`.
- `GET /api/v1/assembly/motions/mine` — delegate retrieves only their own submissions.
- `GET /api/v1/clerk/motions?limit=20` and `GET /api/v1/clerk/motions/:motionId` — active clerk or administrator reviews the restricted submission queue and original text.
- `POST /api/v1/clerk/motions/:motionId/review` — one-time review. Use `{ "decision": "schedule_debate", "publicTitle": "...", "publicSummary": "..." }`, `{ "decision": "refer_to_committee", "committee": "Health and Wellbeing", "publicTitle": "...", "publicSummary": "..." }`, or `{ "decision": "reject", "reasonCode": "duplicate" }`.
- `GET /api/v1/public/motions?limit=20` — returns only separately reviewed public wording for motions scheduled for debate, referred to committee or adopted.

Motion numbers are database-generated. Original submission text and proposer identity are restricted to the submitting delegate and authorised clerks. Public readers receive only the reviewed title, summary, committee, status and non-identifying timestamps. The application rejects obvious email addresses, Kenyan mobile numbers and URLs in public wording; this is a basic filter, not comprehensive de-identification. Clerks remain responsible for reviewing context and indirect identifiers.

The database requires the authenticated actor context, active delegate/clerk role, approved guardian consent for delegate submission, an open sitting, an append-only lifecycle event and a matching audit record. Motion text and identity cannot be rewritten after submission, and each submitted motion can receive only one clerk decision. Rejected motions are excluded from the public view.

This motion backend slice is not yet connected to the React Motions & Voting page. The debate speaker queue API is documented in the following section. Delegate-role provisioning/independent appointment verification, amendments, voting rules and resolution generation remain future work. Do not treat the role value alone as evidence that an election or appointment was independently verified.



## Debate speaker requests and floor management (migration 0015)

- `POST /api/v1/assembly/motions/:motionId/debate-requests` — an active delegate with approved, unwithdrawn guardian consent requests one speaking slot on a motion already under debate. The request body must be an empty JSON object; the service does not collect a free-text explanation or extra child data.
- `GET /api/v1/assembly/debate-requests/mine` — a delegate retrieves only their own speaker requests and the reviewed public motion title.
- `GET /api/v1/clerk/motions/:motionId/debate-requests` — an active clerk or administrator views the restricted queue, including delegate account identifiers needed for official allocation. Stakeholders and public-child accounts cannot read it.
- `POST /api/v1/clerk/debate-requests/:requestId/review` — approve with `{ "decision": "approve", "allocatedSeconds": 120 }` (30–600 seconds; defaults to 120), or reject with `{ "decision": "reject", "reasonCode": "capacity" }`. Rejection reasons are controlled codes, not free-text notes.
- `POST /api/v1/clerk/debate-requests/:requestId/start` — records the server-side start time for the first eligible approved speaker. The request body is an empty JSON object.
- `POST /api/v1/clerk/debate-requests/:requestId/finish` — records the server-side end time and completes the speaker turn. The request body is an empty JSON object.

The database locks the motion while requests are submitted or allocated, assigns sequential queue positions, prevents duplicate active/completed requests by the same delegate, and enforces one active speaker per motion. A later speaker cannot start while an earlier approved speaker is waiting. The delegate must have active account status and approved, unwithdrawn guardian consent at request time. Only clerks and administrators can review, start or finish turns.

Migration 0015 adds append-only `debate_request_events`, a unique queue-position index, a partial unique active-speaker index, controlled review reason codes and database triggers requiring a transaction-local authenticated actor, lifecycle event and matching audit row for each mutation. There is intentionally no public debate queue or speaker-identity projection. The API returns no guardian data or child narrative.

The current slice records actual start/end timestamps but does not automatically stop a speaker at the allocated duration; the clerk remains responsible for ending the turn. It is not yet connected to the React debate interface. Debate transcript/Hansard capture, amendments, quorum rules and voting remain future work. The existing role field is not proof of independent delegate appointment verification.
