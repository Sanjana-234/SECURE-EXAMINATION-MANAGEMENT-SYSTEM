import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { AppError } from './service.ts';
import type { Sems, Actor, Role } from './service.ts';
import type { Extras } from './extras.ts';

type Ctx = { a: Actor; body: any; params: Record<string, string>; query: URLSearchParams };
type Route = { method: string; re: RegExp; roles: Role[] | null; fn: (c: Ctx) => any };

export function createHttpServer(s: Sems, x?: Extras, opts: { requireAdminMfa?: boolean; trustProxy?: boolean } = {}) {
  const routes: Route[] = [];
  const r = (method: string, path: string, roles: Role[] | null, fn: (c: Ctx) => any) =>
    routes.push({ method, re: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), roles, fn });
  const A: Role[] = ['ADMIN'], F: Role[] = ['FACULTY'], S: Role[] = ['STUDENT'], FA: Role[] = ['FACULTY', 'ADMIN'];
  const ANY: Role[] = ['ADMIN', 'FACULTY', 'STUDENT'];

  // ---- auth ----
  r('POST', '/api/auth/login', null, (c) => s.login(c.body.email, c.body.password, { ip: c.a.ip, ua: c.a.ua }, c.body.totp));
  r('POST', '/api/auth/logout', ANY, (c) => (s.logout(c.a), { loggedOut: true }));
  r('POST', '/api/auth/change-password', ANY, (c) => (s.changePassword(c.a, c.body.oldPassword, c.body.newPassword), { changed: true }));
  r('GET', '/api/notifications', ANY, (c) => s.listNotifications(c.a));
  r('POST', '/api/notifications/:id/read', ANY, (c) => (s.markNotificationRead(c.a, c.params.id), { ok: true }));
  // ---- student ----
  r('GET', '/api/student/exams', S, (c) => s.listStudentExams(c.a));
  r('GET', '/api/student/exams/:id', S, (c) => s.examInfo(c.a, c.params.id));
  r('POST', '/api/student/exams/:id/start', S, (c) => s.startAttempt(c.a, c.params.id));
  r('GET', '/api/student/attempts/:id', S, (c) => s.getAttemptView(c.a, c.params.id));
  r('PUT', '/api/student/attempts/:id/answers/:qid', S, (c) => s.saveAnswer(c.a, c.params.id, c.params.qid, c.body.answer, Number(c.body.seq ?? 0)));
  r('POST', '/api/student/attempts/:id/submit', S, (c) => s.submitAttempt(c.a, c.params.id));
  r('POST', '/api/student/attempts/:id/violations', S, (c) => s.recordViolation(c.a, c.params.id, c.body));
  r('POST', '/api/student/attempts/:id/heartbeat', S, (c) => s.heartbeat(c.a, c.params.id));
  r('GET', '/api/student/results/:id/review', S, (c) => s.studentReview(c.a, c.params.id));
  r('GET', '/api/student/results', S, (c) => s.listStudentResults(c.a));
  r('GET', '/api/student/results/:id', S, (c) => s.studentResult(c.a, c.params.id));
  // ---- faculty ----
  r('GET', '/api/faculty/exams', F, (c) => s.listFacultyExams(c.a));
  r('POST', '/api/faculty/exams', F, (c) => s.createExam(c.a, c.body));
  r('POST', '/api/faculty/exams/:id/questions', F, (c) => s.addQuestion(c.a, c.params.id, c.body));
  r('POST', '/api/faculty/exams/:id/status', F, (c) => (s.setExamStatus(c.a, c.params.id, c.body.status), { ok: true }));
  r('GET', '/api/faculty/exams/:id/violations', F, (c) => s.examViolations(c.a, c.params.id));
  r('POST', '/api/faculty/attempts/:id/evaluate', F, (c) => s.evaluate(c.a, c.params.id, c.body.marks, c.body.remarks));
  r('POST', '/api/faculty/exams/:id/publish-results', F, (c) => s.publishResults(c.a, c.params.id, c.body.password));
  // ---- admin ----
  r('GET', '/api/admin/users', A, (c) => s.listUsers(c.query.get('role') ?? undefined, Number(c.query.get('limit') ?? 500) || 500, Number(c.query.get('offset') ?? 0) || 0));
  r('POST', '/api/admin/users', A, (c) => s.createUser(c.a, { email: c.body.email, name: c.body.name, role: c.body.role,
    password: c.body.password, mustChangePassword: true }));                      // explicit field pick: no mass assignment
  r('PUT', '/api/admin/users/:id', A, (c) => s.updateUser(c.a, c.params.id, { name: c.body.name, email: c.body.email }, c.body.password));
  r('POST', '/api/admin/users/:id/status', A, (c) => (s.setUserStatus(c.a, c.params.id, c.body.status, c.body.password), { ok: true }));
  r('GET', '/api/admin/audit/verify', A, (c) => s.verifyAuditChain());
  r('GET', '/api/admin/audit', A, (c) => s.listAudit({ action: c.query.get('action') ?? undefined, severity: c.query.get('severity') ?? undefined, limit: Number(c.query.get('limit') ?? 100) || 100, offset: Number(c.query.get('offset') ?? 0) || 0 }));
  r('GET', '/api/admin/security/summary', A, (c) => s.securitySummary({ from: c.query.get('from') ?? undefined, to: c.query.get('to') ?? undefined, examId: c.query.get('examId') ?? undefined }));
  // ---- integrity (admin or owning faculty) ----
  r('GET', '/api/integrity/:id', FA, (c) => s.verifyIntegrity(c.a, c.params.id));

  // ---- extras: profile, notices, resources, bank, reports, dashboards, MFA ----
  if (x) {
    r('GET', '/api/faculty/pending-evaluations', FA, (c) => x.pendingEvaluations(c.a));
    r('GET', '/api/faculty/exams/:id', FA, (c) => x.examDetail(c.a, c.params.id));
    r('GET', '/api/faculty/exams/:id/submissions', FA, (c) => x.listSubmissions(c.a, c.params.id));
    r('GET', '/api/faculty/attempts/:id', FA, (c) => x.submissionDetail(c.a, c.params.id));
    r('GET', '/api/admin/exams', A, (c) => x.listAllExams(c.a));
    r('GET', '/api/me', ANY, (c) => x.me(c.a));
    r('GET', '/api/dashboard', ANY, (c) => x.dashboard(c.a));
    r('POST', '/api/auth/mfa/setup', ANY, (c) => s.mfaSetup(c.a));
    r('POST', '/api/auth/mfa/enable', ANY, (c) => (s.mfaEnable(c.a, c.body.code), { enabled: true }));
    r('GET', '/api/notices', ANY, (c) => x.listNotices(c.a));
    r('POST', '/api/faculty/notices', FA, (c) => x.createNotice(c.a, c.body));
    r('GET', '/api/resources', ANY, (c) => x.listResources(c.a));
    r('GET', '/api/resources/:id/download', ANY, (c) => x.downloadResource(c.a, c.params.id));
    r('POST', '/api/faculty/resources', FA, (c) => x.uploadResource(c.a, c.body));
    r('DELETE', '/api/faculty/resources/:id', FA, (c) => (x.deleteResource(c.a, c.params.id), { deleted: true }));
    r('GET', '/api/faculty/bank', FA, (c) => x.bankList(c.a, { q: c.query.get('q') ?? undefined, difficulty: c.query.get('difficulty') ?? undefined, topic: c.query.get('topic') ?? undefined, type: c.query.get('type') ?? undefined }));
    r('POST', '/api/faculty/bank', FA, (c) => x.bankAdd(c.a, c.body));
    r('PUT', '/api/faculty/bank/:id', FA, (c) => (x.bankUpdate(c.a, c.params.id, c.body), { ok: true }));
    r('DELETE', '/api/faculty/bank/:id', FA, (c) => (x.bankDelete(c.a, c.params.id), { deleted: true }));
    r('POST', '/api/faculty/exams/:id/import-questions', F, (c) => x.bankImport(c.a, c.params.id, c.body.questionIds));
    r('GET', '/api/faculty/exams/:id/report', FA, (c) => x.examReport(c.a, c.params.id));
    r('PUT', '/api/admin/users/:id/profile', A, (c) => (x.setProfile(c.a, c.params.id, c.body), { ok: true }));
    r('GET', '/api/catalog/:kind', ANY, (c) => x.listCatalog(c.params.kind.toUpperCase()));
    r('POST', '/api/admin/catalog/:kind', A, (c) => x.createCatalog(c.a, c.params.kind.toUpperCase(), c.body.name));
    r('POST', '/api/admin/catalog/item/:id/active', A, (c) => (x.setCatalogActive(c.a, c.params.id, !!c.body.active), { ok: true }));
  }

  const pub = fileURLToPath(new URL('../public/', import.meta.url));
  const STATIC: Record<string, [string, string]> = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/app.css': ['app.css', 'text/css; charset=utf-8'] };
  const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

  // Per-IP throttle on public routes, stored in the shared DB so every instance behind a load balancer sees the same counts.
  function ipLimited(ip: string) {
    const w = Math.floor(Date.now() / 60_000);
    const row: any = s.db.prepare('INSERT INTO ip_hits (k,w,n) VALUES (?,?,1) ON CONFLICT(k,w) DO UPDATE SET n=n+1 RETURNING n').get(ip, w);
    return row.n > 30;
  }
  const send = (res: http.ServerResponse, status: number, body: any) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'", ...(opts.trustProxy ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}) });
    res.end(JSON.stringify(body));
  };
  const err = (res: http.ServerResponse, st: number, code: string, msg: string) => send(res, st, { success: false, message: msg, errorCode: code });

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { success: true, data: { status: 'ok' } });   // for container/LB probes; exempt from login throttle
      if (req.method === 'GET' && url.pathname === '/api/ready') {                      // readiness: can this instance reach the database?
        try { s.db.prepare('SELECT 1').get(); return send(res, 200, { success: true, data: { ready: true } }); } catch { return err(res, 503, 'NOT_READY', 'Database unavailable.'); }
      }
      const st = req.method === 'GET' ? STATIC[url.pathname] : undefined;
      if (st) {
        res.writeHead(200, { 'Content-Type': st[1], 'Content-Security-Policy': PAGE_CSP, 'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-cache', ...(opts.trustProxy ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}) });
        return void res.end(readFileSync(pub + st[0]));
      }
      const route = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!route) return err(res, 404, 'NOT_FOUND', 'Route not found.');
      const fwd = opts.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim().slice(0, 64) : '';   // only trusted behind our own proxy
      const ip = fwd || req.socket.remoteAddress || null, ua = String(req.headers['user-agent'] ?? '').slice(0, 300);
      if (route.roles === null && ipLimited(ip ?? '?')) return err(res, 429, 'RATE_LIMITED', 'Too many requests.');
      let a: Actor = { id: '', role: 'STUDENT', ip, ua };
      if (route.roles) {                                                           // authN then authZ, before any handler runs
        const m = /^Bearer (.+)$/.exec(String(req.headers.authorization ?? ''));
        if (!m) return err(res, 401, 'AUTH_REQUIRED', 'Authentication required.');
        a = s.authenticate(m[1], { ip, ua });
        if (opts.requireAdminMfa && a.role === 'ADMIN' && !s.hasMfa(a.id) && !/^\/api\/(auth\/|me$|notifications)/.test(url.pathname))
          return err(res, 403, 'MFA_SETUP_REQUIRED', 'Set up two-factor authentication to continue.');   // enforced per request, server-side
        if (!route.roles.includes(a.role)) {
          s.audit(a, 'ACCESS_DENIED', 'route', url.pathname, 'WARNING');
          return err(res, 403, 'AUTH_FORBIDDEN', 'You are not authorized to access this resource.');
        }
      }
      let body: any = {};
      const limit = url.pathname === '/api/faculty/resources' ? 8_000_000 : 1_000_000;
      if (req.method === 'POST' || req.method === 'PUT') {
        const chunks: Buffer[] = []; let size = 0, over = false;
        for await (const ch of req) {                                              // oversized bodies are discarded (not buffered) so the client still gets a clean 413
          size += ch.length;
          if (size > limit * 20) { req.destroy(); return; }                        // hard cap against endless streams
          if (over || size > limit) { over = true; chunks.length = 0; continue; }
          chunks.push(ch);
        }
        if (over) return err(res, 413, 'TOO_LARGE', 'Body too large.');
        try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { return err(res, 400, 'BAD_JSON', 'Invalid JSON.'); }
        if (body === null || typeof body !== 'object') body = {};
      }
      const data = await route.fn({ a, body, params: { ...(route.re.exec(url.pathname)!.groups ?? {}) }, query: url.searchParams });
      if (data && data.__file) {
        const f = data.__file, safe = String(f.name).replace(/[^A-Za-z0-9._-]/g, '_');
        res.writeHead(200, { 'Content-Type': f.mime, 'Content-Length': f.buffer.length, 'Content-Disposition': `attachment; filename="${safe}"`,
          'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" });
        return void res.end(f.buffer);
      }
      send(res, 200, { success: true, data });
    } catch (e: any) {
      if (e instanceof AppError) return err(res, e.status, e.code, e.message);
      console.error('Unhandled error:', e);                                          // details only in server logs
      err(res, 500, 'INTERNAL', 'Something went wrong.');
    }
  });
}
