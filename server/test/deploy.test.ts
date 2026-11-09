import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSems } from '../src/service.ts';
import { createExtras } from '../src/extras.ts';
import { createHttpServer } from '../src/http.ts';

const boot = async (opts: any) => { const s = createSems(); s.createUser(null, { email: 'a@x.com', name: 'a', role: 'ADMIN', password: 'Demo@12345!' });
  const srv = createHttpServer(s, createExtras(s, { uploadDir: mkdtempSync(join(tmpdir(), 'd-')) }), opts).listen(0); await new Promise((r) => srv.once('listening', r));
  return { s, srv, base: `http://127.0.0.1:${(srv.address() as any).port}` }; };

test('health probe works, is not rate limited, and proxy headers are honoured only when trusted', async () => {
  const t = await boot({ trustProxy: true }), u = await boot({});
  try {
    for (let i = 0; i < 60; i++) assert.equal((await fetch(t.base + '/api/health')).status, 200);
    const bad = (base: string) => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, body: '{"email":"a@x.com","password":"x"}' });
    await bad(t.base); await bad(u.base);
    assert.equal((t.s.listAudit({ action: 'FAILED_LOGIN' })[0] as any).ip, '203.0.113.9');            // behind our proxy
    assert.notEqual((u.s.listAudit({ action: 'FAILED_LOGIN' })[0] as any).ip, '203.0.113.9');          // spoofed header ignored when not trusted
    assert.match((await fetch(t.base + '/')).headers.get('strict-transport-security')!, /max-age/);
    assert.equal((await fetch(u.base + '/')).headers.get('strict-transport-security'), null);
  } finally { t.srv.close(); u.srv.close(); }
});
