import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSems, AppError } from '../src/service.ts';
import { createExtras } from '../src/extras.ts';
import { createHttpServer } from '../src/http.ts';

const P = 'Demo@12345!';
const A = (u: any) => ({ id: u.id, role: u.role } as any);
const code = (c: string) => (e: any) => e instanceof AppError && e.code === c;
const bad = (fn: () => any, c: string, label = '') => assert.throws(fn, code(c), label);
const badAsync = (p: Promise<any>, c: string, label = '') => assert.rejects(p, code(c), label);

function world() {
  let t = Date.parse('2026-10-07T10:00:00Z');
  const s = createSems({ now: () => new Date(t) }), x = createExtras(s, { uploadDir: mkdtempSync(join(tmpdir(), 'n-')) });
  const mk = (e: string, r: any) => s.createUser(null, { email: e, name: e, role: r, password: P });
  const admin = A(mk('a@x.com', 'ADMIN')), fac = A(mk('f@x.com', 'FACULTY')), fac2 = A(mk('f2@x.com', 'FACULTY')), stu = A(mk('s@x.com', 'STUDENT')), stu2 = A(mk('s2@x.com', 'STUDENT'));
  const opts = [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }];
  const exam = s.createExam(fac, { title: 'E', subject: 'S', startAt: new Date(t).toISOString(), durationMin: 10, passMarks: 1 });
  const qs = {
    mcq: s.addQuestion(fac, exam.id, { type: 'MCQ', text: 'm', options: opts, correct: 'A', marks: 1 }).id,
    multi: s.addQuestion(fac, exam.id, { type: 'MULTI', text: 'mm', options: opts, correct: ['A', 'B'], marks: 1 }).id,
    tf: s.addQuestion(fac, exam.id, { type: 'TF', text: 't', correct: 'true', marks: 1 }).id,
    short: s.addQuestion(fac, exam.id, { type: 'SHORT', text: 's', marks: 1 }).id,
  };
  s.setExamStatus(fac, exam.id, 'SCHEDULED');
  return { s, x, admin, fac, fac2, stu, stu2, exam, qs, opts, advance: (ms: number) => { t += ms; } };
}

test('validation: users, exams, questions reject bad input with specific codes', () => {
  const { s, admin, fac, fac2, exam, opts } = world();
  const u = (o: any) => () => s.createUser(admin, { email: 'n@x.com', name: 'N', role: 'STUDENT', password: P, ...o });
  bad(u({ email: 'nope' }), 'VALIDATION'); bad(u({ role: 'ROOT' }), 'VALIDATION'); bad(u({ name: ' ' }), 'VALIDATION');
  bad(u({ password: 'alllowercase1!' }), 'WEAK_PASSWORD'); bad(u({ email: 'S@X.COM' }), 'EMAIL_EXISTS');                // case-insensitive uniqueness
  const e = (o: any) => () => s.createExam(fac, { title: 'T', subject: 'S', startAt: '2026-10-08T00:00:00Z', durationMin: 5, ...o });
  bad(e({ title: ' ' }), 'VALIDATION'); bad(e({ startAt: 'garbage' }), 'VALIDATION'); bad(e({ durationMin: 0 }), 'VALIDATION'); bad(e({ durationMin: 601 }), 'VALIDATION');
  bad(e({ durationMin: 1.5 }), 'VALIDATION'); bad(e({ passMarks: -1 }), 'VALIDATION'); bad(e({ maxViolations: 0 }), 'VALIDATION'); bad(e({ violationPolicy: 'EXPEL' }), 'VALIDATION');
  const q = (o: any) => () => s.addQuestion(fac, exam.id, { type: 'MCQ', text: 'q', options: opts, correct: 'A', marks: 1, ...o });
  s.createExam(fac, { title: 'Draft', subject: 'S', startAt: '2026-10-08T00:00:00Z', durationMin: 5 });
  const d = s.createExam(fac, { title: 'D2', subject: 'S', startAt: '2026-10-08T00:00:00Z', durationMin: 5 });
  const qd = (o: any) => () => s.addQuestion(fac, d.id, { type: 'MCQ', text: 'q', options: opts, correct: 'A', marks: 1, ...o });
  bad(qd({ type: 'ESSAY' }), 'VALIDATION'); bad(qd({ text: '' }), 'VALIDATION'); bad(qd({ marks: 0 }), 'VALIDATION'); bad(qd({ negMarks: -1 }), 'VALIDATION');
  bad(qd({ options: [{ id: 'A', text: 'x' }] }), 'VALIDATION'); bad(qd({ options: [{ id: 'A', text: 'x' }, { id: 'A', text: 'y' }] }), 'VALIDATION'); bad(qd({ correct: 'Z' }), 'VALIDATION');
  bad(qd({ type: 'MULTI', correct: [] }), 'VALIDATION'); bad(qd({ type: 'MULTI', correct: ['A', 'Z'] }), 'VALIDATION'); bad(qd({ type: 'TF', correct: 'maybe' }), 'VALIDATION');
  bad(() => s.addQuestion(fac2, d.id, { type: 'TF', text: 'x', correct: 'true', marks: 1 }), 'NOT_FOUND');                      // not your exam
  bad(q({}), 'EXAM_LOCKED');                                                                                                    // scheduled exam is frozen
  bad(() => s.setExamStatus(fac, d.id, 'SCHEDULED'), 'NO_QUESTIONS'); bad(() => s.setExamStatus(fac2, exam.id, 'LIVE'), 'NOT_FOUND');
  assert.equal(s.listFacultyExams(fac).length, 3); assert.equal(s.listFacultyExams(admin).length, 3); assert.equal(s.listFacultyExams(fac2).length, 0);
});

test('autosave and attempt edge cases', async () => {
  const w = world(); const at = w.s.startAttempt(w.stu, w.exam.id);
  await w.s.saveAnswer(w.stu, at.id, w.qs.mcq, 'A', 1); await w.s.saveAnswer(w.stu, at.id, w.qs.mcq, null, 2);                  // clearing an answer deletes it
  assert.deepEqual((await w.s.getAttemptView(w.stu, at.id)).answers, {});
  await w.s.saveAnswer(w.stu, at.id, w.qs.multi, ['A'], 3); await w.s.saveAnswer(w.stu, at.id, w.qs.multi, [], 4);
  await w.s.saveAnswer(w.stu, at.id, w.qs.short, '', 5); assert.deepEqual((await w.s.getAttemptView(w.stu, at.id)).answers, {});
  await badAsync(w.s.saveAnswer(w.stu, at.id, w.qs.multi, ['A', 'Z'], 6), 'VALIDATION'); await badAsync(w.s.saveAnswer(w.stu, at.id, w.qs.multi, 'A', 6), 'VALIDATION');
  await badAsync(w.s.saveAnswer(w.stu, at.id, w.qs.short, 'x'.repeat(10001), 6), 'VALIDATION'); await badAsync(w.s.saveAnswer(w.stu, at.id, w.qs.short, 42 as any, 6), 'VALIDATION');
  await badAsync(w.s.saveAnswer(w.stu, at.id, 'no-such-question', 'A', 6), 'NOT_FOUND'); await badAsync(w.s.saveAnswer(w.stu2, at.id, w.qs.mcq, 'A', 6), 'NOT_FOUND');
  await badAsync(w.s.getAttemptView(w.stu2, at.id), 'NOT_FOUND'); await badAsync(w.s.submitAttempt(w.stu2, at.id), 'NOT_FOUND');
  await badAsync(w.s.evaluate(w.fac, at.id, {}), 'ATTEMPT_OPEN');                                                                // cannot grade an open attempt
  await badAsync(w.s.evaluate(w.fac, 'missing', {}), 'NOT_FOUND'); await badAsync(w.s.verifyIntegrity(w.admin, 'missing'), 'NOT_FOUND');
  await badAsync(w.s.verifyIntegrity(w.admin, at.id), 'NOT_ANCHORED');                                                            // not submitted -> nothing anchored
  bad(() => w.s.examInfo(w.stu, 'missing'), 'NOT_FOUND'); bad(() => w.s.studentResult(w.stu, 'missing'), 'NOT_FOUND');
  bad(() => w.s.startAttempt(w.stu, 'missing'), 'NOT_FOUND');
  const late = world(); late.advance(11 * 60_000); bad(() => late.s.startAttempt(late.stu, late.exam.id), 'EXAM_WINDOW_CLOSED');   // joined after the window
  const draft = world(); const dr = draft.s.createExam(draft.fac, { title: 'D', subject: 'S', startAt: '2026-10-07T10:00:00Z', durationMin: 5 });
  bad(() => draft.s.startAttempt(draft.stu, dr.id), 'NOT_FOUND');                                                                 // drafts are not startable
  const subj = world(); const a2 = subj.s.startAttempt(subj.stu, subj.exam.id); await subj.s.submitAttempt(subj.stu, a2.id);
  await badAsync(subj.s.evaluate(subj.fac, a2.id, { [subj.qs.mcq]: 1 }), 'VALIDATION'); await badAsync(subj.s.evaluate(subj.fac, a2.id, { [subj.qs.short]: -1 }), 'VALIDATION');
  await badAsync(subj.s.evaluate(subj.fac, a2.id, { [subj.qs.short]: 'ten' as any }), 'VALIDATION'); await badAsync(subj.s.evaluate(subj.fac2, a2.id, {}), 'NOT_FOUND');
});

test('admin/account edge cases and filters', async () => {
  const w = world();
  bad(() => w.s.setUserStatus(w.admin, w.stu.id, 'BANNED', P), 'VALIDATION'); bad(() => w.s.setUserStatus(w.admin, w.admin.id, 'INACTIVE', P), 'VALIDATION');
  bad(() => w.s.setUserStatus(w.admin, 'nobody', 'INACTIVE', P), 'NOT_FOUND'); bad(() => w.s.updateUser(w.admin, 'nobody', { name: 'x' }), 'NOT_FOUND');
  w.s.setUserStatus(w.admin, w.stu.id, 'SUSPENDED', P); w.s.setUserStatus(w.admin, w.stu.id, 'ACTIVE', P);                      // reactivation path
  assert.ok(w.s.listAudit({ action: 'USER_ACTIVATED' }).length === 1);
  bad(() => w.s.changePassword(w.admin, P, 'weak'), 'WEAK_PASSWORD'); bad(() => w.s.changePassword(w.admin, 'wrong', 'New@Pass12345!'), 'REAUTH_REQUIRED');
  const tok = w.s.login('a@x.com', P).token; w.s.changePassword({ ...w.s.authenticate(tok) }, P, 'New@Pass12345!');
  assert.equal(w.s.login('a@x.com', 'New@Pass12345!').user.role, 'ADMIN');
  bad(() => w.s.login('a@x.com', undefined as any), 'AUTH_INVALID_CREDENTIALS');                                                // non-string password cannot crash login
  bad(() => w.s.authenticate('garbage'), 'AUTH_REQUIRED'); bad(() => w.s.authenticate(''), 'AUTH_REQUIRED');
  assert.equal(w.s.securitySummary({ from: '2020-01-01', to: '2099-01-01', examId: w.exam.id }).totalViolations, 0);
  assert.equal(w.s.listAudit({ severity: 'CRITICAL', limit: 5 }).length, 0); assert.ok(w.s.listUsers('STUDENT', 1, 1).length === 1); assert.ok(w.s.listUsers(undefined, 99999, -5).length >= 5);
  w.s.notify(w.stu.id, 'hi', 'there'); const n = w.s.listNotifications(w.stu)[0]; w.s.markNotificationRead(w.stu2, n.id);       // someone else's id: no effect
  assert.equal(w.s.listNotifications(w.stu)[0].is_read, 0); w.s.markNotificationRead(w.stu, n.id); assert.equal(w.s.listNotifications(w.stu)[0].is_read, 1);
});

test('faculty views: violations list, catalog, profile, notices, resources edge cases', async () => {
  const w = world(); const at = w.s.startAttempt(w.stu, w.exam.id);
  await w.s.recordViolation(w.stu, at.id, { type: 'TAB_SWITCH', description: 'x'.repeat(900) });
  const v = w.s.examViolations(w.fac, w.exam.id); assert.equal(v.length, 1); assert.equal(v[0].description.length, 500);              // truncated
  bad(() => w.s.examViolations(w.fac2, w.exam.id), 'NOT_FOUND'); assert.equal(w.s.examViolations(w.admin, w.exam.id).length, 1);
  const c = w.x.createCatalog(w.admin, 'SUBJECT', ' Physics '); assert.equal(w.x.listCatalog('SUBJECT')[0].name, 'Physics');
  bad(() => w.x.createCatalog(w.admin, 'PLANET', 'x'), 'VALIDATION'); bad(() => w.x.createCatalog(w.admin, 'COURSE', ' '), 'VALIDATION'); bad(() => w.x.createCatalog(w.admin, 'COURSE', 'x'.repeat(101)), 'VALIDATION');
  w.x.setCatalogActive(w.admin, c.id, false); assert.equal(w.x.listCatalog('SUBJECT')[0].active, 0); w.x.setCatalogActive(w.admin, c.id, true); bad(() => w.x.setCatalogActive(w.admin, 'nope', true), 'NOT_FOUND');
  bad(() => w.x.setProfile(w.admin, 'nobody', {}), 'NOT_FOUND'); w.x.setProfile(w.admin, w.stu.id, { department: 'CS' }); assert.equal(w.x.me(w.stu).profile.department, 'CS');
  bad(() => w.x.createNotice(w.fac, { title: 't', message: 'm', priority: 'URGENT' }), 'VALIDATION'); bad(() => w.x.createNotice(w.fac, { title: 't', message: 'm', publishAt: 'x' }), 'VALIDATION');
  bad(() => w.x.createNotice(w.fac, { title: 't', message: 'm', publishAt: '2026-10-08T00:00:00Z', expiresAt: '2026-10-07T00:00:00Z' }), 'VALIDATION');
  w.x.createNotice(w.fac, { title: 'F', message: 'm' }); assert.equal(w.x.listNotices(w.fac).length, 1); assert.equal(w.x.listNotices(w.fac2).length, 0); assert.equal(w.x.listNotices(w.admin).length, 1);
  const up = (o: any) => () => w.x.uploadResource(w.fac, { title: 't', filename: 'a.pdf', contentBase64: Buffer.from('%PDF-1').toString('base64'), ...o });
  bad(up({ title: ' ' }), 'VALIDATION'); bad(up({ contentBase64: '' }), 'VALIDATION'); bad(up({ contentBase64: 5 }), 'VALIDATION'); bad(up({ expiresAt: 'x' }), 'VALIDATION');
  bad(() => w.x.downloadResource(w.stu, 'nope'), 'NOT_FOUND'); bad(() => w.x.deleteResource(w.fac, 'nope'), 'NOT_FOUND');
  const rep = w.x.examReport(w.fac, w.exam.id); assert.equal(rep.participated, 0); assert.equal(rep.average, null); assert.equal(rep.passPercentage, null);   // empty exam: no divide-by-zero
  bad(() => w.x.bankImport(w.fac, w.exam.id, []), 'VALIDATION'); bad(() => w.x.bankImport(w.fac, w.exam.id, ['nope']), 'NOT_FOUND');
  assert.equal((w.x.dashboard(w.stu) as any).unreadNotifications >= 0, true);
});

test('http: malformed, oversized and failing requests never leak internals', async () => {
  const w = world(); const srv = createHttpServer(w.s, w.x).listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`, tok = w.s.login('a@x.com', P).token;
  const raw = async (m: string, p: string, body?: any, headers: any = {}) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...headers }, body }); return { status: r.status, j: (await r.json().catch(() => null)) as any }; };
  const origErr = console.error; console.error = () => {};
  try {
    assert.equal((await raw('POST', '/api/auth/login', '{bad json')).j.errorCode, 'BAD_JSON');
    assert.equal((await raw('POST', '/api/auth/login', '[1,2]')).status, 401);                                                    // non-object body treated as empty, not a crash
    assert.equal((await raw('POST', '/api/auth/login', JSON.stringify({ email: 'a@x.com', password: 'x'.repeat(2_000_000) }))).status, 413);
    assert.equal((await raw('GET', '/api/me', undefined, { authorization: 'Basic abc' })).status, 401);                          // wrong scheme
    assert.equal((await raw('GET', '/api/admin/users', undefined, { authorization: 'Bearer forged.token' })).status, 401);
    assert.equal((await raw('DELETE', '/api/auth/login')).status, 404);                                                           // wrong method
    w.s.listUsers = () => { throw new Error('SECRET_DB_PATH /var/lib/db password=hunter2'); };
    const boom = await raw('GET', '/api/admin/users', undefined, { authorization: `Bearer ${tok}` });
    assert.equal(boom.status, 500); assert.equal(boom.j.errorCode, 'INTERNAL'); assert.ok(!JSON.stringify(boom.j).includes('hunter2') && !JSON.stringify(boom.j).includes('SECRET_DB_PATH'));
    assert.equal(Object.keys(boom.j).sort().join(), 'errorCode,message,success');                                                // uniform error envelope
    w.s.db.close();
    assert.equal((await raw('GET', '/api/ready')).status, 503);                                                                   // readiness fails closed when the DB is gone
  } finally { console.error = origErr; srv.close(); }
});
