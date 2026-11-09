# API reference (generated from `server/src/http.ts`)

All responses: `{ success, data }` or `{ success:false, message, errorCode }`. Auth: `Authorization: Bearer <token>` from `POST /api/auth/login`.
Role checks run server-side before any handler; ownership is enforced inside each handler. `test/routes.test.ts` verifies 401/403 for every route below.
Probes (no auth, not throttled): `GET /api/health` (process up), `GET /api/ready` (database reachable).

| Method | Path | Allowed |
|---|---|---|
| POST | `/api/auth/login` | public |
| POST | `/api/auth/logout` | any signed-in user |
| POST | `/api/auth/change-password` | any signed-in user |
| GET | `/api/notifications` | any signed-in user |
| POST | `/api/notifications/:id/read` | any signed-in user |
| GET | `/api/student/exams` | STUDENT |
| GET | `/api/student/exams/:id` | STUDENT |
| POST | `/api/student/exams/:id/start` | STUDENT |
| GET | `/api/student/attempts/:id` | STUDENT |
| PUT | `/api/student/attempts/:id/answers/:qid` | STUDENT |
| POST | `/api/student/attempts/:id/submit` | STUDENT |
| POST | `/api/student/attempts/:id/violations` | STUDENT |
| POST | `/api/student/attempts/:id/heartbeat` | STUDENT |
| GET | `/api/student/results/:id/review` | STUDENT |
| GET | `/api/student/results` | STUDENT |
| GET | `/api/student/results/:id` | STUDENT |
| GET | `/api/faculty/exams` | FACULTY |
| POST | `/api/faculty/exams` | FACULTY |
| POST | `/api/faculty/exams/:id/questions` | FACULTY |
| POST | `/api/faculty/exams/:id/status` | FACULTY |
| GET | `/api/faculty/exams/:id/violations` | FACULTY |
| POST | `/api/faculty/attempts/:id/evaluate` | FACULTY |
| POST | `/api/faculty/exams/:id/publish-results` | FACULTY |
| GET | `/api/admin/users` | ADMIN |
| POST | `/api/admin/users` | ADMIN |
| PUT | `/api/admin/users/:id` | ADMIN |
| POST | `/api/admin/users/:id/status` | ADMIN |
| GET | `/api/admin/audit/verify` | ADMIN |
| GET | `/api/admin/audit` | ADMIN |
| GET | `/api/admin/security/summary` | ADMIN |
| GET | `/api/integrity/:id` | FACULTY, ADMIN |
| GET | `/api/faculty/pending-evaluations` | FACULTY, ADMIN |
| GET | `/api/faculty/exams/:id` | FACULTY, ADMIN |
| GET | `/api/faculty/exams/:id/submissions` | FACULTY, ADMIN |
| GET | `/api/faculty/attempts/:id` | FACULTY, ADMIN |
| GET | `/api/admin/exams` | ADMIN |
| GET | `/api/me` | any signed-in user |
| GET | `/api/dashboard` | any signed-in user |
| POST | `/api/auth/mfa/setup` | any signed-in user |
| POST | `/api/auth/mfa/enable` | any signed-in user |
| GET | `/api/notices` | any signed-in user |
| POST | `/api/faculty/notices` | FACULTY, ADMIN |
| GET | `/api/resources` | any signed-in user |
| GET | `/api/resources/:id/download` | any signed-in user |
| POST | `/api/faculty/resources` | FACULTY, ADMIN |
| DELETE | `/api/faculty/resources/:id` | FACULTY, ADMIN |
| GET | `/api/faculty/bank` | FACULTY, ADMIN |
| POST | `/api/faculty/bank` | FACULTY, ADMIN |
| PUT | `/api/faculty/bank/:id` | FACULTY, ADMIN |
| DELETE | `/api/faculty/bank/:id` | FACULTY, ADMIN |
| POST | `/api/faculty/exams/:id/import-questions` | FACULTY |
| GET | `/api/faculty/exams/:id/report` | FACULTY, ADMIN |
| PUT | `/api/admin/users/:id/profile` | ADMIN |
| GET | `/api/catalog/:kind` | any signed-in user |
| POST | `/api/admin/catalog/:kind` | ADMIN |
| POST | `/api/admin/catalog/item/:id/active` | ADMIN |
