import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSems, AppError } from '../src/service.ts';
import { createExtras } from '../src/extras.ts';
import { createHttpServer } from '../src/http.ts';

const P = 'Demo@12345!';
const rejects = (p: any, code: string) => assert.rejects(async () => (typeof p === 'function' ? p() : p), (e: any) => e instanceof AppError && e.code === code);
const A = (u: any) => ({ id: u.id, role: u.role } as any);

function world(examOpts: any = {}, nStudents = 6) {
  let t = Date.parse('2026-10-07T10:00:00Z');
  const s = createSems({ now: () => new Date(t) }), x = createExtras(s, { uploadDir: mkdtempSync(join(tmpdir(), 'f-')) });
  const mk = (e: string, r: any) => A(s.createUser(null, { email: e, name: e, role: r, password: P }));
  const admin = mk('a@x.com', 'ADMIN'), fac = mk('f@x.com', 'FACULTY'), students = Array.from({ length: nStudents }, (_, i) => mk(`s${i}@x.com`, 'STUDENT'));
  const exam = s.createExam(fac, { title: 'E', subject: 'S', startAt: new Date(t).toISOString(), durationMin: 60, passMarks: 2, negativeMarking: true, maxViolations: 3, ...examOpts });
  const ids: string[] = [], opts = [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }, { id: 'C', text: 'c' }, { id: 'D', text: 'd' }];
  for (let i = 0; i < 8; i++) ids.push(s.addQuestion(fac, exam.id, { type: 'MCQ', text: `Q${i + 1}`, options: opts, correct: 'B', marks: 1, negMarks: 0.25 }).id);
  const essay = s.addQuestion(fac, exam.id, { type: 'LONG', text: 'Explain hashing', marks: 4, keywords: ['Collision', ' bucket ', 'hash function'] }).id;
  s.setExamStatus(fac, exam.id, 'SCHEDULED');
  return { s, x, admin, fac, students, exam, ids, essay, advance: (ms: number) => { t += ms; } };
}

test('randomisation: stable per student, different across students, answers still grade correctly', async () => {
  const w = world();
  const orders: string[] = [], optionOrders: string[] = [];
  for (const st of w.students) {
    const at = w.s.startAttempt(st, w.exam.id), v1 = await w.s.getAttemptView(st, at.id), v2 = await w.s.getAttemptView(st, at.id);
    assert.deepEqual(v1.questions.map((q: any) => q.id), v2.questions.map((q: any) => q.id));            // stable across reloads
    orders.push(v1.questions.map((q: any) => q.id).join()); optionOrders.push(v1.questions[0].options?.map((o: any) => o.id).join() ?? '');
    assert.equal(v1.questions.length, 9);
  }
  assert.ok(new Set(orders).size >= 4, 'question order should differ between students');               // 9! orderings: collisions are astronomically unlikely
  assert.ok(new Set(optionOrders).size >= 2, 'option order should differ too');
  // grading is by option id, so a shuffled view still scores right
  const st = w.students[0], at = w.s.startAttempt(st, w.exam.id);
  await w.s.saveAnswer(st, at.id, w.ids[0], 'B', 1); await w.s.saveAnswer(st, at.id, w.ids[1], 'A', 2);
  await w.s.submitAttempt(st, at.id);
  const r: any = w.s.db.prepare('SELECT * FROM results WHERE attempt_id=?').get(at.id);
  assert.deepEqual([r.correct, r.incorrect, r.score], [1, 1, 0.75]);
  const off = world({ randomize: false });                                                              // opt-out keeps authored order
  const at2 = off.s.startAttempt(off.students[0], off.exam.id);
  assert.deepEqual((await off.s.getAttemptView(off.students[0], at2.id)).questions.map((q: any) => q.text).slice(0, 3), ['Q1', 'Q2', 'Q3']);
  assert.equal(off.s.examInfo(off.students[0], off.exam.id).randomize, false);
});

test('risk analysis: explainable score, burst and rapid-answering signals, advisory flagging', async () => {
  const w = world(); const st = w.students[0], at = w.s.startAttempt(st, w.exam.id);
  assert.deepEqual(w.s.riskAssessment(at.id), { score: 0, level: 'LOW', signals: [] });
  await w.s.recordViolation(st, at.id, { type: 'TAB_SWITCH' });
  w.advance(120_000);
  await w.s.recordViolation(st, at.id, { type: 'RIGHT_CLICK' }); await w.s.recordViolation(st, at.id, { type: 'RIGHT_CLICK' });
  let r = w.s.riskAssessment(at.id); assert.equal(r.score, 10 + 4); assert.equal(r.level, 'LOW'); assert.ok(!r.signals.some((x) => x.code === 'BURST'));
  await w.s.recordViolation(st, at.id, { type: 'COPY_ATTEMPT' });                                       // 3 events within 60 s -> burst
  r = w.s.riskAssessment(at.id); assert.ok(r.signals.some((x) => x.code === 'BURST')); assert.equal(r.score, 10 + 4 + 8 + 15); assert.equal(r.level, 'MEDIUM');
  assert.ok(r.signals.every((x) => x.points > 0 && x.detail));                                          // every point is explained
  // signal-only events raise risk but never count toward the policy threshold (network blips cannot auto-submit)
  const w2 = world({ violationPolicy: 'AUTO_SUBMIT', maxViolations: 2 }); const s2 = w2.students[0], a2 = w2.s.startAttempt(s2, w2.exam.id);
  for (let i = 0; i < 3; i++) assert.equal((await w2.s.recordViolation(s2, a2.id, { type: 'HEARTBEAT_GAP' })).action, 'SIGNAL_RECORDED');
  assert.equal(w2.s.startAttempt(s2, w2.exam.id).status, 'IN_PROGRESS');
  // enough combined weak signals flag the attempt for review (still not failed), but WARN_ONLY exams are never flagged
  const w3 = world({ maxViolations: 99 }); const s3 = w3.students[0], a3 = w3.s.startAttempt(s3, w3.exam.id);
  let last: any; for (const type of ['CAMERA_UNAVAILABLE', 'CAMERA_COVERED', 'HEARTBEAT_GAP', 'TAB_SWITCH', 'FULLSCREEN_EXIT']) last = await w3.s.recordViolation(s3, a3.id, { type });
  assert.equal(w3.s.startAttempt(s3, w3.exam.id).suspicious, true); assert.equal(last.action, 'FLAGGED');
  assert.ok(w3.s.listAudit({ action: 'SUSPICIOUS_ACTIVITY' }).some((a: any) => JSON.parse(a.metadata).reason === 'risk_score'));
  const w4 = world({ violationPolicy: 'WARN_ONLY', maxViolations: 99 }); const s4 = w4.students[0], a4 = w4.s.startAttempt(s4, w4.exam.id);
  for (let i = 0; i < 8; i++) await w4.s.recordViolation(s4, a4.id, { type: 'TAB_SWITCH' });
  assert.equal(w4.s.startAttempt(s4, w4.exam.id).suspicious, false);
  // rapid answering after submission
  const w5 = world(); const s5 = w5.students[0], a5 = w5.s.startAttempt(s5, w5.exam.id);
  for (const [i, q] of w5.ids.slice(0, 6).entries()) await w5.s.saveAnswer(s5, a5.id, q, 'A', i);
  await w5.s.submitAttempt(s5, a5.id);
  assert.ok(w5.s.riskAssessment(a5.id).signals.some((x) => x.code === 'RAPID_ANSWERING'));
});

test('heartbeat: records a gap only after a long silence and returns server time for re-sync', async () => {
  const w = world(); const st = w.students[0], at = w.s.startAttempt(st, w.exam.id);
  const first = await w.s.heartbeat(st, at.id); assert.equal(first.status, 'IN_PROGRESS');
  w.advance(10_000); await w.s.heartbeat(st, at.id);
  assert.equal((w.s.db.prepare("SELECT COUNT(*) c FROM violations WHERE type='HEARTBEAT_GAP'").get() as any).c, 0);
  w.advance(45_000); const hb = await w.s.heartbeat(st, at.id);
  const v: any = w.s.db.prepare("SELECT * FROM violations WHERE type='HEARTBEAT_GAP'").get(); assert.match(v.description, /45 s/); assert.equal(v.severity, 'LOW');
  assert.equal(hb.remainingSeconds, 3600 - 55);
  await w.s.submitAttempt(st, at.id); assert.equal((await w.s.heartbeat(st, at.id)).status, 'SUBMITTED');
  await rejects(w.s.heartbeat(w.students[1], at.id), 'NOT_FOUND');                                      // not your attempt
  await rejects(w.s.recordViolation(st, at.id, { type: 'CAMERA_COVERED' }), 'ATTEMPT_CLOSED');
});

test('subjective grading: keyword hints, comments, queue, next-pending, validation', async () => {
  const w = world({ publishImmediately: true });
  const mkAttempt = async (st: any, text: string) => { const at = w.s.startAttempt(st, w.exam.id); await w.s.saveAnswer(st, at.id, w.essay, text, 1); await w.s.saveAnswer(st, at.id, w.ids[0], 'B', 2); await w.s.submitAttempt(st, at.id); return at.id; };
  const a1 = await mkAttempt(w.students[0], 'A hash function maps keys to a bucket; a Collision happens when two keys share one.');
  const a2 = await mkAttempt(w.students[1], 'It is a thing.');
  const q = (await w.x.examDetail(w.fac, w.exam.id)).questions.find((k: any) => k.id === w.essay)!; assert.deepEqual(q.keywords, ['collision', 'bucket', 'hash function']);
  assert.throws(() => w.s.normalizeQuestion({ type: 'SHORT', text: 't', marks: 1, keywords: new Array(25).fill('k') }), (e: any) => e.code === 'VALIDATION');
  const d1: any = w.x.submissionDetail(w.fac, a1), e1 = d1.questions.find((k: any) => k.id === w.essay);
  assert.deepEqual(e1.keywordHits.found.sort(), ['bucket', 'collision', 'hash function']); assert.equal(e1.keywordHits.missing.length, 0); assert.equal(e1.wordCount, 16);
  const e2: any = w.x.submissionDetail(w.fac, a2).questions.find((k: any) => k.id === w.essay); assert.equal(e2.keywordHits.found.length, 0); assert.equal(e2.keywordHits.missing.length, 3);
  assert.ok(d1.nextPendingAttemptId === a2);                                                             // "save & next" target
  const queue = w.x.pendingEvaluations(w.fac); assert.deepEqual(queue.map((r: any) => [r.attempt_id, r.pending]).sort(), [[a1, 1], [a2, 1]].sort());
  assert.equal(w.x.pendingEvaluations(w.admin).length, 2); assert.equal(w.x.pendingEvaluations({ id: 'other', role: 'FACULTY' } as any).length, 0);
  assert.equal(w.x.listSubmissions(w.fac, w.exam.id).every((r: any) => r.risk_level === 'LOW' && r.risk_score === 0), true);
  await rejects(w.s.evaluate(w.fac, a1, { [w.essay]: { marks: 9, comment: 'x' } }), 'VALIDATION');
  await w.s.evaluate(w.fac, a1, { [w.essay]: { marks: 3.5, comment: 'Good use of terminology' } }, 'Well done');
  assert.equal(w.x.submissionDetail(w.fac, a1).questions.find((k: any) => k.id === w.essay)?.comment, 'Good use of terminology');
  await w.s.evaluate(w.fac, a1, { [w.essay]: 3.5 });                                                     // legacy numeric form keeps the comment
  assert.equal(w.x.submissionDetail(w.fac, a1).questions.find((k: any) => k.id === w.essay)?.comment, 'Good use of terminology');
  assert.deepEqual(w.x.pendingEvaluations(w.fac).map((r: any) => r.attempt_id), [a2]);
  assert.equal((await w.s.verifyIntegrity(w.admin, a1)).verified, true);
});

test('result review: per-question detail only when the exam allows it; subjective feedback always', async () => {
  for (const showAnswers of [false, true]) {
    const w = world({ publishImmediately: false, showAnswers }); const st = w.students[0], at = w.s.startAttempt(st, w.exam.id);
    await w.s.saveAnswer(st, at.id, w.ids[0], 'B', 1); await w.s.saveAnswer(st, at.id, w.ids[1], 'C', 2); await w.s.saveAnswer(st, at.id, w.essay, 'text', 3);
    await w.s.submitAttempt(st, at.id);
    assert.deepEqual(w.s.studentReview(st, at.id), { published: false });                                // nothing before publication
    await w.s.evaluate(w.fac, at.id, { [w.essay]: { marks: 2, comment: 'ok' } }); w.s.publishResults(w.fac, w.exam.id, P);
    const rv: any = w.s.studentReview(st, at.id); assert.equal(rv.published, true); assert.equal(rv.showAnswers, showAnswers);
    const essay = rv.questions.find((q: any) => q.id === w.essay); assert.deepEqual([essay.awarded, essay.comment, essay.status], [2, 'ok', 'MARKED']);
    if (showAnswers) {
      assert.equal(rv.questions.length, 9);
      const right = rv.questions.find((q: any) => q.id === w.ids[0]), wrong = rv.questions.find((q: any) => q.id === w.ids[1]), blank = rv.questions.find((q: any) => q.id === w.ids[2]);
      assert.deepEqual([right.status, right.awarded, right.correct], ['CORRECT', 1, 'B']); assert.deepEqual([wrong.status, wrong.awarded, wrong.correct], ['INCORRECT', -0.25, 'B']);
      assert.deepEqual([blank.status, blank.awarded], ['UNANSWERED', 0]);
    } else { assert.equal(rv.questions.length, 1); assert.ok(!JSON.stringify(rv).includes('"correct"')); }   // no answer-key leakage
    await rejects(() => w.s.studentReview(w.students[1], at.id), 'NOT_FOUND');                           // other students cannot read it
  }
});

test('http: new routes enforce roles and ownership', async () => {
  const w = world({ publishImmediately: true }); const st = w.students[0], at = w.s.startAttempt(st, w.exam.id); await w.s.submitAttempt(st, at.id);
  const srv = createHttpServer(w.s, w.x).listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (m: string, p: string, email: string, body?: any) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${w.s.login(email, P).token}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: (await r.json()) as any }; };
  try {
    assert.equal((await call('POST', `/api/student/attempts/${at.id}/heartbeat`, 's0@x.com')).status, 200);
    assert.equal((await call('POST', `/api/student/attempts/${at.id}/heartbeat`, 's1@x.com')).status, 404);
    assert.equal((await call('POST', `/api/student/attempts/${at.id}/heartbeat`, 'f@x.com')).status, 403);
    assert.equal((await call('GET', `/api/student/results/${at.id}/review`, 's0@x.com')).status, 200);
    assert.equal((await call('GET', `/api/student/results/${at.id}/review`, 's1@x.com')).status, 404);
    assert.equal((await call('GET', '/api/faculty/pending-evaluations', 's0@x.com')).status, 403);
    assert.equal((await call('GET', '/api/faculty/pending-evaluations', 'f@x.com')).status, 200);
    assert.equal((await call('GET', '/api/admin/audit/verify', 'f@x.com')).status, 403);
    const v = await call('GET', '/api/admin/audit/verify', 'a@x.com'); assert.equal(v.status, 200); assert.equal(v.j.data.valid, true);
    const sub = await call('GET', `/api/faculty/exams/${w.exam.id}/submissions`, 'f@x.com'); assert.equal(sub.j.data[0].risk_level, 'LOW');
  } finally { srv.close(); }
});
