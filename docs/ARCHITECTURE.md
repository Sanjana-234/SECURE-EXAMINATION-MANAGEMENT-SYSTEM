# Architecture

    Browser (vanilla JS client, server/public)
       │  HTTPS (Caddy / any TLS proxy)  – Bearer token, JSON
    HTTP layer  server/src/http.ts      routing, security headers, body limits, throttle, role check (authZ before handler)
       │
    Services    server/src/service.ts   auth, users, exams, attempts, timer, grading, violations, audit, integrity
                server/src/extras.ts    notices, resources, question bank, reports, dashboards, catalog
                server/src/grading.ts   pure grading function
       │
    Data        server/src/db.ts        SQL schema (portable)  → SQLite file today, PostgreSQL later
    Integrity   server/src/ledger.ts    `Ledger` interface → LocalLedger (hash-chained, dev) | EVM adapter (blockchain/)

Key rules: the client never talks to the database; marks, timer, role, exam/attempt status and permissions are decided only on the server;
students receive questions with the answer key stripped; every state change writes an audit row.

## Integrity flow
submit → server grades → canonical JSON (sorted keys) of submission+result (ids, answers, marks; no names/emails) → SHA-256 →
stored in `blockchain_records` and anchored in the ledger (tx reference stored). Faculty evaluation re-anchors a new version.
Verify = recompute hash → compare with stored record and ledger payload → also validate the ledger chain.

## Timer
`expires_at` is written at start. Every attempt read/write checks it; expired attempts are auto-submitted (at `expires_at`) and closed.
A 15 s sweeper finalises idle attempts. The browser countdown is cosmetic and re-synced every 20 s.

## Audit chain
`audit_logs.entry_hash = SHA-256(prev_hash | canonical(row))`, appended inside a `BEGIN IMMEDIATE` transaction so concurrent instances form one chain.
`verifyAuditChain` recomputes every link, then checks that each **anchored head** (periodically written to the ledger, table `audit_anchors`) still exists
and matches the ledger. Edits, mid-chain deletions and tail truncation are all detected (tested). Pre-migration rows are reported as `legacyUnprotected`.

## Continuous anti-cheating analysis
Client: heartbeat every 5 s, event listeners, optional on-device camera check. Server: `violations` rows + `riskAssessment()` (weighted, capped per type, burst and rapid-answering signals).
Policy (WARN_ONLY / FLAG / AUTO_SUBMIT) counts only direct violations; signal-only events (heartbeat gap, camera) feed the risk score. Risk >= 50 flags for human review (never fails a student; WARN_ONLY exams are never flagged).

## Multi-instance operation
Sessions, throttling counters, attempts, ledger and audit chain all live in the shared database; finalisation is a single conditional `UPDATE`; ledger/audit appends are atomic transactions;
`maintenance()` (every instance, every 15 s) closes expired attempts, repairs submissions that lost their result/anchor (60 s grace so it never races a live finalisation), anchors the audit head and prunes throttle rows.
