# Alignment with the mid-term report (SEMS Midterm Presentation, Sept 2026)

## Slide 11, "Future Implementations": status
| # | Planned item | Status | Where / evidence |
|---|---|---|---|
| 1 | Complete backend test coverage | **Done** | 51 automated tests; 100 % line coverage on all backend modules the tests load, 91-97 % branch on the main ones; every route's 401/403 verified by a route sweep. `docs/TEST_MATRIX.md`, `npm run coverage` |
| 2 | Harden anti-cheating monitors (continuous signal analysis) | **Done (server + client wiring; client not browser-verified)** | Heartbeat every 5 s with gap detection; explainable per-attempt risk score (weighted signals, burst detection, rapid-answering); risk-based flagging (advisory, never auto-fail); optional camera presence check (permission denied / stopped / covered), analysed on the device, nothing uploaded; signal-only events never count toward the violation policy so a network blip cannot auto-submit anyone |
| 3 | Expand subjective-grading UI | **Done (UI not browser-verified)** | Evaluation Queue across exams, per-question marks with Zero/Half/Full shortcuts, per-question feedback shown to the student, expected-keyword hints with found/missing chips and word counts (hints only; marks stay a human decision), overall remarks, "Save & next pending", risk panel and integrity check on the same page |
| 4 | Database-backed persistence | **Done on SQLite; PostgreSQL not done** | Replaces JSON files with a relational DB (`node:sqlite`, WAL, foreign keys, busy timeout), versioned migrations with a `schema_version` table, atomic write transactions, online backup (`npm run backup`, `deploy/backup.sh`). A PostgreSQL port needs the `pg` driver (no network here): mapping in `docs/DEPLOYMENT.md` |
| 5 | High-availability deployment | **Done for single-host multi-replica; multi-host not done** | 3 replicas + Caddy load balancing with active health checks (`docker-compose.ha.yml`), DB-backed sessions and rate limits shared across replicas, race-safe finalisation, atomic ledger/audit appends, repair job for half-finished submissions after a crash, `/api/ready`. Tested with two server instances on one database file. The compose file itself was not run here. Loss of the host/disk still means downtime: that needs PostgreSQL + replicated storage |

## Claims in the report that were not yet true of the code, now implemented
| Report claim | Before this round | Now |
|---|---|---|
| "Each student sees questions in a different order" | not implemented | per-attempt stable shuffle of questions **and options** (exam setting, default on) |
| "SHA-256 hash-chained audit log; Admin can verify the chain" | only submissions were chained | every audit row is chained (`prev_hash`/`entry_hash`); the chain head is anchored on the ledger so even tail truncation is detected; Admin page has **Verify audit chain** |
| "Periodic webcam activity" | not implemented | presence/covered checks only (see above). **Deliberate difference:** no frames are uploaded or stored, for privacy and bandwidth, in line with the report's own criticism of video proctoring |
| "Zero external runtime dependencies" | true | still true. Storage moved from JSON files to Node's built-in `node:sqlite` (which Node still labels *experimental*: pin the Node version and test upgrades) |

## Report module -> code
Authentication `service.ts` + `security.ts` · RBAC middleware `http.ts` (route table) · Question bank `extras.ts` · Exam creation/publishing `service.ts` ·
Exam delivery `service.ts` + `public/app.js` · Grading `grading.ts` + `service.ts` · Audit log `service.ts` (`audit`, `verifyAuditChain`) · Admin `service.ts`, `extras.ts`, `public/app.js`.

## Suggested wording updates for the final report
Mention: PostgreSQL is *planned, not done*; HA is single-host; browser-side detection is best-effort; webcam check is on-device and signal-only; risk score is advisory; client UI has had automated smoke tests plus a manual QA checklist, not a full browser test suite.
