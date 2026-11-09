import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSems, AppError } from '../src/service.ts';
import { createExtras, sanitizeFilename } from '../src/extras.ts';
import { createHttpServer } from '../src/http.ts';
import { totp, verifyTotp } from '../src/security.ts';

const P = 'Demo@12345!';
const rejects = (p: Promise<any> | (() => any), code: string) =>
  assert.rejects(async () => (typeof p === 'function' ? p() : p), (e: any) => e instanceof AppError && e.code === code);

function setup() {
  let t = Date.parse('2026-10-07T10:00:00Z');
  const s = createSems({ now: () => new Date(t) });
  const uploads = mkdtempSync(join(tmpdir(), 'sems-up-'));
  const x = createExtras(s, { uploadDir: uploads });
  const mk = (e: string, r: any) => s.createUser(null, { email: e, name: e, role: r, password: P });
  const A = (u: any) => ({ id: u.id, role: u.role } as any);
  const admin = A(mk('a@x.com', 'ADMIN')), fac = A(mk('f@x.com', 'FACULTY')), fac2 = A(mk('f2@x.com', 'FACULTY'));
  const cs = A(mk('cs@x.com', 'STUDENT')), ee = A(mk('ee@x.com', 'STUDENT')), absent = A(mk('ab@x.com', 'STUDENT'));
  x.setProfile(admin, cs.id, { department: 'CS', className: 'Y2' }); x.setProfile(admin, ee.id, { department: 'EE', className: 'Y2' });
  return { s, x, uploads, admin, fac, fac2, cs, ee, absent, advance: (ms: number) => { t += ms; } };
}
const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
const PDF = Buffer.from('%PDF-1.4 hello');

test('totp: RFC 6238 vector, window, and MFA-gated login', async () => {
  assert.equal(totp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000), '287082');           // RFC test vector (last 6 digits)
  const { s, admin } = setup();
  const { secret } = s.mfaSetup(admin);
  await rejects(() => s.login('a@x.com', P, {}, '000000') && s.mfaEnable(admin, '000000'), 'MFA_INVALID');
  s.mfaEnable(admin, totp(secret, s.now().getTime()));
  await rejects(() => s.login('a@x.com', P), 'MFA_REQUIRED');
  await rejects(() => s.login('a@x.com', P, {}, '123456'), 'MFA_REQUIRED');
  assert.equal(s.login('a@x.com', P, {}, totp(secret, s.now().getTime())).user.role, 'ADMIN');
  assert.equal(verifyTotp(secret, totp(secret, s.now().getTime() - 120_000), s.now().getTime()), false);   // stale code
});

test('notices: targeting, schedule, expiry and notifications', () => {
  const { s, x, fac, cs, ee, advance } = setup();
  x.createNotice(fac, { title: 'CS only', message: 'hello', department: 'CS' });
  x.createNotice(fac, { title: 'Everyone', message: 'hi' });
  x.createNotice(fac, { title: 'Later', message: 'future', publishAt: '2026-10-07T12:00:00Z' });
  x.createNotice(fac, { title: 'Short', message: 'brief', expiresAt: '2026-10-07T10:30:00Z' });
  assert.deepEqual(x.listNotices(cs).map((n: any) => n.title).sort(), ['CS only', 'Everyone', 'Short']);
  assert.deepEqual(x.listNotices(ee).map((n: any) => n.title).sort(), ['Everyone', 'Short']);
  assert.ok(s.listNotifications(cs).some((n: any) => n.title === 'Notice: CS only'));
  assert.ok(!s.listNotifications(ee).some((n: any) => n.title === 'Notice: CS only'));
  advance(3 * 3600_000);
  assert.deepEqual(x.listNotices(cs).map((n: any) => n.title).sort(), ['CS only', 'Everyone', 'Later']);
  assert.throws(() => x.createNotice(fac, { title: '', message: 'x' }), (e: any) => e.code === 'VALIDATION');
});

test('resources: upload validation (type, content sniffing, size, names)', async () => {
  const { x, fac, uploads } = setup();
  const up = (filename: string, content: Buffer | string, extra: any = {}) =>
    x.uploadResource(fac, { title: 't', filename, contentBase64: b64(content), ...extra });
  const ok = up('notes.pdf', PDF); assert.equal(ok.mime, 'application/pdf');
  assert.throws(() => up('evil.exe', PDF), (e: any) => e.code === 'FILE_TYPE_NOT_ALLOWED');
  assert.throws(() => up('evil.pdf.exe', PDF), (e: any) => e.code === 'FILE_TYPE_NOT_ALLOWED');
  assert.throws(() => up('noext', PDF), (e: any) => e.code === 'FILE_TYPE_NOT_ALLOWED');
  assert.throws(() => up('fake.pdf', Buffer.concat([Buffer.from('MZ'), Buffer.alloc(50)])), (e: any) => e.code === 'FILE_CONTENT_MISMATCH');
  assert.throws(() => up('script.txt', '#!/bin/sh\nrm -rf /'), (e: any) => e.code === 'FILE_CONTENT_MISMATCH');
  assert.throws(() => up('photo.pdf', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0])), (e: any) => e.code === 'FILE_CONTENT_MISMATCH');
  assert.throws(() => up('doc.docx', 'PK\x03\x04 no content types'), (e: any) => e.code === 'FILE_CONTENT_MISMATCH');
  assert.equal(up('real.docx', 'PK\x03\x04[Content_Types].xml word/document.xml').mime.includes('wordprocessingml'), true);
  assert.throws(() => up('big.pdf', Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)])), (e: any) => e.code === 'FILE_TOO_LARGE');
  assert.equal(up('../../etc/pass wd.pdf', PDF).name, 'pass wd.pdf');
  assert.equal(sanitizeFilename('..\\..\\x<script>.pdf'), 'x_script_.pdf');
  assert.ok(readdirSync(uploads).every((f) => /^[0-9a-f-]{36}\.bin$/.test(f)));        // stored names are server-generated only
});

test('resources: download authorisation, targeting, expiry, deletion', () => {
  const { x, fac, fac2, admin, cs, ee, advance } = setup();
  const r = x.uploadResource(fac, { title: 'CS slides', filename: 'a.pdf', contentBase64: b64(PDF), department: 'CS', expiresAt: '2026-10-08T10:00:00Z' });
  const dl: any = x.downloadResource(cs, r.id);
  assert.equal(dl.__file.buffer.toString(), PDF.toString());
  assert.throws(() => x.downloadResource(ee, r.id), (e: any) => e.code === 'NOT_FOUND');   // other department
  assert.equal(x.listResources(ee).length, 0); assert.equal(x.listResources(cs).length, 1);
  assert.ok(x.downloadResource(fac, r.id) && x.downloadResource(admin, r.id));
  assert.throws(() => x.deleteResource(fac2, r.id), (e: any) => e.code === 'NOT_FOUND');   // not the uploader
  advance(25 * 3600_000);
  assert.throws(() => x.downloadResource(cs, r.id), (e: any) => e.code === 'NOT_FOUND');   // expired
  x.deleteResource(fac, r.id); assert.throws(() => x.downloadResource(fac, r.id), (e: any) => e.code === 'NOT_FOUND');
});

test('question bank: validate, search, filter, ownership, import, soft delete', () => {
  const { s, x, fac, fac2 } = setup();
  const opts = [{ id: 'A', text: 'x' }, { id: 'B', text: 'y' }];
  const q1 = x.bankAdd(fac, { type: 'MCQ', text: 'What is 50% of 10_0?', options: opts, correct: 'A', marks: 2, difficulty: 'EASY', topic: 'math' }).id;
  x.bankAdd(fac, { type: 'TF', text: 'Sky is blue', correct: 'true', marks: 1, difficulty: 'HARD', topic: 'misc' });
  assert.throws(() => x.bankAdd(fac, { type: 'MCQ', text: 'bad', options: opts, correct: 'Z', marks: 1 }), (e: any) => e.code === 'VALIDATION');
  assert.equal(x.bankList(fac).length, 2);
  assert.equal(x.bankList(fac, { q: 'blue' }).length, 1);
  assert.equal(x.bankList(fac, { q: '%' }).length, 1);                                    // literal match only: an unescaped wildcard would match 2
  assert.equal(x.bankList(fac, { q: '_' }).length, 1);
  assert.equal(x.bankList(fac, { q: "'; DROP TABLE users;--" }).length, 0);
  assert.equal(x.bankList(fac, { difficulty: 'EASY' }).length, 1);
  assert.equal(x.bankList(fac2).length, 0);                                               // other faculty sees nothing
  assert.throws(() => x.bankUpdate(fac2, q1, { type: 'TF', text: 'h', correct: 'true', marks: 1 }), (e: any) => e.code === 'NOT_FOUND');
  const exam = s.createExam(fac, { title: 'E', subject: 'S', startAt: '2026-10-08T00:00:00Z', durationMin: 5 });
  assert.equal(x.bankImport(fac, exam.id, [q1]).length, 1);
  assert.equal((s.db.prepare('SELECT COUNT(*) c FROM questions WHERE exam_id=?').get(exam.id) as any).c, 1);
  x.bankDelete(fac, q1); assert.equal(x.bankList(fac).length, 1);
});

test('reports and dashboards', async () => {
  const { s, x, fac, admin, cs, ee, absent } = setup();
  const exam = s.createExam(fac, { title: 'R', subject: 'S', startAt: '2026-10-07T10:00:00Z', durationMin: 30, passMarks: 2 });
  const q = s.addQuestion(fac, exam.id, { type: 'MCQ', text: 'q', options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }], correct: 'A', marks: 4 }).id;
  s.setExamStatus(fac, exam.id, 'SCHEDULED');
  for (const [st, ans] of [[cs, 'A'], [ee, 'B']] as any) {
    const at = s.startAttempt(st, exam.id); await s.saveAnswer(st, at.id, q, ans, 1); await s.submitAttempt(st, at.id);
  }
  const rep = x.examReport(fac, exam.id);
  assert.deepEqual([rep.enrolled, rep.participated, rep.highest, rep.lowest, rep.average, rep.passPercentage], [3, 2, 4, 0, 2, 50]);
  assert.deepEqual(rep.absent, [{ id: absent.id, name: 'ab@x.com' }]);
  assert.equal(rep.questionPerformance[0].correctRate, 50);
  assert.throws(() => x.examReport({ id: 'other', role: 'FACULTY' } as any, exam.id), (e: any) => e.code === 'NOT_FOUND');
  const d: any = x.dashboard(admin); assert.equal(d.students, 3); assert.equal(d.faculty, 2);
  assert.equal((x.dashboard(fac) as any).participation, 2);
  assert.equal((x.dashboard(cs) as any).recentResults.length, 0);
  x.createCatalog(admin, 'DEPARTMENT', 'CS');
  assert.throws(() => x.createCatalog(admin, 'DEPARTMENT', 'CS'), (e: any) => e.code === 'EXISTS');
});

test('http: upload/download enforce roles and send safe headers', async () => {
  const { s, x } = setup();
  const srv = createHttpServer(s, x).listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = (m: string, p: string, tok?: string, body?: any) => fetch(base + p, { method: m,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const tok = async (e: string) => ((await (await call('POST', '/api/auth/login', undefined, { email: e, password: P })).json()) as any).data.token;
  const [tf, tc, te] = [await tok('f@x.com'), await tok('cs@x.com'), await tok('ee@x.com')];
  try {
    assert.equal((await call('POST', '/api/faculty/resources', tc, { title: 't', filename: 'a.pdf', contentBase64: b64(PDF) })).status, 403);
    const up = await call('POST', '/api/faculty/resources', tf, { title: 'x', filename: 'a.pdf', contentBase64: b64(PDF), department: 'CS' });
    assert.equal(up.status, 200); const id = ((await up.json()) as any).data.id;
    const bad = await call('POST', '/api/faculty/resources', tf, { title: 'x', filename: 'a.exe', contentBase64: b64(PDF) });
    assert.equal(bad.status, 415);
    const dl = await call('GET', `/api/resources/${id}/download`, tc);
    assert.equal(dl.status, 200); assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
    assert.match(dl.headers.get('content-disposition')!, /attachment/); assert.equal(Buffer.from(await dl.arrayBuffer()).toString(), PDF.toString());
    assert.equal((await call('GET', `/api/resources/${id}/download`, te)).status, 404);
    assert.equal((await call('GET', `/api/resources/${id}/download`)).status, 401);
    assert.equal((await call('GET', '/api/faculty/bank', tc)).status, 403);
    assert.equal((await call('GET', '/api/dashboard', tc)).status, 200);
  } finally { srv.close(); }
});
