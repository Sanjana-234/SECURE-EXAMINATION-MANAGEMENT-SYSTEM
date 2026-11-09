import { createSems } from './service.ts';
import { createHttpServer } from './http.ts';
import { createExtras } from './extras.ts';
import { seed, refreshDemoExam, DEMO_PASSWORD } from './seed.ts';
import { passwordPolicyError } from './security.ts';

const prod = process.env.NODE_ENV === 'production';
const env = process.env;
if (prod && (!env.SEMS_SECRET || env.SEMS_SECRET.length < 32 || env.SEMS_SECRET.includes('change-me'))) {
  console.error('FATAL: set SEMS_SECRET to a random string of at least 32 characters in production (e.g. `openssl rand -base64 48`).');
  process.exit(1);
}
const sems = createSems({ dbPath: env.SEMS_DB ?? './sems.db' });
if (!sems.listUsers().length) {
  if (env.SEMS_SEED_DEMO === '1' || !prod) {                                  // demo data only in dev, or when explicitly requested
    await seed(sems); console.log(`Seeded DEMO users (password: ${DEMO_PASSWORD}). Never use this in production.`);
  } else if (env.SEMS_BOOTSTRAP_ADMIN_EMAIL && env.SEMS_BOOTSTRAP_ADMIN_PASSWORD) {
    const pe = passwordPolicyError(env.SEMS_BOOTSTRAP_ADMIN_PASSWORD);
    if (pe) { console.error('FATAL: SEMS_BOOTSTRAP_ADMIN_PASSWORD invalid: ' + pe); process.exit(1); }
    sems.createUser(null, { email: env.SEMS_BOOTSTRAP_ADMIN_EMAIL, name: 'Administrator', role: 'ADMIN', password: env.SEMS_BOOTSTRAP_ADMIN_PASSWORD, mustChangePassword: true });
    console.log('Created bootstrap admin ' + env.SEMS_BOOTSTRAP_ADMIN_EMAIL + ' (must change password at first login). Remove the bootstrap env vars now.');
  } else { console.error('FATAL: empty database in production. Set SEMS_BOOTSTRAP_ADMIN_EMAIL and SEMS_BOOTSTRAP_ADMIN_PASSWORD for first start.'); process.exit(1); }
}
if (!prod && refreshDemoExam(sems)) console.log('Demo exam window had expired; re-opened it for local testing.');
setInterval(() => sems.maintenance().catch((e) => console.error(e)), 15_000);   // timeout sweeper + repair + audit anchoring (safe on every replica)
const port = Number(env.PORT ?? 4000);
const server = createHttpServer(sems, createExtras(sems), { requireAdminMfa: env.SEMS_REQUIRE_ADMIN_MFA === '1', trustProxy: env.SEMS_TRUST_PROXY === '1' });
server.listen(port, () => console.log(`SEMS listening on :${port}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log('Shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); });
