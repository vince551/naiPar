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
The React application remains a **frontend demonstration**: sign-in is simulated; sample delegates, agenda items, motions and status counts are illustrative; and browser form submissions are not sent to a server. The separate `backend/` directory now contains an early Node.js/PostgreSQL API foundation and a pending child-registration request endpoint, but it is not connected to this frontend. There is still no login/session service, verified guardian consent, verified delegate register, live attendance, binding voting, or stakeholder messaging.

Do not enter real children's personal information or safeguarding disclosures. Before production use, complete independent guardian verification, secure session authentication, role/resource authorisation, data minimisation, consent and retention controls, moderation, audit logging, accessibility testing, and a restricted safeguarding workflow handled by trained and authorised personnel. Safeguarding disclosures must never be routed to public forums or ordinary moderation.

Formal parliamentary procedures and standing orders must be checked against the applicable approved governance documents. This independent project does not claim government endorsement, does not replace recognised county or national children's assembly structures, and cannot compel stakeholder action.

## Project identity
MCCeAS means **Mombasa County Children E-Assembly**. “Sauti Yetu” is the platform experience name.


## Backend development status

The API is an early development foundation, not a production Assembly service. See [backend/README.md](backend/README.md) for local setup, migration instructions, the implemented pending-registration flow, tests and security limitations. Do not enter real children's information until independent guardian verification, session authentication, safeguarding workflows and production security review are complete.
