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
This repository currently contains a **frontend demonstration**, not a live Assembly service. Sign-in is simulated; sample delegates, agenda items, motions and status counts are illustrative. Form submissions are held only in the current browser session. There is no connected database, secure authentication, verified delegate register, real attendance, binding voting, or stakeholder messaging.

Do not enter real children's personal information or safeguarding disclosures. Before production use, implement secure authentication and role-based access, data minimisation, consent and retention controls, moderation, audit logs, accessibility testing, and a restricted safeguarding workflow handled by trained and authorised personnel. Safeguarding disclosures must never be routed to public forums or ordinary moderation.

Formal parliamentary procedures and standing orders must be checked against the applicable approved governance documents. This independent project does not claim government endorsement, does not replace recognised county or national children's assembly structures, and cannot compel stakeholder action.

## Project identity
MCCeAS means **Mombasa County Children E-Assembly**. “Sauti Yetu” is the platform experience name.
