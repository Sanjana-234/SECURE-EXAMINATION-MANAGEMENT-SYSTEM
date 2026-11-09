import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSems, AppError } from '../src/service.ts';
import { createHttpServer } from '../src/http.ts';
import { seed, refreshDemoExam } from '../src/seed.ts';

const P = 'Demo@12345!';
const rejects = (p: Promise<any> | (() => any), code: string) =>
  assert.rejects(async () => (typeof p === 'function' ? p() : p), (e: any) => e instanceof AppError && e.code === code);

async function setup(extra: any = {}) {
  let t = Date.parse('2026-10-07T10:00:00Z');
  const s = createSems({ now: () => new Date(t) });
  const mk = (email: string, role: any) => s.createUser(null, { email, name: email, role, password: P });
  const admin = mk('admin@x.com', 'ADMIN'), fac = mk('fac@x.com', 'FACULTY'), fac2 = mk('fac2@x.com', 'FACULTY');
  const st1 = mk('s1@x.com', 'STUDENT'), st2 = mk('s2@x.com', 'STUDENT');
  const A = (u: any) => ({ id: u.id, role: u.role } as any);
  const f = A(fac);
  const exam = s.createExam(f, { title: 'DS', subject: 'DS', startAt: new Date(t).toISOString(), durationMin: 10, passMarks: 5,
    negativeMarking: true, publishImmediately: true, ...extra });
  const ab = [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }, { id: 'C', text: 'c' }];
  const q1 = s.addQuestion(f, exam.id, { type: 'MCQ', text: 'Q1', options: ab, correct: 'B', marks: 2, negMarks: 0.5 }).id;
  const q2 = s.addQuestion(f, exam.id, { type: 'MULTI', text: 'Q2', options: ab, correct: ['A', 'B'], marks: 3, negMarks: 1 }).id;
  const q3 = s.addQuestion(f, exam.id, { type: 'TF', text: 'Q3', correct: 'true', marks: 1, negMarks: 0.25 }).id;
  const q4 = s.addQuestion(f, exam.id, { type: 'SHORT', text: 'Q4', marks: 4 }).id;
  s.setExamStatus(f, exam.id, 'SCHEDULED');
  return { s, admin: A(admin), f, f2: A(fac2), a1: A(st1), a2: A(st2), exam, q: [q1, q2, q3, q4], advance: (ms: number) => { t += ms; } };
}

// ---------------- Authentication ----------------
test('auth: valid login, invalid login, logout, lockout', async () => {
  const { s } = await setup();
  const ok = s.login('s1@x.com', P);
  assert.equal(ok.user.role, 'STUDENT'); assert.ok(!JSON.stringify(ok).includes('password'));
  const actor = s.authenticate(ok.token);
  assert.equal(actor.role, 'STUDENT');
  s.logout(actor);
  await rejects(() => s.authenticate(ok.token), 'AUTH_REQUIRED');                 // revoked session
  await rejects(() => s.login('s1@x.com', 'wrong'), 'AUTH_INVALID_CREDENTIALS');
  await rejects(() => s.login('nobody@x.com', P), 'AUTH_INVALID_CREDENTIALS');    // no user enumeration
  for (let i = 0; i < 4; i++) await rejects(() => s.login('s2@x.com', 'bad'), 'AUTH_INVALID_CREDENTIALS');
  await rejects(() => s.login('s2@x.com', 'bad'), 'AUTH_INVALID_CREDENTIALS');    // 5th failure locks
  await rejects(() => s.login('s2@x.com', P), 'AUTH_LOCKED');                     // even the right password is refused
  assert.ok(s.securitySummary().failedLogins >= 7);
});
test('auth: tokens cannot be forged; weak passwords rejected; suspended users cut off', async () => {
  const { s, admin, a1 } = await setup();
  const tok = s.login('s1@x.com', P).token;
  await rejects(() => s.authenticate(tok.slice(0, -2) + 'xx'), 'AUTH_REQUIRED');
  await rejects(() => s.createUser(null, { email: 'w@x.com', name: 'w', role: 'STUDENT', password: 'short' }), 'WEAK_PASSWORD');
  await rejects(() => s.setUserStatus(admin, a1.id, 'SUSPENDED', 'wrong-password'), 'REAUTH_REQUIRED');  // re-auth gate
  s.setUserStatus(admin, a1.id, 'SUSPENDED', P);
  await rejects(() => s.authenticate(tok), 'AUTH_REQUIRED');
  await rejects(() => s.login('s1@x.com', P), 'AUTH_ACCOUNT_DISABLED');
  assert.ok(s.listAudit({ action: 'USER_DEACTIVATED' }).length === 1);
});

// ---------------- Authorization over HTTP ----------------
test('authz: role boundaries and cross-student result access', async () => {
  const { s, exam, q } = await setup();
  const srv = createHttpServer(s).listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (m: string, p: string, tok?: string, body?: any) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json()) as any };
  };
  const tok = async (e: string) => (await call('POST', '/api/auth/login', undefined, { email: e, password: P })).json.data.token;
  const [ts1, ts2, tf, ta] = [await tok('s1@x.com'), await tok('s2@x.com'), await tok('fac@x.com'), await tok('admin@x.com')];
  try {
    assert.equal((await call('GET', '/api/faculty/exams')).status, 401);
    const sf = await call('GET', '/api/faculty/exams', ts1);
    assert.equal(sf.status, 403); assert.equal(sf.json.errorCode, 'AUTH_FORBIDDEN'); assert.equal(sf.json.success, false);
    assert.equal((await call('GET', '/api/admin/users', tf)).status, 403);        // faculty -> admin
    assert.equal((await call('GET', '/api/admin/users', ts1)).status, 403);       // student -> admin
    assert.equal((await call('POST', '/api/faculty/exams', ts1, {})).status, 403);
    assert.equal((await call('GET', `/api/integrity/x`, ts1)).status, 403);       // students cannot verify
    assert.equal((await call('GET', '/api/admin/users', ta)).status, 200);
    const users = (await call('GET', '/api/admin/users', ta)).json.data;
    assert.ok(!JSON.stringify(users).includes('password'));                        // no hashes leaked
    // student 1 takes + submits; student 2 must not see it (IDOR)
    const att = (await call('POST', `/api/student/exams/${exam.id}/start`, ts1)).json.data;
    await call('PUT', `/api/student/attempts/${att.id}/answers/${q[0]}`, ts1, { answer: 'B', seq: 1 });
    assert.equal((await call('POST', `/api/student/attempts/${att.id}/submit`, ts1)).status, 200);
    assert.equal((await call('GET', `/api/student/results/${att.id}`, ts2)).status, 404);
    assert.equal((await call('GET', `/api/student/attempts/${att.id}`, ts2)).status, 404);
    assert.equal((await call('PUT', `/api/student/attempts/${att.id}/answers/${q[0]}`, ts2, { answer: 'A' })).status, 404);
    assert.equal((await call('GET', `/api/student/results/${att.id}`, ts1)).status, 200);
    assert.equal((await call('GET', '/api/nope', ts1)).status, 404);
  } finally { srv.close(); }
});

// ---------------- Examination engine ----------------
test('exam: start is idempotent, hides answers, and respects schedule', async () => {
  const { s, a1, exam, advance } = await setup({ startAt: '2026-10-07T10:30:00Z' });
  await rejects(() => s.startAttempt(a1, exam.id), 'EXAM_NOT_STARTED');
  advance(31 * 60_000);
  const a = s.startAttempt(a1, exam.id), b = s.startAttempt(a1, exam.id);
  assert.equal(a.id, b.id); assert.equal(a.remainingSeconds, 600 - 0);
  const view = await s.getAttemptView(a1, a.id);
  assert.equal(view.questions.length, 4); assert.ok(!JSON.stringify(view).includes('"correct"'));
});
test('exam: autosave is idempotent, ordered, and validated', async () => {
  const { s, a1, exam, q } = await setup();
  const at = s.startAttempt(a1, exam.id);
  await s.saveAnswer(a1, at.id, q[0], 'A', 1); await s.saveAnswer(a1, at.id, q[0], 'B', 2);
  await s.saveAnswer(a1, at.id, q[0], 'A', 1);                                       // stale retry must not overwrite
  assert.equal((await s.getAttemptView(a1, at.id)).answers[q[0]], 'B');
  assert.equal((s.db.prepare('SELECT COUNT(*) c FROM answers').get() as any).c, 1);
  await rejects(s.saveAnswer(a1, at.id, q[0], 'ZZ', 3), 'VALIDATION');
  await rejects(s.saveAnswer(a1, at.id, q[2], 'maybe', 3), 'VALIDATION');
});
test('exam: server timer auto-submits and locks answers after expiry', async () => {
  const { s, a1, a2, exam, q, advance } = await setup();
  const at = s.startAttempt(a1, exam.id); s.startAttempt(a2, exam.id);
  await s.saveAnswer(a1, at.id, q[0], 'B', 1);
  advance(9 * 60_000); assert.equal(s.startAttempt(a1, exam.id).remainingSeconds, 60);
  advance(2 * 60_000);                                                               // 1 minute past deadline
  await rejects(s.saveAnswer(a1, at.id, q[1], ['A'], 2), 'ATTEMPT_CLOSED');         // lazy enforcement
  const row: any = s.db.prepare('SELECT * FROM attempts WHERE id=?').get(at.id);
  assert.equal(row.status, 'AUTO_SUBMITTED'); assert.equal(row.submitted_at, row.expires_at);
  assert.equal((await s.autoSubmitExpired()), 1);                                    // sweeper catches the idle student
  assert.equal(s.listStudentResults(a1)[0].published, true);
  await rejects(s.submitAttempt(a1, at.id), 'ALREADY_SUBMITTED');
});
test('exam: duplicate / concurrent submission is rejected or collapsed', async () => {
  const { s, a1, exam } = await setup();
  const at = s.startAttempt(a1, exam.id);
  await s.submitAttempt(a1, at.id);
  await rejects(s.submitAttempt(a1, at.id), 'ALREADY_SUBMITTED');
  const b = await setup(); const t2 = b.s.startAttempt(b.a1, b.exam.id);
  await Promise.allSettled([b.s.submitAttempt(b.a1, t2.id), b.s.submitAttempt(b.a1, t2.id)]);
  assert.equal((b.s.db.prepare('SELECT COUNT(*) c FROM blockchain_records').get() as any).c, 1);
  assert.equal((b.s.db.prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='EXAM_SUBMITTED'").get() as any).c, 1);
});

// ---------------- Grading ----------------
test('grading: negative marks, pending subjective, manual evaluation, publish rules', async () => {
  const { s, f, a1, exam, q } = await setup();
  const at = s.startAttempt(a1, exam.id);
  await s.saveAnswer(a1, at.id, q[0], 'B', 1);           // correct  +2
  await s.saveAnswer(a1, at.id, q[1], ['A'], 1);          // wrong    -1 (partial is wrong)
  await s.saveAnswer(a1, at.id, q[2], 'false', 1);        // wrong    -0.25
  await s.saveAnswer(a1, at.id, q[3], 'hash collision is...', 1);
  const r1: any = await s.submitAttempt(a1, at.id);
  assert.equal(r1.published, false);                       // not shown: subjective pending
  const raw: any = s.db.prepare('SELECT * FROM results WHERE attempt_id=?').get(at.id);
  assert.deepEqual([raw.attempted, raw.correct, raw.incorrect, raw.unanswered, raw.positive_marks, raw.negative_marks, raw.score],
    [4, 1, 2, 0, 2, 1.25, 0.75]);
  assert.equal(raw.eval_status, 'PENDING_FACULTY_EVALUATION');
  await rejects(s.evaluate(f, at.id, { [q[0]]: 1 }), 'VALIDATION');                 // cannot hand-mark an MCQ
  await rejects(s.evaluate(f, at.id, { [q[3]]: 99 }), 'VALIDATION');                // exceeds question marks
  await s.evaluate(f, at.id, { [q[3]]: 3 }, 'Good attempt');
  const r2: any = s.studentResult(a1, at.id);
  assert.equal(r2.published, true); assert.equal(r2.score, 3.75); assert.equal(r2.percentage, 37.5);
  assert.equal(r2.passed, false); assert.equal(r2.grade, 'F'); assert.equal(r2.remarks, 'Good attempt');
});
test('grading: full pass, unanswered counted, delayed publication needs re-auth', async () => {
  const { s, f, a1, exam, q } = await setup({ publishImmediately: false });
  const at = s.startAttempt(a1, exam.id);
  await s.saveAnswer(a1, at.id, q[0], 'B', 1); await s.saveAnswer(a1, at.id, q[1], ['B', 'A'], 1); await s.saveAnswer(a1, at.id, q[2], 'true', 1);
  assert.equal(((await s.submitAttempt(a1, at.id)) as any).published, false);
  await rejects(() => s.publishResults(f, exam.id, 'nope'), 'REAUTH_REQUIRED');
  assert.equal(s.publishResults(f, exam.id, P).published, 1);
  const r: any = s.studentResult(a1, at.id);
  assert.deepEqual([r.score, r.unanswered, r.passed, r.percentage, r.grade], [6, 1, true, 60, 'D']);
});

// ---------------- Exam security / violations ----------------
test('security: every violation type is logged with policy escalation', async () => {
  const { s, admin, a1, exam } = await setup();
  const at = s.startAttempt(a1, exam.id);
  const ctx = { ...a1, ip: '10.0.0.5', ua: 'TestBrowser' };
  const r1 = await s.recordViolation(ctx, at.id, { type: 'TAB_SWITCH', description: 'hidden' });
  const r2 = await s.recordViolation(ctx, at.id, { type: 'FULLSCREEN_EXIT' });
  assert.deepEqual([r1.action, r2.action, r2.count], ['WARNING', 'WARNING', 2]);
  const r3 = await s.recordViolation(ctx, at.id, { type: 'COPY_ATTEMPT' });
  assert.deepEqual([r3.action, r3.count], ['FLAGGED', 3]);
  for (const type of ['PASTE_ATTEMPT', 'CUT_ATTEMPT', 'RIGHT_CLICK', 'SUSPICIOUS_KEYBOARD_EVENT'])
    await s.recordViolation(ctx, at.id, { type });
  await rejects(s.recordViolation(ctx, at.id, { type: 'MADE_UP' }), 'VALIDATION');
  const v: any = s.db.prepare("SELECT * FROM violations WHERE type='TAB_SWITCH'").get();
  assert.equal(v.ip, '10.0.0.5'); assert.equal(v.user_agent, 'TestBrowser'); assert.equal(v.severity, 'MEDIUM');
  assert.equal((s.startAttempt(a1, exam.id)).suspicious, true);                       // attempt flagged, NOT failed
  assert.equal(s.securitySummary().totalViolations, 7);
  assert.equal(s.securitySummary().suspiciousSessions, 1);
  assert.equal(s.listAudit({ action: 'SUSPICIOUS_ACTIVITY' }).length, 1);
  assert.ok(s.listNotifications(admin).some((n: any) => n.title === 'Suspicious exam session'));
});
test('security: configurable policy (WARN_ONLY never flags, AUTO_SUBMIT submits)', async () => {
  const w = await setup({ violationPolicy: 'WARN_ONLY', maxViolations: 1 });
  const aw = w.s.startAttempt(w.a1, w.exam.id);
  assert.equal((await w.s.recordViolation(w.a1, aw.id, { type: 'TAB_SWITCH' })).action, 'WARNING');
  assert.equal(w.s.startAttempt(w.a1, w.exam.id).suspicious, false);
  const x = await setup({ violationPolicy: 'AUTO_SUBMIT', maxViolations: 2 });
  const ax = x.s.startAttempt(x.a1, x.exam.id);
  await x.s.recordViolation(x.a1, ax.id, { type: 'TAB_SWITCH' });
  assert.equal((await x.s.recordViolation(x.a1, ax.id, { type: 'TAB_SWITCH' })).action, 'AUTO_SUBMITTED');
  await rejects(x.s.saveAnswer(x.a1, ax.id, x.q[0], 'A', 1), 'ATTEMPT_CLOSED');
  await rejects(x.s.recordViolation(x.a1, ax.id, { type: 'TAB_SWITCH' }), 'ATTEMPT_CLOSED');
});

// ---------------- Blockchain integrity ----------------
test('blockchain: hash creation, verification, and tamper detection', async () => {
  const { s, admin, f, f2, a1, exam, q } = await setup();
  const at = s.startAttempt(a1, exam.id);
  await s.saveAnswer(a1, at.id, q[0], 'B', 1); await s.submitAttempt(a1, at.id);
  const h1 = s.computeHash(at.id);
  assert.match(h1, /^[0-9a-f]{64}$/); assert.equal(h1, s.computeHash(at.id));          // deterministic
  const ok = await s.verifyIntegrity(admin, at.id);
  assert.equal(ok.verified, true); assert.equal(ok.verdict, 'INTEGRITY VERIFIED'); assert.equal(ok.recalculatedHash, ok.storedHash);
  assert.ok(ok.txRef.startsWith('0x'));
  assert.equal((await s.verifyIntegrity(f, at.id)).verified, true);                    // owning faculty
  await rejects(s.verifyIntegrity(f2, at.id), 'NOT_FOUND');                            // other faculty
  s.db.prepare('UPDATE results SET score = 10 WHERE attempt_id=?').run(at.id);         // DB tampering
  const bad = await s.verifyIntegrity(admin, at.id);
  assert.equal(bad.verified, false); assert.equal(bad.verdict, 'INTEGRITY MISMATCH'); assert.notEqual(bad.recalculatedHash, bad.storedHash);
  assert.ok(s.listAudit({ severity: 'CRITICAL' }).length === 1);
});
test('blockchain: ledger tampering and re-anchoring after evaluation', async () => {
  const { s, admin, f, a1, exam, q } = await setup();
  const at = s.startAttempt(a1, exam.id);
  await s.saveAnswer(a1, at.id, q[3], 'text', 1); await s.submitAttempt(a1, at.id);
  await s.evaluate(f, at.id, { [q[3]]: 2 });
  assert.equal((s.db.prepare('SELECT COUNT(*) c FROM blockchain_records').get() as any).c, 2);
  assert.equal((await s.verifyIntegrity(admin, at.id)).verified, true);                // latest version verifies
  s.db.prepare("UPDATE ledger SET payload_hash = 'deadbeef' WHERE idx = 0").run();                // tamper the chain
  const bad = await s.verifyIntegrity(admin, at.id);
  assert.equal(bad.verified, false);
});

// ---------------- Seed ----------------
test('seed: demo data loads and demo users can log in', async () => {
  const s = createSems(); await seed(s);
  assert.equal(s.login('admin@example.com', P).user.mustChangePassword, true);
  const st = s.authenticate(s.login('student@example.com', P).token);
  assert.equal(s.listStudentExams(st).length, 1);                                       // draft exam hidden from students
});

test('seed: stale demo exam is re-opened for local testing, but never once attempted', async () => {
  let t = Date.now(); const s = createSems({ now: () => new Date(t) }); const seeded = await seed(s);
  assert.equal(refreshDemoExam(s), false);                                   // still open: untouched
  t += 2 * 86_400_000;                                                       // two days later the window has closed
  const stu = { id: seeded.stu.id, role: 'STUDENT' as const };
  assert.throws(() => s.startAttempt(stu, seeded.examId), (e: any) => e.code === 'EXAM_WINDOW_CLOSED');
  assert.equal(refreshDemoExam(s), true);
  assert.ok(s.startAttempt(stu, seeded.examId).id);                          // startable again
  t += 2 * 86_400_000;
  assert.equal(refreshDemoExam(s), false);                                   // has an attempt now: never rewritten
});
