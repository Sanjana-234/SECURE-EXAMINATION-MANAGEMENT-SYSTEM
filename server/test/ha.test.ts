import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHEMA, MIGRATIONS, openDb, backupDb } from '../src/db.ts';
import { createSems } from '../src/service.ts';
import { createExtras } from '../src/extras.ts';
import { createHttpServer } from '../src/http.ts';

const P = 'Demo@12345!';
const tmp = () => mkdtempSync(join(tmpdir(), 'ha-'));
const mk = (s: any, e: string, r: any) => s.createUser(null, { email: e, name: e, role: r, password: P });
const act = (u: any) => ({ id: u.id, role: u.role } as any);

function examWorld(s: any) {
  const fac = act(mk(s, 'f@x.com', 'FACULTY')), stu = act(mk(s, 's@x.com', 'STUDENT'));
  const exam = s.createExam(fac, { title: 'E', subject: 'S', startAt: new Date(Date.now() - 1000).toISOString(), durationMin: 30, passMarks: 1, publishImmediately: true });
  const q = s.addQuestion(fac, exam.id, { type: 'MCQ', text: 'q', options: [{ id: 'A', text: 'a' }, { id: 'B', text: 'b' }], correct: 'A', marks: 2 }).id;
  s.setExamStatus(fac, exam.id, 'SCHEDULED');
  return { fac, stu, exam, q };
}

test('migrations: legacy database is upgraded, versions recorded, reopening is idempotent', async () => {
  const path = join(tmp(), 'legacy.db');
  const raw = new DatabaseSync(path); raw.exec(SCHEMA);                                  // v0 schema, as shipped before migrations
  raw.prepare("INSERT INTO audit_logs (id,action,severity,created_at) VALUES ('legacy-1','OLD_EVENT','INFO','2026-01-01T00:00:00Z')").run(); raw.close();
  const s = createSems({ dbPath: path });
  const cols = (t: string) => (s.db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map((c) => c.name);
  assert.ok(cols('exams').includes('randomize') && cols('audit_logs').includes('entry_hash') && cols('manual_marks').includes('comment'));
  assert.equal((s.db.prepare('SELECT COUNT(*) c FROM schema_version').get() as any).c, MIGRATIONS.length);
  mk(s, 'a@x.com', 'ADMIN');
  const v: any = await s.verifyAuditChain();
  assert.equal(v.valid, true); assert.equal(v.legacyUnprotected, 1); assert.ok(v.entries >= 1);   // old rows are reported, not silently trusted
  s.db.close();
  const again = openDb(path); assert.equal((again.prepare('SELECT COUNT(*) c FROM schema_version').get() as any).c, MIGRATIONS.length);
});

test('audit chain: detects edits, deletions, truncation and ledger tampering', async () => {
  const fresh = async () => { const s = createSems(); mk(s, 'a@x.com', 'ADMIN'); mk(s, 'b@x.com', 'STUDENT'); s.login('a@x.com', P); s.login('b@x.com', P); return s; };
  let s = await fresh(); const ok: any = await s.verifyAuditChain();
  assert.equal(ok.valid, true); assert.ok(ok.entries >= 4); assert.match(ok.head, /^[0-9a-f]{64}$/);
  s = await fresh(); s.db.prepare("UPDATE audit_logs SET action='NOTHING_HAPPENED' WHERE rowid=2").run();
  const edited: any = await s.verifyAuditChain(); assert.equal(edited.valid, false); assert.equal(edited.brokenAtRow, 2);
  s = await fresh(); s.db.prepare('DELETE FROM audit_logs WHERE rowid=2').run();
  assert.equal(((await s.verifyAuditChain()) as any).valid, false);                       // gap in the middle
  s = await fresh(); await s.verifyAuditChain();                                           // anchors the head on the ledger
  s.db.prepare('DELETE FROM audit_logs WHERE rowid=(SELECT MAX(rowid) FROM audit_logs)').run();
  const trunc: any = await s.verifyAuditChain(); assert.equal(trunc.valid, false); assert.match(trunc.reason, /truncated/);   // tail removal caught via anchor
  s = await fresh(); await s.verifyAuditChain(); s.db.prepare("UPDATE ledger SET payload_hash='deadbeef'").run();
  const led: any = await s.verifyAuditChain(); assert.equal(led.valid, false); assert.match(led.reason, /ledger/);
  s = await fresh(); const a1 = (await s.verifyAuditChain()) as any; s.login('a@x.com', P); const a2 = (await s.verifyAuditChain()) as any;
  assert.equal(a2.valid, true); assert.ok(a2.entries > a1.entries); assert.equal(a2.anchors, 2);   // grows and re-anchors
});

test('two instances on one database: races resolve to exactly one submission, chains stay valid', async () => {
  const path = join(tmp(), 'shared.db');
  const A = createSems({ dbPath: path }), B = createSems({ dbPath: path });
  const { stu, exam, q } = examWorld(A);
  const at = B.startAttempt(stu, exam.id);                                                 // started on B ...
  await A.saveAnswer(stu, at.id, q, 'A', 1);                                               // ... answered on A (sessions/answers are shared)
  const results = await Promise.allSettled([A.submitAttempt(stu, at.id), B.submitAttempt(stu, at.id), A.autoSubmitExpired(), B.maintenance()]);
  assert.ok(results.every((r) => r.status === 'fulfilled' || (r as any).reason.code === 'ALREADY_SUBMITTED'));
  const n = (sql: string) => (A.db.prepare(sql).get() as any).c;
  assert.equal(n("SELECT COUNT(*) c FROM audit_logs WHERE action='EXAM_SUBMITTED'"), 1);
  assert.equal(n('SELECT COUNT(*) c FROM blockchain_records'), 1);
  assert.equal(n('SELECT COUNT(*) c FROM results'), 1);
  assert.equal((A.ledger as any).chainValid(), true);
  assert.equal(((await B.verifyAuditChain()) as any).valid, true);                         // interleaved writers still form one chain
  assert.equal((await A.verifyIntegrity({ id: 'x', role: 'ADMIN' } as any, at.id)).verified, true);
  assert.equal(B.login('s@x.com', P).user.role, 'STUDENT');                                // a user created via A logs in on B
});

test('failover repair: a submission that lost its result/anchor is repaired by maintenance', async () => {
  let t = Date.now(); const s = createSems({ now: () => new Date(t) }); const { stu, exam, q } = examWorld(s);
  const at = s.startAttempt(stu, exam.id); await s.saveAnswer(stu, at.id, q, 'A', 1); await s.submitAttempt(stu, at.id);
  s.db.prepare('DELETE FROM blockchain_records').run(); s.db.prepare('DELETE FROM results').run();   // simulate a crash mid-finalisation
  assert.equal((await s.maintenance()).repaired, 0);                                       // too fresh: another instance may still be finalising
  t += 61_000;
  assert.equal((await s.maintenance()).repaired, 1);
  assert.equal((await s.verifyIntegrity({ id: 'x', role: 'ADMIN' } as any, at.id)).verified, true);
  assert.equal((await s.maintenance()).repaired, 0);                                       // idempotent
});

test('http: shared rate limit across replicas, readiness probe, online backup', async () => {
  const path = join(tmp(), 'lb.db'), A = createSems({ dbPath: path }), B = createSems({ dbPath: path });
  mk(A, 'u@x.com', 'STUDENT');
  const sa = createHttpServer(A, createExtras(A, { uploadDir: tmp() })).listen(0), sb = createHttpServer(B, createExtras(B, { uploadDir: tmp() })).listen(0);
  await Promise.all([sa, sb].map((x) => new Promise((r) => x.once('listening', r))));
  const urls = [sa, sb].map((x) => `http://127.0.0.1:${(x.address() as any).port}`);
  try {
    assert.equal((await fetch(urls[0] + '/api/ready')).status, 200); assert.equal((await fetch(urls[1] + '/api/ready')).status, 200);
    let first429 = -1;
    for (let attempt = 0; attempt < 3 && first429 < 0; attempt++) {                        // retry only if a minute boundary split the window
      const w0 = Math.floor(Date.now() / 60000); A.db.exec('DELETE FROM ip_hits');
      for (let i = 0; i < 31; i++) {
        const r = await fetch(urls[i % 2] + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email":"nobody@x.com","password":"bad"}' });
        if (r.status === 429) { first429 = i; break; }
      }
      if (Math.floor(Date.now() / 60000) !== w0) first429 = -1;
    }
    assert.equal(first429, 30);                                                            // (unknown email: avoids the per-account lock, which also answers 429)                                                            // 31st request overall, though each replica saw only ~15
    const dest = join(tmp(), 'copy.db'); backupDb(A.db, dest);
    const copy = openDb(dest); assert.equal((copy.prepare('SELECT COUNT(*) c FROM users').get() as any).c, 1);
  } finally { sa.close(); sb.close(); }
});
