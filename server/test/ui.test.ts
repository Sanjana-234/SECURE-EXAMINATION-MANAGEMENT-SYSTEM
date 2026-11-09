import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSems } from '../src/service.ts';
import { createExtras } from '../src/extras.ts';
import { createHttpServer } from '../src/http.ts';
import { seed, DEMO_PASSWORD as P } from '../src/seed.ts';

// ---- minimal fake DOM: enough to execute the real client against the real API ----
class FNode { children: any[] = []; remove() {} }
class FText extends FNode { data: string; constructor(d: string) { super(); this.data = d; } }
class FEl extends FNode {
  tagName: string; className = ''; id = ''; attrs: Record<string, any> = {}; listeners: Record<string, Function[]> = {};
  value = ''; checked = false; hidden = false; disabled = false; files: any[] = []; style: any = {};
  constructor(t: string) { super(); this.tagName = t.toUpperCase(); }
  set textContent(v: string) { this.children = [new FText(String(v))]; }
  append(...k: any[]) { this.children.push(...k.map((x) => (x instanceof FNode ? x : new FText(String(x))))); }
  replaceChildren(...k: any[]) { this.children = k.map((x) => (x instanceof FNode ? x : new FText(String(x)))); }
  setAttribute(k: string, v: any) { this.attrs[k] = v; } addEventListener(t: string, f: Function) { (this.listeners[t] ??= []).push(f); }
  removeEventListener() {} focus() {} click() {} reset() {} querySelector() { return new FEl('button'); }
}
const textOf = (n: any): string => (n instanceof FText ? n.data : (n.children ?? []).map(textOf).join(' '));
const find = (n: any, pred: (e: FEl) => boolean, out: FEl[] = []): FEl[] => { if (n instanceof FEl && pred(n)) out.push(n); (n.children ?? []).forEach((c: any) => find(c, pred, out)); return out; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const realFetch = globalThis.fetch;
let base = '', appEl: FEl, handlers: Function[] = [], store = new Map<string, string>();
function installDom() {
  appEl = new FEl('div'); handlers = [];
  const toasts = new FEl('div');
  (globalThis as any).Node = FNode;
  (globalThis as any).document = { getElementById: (id: string) => (id === 'app' ? appEl : toasts), createElement: (t: string) => new FEl(t), createTextNode: (d: string) => new FText(d),
    body: new FEl('body'), documentElement: new FEl('html'), addEventListener() {}, removeEventListener() {}, hidden: false, fullscreenElement: null };
  (globalThis as any).window = { addEventListener: (t: string, f: Function) => t === 'hashchange' && handlers.push(f), removeEventListener() {} };
  (globalThis as any).location = { hash: '' };
  (globalThis as any).sessionStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v), clear: () => store.clear() };
  (globalThis as any).fetch = (u: string, o: any) => realFetch(base + u, o);
}
async function settle() { for (let i = 0; i < 60; i++) { await sleep(25); if (!textOf(appEl).includes('Loading')) break; } await sleep(30); }
async function visit(hash: string) { (globalThis as any).location.hash = hash; handlers[handlers.length - 1](); await settle(); }
const texts = (n: any, out: string[] = []): string[] => { if (n instanceof FText) out.push(n.data); (n.children ?? []).forEach((c: any) => texts(c, out)); return out; };
const errorsOnPage = () => [...find(appEl, (e) => e.className === 'err').map(textOf),
  ...texts(appEl).filter((t) => /^(false|NaN|undefined|null)$/.test(t.trim()) || /\[object|undefined/.test(t)).map((t) => 'stray text: ' + t)];   // classic DOM-building bugs

async function world() {
  const s = createSems(); const x = createExtras(s, { uploadDir: mkdtempSync(join(tmpdir(), 'ui-')) });
  const seeded = await seed(s);
  const stu = { id: seeded.stu.id, role: 'STUDENT' as const }, st2 = { id: s.listUsers('STUDENT')[1].id, role: 'STUDENT' as const };
  const at1 = s.startAttempt(stu, seeded.examId); const qs = (await s.getAttemptView(stu, at1.id)).questions;
  const byType = (t: string) => qs.find((q: any) => q.type === t)!.id;
  await s.saveAnswer(stu, at1.id, byType('MCQ'), 'B', 1); await s.saveAnswer(stu, at1.id, byType('SHORT'), 'a collision happens when...', 1); await s.submitAttempt(stu, at1.id);
  const at2 = s.startAttempt(st2, seeded.examId);
  x.createNotice({ id: seeded.fac.id, role: 'FACULTY' } as any, { title: 'Welcome', message: 'Hello class' });
  const srv = createHttpServer(s, x).listen(0); await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
  return { s, srv, seeded, at1: at1.id, at2: at2.id };
}
async function boot(s: any, email: string, tag: string) {
  const d = s.login(email, P); installDom(); store.clear();
  store.set('sems_token', d.token); store.set('sems_user', JSON.stringify(d.user));
  await import(`../public/app.js?${tag}`); await settle();
}

test('static: client is served with strict CSP; no path traversal', async () => {
  const w = await world();
  try {
    const r = await realFetch(base + '/'); assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy')!, /script-src 'self'/); assert.doesNotMatch(r.headers.get('content-security-policy')!, /unsafe-inline/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY'); assert.match(await r.text(), /Student Examination Management System/);
    assert.match((await realFetch(base + '/app.js')).headers.get('content-type')!, /javascript/);
    for (const p of ['/%2e%2e/src/main.ts', '/../src/db.ts', '/server/src/main.ts', '/index.html/../../package.json']) {
      const x = await realFetch(base + p); assert.ok([404].includes(x.status), p + ' -> ' + x.status); assert.doesNotMatch(await x.text(), /import|SCHEMA/);
    }
  } finally { w.srv.close(); }
});

test('new endpoints: role and ownership checks', async () => {
  const w = await world();
  try {
    const tok = (e: string) => w.s.login(e, P).token;
    const call = (p: string, t: string) => realFetch(base + p, { headers: { authorization: `Bearer ${t}` } });
    assert.equal((await call(`/api/faculty/exams/${w.seeded.examId}/submissions`, tok('student@example.com'))).status, 403);
    assert.equal((await call(`/api/faculty/attempts/${w.at1}`, tok('student@example.com'))).status, 403);
    assert.equal((await call(`/api/faculty/exams/${w.seeded.examId}/submissions`, tok('faculty@example.com'))).status, 200);
    assert.equal((await call(`/api/faculty/attempts/${w.at1}`, tok('admin@example.com'))).status, 200);
    assert.equal((await call('/api/admin/exams', tok('faculty@example.com'))).status, 403);
    w.s.createUser(null, { email: 'other@example.com', name: 'o', role: 'FACULTY', password: P });
    assert.equal((await call(`/api/faculty/attempts/${w.at1}`, tok('other@example.com'))).status, 404);   // not their exam
    const j: any = await (await call(`/api/faculty/attempts/${w.at1}`, tok('faculty@example.com'))).json();
    assert.equal(j.data.questions.length, 4); assert.equal(j.data.result.eval_status, 'PENDING_FACULTY_EVALUATION');
  } finally { w.srv.close(); }
});

test('client smoke: every student page renders against the live API', async () => {
  const w = await world();
  try {
    await boot(w.s, 'student@example.com', 'stu');
    for (const p of ['dashboard', 'exams', 'resources', 'notices', 'results', 'notifications', 'profile', `exam/${w.seeded.examId}`, `review/${w.at1}`]) {
      await visit(`#/student/${p}`); assert.deepEqual(errorsOnPage(), [], p); assert.match(textOf(appEl), /Logout/, p);
    }
    await visit('#/student/notices'); assert.match(textOf(appEl), /Welcome/);
    await visit('#/student/results'); assert.match(textOf(appEl), /PENDING_FACULTY_EVALUATION|NOT PUBLISHED/);
    await visit('#/student/dashboard'); assert.match(textOf(appEl), /Welcome, Demo Student/);
    await visit('#/faculty/dashboard'); assert.match(textOf(appEl), /Welcome, Demo Student/);           // wrong portal bounces to own dashboard
  } finally { await visit('#/student/dashboard'); w.srv.close(); }
});

test('client smoke: secure exam screen renders questions, timer, security status', async () => {
  const w = await world();
  try {
    await boot(w.s, 'student2@example.com', 'exam');
    await visit(`#/exam/${w.at2}`);
    const t = textOf(appEl);
    assert.match(t, /SECURE EXAM MODE/); assert.match(t, /Data Structures Midterm/); assert.match(t, /Question 1 \/ 4/);   // order is randomised per student
    assert.match(t, /Question navigator/); assert.match(t, /Violations: 0/); assert.match(t, /SUBMIT EXAM/); assert.doesNotMatch(t, /Dashboard/);   // distraction-free: no nav
    assert.match(textOf(find(appEl, (e) => e.className.startsWith('time'))[0]), /^\d\d:\d\d$/);
    assert.ok(find(appEl, (e) => ['INPUT', 'TEXTAREA'].includes(e.tagName)).length >= 1);          // the first question's answer control rendered
    assert.deepEqual(errorsOnPage(), []);
  } finally { await visit('#/student/dashboard'); w.srv.close(); }      // navigating away runs cleanup and clears timers
});

test('client smoke: faculty pages (manage, submissions, evaluation, report, bank)', async () => {
  const w = await world();
  try {
    await boot(w.s, 'faculty@example.com', 'fac');
    for (const p of ['dashboard', 'exams', 'queue', `exam/${w.seeded.examId}`, `submissions/${w.seeded.examId}`, `submission/${w.at1}`, `report/${w.seeded.examId}`, 'bank', 'resources', 'notices', 'profile']) {
      await visit(`#/faculty/${p}`); assert.deepEqual(errorsOnPage(), [], p);
    }
    await visit(`#/faculty/submission/${w.at1}`); assert.match(textOf(appEl), /Verify Examination Integrity/); assert.match(textOf(appEl), /Save evaluation/);
    assert.match(textOf(appEl), /Behaviour risk/); assert.match(textOf(appEl), /Save & back to queue|Save & next pending/);
    await visit('#/faculty/queue'); assert.match(textOf(appEl), /Demo Student/);                        // the pending subjective answer is queued
    await visit(`#/faculty/report/${w.seeded.examId}`); assert.match(textOf(appEl), /Question performance/);
  } finally { w.srv.close(); }
});

test('client smoke: admin pages', async () => {
  const w = await world();
  try {
    await boot(w.s, 'admin@example.com', 'adm');
    for (const p of ['dashboard', 'users', 'exams', `submissions/${w.seeded.examId}`, `submission/${w.at1}`, 'audit', 'security', 'integrity', 'catalog', 'notices', 'resources', 'profile']) {
      await visit(`#/admin/${p}`); assert.deepEqual(errorsOnPage(), [], p);
    }
    await visit('#/admin/users'); assert.match(textOf(appEl), /student@example\.com/);
    await visit('#/admin/audit'); assert.match(textOf(appEl), /Verify audit chain/);
    await visit(`#/admin/submission/${w.at1}`); assert.doesNotMatch(textOf(appEl), /Save evaluation/);   // admins cannot grade
  } finally { w.srv.close(); }
});

test('css: hidden attribute always wins (regression: overlay covered the exam screen)', async () => {
  const css = (await import('node:fs')).readFileSync(new URL('../public/app.css', import.meta.url), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display\s*:\s*none\s*!important/);
  assert.match(css, /\.overlay\s*\{[^}]*display\s*:\s*flex/);          // the rule that used to defeat [hidden]
});

test('client smoke: camera presence check signals server-side; exam screen shows camera notice', async () => {
  const w = await world();
  const fac = { id: w.seeded.fac.id, role: 'FACULTY' as const };
  const ex = w.s.createExam(fac, { title: 'Cam', subject: 'S', startAt: new Date(Date.now() - 1000).toISOString(), durationMin: 30, requireWebcam: true });
  w.s.addQuestion(fac, ex.id, { type: 'TF', text: 'T?', correct: 'true', marks: 1 }); w.s.setExamStatus(fac, ex.id, 'SCHEDULED');
  const st2 = { id: w.s.listUsers('STUDENT')[1].id, role: 'STUDENT' as const }, at = w.s.startAttempt(st2, ex.id);
  try {
    await boot(w.s, 'student2@example.com', 'cam'); await visit(`#/exam/${at.id}`); await sleep(500);
    assert.match(textOf(appEl), /Camera/); assert.match(textOf(appEl), /Nothing is uploaded/);
    assert.equal((w.s.db.prepare("SELECT COUNT(*) c FROM violations WHERE type='CAMERA_UNAVAILABLE'").get() as any).c, 1);   // no camera in this environment -> signal recorded
    assert.equal(w.s.startAttempt(st2, ex.id).status, 'IN_PROGRESS');                                                       // signal-only: never ends the exam
    await visit(`#/student/exam/${ex.id}`); assert.match(textOf(appEl), /camera must stay on/);
  } finally { await visit('#/student/dashboard'); w.srv.close(); }
});

test('client: instructions page explains a closed exam instead of entering fullscreen; open exam can start', async () => {
  const s = createSems(); const seeded = await seed(s);
  const srv = createHttpServer(s, createExtras(s, { uploadDir: mkdtempSync(join(tmpdir(), 'ui-')) })).listen(0); await new Promise((r) => srv.once('listening', r));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    await boot(s, 'student@example.com', 'win-open'); await visit(`#/student/exam/${seeded.examId}`);
    assert.ok(find(appEl, (e) => e.tagName === 'BUTTON' && textOf(e) === 'Start Examination' && !e.disabled).length === 1, 'open exam: enabled Start button');
    s.db.prepare('UPDATE exams SET start_at=? WHERE id=?').run(new Date(Date.now() - 3 * 3600_000).toISOString(), seeded.examId);
    await visit('#/student/exams'); await visit(`#/student/exam/${seeded.examId}`);
    assert.match(textOf(appEl), /exam window has closed/i);
    assert.equal(find(appEl, (e) => e.tagName === 'BUTTON' && textOf(e) === 'Start Examination' && !e.disabled).length, 0, 'closed exam: no enabled Start button');
    assert.deepEqual(errorsOnPage(), []);
  } finally { srv.close(); }
});
