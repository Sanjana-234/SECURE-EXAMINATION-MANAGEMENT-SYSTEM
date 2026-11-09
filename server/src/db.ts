import { DatabaseSync } from 'node:sqlite';

// Schema is written in portable SQL so it maps 1:1 to PostgreSQL (see /database/README).
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','FACULTY','STUDENT')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE','SUSPENDED')),
  password_hash TEXT NOT NULL, must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exams (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, subject TEXT NOT NULL,
  faculty_id TEXT NOT NULL REFERENCES users(id), start_at TEXT NOT NULL,
  duration_min INTEGER NOT NULL, pass_marks REAL NOT NULL,
  negative_marking INTEGER NOT NULL DEFAULT 0, instructions TEXT NOT NULL DEFAULT '',
  max_violations INTEGER NOT NULL DEFAULT 3,
  violation_policy TEXT NOT NULL DEFAULT 'FLAG' CHECK (violation_policy IN ('WARN_ONLY','FLAG','AUTO_SUBMIT')),
  publish_immediately INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SCHEDULED','LIVE','COMPLETED','EVALUATING','PUBLISHED')),
  created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, type TEXT NOT NULL CHECK (type IN ('MCQ','MULTI','TF','SHORT','LONG')),
  text TEXT NOT NULL, options TEXT, correct TEXT, marks REAL NOT NULL, neg_marks REAL NOT NULL DEFAULT 0,
  difficulty TEXT NOT NULL DEFAULT 'MEDIUM', topic TEXT);
CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id);
CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY, exam_id TEXT NOT NULL REFERENCES exams(id),
  student_id TEXT NOT NULL REFERENCES users(id), started_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  submitted_at TEXT, status TEXT NOT NULL DEFAULT 'IN_PROGRESS' CHECK (status IN ('IN_PROGRESS','SUBMITTED','AUTO_SUBMITTED')),
  suspicious INTEGER NOT NULL DEFAULT 0, UNIQUE (exam_id, student_id));
CREATE TABLE IF NOT EXISTS answers (
  attempt_id TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES questions(id), answer TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0, saved_at TEXT NOT NULL, PRIMARY KEY (attempt_id, question_id));
CREATE TABLE IF NOT EXISTS manual_marks (
  attempt_id TEXT NOT NULL REFERENCES attempts(id), question_id TEXT NOT NULL REFERENCES questions(id),
  marks REAL NOT NULL, PRIMARY KEY (attempt_id, question_id));
CREATE TABLE IF NOT EXISTS results (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(id), total_questions INTEGER, attempted INTEGER,
  correct INTEGER, incorrect INTEGER, unanswered INTEGER, positive_marks REAL, negative_marks REAL,
  score REAL, max_marks REAL, percentage REAL, grade TEXT, passed INTEGER, eval_status TEXT,
  remarks TEXT, published INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS violations (
  id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL REFERENCES attempts(id), student_id TEXT NOT NULL,
  exam_id TEXT NOT NULL, type TEXT NOT NULL, severity TEXT NOT NULL, description TEXT,
  ip TEXT, user_agent TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_viol_attempt ON violations(attempt_id);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, user_id TEXT, role TEXT, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT,
  severity TEXT NOT NULL DEFAULT 'INFO', ip TEXT, user_agent TEXT, metadata TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'NORMAL', is_read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blockchain_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT, attempt_id TEXT NOT NULL REFERENCES attempts(id),
  hash TEXT NOT NULL, tx_ref TEXT NOT NULL, block_index INTEGER NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger (
  idx INTEGER PRIMARY KEY, prev_hash TEXT NOT NULL, payload_hash TEXT NOT NULL,
  block_hash TEXT NOT NULL, ts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mfa (user_id TEXT PRIMARY KEY REFERENCES users(id), secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS profiles (user_id TEXT PRIMARY KEY REFERENCES users(id), department TEXT, class_name TEXT);
CREATE TABLE IF NOT EXISTS catalog (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('DEPARTMENT','COURSE','SUBJECT')), name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, UNIQUE (kind, name));
CREATE TABLE IF NOT EXISTS notices (
  id TEXT PRIMARY KEY, author_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, message TEXT NOT NULL,
  department TEXT, class_name TEXT, priority TEXT NOT NULL DEFAULT 'NORMAL', publish_at TEXT NOT NULL,
  expires_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY, uploaded_by TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, description TEXT,
  subject TEXT, department TEXT, class_name TEXT, expires_at TEXT, stored_name TEXT NOT NULL, original_name TEXT NOT NULL,
  mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS question_bank (
  id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), type TEXT NOT NULL, text TEXT NOT NULL,
  options TEXT, correct TEXT, marks REAL NOT NULL, neg_marks REAL NOT NULL DEFAULT 0, difficulty TEXT NOT NULL,
  topic TEXT, deleted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
`;

// Versioned, idempotent migrations (applied in order, each inside BEGIN IMMEDIATE so two instances can start safely).
export const MIGRATIONS: [number, string][] = [
  [1, `ALTER TABLE exams ADD COLUMN randomize INTEGER NOT NULL DEFAULT 1;
       ALTER TABLE exams ADD COLUMN require_webcam INTEGER NOT NULL DEFAULT 0;
       ALTER TABLE exams ADD COLUMN show_answers INTEGER NOT NULL DEFAULT 0;`],
  [2, `ALTER TABLE questions ADD COLUMN keywords TEXT;
       ALTER TABLE manual_marks ADD COLUMN comment TEXT;`],
  [3, `ALTER TABLE attempts ADD COLUMN last_heartbeat TEXT;`],
  [4, `ALTER TABLE audit_logs ADD COLUMN prev_hash TEXT;
       ALTER TABLE audit_logs ADD COLUMN entry_hash TEXT;`],
  [5, `CREATE TABLE IF NOT EXISTS ip_hits (k TEXT NOT NULL, w INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (k, w));`],
  [6, `CREATE TABLE IF NOT EXISTS audit_anchors (
         id INTEGER PRIMARY KEY AUTOINCREMENT, head_hash TEXT NOT NULL, entries INTEGER NOT NULL,
         tx_ref TEXT NOT NULL, block_index INTEGER NOT NULL, created_at TEXT NOT NULL);`],
];

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');   // safe concurrent readers + writers
  db.exec(SCHEMA);
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  for (const [v, sql] of MIGRATIONS) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!db.prepare('SELECT 1 FROM schema_version WHERE version=?').get(v)) {
        db.exec(sql); db.prepare('INSERT INTO schema_version VALUES (?,?)').run(v, new Date().toISOString());
      }
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  return db;
}

// Synchronous write transaction (BEGIN IMMEDIATE = cross-process write lock). Nested calls join the outer one.
const depth = new WeakMap<DatabaseSync, number>();
export function withTx<T>(db: DatabaseSync, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  if (d > 0) { depth.set(db, d + 1); try { return fn(); } finally { depth.set(db, d); } }
  db.exec('BEGIN IMMEDIATE'); depth.set(db, 1);
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
  finally { depth.set(db, 0); }
}

export function backupDb(db: DatabaseSync, dest: string) { db.prepare('VACUUM INTO ?').run(dest); }
