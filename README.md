# Student Examination Management System (SEMS)

Secure, automated and transparent online examination management: Student, Faculty and Admin portals, a server-authoritative
exam engine, auto-grading, violation monitoring, audit logs, notices/resources/notifications, reports, and hash-based result
integrity verification.

## Status (honest summary)
| Area | State |
|---|---|
| API (56 routes), exam engine, grading, violations, audit, RBAC, MFA, uploads, reports, integrity | **Done: 53 automated tests, 100 % line coverage of backend modules** (`docs/TEST_MATRIX.md`) |
| Mid-term "Future Implementations" (coverage, anti-cheating hardening, subjective-grading UI, DB persistence, HA) | **Done within the limits listed in `docs/MIDTERM_ALIGNMENT.md`** |
| Per-student randomisation, hash-chained audit log + verify, webcam presence check | **Done** |
| Browser client (3 portals, secure exam screen, grading UI) | **Done**, smoke-tested on a fake DOM against the real API. **Not verified in real browsers**: use `docs/MANUAL_QA.md` |
| Docker + HTTPS deployment, 3-replica HA profile, backups, migrations | **Done**; compose files **not run** in the build sandbox |
| PostgreSQL / multi-host HA | **Not done** (needs the `pg` driver and network); runs on SQLite, port notes in `docs/DEPLOYMENT.md` |
| Real blockchain | **Not done**: local hash-chained ledger; Solidity/Hardhat sources in `blockchain/` are uncompiled and unrun |
| React/TypeScript/Tailwind client | **Not done**: dependency-free JS client (API is stable for a later port) |

The build sandbox had no network, so npm packages, PostgreSQL, Docker and a browser could not be used or tested.

## Run locally (Node 22.13+; no dependencies)
    cd server
    npm test                 # 53 tests
    npm run coverage         # measured coverage report
    npm install && npm run typecheck   # optional, dev-only: editor/type checking (@types/node + typescript); the server itself has no dependencies
    npm run backup -- out.db # online snapshot
    npm run start            # http://localhost:4000, seeds demo data
In dev (not production) the seeded "Data Structures Midterm" is only open for its 60 minutes; if your local `sems.db` is older, the server re-opens it on start (only if nobody has attempted it). To start completely fresh, stop the server and delete `server/sems.db*`.
Demo logins (password `Demo@12345!`, flagged must-change): admin@example.com, faculty@example.com, student@example.com, student2@example.com.

## Production
See `docs/DEPLOYMENT.md` (Docker Compose + Caddy HTTPS, HA profile, backups), `docs/SECURITY.md` (controls and limits), `.env.example`.

## Layout
    server/src      API, services, schema, ledger, grading        server/public   browser client
    server/test     automated tests                                blockchain/     Solidity + Hardhat sources (unverified)
    database/       schema.sql                                      docs/           architecture, API reference, security, deployment, QA
    deploy/ docker-compose.yml docker-compose.ha.yml .env.example

## Known limits
Browser-based exam security is prevention + detection + logging, not absolute control (see `docs/SECURITY.md`); risk scores are advisory. No email delivery, no password-reset flow, no antivirus on uploads, token stored in sessionStorage.
