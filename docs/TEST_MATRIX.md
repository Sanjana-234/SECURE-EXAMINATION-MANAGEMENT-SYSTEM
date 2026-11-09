# Test matrix and certification

Run: `cd server && npm test` (53 automated tests) and `npm run coverage` (Node's built-in coverage).

**Measured backend coverage (src/):** 100 % of lines in every module that tests load (`db`, `extras`, `grading`, `http`, `ledger`, `security`, `seed`, `service`);
branch coverage 91–97 % on the main modules (`service` 97 %, `http` 94 %, `extras` 92 %, `ledger` 96 %, `security` 90 %, `grading` 91 %; `db.ts` 73 %, the gap being migration/rollback error paths).
`main.ts` and `backup.ts` are thin entry scripts, exercised manually (production start guards were run by hand, see README).
The browser client (`public/app.js`) is only smoke-tested on a fake DOM (about half of its lines run); see `docs/MANUAL_QA.md`.
"100 % line coverage" shows code was executed, not that every behaviour is correct. Treat it as a floor.

## Original specification section 39 -> tests
| Required test | Test (file) |
|---|---|
| Auth: valid / invalid login, logout | `auth: valid login, invalid login, logout, lockout` (sems) |
| Auth: rate limiting & lockout | same; `http: shared rate limit across replicas...` (ha); `health probe...` (deploy) |
| Authz: student -> faculty API; faculty -> admin API | `authz: role boundaries and cross-student result access` (sems); **`route sweep`** (routes): every route x every wrong role = 403, anonymous = 401 |
| Authz: student reading another student's result | `authz: ...cross-student result access`; `result review: ...other students cannot read it` (features) |
| Exam start / idempotent resume | `exam: start is idempotent, hides answers, and respects schedule` |
| Server timer, auto-submit on timeout | `exam: server timer auto-submits and locks answers after expiry` |
| Autosave (no duplicates, retries) | `exam: autosave is idempotent, ordered, and validated`; `autosave and attempt edge cases` (negative) |
| Submission, duplicate submission | `exam: duplicate / concurrent submission is rejected or collapsed`; `two instances on one database...` (ha) |
| Auto grading (+ negative marks, pending subjective) | `grading: negative marks, pending subjective...`; `grading: full pass, unanswered counted...` |
| Security events: tab switch, fullscreen exit, copy, paste, right click | `security: every violation type is logged with policy escalation`; `security: configurable policy...` (server side) |
| Blockchain: hash creation / verification / mismatch | `blockchain: hash creation, verification, and tamper detection`; `blockchain: ledger tampering and re-anchoring...` |

**Not automatically tested:** the browser event listeners that *produce* those security events (copy/paste/visibility/fullscreen/camera), real fullscreen behaviour, layout.
The server side of every event is tested; the client wiring is covered only by `docs/MANUAL_QA.md`.

## Tests added for the Future Implementations
| Area | Tests |
|---|---|
| Randomised delivery | `randomisation: stable per student, different across students...` |
| Continuous anti-cheating analysis | `risk analysis...`, `heartbeat...`, `client smoke: camera presence check...` |
| Subjective grading | `subjective grading: keyword hints, comments, queue...`, `result review...` |
| Persistence / migrations / backup | `migrations: legacy database is upgraded...`, `http: ...online backup` |
| Tamper-evident audit log | `audit chain: detects edits, deletions, truncation and ledger tampering` |
| High availability | `two instances on one database...`, `failover repair...`, shared rate limit + readiness |
| Robustness | `validation: ...`, `admin/account edge cases...`, `http: malformed, oversized and failing requests never leak internals` |
