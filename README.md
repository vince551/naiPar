# MCCeAS — Mombasa County Children E-Assembly

**Sauti Yetu** is a digital participation and Assembly-workspace concept for children in Mombasa County.

## Three pillars
1. **Official Assembly Hall** — delegate workspace, sittings, order papers, motions, debate, voting interface and records.
2. **Open Child Participation** — public forums, community concerns, proposals and consultations. Open participation does not confer delegate status or parliamentary voting rights.
3. **Shared Advocacy & Accountability** — a workflow for reviewing contributions, referring priorities to relevant stakeholders, and tracking responses and follow-up.

## Technology
- React 18
- Vite
- Lucide React
- Responsive CSS

## Run locally
```bash
npm install
npm run dev
```

Build for production:
```bash
npm run build
```

## Important implementation status
The React application is now **partially connected** to the Node.js/PostgreSQL API for child registration, guardian OTP request/verification, adult and child login, session refresh/logout, and private concern submission. The Assembly Hall, agenda, member register, motions, voting, Hansard and stakeholder screens remain illustrative; they are not live parliamentary records or actions. The backend has no persistent staging database or production deployment, and no SMS relay is configured. Do not use real children's information or real credentials until a secured staging environment, approved SMS delivery, safeguarding review and data-protection approval are in place.

Do not enter real children's personal information or safeguarding disclosures. Before production use, complete independent guardian verification, secure session authentication, role/resource authorisation, data minimisation, consent and retention controls, moderation, audit logging, accessibility testing, and a restricted safeguarding workflow handled by trained and authorised personnel. Safeguarding disclosures must never be routed to public forums or ordinary moderation.

Formal parliamentary procedures and standing orders must be checked against the applicable approved governance documents. This independent project does not claim government endorsement, does not replace recognised county or national children's assembly structures, and cannot compel stakeholder action.

## Project identity
MCCeAS means **Mombasa County Children E-Assembly**. “Sauti Yetu” is the platform experience name.


## Backend development status

The API is an early development foundation, not a production Assembly service. See [backend/README.md](backend/README.md) for local setup, migration instructions, the implemented pending-registration flow, tests and security limitations. Do not enter real children's information until independent guardian verification, session authentication, safeguarding workflows and production security review are complete.


## Connect the browser to the API

The React login, child registration/guardian OTP flow and private concern form use the same-origin `/api/v1` routes. For local development, start the backend in `backend/` with its required development environment variables, then run Vite from the repository root. Vite proxies `/api` to `http://127.0.0.1:4000` by default; override the target with `SAUTI_YETU_API_TARGET` if needed. In production, configure the hosting reverse proxy to forward `/api/*` to the API over a private network. Keep the browser and API same-origin; this API deliberately does not enable permissive cross-origin CORS. The frontend never stores the session token or CSRF token in localStorage; the session cookie is HttpOnly and the CSRF token remains in memory.

The child registration form now creates a pending registration and can request guardian phone OTP. A successful OTP confirms phone possession only; an authorised coordinator must still review guardian consent before activation. The community contribution form submits a private concern and requires an active child/delegate session with approved consent. The Assembly Hall, motion/vote screens, sample member register and Hansard remain illustrative until their APIs are implemented.


### Run the API locally

The API requires a PostgreSQL development database and the environment values in `backend/.env.example`. In a separate terminal, configure a disposable local database and backend-only secrets, then run:

```bash
cd backend
npm install
npm run migrate
npm run dev
```

In the repository root, run `npm run dev`; Vite proxies `/api` to `http://127.0.0.1:4000`. To use another local API host, set `SAUTI_YETU_API_TARGET` in the Vite environment. Production hosting must provide a same-origin reverse proxy for `/api/*`; permissive cross-origin CORS is intentionally not enabled.
