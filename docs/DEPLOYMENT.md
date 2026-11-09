# Deployment

## Option A: Docker Compose with automatic HTTPS (works today, SQLite on a volume)
    cp .env.example .env      # set SEMS_DOMAIN, SEMS_SECRET (openssl rand -base64 48), bootstrap admin
    docker compose up -d --build
    # sign in as the bootstrap admin, change the password, enable 2FA, then delete the bootstrap vars from .env and `docker compose up -d`.

## Option B: bare Node 22+
    cd server && NODE_ENV=production SEMS_SECRET=... SEMS_BOOTSTRAP_ADMIN_EMAIL=... SEMS_BOOTSTRAP_ADMIN_PASSWORD=... \
      SEMS_DB=/var/lib/sems/sems.db SEMS_UPLOADS=/var/lib/sems/uploads SEMS_TRUST_PROXY=1 node --disable-warning=ExperimentalWarning src/main.ts
Put a TLS-terminating proxy in front. Do NOT set `SEMS_TRUST_PROXY=1` unless the proxy is the only way to reach the app.

## Option C: high availability on one host (3 replicas)
    docker compose -f docker-compose.ha.yml up -d --build
Caddy health-checks `/api/ready` every 5 s and stops sending traffic to a failed replica. Sessions, rate limits, exam attempts and timers are in the shared database,
so users stay signed in and running exams continue when a replica dies; surviving replicas finalise expired attempts. Rolling upgrade:
`docker compose -f docker-compose.ha.yml up -d --no-deps --build sems-1`, then sems-2, then sems-3 (migrations are idempotent and run under a database lock at start).
**Limits:** one host and one local disk (SQLite WAL must not sit on NFS/SMB). A host or disk failure is downtime: restore from backup. True multi-host failover requires the PostgreSQL port.
This compose file was written but **not run** in the build environment: smoke-test it (kill a replica during a test exam) before relying on it.

## Backups
Back up the database and `uploads/` together. `npm run backup -- out.db` (or `deploy/backup.sh` from cron; for the HA stack run `COMPOSE_FILE=docker-compose.ha.yml deploy/backup.sh`) takes a consistent online snapshot with `VACUUM INTO`; no downtime. Test a restore at least once per term. Schema upgrades are versioned (`schema_version`); take a backup before upgrading. Keep `SEMS_SECRET` separately and safely: without it, 2FA seeds cannot be decrypted.

## Environment
| Var | Purpose |
|---|---|
| `SEMS_SECRET` | token signing + data-key derivation (required in production) |
| `SEMS_DB`, `SEMS_UPLOADS` | storage paths |
| `SEMS_REQUIRE_ADMIN_MFA=1` | force admin 2FA |
| `SEMS_TRUST_PROXY=1` | trust X-Forwarded-For, send HSTS |
| `SEMS_BOOTSTRAP_ADMIN_EMAIL/PASSWORD` | create first admin on an empty DB |
| `SEMS_SEED_DEMO=1` | load demo data (never in production) |

## Moving to PostgreSQL (not done here: needs npm/network)
Schema is in `database/schema.sql`. Mapping: `TEXT` timestamps → `timestamptz`; `INTEGER` 0/1 flags → `boolean`; `INTEGER PRIMARY KEY AUTOINCREMENT` → `GENERATED ALWAYS AS IDENTITY`;
JSON-in-TEXT columns → `jsonb`; `?` placeholders → `$1..`; `INSERT ... ON CONFLICT` already compatible. All SQL lives in `service.ts`/`extras.ts`/`ledger.ts` behind small `get/all/run` helpers, so the port means swapping those helpers to an async `pg` pool (service methods that call them need `await`).
Then run the existing test suite against Postgres: it is the acceptance test.
