import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSems } from '../src/service.ts';
import { createExtras } from '../src/extras.ts';
import { createHttpServer } from '../src/http.ts';

// One complete real-world lifecycle driven ONLY through the public HTTP API (plus a deliberate DB tamper at the end).
test('e2e: admin onboarding -> exam -> attempt -> grading -> publish -> integrity -> suspension', async () => {
  const s = createSems(); const x = createExtras(s, { uploadDir: mkdtempSync(join(tmpdir(), 'e2e-')) });
  const adminPw = 'Admin@Pass123!'; s.createUser(null, { email: 'root@x.com', name: 'Root', role: 'ADMIN', password: adminPw });
  const srv = createHttpServer(s, x).listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const api = async (m: string, p: string, t?: string, body?: any) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body ? JSON.stringify(body) : undefined }); const j: any = await r.json(); return { status: r.status, d: j.data, code: j.errorCode }; };
  const login = async (email: string, password: string) => (await api('POST', '/api/auth/login', undefined, { email, password })).d.token as string;
  try {
    const A = await login('root@x.com', adminPw), tmp = 'Temp@Pass1234!', real = 'Real@Pass1234!';
    // 1. onboarding
    const fac = (await api('POST', '/api/admin/users', A, { name: 'Prof', email: 'prof@x.com', role: 'FACULTY', password: tmp })).d;
    const s1 = (await api('POST', '/api/admin/users', A, { name: 'Alice', email: 'alice@x.com', role: 'STUDENT', password: tmp })).d;
    const s2 = (await api('POST', '/api/admin/users', A, { name: 'Bob', email: 'bob@x.com', role: 'STUDENT', password: tmp })).d;
    assert.equal(s1.mustChangePassword, true);
    assert.equal((await api('PUT', `/api/admin/users/${s1.id}/profile`, A, { department: 'CS', className: 'Y1' })).status, 200);
    const F = await login('prof@x.com', tmp), T1 = await login('alice@x.com', tmp), T2 = await login('bob@x.com', tmp);
    assert.equal((await api('POST', '/api/auth/change-password', T1, { oldPassword: tmp, newPassword: 'weak' })).code, 'WEAK_PASSWORD');
    assert.equal((await api('POST', '/api/auth/change-password', F, { oldPassword: tmp, newPassword: real })).status, 200);
    // 2. faculty builds the exam
    const exam = (await api('POST', '/api/faculty/exams', F, { title: 'Final', subject: 'CS', startAt: new Date(Date.now() - 1000).toISOString(), durationMin: 30, passMarks: 3,
      negativeMarking: true, maxViolations: 2, violationPolicy: 'FLAG', publishImmediately: false })).d;
    const add = (b: any) => api('POST', `/api/faculty/exams/${exam.id}/questions`, F, b);
    const q1 = (await add({ type: 'MCQ', text: 'Pick B', options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }], correct: 'B', marks: 2, negMarks: 0.5 })).d.id;
    const q2 = (await add({ type: 'TF', text: 'Sky is blue', correct: 'true', marks: 1, negMarks: 0.25 })).d.id;
    const q3 = (await add({ type: 'SHORT', text: 'Explain', marks: 4 })).d.id;
    assert.equal((await api('GET', '/api/student/exams', T1)).d.length, 0);                          // draft invisible
    assert.equal((await api('POST', `/api/student/exams/${exam.id}/start`, T1)).status, 404);
    assert.equal((await api('POST', `/api/faculty/exams/${exam.id}/status`, F, { status: 'LIVE' })).code, 'BAD_TRANSITION');   // must schedule first
    assert.equal((await api('POST', `/api/faculty/exams/${exam.id}/status`, F, { status: 'SCHEDULED' })).status, 200);
    assert.equal((await api('POST', `/api/faculty/exams/${exam.id}/questions`, F, { type: 'TF', text: 'late', correct: 'true', marks: 1 })).code, 'EXAM_LOCKED');
    // 3. student attempt
    assert.equal((await api('GET', '/api/student/exams', T1)).d.length, 1);
    const att = (await api('POST', `/api/student/exams/${exam.id}/start`, T1)).d;
    const view = (await api('GET', `/api/student/attempts/${att.id}`, T1)).d; assert.equal(view.questions.length, 3); assert.ok(!JSON.stringify(view).includes('"correct"'));
    const put = (q: string, answer: any, seq: number) => api('PUT', `/api/student/attempts/${att.id}/answers/${q}`, T1, { answer, seq });
    await put(q1, 'B', 1); await put(q2, 'false', 2); await put(q3, 'Because reasons', 3); await put(q1, 'B', 1);   // retry is harmless
    const v1 = (await api('POST', `/api/student/attempts/${att.id}/violations`, T1, { type: 'TAB_SWITCH' })).d;
    const v2 = (await api('POST', `/api/student/attempts/${att.id}/violations`, T1, { type: 'FULLSCREEN_EXIT' })).d;
    assert.deepEqual([v1.action, v2.action], ['WARNING', 'FLAGGED']);
    const sub = (await api('POST', `/api/student/attempts/${att.id}/submit`, T1)).d; assert.equal(sub.published, false);   // subjective pending
    assert.equal((await api('POST', `/api/student/attempts/${att.id}/submit`, T1)).code, 'ALREADY_SUBMITTED');
    assert.equal((await api('PUT', `/api/student/attempts/${att.id}/answers/${q1}`, T1, { answer: 'A', seq: 99 })).code, 'ATTEMPT_CLOSED');
    // 4. faculty evaluates, reports, publishes
    const subs = (await api('GET', `/api/faculty/exams/${exam.id}/submissions`, F)).d; assert.equal(subs.length, 1); assert.equal(subs[0].suspicious, 1);
    assert.equal((await api('POST', `/api/faculty/attempts/${att.id}/evaluate`, F, { marks: { [q3]: 3 }, remarks: 'Solid' })).d.score, 4.75);
    const rep = (await api('GET', `/api/faculty/exams/${exam.id}/report`, F)).d; assert.deepEqual([rep.participated, rep.enrolled, rep.absent.map((a: any) => a.name)], [1, 2, ['Bob']]);
    assert.equal((await api('GET', `/api/student/results/${att.id}`, T1)).d.published, false);       // evaluated but not yet published
    assert.equal((await api('POST', `/api/faculty/exams/${exam.id}/publish-results`, F, { password: 'wrong' })).code, 'REAUTH_REQUIRED');
    assert.equal((await api('POST', `/api/faculty/exams/${exam.id}/publish-results`, F, { password: real })).d.published, 1);
    // 5. student sees result; others cannot
    const res = (await api('GET', `/api/student/results/${att.id}`, T1)).d;
    assert.deepEqual([res.published, res.score, res.max_marks, res.percentage, res.passed, res.grade, res.remarks], [true, 4.75, 7, 67.86, true, 'D', 'Solid']);
    assert.equal((await api('GET', `/api/student/results/${att.id}`, T2)).status, 404);
    assert.ok((await api('GET', '/api/notifications', T1)).d.some((n: any) => n.title === 'Result published'));
    // 6. integrity, then tamper
    assert.equal((await api('GET', `/api/integrity/${att.id}`, A)).d.verified, true);
    s.db.prepare('UPDATE answers SET answer=? WHERE attempt_id=? AND question_id=?').run('"A"', att.id, q1);
    const bad = (await api('GET', `/api/integrity/${att.id}`, A)).d; assert.equal(bad.verified, false); assert.equal(bad.verdict, 'INTEGRITY MISMATCH');
    // 7. admin oversight: audit, security summary, suspension with re-auth
    const sec = (await api('GET', '/api/admin/security/summary', A)).d; assert.equal(sec.totalViolations, 2); assert.equal(sec.suspiciousSessions, 1);
    const actions = (await api('GET', '/api/admin/audit?limit=200', A)).d.map((a: any) => a.action);
    for (const a of ['USER_CREATED', 'LOGIN', 'EXAM_CREATED', 'EXAM_STARTED', 'EXAM_SUBMITTED', 'TAB_SWITCH', 'SUSPICIOUS_ACTIVITY', 'RESULT_PUBLISHED', 'PASSWORD_CHANGE', 'INTEGRITY_VERIFIED']) assert.ok(actions.includes(a), a);
    assert.equal((await api('POST', `/api/admin/users/${s2.id}/status`, A, { status: 'SUSPENDED', password: 'nope' })).code, 'REAUTH_REQUIRED');
    assert.equal((await api('POST', `/api/admin/users/${s2.id}/status`, A, { status: 'SUSPENDED', password: adminPw })).status, 200);
    assert.equal((await api('GET', '/api/student/exams', T2)).status, 401);                          // live token dies immediately
    assert.equal((await api('GET', '/api/admin/users?limit=2&offset=0', A)).d.length, 2);           // paging
    assert.equal((await api('GET', '/api/admin/users?limit=2&offset=2', A)).d.length, 2);
  } finally { srv.close(); }
});
