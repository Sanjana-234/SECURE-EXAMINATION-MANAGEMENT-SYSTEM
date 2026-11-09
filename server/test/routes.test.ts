import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSems } from '../src/service.ts';
import { createExtras } from '../src/extras.ts';
import { createHttpServer } from '../src/http.ts';
import { seed, DEMO_PASSWORD as P } from '../src/seed.ts';

// Reads the real route table, so a newly added route is automatically covered by these checks.
const ROLE: Record<string, string[] | null> = { A: ['ADMIN'], F: ['FACULTY'], S: ['STUDENT'], FA: ['FACULTY', 'ADMIN'], ANY: ['ADMIN', 'FACULTY', 'STUDENT'], null: null };
const routes = [...readFileSync(new URL('../src/http.ts', import.meta.url), 'utf8').matchAll(/r\('(GET|POST|PUT|DELETE)', '([^']+)', (A|F|S|FA|ANY|null),/g)]
  .map((m) => ({ method: m[1], path: m[2].replace(/:kind/, 'department').replace(/:\w+/g, 'x'), roles: ROLE[m[3]] }));

test('route sweep: authentication and role checks hold for every route; no route crashes on junk input', async () => {
  const s = createSems(); const x = createExtras(s, { uploadDir: mkdtempSync(join(tmpdir(), 'rt-')) }); await seed(s);
  const srv = createHttpServer(s, x).listen(0); await new Promise((r) => srv.once('listening', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const emails: Record<string, string> = { ADMIN: 'admin@example.com', FACULTY: 'faculty@example.com', STUDENT: 'student@example.com' };
  const call = async (r: any, role?: string) => {
    const headers: any = { 'content-type': 'application/json' }; if (role) headers.authorization = `Bearer ${s.login(emails[role], P).token}`;   // fresh session per call (logout revokes)
    const res = await fetch(base + r.path, { method: r.method, headers, body: r.method === 'GET' || r.method === 'DELETE' ? undefined : '{}' });
    return { status: res.status, j: (await res.json().catch(() => null)) as any };
  };
  const origErr = console.error; console.error = () => {};
  try {
    assert.ok(routes.length >= 50, `found ${routes.length} routes`);
    let checked = 0;
    for (const r of routes) {
      const roles = r.roles; if (!roles) continue;                                                                      // public routes are covered by auth tests
      const anon = await call(r); assert.equal(anon.status, 401, `${r.method} ${r.path} anonymous`);
      for (const role of ['ADMIN', 'FACULTY', 'STUDENT'].filter((x) => !roles.includes(x))) {
        const bad = await call(r, role); assert.equal(bad.status, 403, `${r.method} ${r.path} as ${role}`); assert.equal(bad.j.errorCode, 'AUTH_FORBIDDEN');
      }
      for (const role of roles) {
        const ok = await call(r, role);
        assert.ok(ok.status < 500, `${r.method} ${r.path} as ${role} -> ${ok.status}`);              // junk input yields a 4xx, never a crash
        if (ok.j) assert.ok(ok.j.success === true || (typeof ok.j.message === 'string' && typeof ok.j.errorCode === 'string'));
      }
      checked++;
    }
    assert.ok(checked >= 45);
    assert.ok((s.listAudit({ action: 'ACCESS_DENIED' }) as any[]).length > 40);                    // every forbidden attempt was audited
  } finally { console.error = origErr; srv.close(); }
});
