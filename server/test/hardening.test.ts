import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSems, AppError } from '../src/service.ts';
import { createExtras } from '../src/extras.ts';
import { createHttpServer } from '../src/http.ts';
import { totp, seal, unseal } from '../src/security.ts';

const P = 'Demo@12345!';
const rejects = (p: any, code: string) => assert.rejects(async () => (typeof p === 'function' ? p() : p), (e: any) => e instanceof AppError && e.code === code);
function setup() {
  const s = createSems({ secret: 'test-secret-1' }); const x = createExtras(s, { uploadDir: mkdtempSync(join(tmpdir(), 'h-')) });
  const mk = (e: string, r: any) => s.createUser(null, { email: e, name: e, role: r, password: P });
  const admin = mk('a@x.com', 'ADMIN'), stu = mk('s@x.com', 'STUDENT'); mk('t@x.com', 'STUDENT');
  return { s, x, admin: { id: admin.id, role: 'ADMIN' } as any, stu };
}

test('mfa: secret is encrypted at rest, still works, tamper-safe', async () => {
  const { s, admin } = setup();
  const { secret } = s.mfaSetup(admin);
  const stored = (s.db.prepare('SELECT secret FROM mfa').get() as any).secret;
  assert.ok(stored.startsWith('v1.') && !stored.includes(secret));                       // ciphertext, not the seed
  s.mfaEnable(admin, totp(secret, s.now().getTime()));
  assert.equal(s.login('a@x.com', P, {}, totp(secret, s.now().getTime())).user.role, 'ADMIN');
  s.db.prepare('UPDATE mfa SET secret=?').run(stored.slice(0, -3) + 'AAA');                // corrupt ciphertext
  await rejects(() => s.login('a@x.com', P, {}, totp(secret, s.now().getTime())), 'MFA_REQUIRED');   // fails closed, no crash
  assert.equal(unseal(seal('hello', 'k1'), 'k2'), null);                                  // wrong key
  assert.equal(unseal(seal('hello', 'k1'), 'k1'), 'hello');
});

test('admin MFA enforcement: blocked until set up, per request, students unaffected', async () => {
  const { s, x } = setup();
  const srv = createHttpServer(s, x, { requireAdminMfa: true }).listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const call = async (m: string, p: string, t: string, body?: any) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: (await r.json()) as any }; };
  try {
    const ta = s.login('a@x.com', P).token, ts = s.login('s@x.com', P).token;
    const blocked = await call('GET', '/api/admin/users', ta);
    assert.equal(blocked.status, 403); assert.equal(blocked.json.errorCode, 'MFA_SETUP_REQUIRED');
    assert.equal((await call('GET', '/api/me', ta)).status, 200);
    const setup = await call('POST', '/api/auth/mfa/setup', ta); assert.equal(setup.status, 200);
    assert.equal((await call('GET', '/api/admin/users', ta)).status, 403);                // setup alone is not enough
    assert.equal((await call('POST', '/api/auth/mfa/enable', ta, { code: totp(setup.json.data.secret, Date.now()) })).status, 200);
    assert.equal((await call('GET', '/api/admin/users', ta)).status, 200);               // same token now allowed
    assert.equal((await call('GET', '/api/student/exams', ts)).status, 200);
  } finally { srv.close(); }
});

test('admin edit user: validation, email re-auth, sessions revoked, authz', async () => {
  const { s, x, admin, stu } = setup();
  const u = s.updateUser(admin, stu.id, { name: 'New Name' });
  assert.equal(u.name, 'New Name'); assert.equal(u.email, 's@x.com');
  await rejects(() => s.updateUser(admin, stu.id, { email: 'new@x.com' }, 'wrong'), 'REAUTH_REQUIRED');
  await rejects(() => s.updateUser(admin, stu.id, { email: 't@x.com' }, P), 'EMAIL_EXISTS');
  await rejects(() => s.updateUser(admin, stu.id, { email: 'not-an-email' }, P), 'VALIDATION');
  await rejects(() => s.updateUser(admin, stu.id, { name: '  ' }), 'VALIDATION');
  const tok = s.login('s@x.com', P).token;
  assert.equal(s.updateUser(admin, stu.id, { email: 'Moved@X.com' }, P).email, 'moved@x.com');
  await rejects(() => s.authenticate(tok), 'AUTH_REQUIRED');                              // old sessions revoked
  assert.equal(s.login('moved@x.com', P).user.id, stu.id);
  assert.ok(s.listAudit({ action: 'USER_UPDATED' }).length === 2);
  const srv = createHttpServer(s, x).listen(0); await new Promise((r) => srv.once('listening', r));
  try {
    const t = s.login('moved@x.com', P).token;
    const r = await fetch(`http://127.0.0.1:${(srv.address() as any).port}/api/admin/users/${stu.id}`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: '{"name":"x"}' });
    assert.equal(r.status, 403);                                                         // students cannot edit users
  } finally { srv.close(); }
});
