import { randomUUID, randomBytes } from 'node:crypto';
import { openDb, withTx } from './db.ts';
import { hashPassword, verifyPassword, passwordPolicyError, signToken, verifyToken, verifyTotp, base32, seal, unseal } from './security.ts';
import { LocalLedger, canonical, sha256 } from './ledger.ts';
import type { Ledger } from './ledger.ts';
import { grade, perQuestion } from './grading.ts';

export class AppError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}
export type Role = 'ADMIN' | 'FACULTY' | 'STUDENT';
export type Actor = { id: string; role: Role; sid?: string; ip?: string | null; ua?: string | null };

const MAX_FAILS = 5, LOCK_MS = 15 * 60_000;
const VIOLATIONS: Record<string, string> = {
  TAB_SWITCH: 'MEDIUM', FULLSCREEN_EXIT: 'MEDIUM', COPY_ATTEMPT: 'MEDIUM', PASTE_ATTEMPT: 'MEDIUM',
  CUT_ATTEMPT: 'MEDIUM', RIGHT_CLICK: 'LOW', SUSPICIOUS_KEYBOARD_EVENT: 'LOW',
  HEARTBEAT_GAP: 'LOW', CAMERA_UNAVAILABLE: 'MEDIUM', CAMERA_COVERED: 'MEDIUM',
};
// Signal-only events feed the risk score but never count toward the exam's violation policy (network blips must not auto-submit anyone).
const SIGNAL_ONLY = new Set(['HEARTBEAT_GAP', 'CAMERA_UNAVAILABLE', 'CAMERA_COVERED']);
const RISK_WEIGHT: Record<string, number> = { TAB_SWITCH: 10, FULLSCREEN_EXIT: 10, COPY_ATTEMPT: 8, PASTE_ATTEMPT: 8, CUT_ATTEMPT: 8,
  RIGHT_CLICK: 2, SUSPICIOUS_KEYBOARD_EVENT: 3, HEARTBEAT_GAP: 6, CAMERA_UNAVAILABLE: 10, CAMERA_COVERED: 8 };
const RISK_FLAG_AT = 50, HEARTBEAT_GAP_S = 30;
const TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SCHEDULED'], SCHEDULED: ['LIVE', 'DRAFT'], LIVE: ['COMPLETED'],
  COMPLETED: ['EVALUATING'], EVALUATING: ['PUBLISHED'], PUBLISHED: [],
};

export function createSems(opts: { dbPath?: string; now?: () => Date; secret?: string; ledger?: Ledger } = {}) {
  const db = openDb(opts.dbPath ?? ':memory:');
  const now = opts.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const secret = opts.secret ?? process.env.SEMS_SECRET ?? 'dev-only-secret-change-me';
  const ledger: Ledger = opts.ledger ?? new LocalLedger(db, now);
  const get = (sql: string, ...p: any[]): any => db.prepare(sql).get(...p);
  const all = (sql: string, ...p: any[]): any[] => db.prepare(sql).all(...p);
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const j = (v: any) => (v === undefined ? null : JSON.stringify(v));
  const parse = (s: any) => (s == null ? null : JSON.parse(s));
  const fail = (s: number, c: string, m: string): never => { throw new AppError(s, c, m); };

  // ---------- audit & notifications ----------
  // Every audit row is chained: entry_hash = SHA-256(prev_hash | canonical(row)). Editing or deleting history breaks the chain.
  const GENESIS = '0'.repeat(64);
  const auditBody = (r: any) => ({ id: r.id, user_id: r.user_id, role: r.role, action: r.action, entity_type: r.entity_type, entity_id: r.entity_id,
    severity: r.severity, ip: r.ip, user_agent: r.user_agent, metadata: r.metadata, created_at: r.created_at });
  function audit(a: Partial<Actor> | null, action: string, entityType?: string, entityId?: string,
                 severity = 'INFO', meta?: any) {
    withTx(db, () => {
      const prev = get('SELECT entry_hash FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1')?.entry_hash ?? GENESIS;
      const row = { id: randomUUID(), user_id: a?.id ?? null, role: a?.role ?? null, action, entity_type: entityType ?? null, entity_id: entityId ?? null,
        severity, ip: a?.ip ?? null, user_agent: a?.ua ?? null, metadata: j(meta), created_at: iso() };
      run(`INSERT INTO audit_logs (id,user_id,role,action,entity_type,entity_id,severity,ip,user_agent,metadata,created_at,prev_hash,entry_hash)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, row.id, row.user_id, row.role, row.action, row.entity_type, row.entity_id, row.severity,
        row.ip, row.user_agent, row.metadata, row.created_at, prev, sha256(prev + '|' + canonical(row)));
    });
  }
  async function anchorAuditHead() {
    const head = get('SELECT entry_hash h, (SELECT COUNT(*) FROM audit_logs WHERE entry_hash IS NOT NULL) n FROM audit_logs WHERE entry_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1');
    if (!head) return false;
    const last = get('SELECT head_hash FROM audit_anchors ORDER BY id DESC LIMIT 1');
    if (last?.head_hash === head.h) return false;
    const tx = await ledger.anchor(head.h);
    run('INSERT INTO audit_anchors (head_hash,entries,tx_ref,block_index,created_at) VALUES (?,?,?,?,?)', head.h, head.n, tx.txRef, tx.blockIndex, iso());
    return true;
  }
  async function verifyAuditChain() {
    await anchorAuditHead();
    let prev: string | null = null, entries = 0, legacy = 0;
    const broken = (rid: number, reason: string) => ({ valid: false, entries, brokenAtRow: rid, reason });
    for (const r of all('SELECT rowid AS rid, * FROM audit_logs ORDER BY rowid')) {
      if (!r.entry_hash) { if (prev !== null) return broken(r.rid, 'unhashed entry inside the chain'); legacy++; continue; }
      const expect = prev ?? GENESIS;
      if (r.prev_hash !== expect || sha256(expect + '|' + canonical(auditBody(r))) !== r.entry_hash) return broken(r.rid, 'entry was modified, removed or reordered');
      prev = r.entry_hash; entries++;
    }
    for (const an of all('SELECT * FROM audit_anchors ORDER BY id')) {                 // anchored heads must still exist and match the ledger
      const onLedger = await ledger.lookup(an.tx_ref);
      if (!get('SELECT 1 FROM audit_logs WHERE entry_hash=?', an.head_hash)) return broken(0, 'log was truncated (an anchored entry is missing)');
      if (!onLedger || onLedger.payloadHash !== an.head_hash || !onLedger.chainValid) return broken(0, 'ledger anchor mismatch');
    }
    return { valid: true, entries, legacyUnprotected: legacy, head: prev, anchors: get('SELECT COUNT(*) c FROM audit_anchors').c };
  }
  function notify(userId: string, title: string, message: string, priority = 'NORMAL') {
    run('INSERT INTO notifications VALUES (?,?,?,?,?,0,?)', randomUUID(), userId, title, message, priority, iso());
  }
  const notifyRole = (role: Role, t: string, m: string, p = 'HIGH') =>
    all("SELECT id FROM users WHERE role=? AND status='ACTIVE'", role).forEach((u) => notify(u.id, t, m, p));

  // ---------- auth ----------
  const publicUser = (u: any) => ({ id: u.id, email: u.email, name: u.name, role: u.role, status: u.status,
    mustChangePassword: !!u.must_change_password });

  function createUser(actor: Actor | null, i: any) {
    const email = String(i.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'VALIDATION', 'Valid email required.');
    if (!['ADMIN', 'FACULTY', 'STUDENT'].includes(i.role)) fail(400, 'VALIDATION', 'Invalid role.');
    if (!String(i.name ?? '').trim()) fail(400, 'VALIDATION', 'Name required.');
    const pe = passwordPolicyError(i.password); if (pe) fail(400, 'WEAK_PASSWORD', pe);
    if (get('SELECT 1 FROM users WHERE email=?', email)) fail(409, 'EMAIL_EXISTS', 'Email already registered.');
    const id = randomUUID();
    run('INSERT INTO users (id,email,name,role,password_hash,must_change_password,created_at) VALUES (?,?,?,?,?,?,?)',
      id, email, String(i.name).trim(), i.role, hashPassword(i.password), i.mustChangePassword ? 1 : 0, iso());
    audit(actor, 'USER_CREATED', 'user', id, 'INFO', { role: i.role });
    return publicUser(get('SELECT * FROM users WHERE id=?', id));
  }

  function login(email: string, password: string, ctx: { ip?: string | null; ua?: string | null } = {}, totpCode?: string) {
    const u = get('SELECT * FROM users WHERE email=?', String(email ?? '').trim().toLowerCase());
    const bad = () => fail(401, 'AUTH_INVALID_CREDENTIALS', 'Invalid email or password.');
    if (!u) { audit({ ...ctx }, 'FAILED_LOGIN', 'user', undefined, 'WARNING', { reason: 'unknown_email' }); return bad(); }
    if (u.locked_until && Date.parse(u.locked_until) > now().getTime()) {
      audit({ id: u.id, role: u.role, ...ctx }, 'FAILED_LOGIN', 'user', u.id, 'WARNING', { reason: 'locked' });
      fail(429, 'AUTH_LOCKED', 'Account temporarily locked. Try again later.');
    }
    if (typeof password !== 'string' || !verifyPassword(password, u.password_hash)) {
      const fails = u.failed_logins + 1;
      const lock = fails >= MAX_FAILS ? new Date(now().getTime() + LOCK_MS).toISOString() : null;
      run('UPDATE users SET failed_logins=?, locked_until=? WHERE id=?', lock ? 0 : fails, lock, u.id);
      audit({ id: u.id, role: u.role, ...ctx }, 'FAILED_LOGIN', 'user', u.id, lock ? 'HIGH' : 'WARNING', { attempts: fails });
      return bad();
    }
    if (u.status !== 'ACTIVE') fail(403, 'AUTH_ACCOUNT_DISABLED', 'Account is not active.');
    const m = get('SELECT * FROM mfa WHERE user_id=? AND enabled=1', u.id);
    if (m && !verifyTotp(unseal(m.secret, secret), totpCode, now().getTime())) {
      audit({ id: u.id, role: u.role, ...ctx }, 'FAILED_LOGIN', 'user', u.id, 'WARNING', { reason: 'mfa' });
      fail(401, 'MFA_REQUIRED', 'A valid verification code is required.');
    }
    run('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=?', u.id);
    const ttl = (u.role === 'ADMIN' ? 15 : 60) * 60_000;       // shorter admin sessions
    const sid = randomUUID(), exp = now().getTime() + ttl;
    run('INSERT INTO sessions VALUES (?,?,?,0,?)', sid, u.id, new Date(exp).toISOString(), iso());
    audit({ id: u.id, role: u.role, ...ctx }, 'LOGIN', 'user', u.id);
    return { token: signToken({ uid: u.id, sid, exp }, secret), user: publicUser(u) };
  }

  function authenticate(token: string, ctx: { ip?: string | null; ua?: string | null } = {}): Actor {
    const p = verifyToken(token, secret);
    if (!p || p.exp < now().getTime()) return fail(401, 'AUTH_REQUIRED', 'Authentication required.');
    const s = get('SELECT * FROM sessions WHERE id=?', p.sid);
    const u = get('SELECT * FROM users WHERE id=?', p.uid);
    if (!s || s.revoked || !u || u.status !== 'ACTIVE') return fail(401, 'AUTH_REQUIRED', 'Authentication required.');
    return { id: u.id, role: u.role, sid: p.sid, ...ctx };
  }
  function logout(a: Actor) {
    run('UPDATE sessions SET revoked=1 WHERE id=?', a.sid); audit(a, 'LOGOUT', 'user', a.id);
  }
  function reauth(a: Actor, password: string) {
    const u = get('SELECT * FROM users WHERE id=?', a.id);
    if (!password || !verifyPassword(password, u.password_hash)) {
      audit(a, 'REAUTH_FAILED', 'user', a.id, 'HIGH');
      fail(403, 'REAUTH_REQUIRED', 'Password confirmation required for this action.');
    }
  }
  function changePassword(a: Actor, oldPw: string, newPw: string) {
    reauth(a, oldPw);
    const pe = passwordPolicyError(newPw); if (pe) fail(400, 'WEAK_PASSWORD', pe);
    run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hashPassword(newPw), a.id);
    run('UPDATE sessions SET revoked=1 WHERE user_id=? AND id<>?', a.id, a.sid ?? '');
    audit(a, 'PASSWORD_CHANGE', 'user', a.id);
  }
  function setUserStatus(a: Actor, userId: string, status: string, password: string) {
    if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(status)) fail(400, 'VALIDATION', 'Invalid status.');
    reauth(a, password);                                           // sensitive action
    if (userId === a.id) fail(400, 'VALIDATION', 'You cannot change your own status.');
    if (!get('SELECT 1 FROM users WHERE id=?', userId)) fail(404, 'NOT_FOUND', 'User not found.');
    run('UPDATE users SET status=? WHERE id=?', status, userId);
    if (status !== 'ACTIVE') run('UPDATE sessions SET revoked=1 WHERE user_id=?', userId);
    audit(a, status === 'ACTIVE' ? 'USER_ACTIVATED' : 'USER_DEACTIVATED', 'user', userId, 'WARNING', { status });
  }
  const listUsers = (role?: string, limit = 500, offset = 0) =>
    all(`SELECT id,email,name,role,status,created_at FROM users ${role ? 'WHERE role=?' : ''} ORDER BY created_at, id LIMIT ? OFFSET ?`, ...(role ? [role] : []), Math.min(Math.max(limit, 1), 500), Math.max(offset, 0));

  // ---------- exams & questions ----------
  function ownExam(a: Actor, examId: string) {
    const e = get('SELECT * FROM exams WHERE id=?', examId);
    if (!e || (a.role === 'FACULTY' && e.faculty_id !== a.id)) return fail(404, 'NOT_FOUND', 'Exam not found.');
    return e;
  }
  function createExam(a: Actor, i: any) {
    const title = String(i.title ?? '').trim(), subject = String(i.subject ?? '').trim();
    if (!title || !subject) fail(400, 'VALIDATION', 'Title and subject required.');
    if (Number.isNaN(Date.parse(i.startAt))) fail(400, 'VALIDATION', 'Valid startAt required.');
    const dur = Number(i.durationMin), pass = Number(i.passMarks ?? 0), maxV = Number(i.maxViolations ?? 3);
    if (!Number.isInteger(dur) || dur < 1 || dur > 600) fail(400, 'VALIDATION', 'durationMin must be 1-600.');
    if (!(pass >= 0)) fail(400, 'VALIDATION', 'passMarks invalid.');
    if (!Number.isInteger(maxV) || maxV < 1) fail(400, 'VALIDATION', 'maxViolations must be >= 1.');
    const policy = i.violationPolicy ?? 'FLAG';
    if (!['WARN_ONLY', 'FLAG', 'AUTO_SUBMIT'].includes(policy)) fail(400, 'VALIDATION', 'Invalid violationPolicy.');
    const id = randomUUID();
    run(`INSERT INTO exams (id,title,subject,faculty_id,start_at,duration_min,pass_marks,negative_marking,instructions,
         max_violations,violation_policy,publish_immediately,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, title, subject, a.id, new Date(i.startAt).toISOString(), dur, pass, i.negativeMarking ? 1 : 0,
      String(i.instructions ?? ''), maxV, policy, i.publishImmediately ? 1 : 0, iso());
    run('UPDATE exams SET randomize=?, require_webcam=?, show_answers=? WHERE id=?', i.randomize === undefined ? 1 : i.randomize ? 1 : 0, i.requireWebcam ? 1 : 0, i.showAnswers ? 1 : 0, id);
    audit(a, 'EXAM_CREATED', 'exam', id);
    return get('SELECT * FROM exams WHERE id=?', id);
  }
  function normalizeQuestion(i: any) {
    const type = i.type, marks = Number(i.marks), neg = Number(i.negMarks ?? 0);
    if (!['MCQ', 'MULTI', 'TF', 'SHORT', 'LONG'].includes(type)) fail(400, 'VALIDATION', 'Invalid question type.');
    if (!String(i.text ?? '').trim()) fail(400, 'VALIDATION', 'Question text required.');
    if (!(marks > 0) || !(neg >= 0)) fail(400, 'VALIDATION', 'Invalid marks.');
    let options: any = null, correct: any = null;
    if (type === 'MCQ' || type === 'MULTI') {
      options = i.options;
      if (!Array.isArray(options) || options.length < 2 || new Set(options.map((o: any) => o.id)).size !== options.length)
        fail(400, 'VALIDATION', 'At least two options with unique ids required.');
      options = options.map((o: any) => ({ id: String(o.id), text: String(o.text) }));
      const ids = options.map((o: any) => o.id);
      if (type === 'MCQ') { correct = String(i.correct); if (!ids.includes(correct)) fail(400, 'VALIDATION', 'Correct option invalid.'); }
      else {
        correct = i.correct;
        if (!Array.isArray(correct) || !correct.length || !correct.every((c: any) => ids.includes(String(c))))
          fail(400, 'VALIDATION', 'Correct options invalid.');
        correct = correct.map(String);
      }
    } else if (type === 'TF') {
      correct = String(i.correct);
      if (!['true', 'false'].includes(correct)) fail(400, 'VALIDATION', 'TF correct must be true/false.');
    }
    let keywords: string[] | null = null;                       // optional grading hints for SHORT/LONG (never auto-graded)
    if ((type === 'SHORT' || type === 'LONG') && i.keywords != null) {
      if (!Array.isArray(i.keywords) || i.keywords.length > 20) fail(400, 'VALIDATION', 'keywords must be a list of at most 20 items.');
      keywords = i.keywords.map((k: any) => String(k).trim().toLowerCase().slice(0, 50)).filter(Boolean); if (!keywords!.length) keywords = null;
    }
    return { type, text: String(i.text).trim(), options, correct, marks, neg, keywords,
      difficulty: ['EASY', 'MEDIUM', 'HARD'].includes(i.difficulty) ? i.difficulty : 'MEDIUM', topic: i.topic ?? null };
  }
  function addQuestion(a: Actor, examId: string, i: any) {
    const e = ownExam(a, examId);
    if (e.status !== 'DRAFT') fail(409, 'EXAM_LOCKED', 'Questions can only change while the exam is a draft.');
    const n = normalizeQuestion(i);
    const id = randomUUID();
    const pos = get('SELECT COUNT(*) c FROM questions WHERE exam_id=?', examId).c + 1;
    run('INSERT INTO questions (id,exam_id,position,type,text,options,correct,marks,neg_marks,difficulty,topic) VALUES (?,?,?,?,?,?,?,?,?,?,?)', id, examId, pos, n.type, n.text, j(n.options), j(n.correct),
      n.marks, n.neg, n.difficulty, n.topic);
    if (n.keywords) run('UPDATE questions SET keywords=? WHERE id=?', j(n.keywords), id);
    audit(a, 'QUESTION_CREATED', 'question', id, 'INFO', { examId });
    return { id, position: pos };
  }
  function setExamStatus(a: Actor, examId: string, status: string) {
    const e = ownExam(a, examId);
    if (!(TRANSITIONS[e.status] ?? []).includes(status)) fail(409, 'BAD_TRANSITION', `Cannot go from ${e.status} to ${status}.`);
    if (status === 'SCHEDULED' && !get('SELECT 1 FROM questions WHERE exam_id=?', examId))
      fail(409, 'NO_QUESTIONS', 'Add questions before scheduling.');
    run('UPDATE exams SET status=? WHERE id=?', status, examId);
    audit(a, 'EXAM_UPDATED', 'exam', examId, 'INFO', { status });
    if (status === 'SCHEDULED')
      all("SELECT id FROM users WHERE role='STUDENT' AND status='ACTIVE'").forEach((s) =>
        notify(s.id, 'Exam scheduled', `${e.title} starts ${e.start_at}`));
  }
  const listFacultyExams = (a: Actor) =>
    all(`SELECT * FROM exams ${a.role === 'FACULTY' ? 'WHERE faculty_id=?' : ''} ORDER BY start_at`, ...(a.role === 'FACULTY' ? [a.id] : []));

  // ---------- student exam engine ----------
  const loadQ = (examId: string) => all('SELECT * FROM questions WHERE exam_id=? ORDER BY position', examId)
    .map((q) => ({ ...q, options: parse(q.options), correct: parse(q.correct) }));
  const stripQ = (q: any) => ({ id: q.id, position: q.position, type: q.type, text: q.text, options: q.options,
    marks: q.marks, negMarks: q.neg_marks, difficulty: q.difficulty, topic: q.topic });  // never leaks `correct`

  function listStudentExams(a: Actor) {
    return all(`SELECT e.id,e.title,e.subject,e.start_at,e.duration_min,e.status,e.pass_marks,
        (SELECT status FROM attempts t WHERE t.exam_id=e.id AND t.student_id=?) attempt_status
        FROM exams e WHERE e.status IN ('SCHEDULED','LIVE','COMPLETED','EVALUATING','PUBLISHED') ORDER BY e.start_at`, a.id);
  }
  function examInfo(a: Actor, examId: string) {
    const e = get("SELECT * FROM exams WHERE id=? AND status IN ('SCHEDULED','LIVE','COMPLETED','EVALUATING','PUBLISHED')", examId);
    if (!e) return fail(404, 'NOT_FOUND', 'Exam not found.');
    const qs = loadQ(examId);
    return { id: e.id, title: e.title, subject: e.subject, startAt: e.start_at, durationMin: e.duration_min,
      totalQuestions: qs.length, totalMarks: qs.reduce((s, q) => s + q.marks, 0), passMarks: e.pass_marks,
      instructions: e.instructions, maxViolations: e.max_violations, violationPolicy: e.violation_policy,
      requireWebcam: !!e.require_webcam, randomize: !!e.randomize, showAnswers: !!e.show_answers };
  }
  function startAttempt(a: Actor, examId: string) {
    const e = get('SELECT * FROM exams WHERE id=?', examId);
    if (!e || !['SCHEDULED', 'LIVE'].includes(e.status)) return fail(404, 'NOT_FOUND', 'Exam not available.');
    const existing = get('SELECT * FROM attempts WHERE exam_id=? AND student_id=?', examId, a.id);
    if (existing) return attemptMeta(existing);                       // idempotent resume; never a second attempt
    const t = now().getTime(), start = Date.parse(e.start_at);
    if (t < start) fail(403, 'EXAM_NOT_STARTED', 'Exam has not started yet.');
    if (t > start + e.duration_min * 60_000) fail(403, 'EXAM_WINDOW_CLOSED', 'Exam window has closed.');
    const id = randomUUID();
    run('INSERT INTO attempts (id,exam_id,student_id,started_at,expires_at) VALUES (?,?,?,?,?)', id, examId, a.id, iso(),
      new Date(t + e.duration_min * 60_000).toISOString());          // server-authoritative deadline
    audit(a, 'EXAM_STARTED', 'attempt', id, 'INFO', { examId });
    return attemptMeta(get('SELECT * FROM attempts WHERE id=?', id));
  }
  const attemptMeta = (t: any) => ({ id: t.id, examId: t.exam_id, status: t.status, startedAt: t.started_at,
    expiresAt: t.expires_at, remainingSeconds: t.status === 'IN_PROGRESS'
      ? Math.max(0, Math.floor((Date.parse(t.expires_at) - now().getTime()) / 1000)) : 0, suspicious: !!t.suspicious });

  async function ownAttempt(a: Actor, attemptId: string) {
    const t = get('SELECT * FROM attempts WHERE id=? AND student_id=?', attemptId, a.id);   // ownership enforced in query
    if (!t) return fail(404, 'NOT_FOUND', 'Attempt not found.');
    if (t.status === 'IN_PROGRESS' && now().getTime() > Date.parse(t.expires_at)) {         // lazy timeout enforcement
      await finalize(t.id, 'AUTO_SUBMITTED', a);
      return get('SELECT * FROM attempts WHERE id=?', attemptId);
    }
    return t;
  }
  async function getAttemptView(a: Actor, attemptId: string) {
    const t = await ownAttempt(a, attemptId);
    const answers: Record<string, any> = {};
    all('SELECT question_id, answer FROM answers WHERE attempt_id=?', t.id).forEach((r) => (answers[r.question_id] = parse(r.answer)));
    const e = get('SELECT randomize FROM exams WHERE id=?', t.exam_id);
    let qs = loadQ(t.exam_id);
    if (e.randomize) {                                          // per-attempt stable shuffle: same student always sees the same order, others differ
      const k = (...p: string[]) => sha256([t.id, ...p].join('|'));
      qs = qs.map((q) => ({ ...q, options: q.options ? [...q.options].sort((x: any, y: any) => (k(q.id, x.id) < k(q.id, y.id) ? -1 : 1)) : q.options }))
        .sort((x, y) => (k(x.id) < k(y.id) ? -1 : 1));
    }
    return { attempt: attemptMeta(t), questions: qs.map(stripQ), answers,
      violationCount: get('SELECT COUNT(*) c FROM violations WHERE attempt_id=?', t.id).c };
  }
  async function saveAnswer(a: Actor, attemptId: string, qid: string, answer: any, seq = 0) {
    const t = await ownAttempt(a, attemptId);
    if (t.status !== 'IN_PROGRESS') fail(409, 'ATTEMPT_CLOSED', 'This attempt is closed; answers can no longer change.');
    const q = get('SELECT * FROM questions WHERE id=? AND exam_id=?', qid, t.exam_id);
    if (!q) fail(404, 'NOT_FOUND', 'Question not found.');
    if (answer === null || answer === '' || (Array.isArray(answer) && !answer.length)) {
      run('DELETE FROM answers WHERE attempt_id=? AND question_id=?', t.id, qid); return { saved: true };
    }
    const opts = (parse(q.options) ?? []).map((o: any) => o.id);
    if (q.type === 'MCQ' && !opts.includes(String(answer))) fail(400, 'VALIDATION', 'Invalid option.');
    if (q.type === 'MULTI' && !(Array.isArray(answer) && answer.every((x: any) => opts.includes(String(x))))) fail(400, 'VALIDATION', 'Invalid options.');
    if (q.type === 'TF' && !['true', 'false'].includes(String(answer))) fail(400, 'VALIDATION', 'Invalid answer.');
    if ((q.type === 'SHORT' || q.type === 'LONG') && (typeof answer !== 'string' || answer.length > 10000)) fail(400, 'VALIDATION', 'Invalid text answer.');
    // UPSERT: retries never create duplicates; stale (lower seq) retries never overwrite newer answers.
    run(`INSERT INTO answers (attempt_id,question_id,answer,seq,saved_at) VALUES (?,?,?,?,?)
         ON CONFLICT(attempt_id,question_id) DO UPDATE SET answer=excluded.answer, seq=excluded.seq, saved_at=excluded.saved_at
         WHERE excluded.seq >= answers.seq`, t.id, qid, j(answer), seq, iso());
    return { saved: true };
  }
  async function submitAttempt(a: Actor, attemptId: string) {
    const t = await ownAttempt(a, attemptId);
    if (t.status !== 'IN_PROGRESS') fail(409, 'ALREADY_SUBMITTED', 'This exam was already submitted.');
    await finalize(t.id, 'SUBMITTED', a);
    return studentResult(a, attemptId);
  }

  // Close an attempt exactly once, grade it, and anchor its integrity hash.
  async function finalize(attemptId: string, status: 'SUBMITTED' | 'AUTO_SUBMITTED', who: Partial<Actor> | null) {
    const t = get('SELECT * FROM attempts WHERE id=?', attemptId);
    const at = status === 'AUTO_SUBMITTED' && now().getTime() > Date.parse(t.expires_at) ? t.expires_at : iso();
    const r = run("UPDATE attempts SET status=?, submitted_at=? WHERE id=? AND status='IN_PROGRESS'", status, at, attemptId);
    if (Number(r.changes) !== 1) return;                               // lost the race: someone else finalized
    const e = get('SELECT * FROM exams WHERE id=?', t.exam_id);
    computeResult(attemptId);
    await anchor(attemptId);
    audit(who ?? { id: t.student_id }, 'EXAM_SUBMITTED', 'attempt', attemptId, 'INFO', { status });
    notify(e.faculty_id, 'Submission received', `A student submitted "${e.title}".`);
    if (get('SELECT eval_status FROM results WHERE attempt_id=?', attemptId).eval_status !== 'COMPLETE')
      notify(e.faculty_id, 'Pending evaluation', `Subjective answers in "${e.title}" need marking.`);
  }
  async function autoSubmitExpired() {
    const rows = all("SELECT id FROM attempts WHERE status='IN_PROGRESS' AND expires_at < ?", iso());
    for (const r of rows) await finalize(r.id, 'AUTO_SUBMITTED', null);
    return rows.length;
  }

  function computeResult(attemptId: string) {
    const t = get('SELECT * FROM attempts WHERE id=?', attemptId), e = get('SELECT * FROM exams WHERE id=?', t.exam_id);
    const ans = new Map<string, any>(all('SELECT question_id, answer FROM answers WHERE attempt_id=?', attemptId).map((r) => [r.question_id, parse(r.answer)]));
    const man = new Map<string, number>(all('SELECT question_id, marks FROM manual_marks WHERE attempt_id=?', attemptId).map((r) => [r.question_id, r.marks]));
    const g = grade(loadQ(t.exam_id), ans, man, e);
    const publish = e.publish_immediately && g.eval_status === 'COMPLETE' ? 1 : 0;
    run(`INSERT INTO results (attempt_id,total_questions,attempted,correct,incorrect,unanswered,positive_marks,negative_marks,
         score,max_marks,percentage,grade,passed,eval_status,published) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(attempt_id) DO UPDATE SET total_questions=excluded.total_questions, attempted=excluded.attempted,
         correct=excluded.correct, incorrect=excluded.incorrect, unanswered=excluded.unanswered, positive_marks=excluded.positive_marks,
         negative_marks=excluded.negative_marks, score=excluded.score, max_marks=excluded.max_marks, percentage=excluded.percentage,
         grade=excluded.grade, passed=excluded.passed, eval_status=excluded.eval_status,
         published = MAX(results.published, excluded.published)`,
      attemptId, g.total_questions, g.attempted, g.correct, g.incorrect, g.unanswered, g.positive_marks, g.negative_marks,
      g.score, g.max_marks, g.percentage, g.grade, g.passed, g.eval_status, publish);
    if (publish) notify(t.student_id, 'Result published', `Your result for "${e.title}" is available.`);
  }

  // ---------- results ----------
  function studentResult(a: Actor, attemptId: string) {
    const t = get('SELECT * FROM attempts WHERE id=? AND student_id=?', attemptId, a.id);
    if (!t) return fail(404, 'NOT_FOUND', 'Result not found.');          // 404 (not 403) avoids confirming others' IDs
    const e = get('SELECT title,subject FROM exams WHERE id=?', t.exam_id), r = get('SELECT * FROM results WHERE attempt_id=?', attemptId);
    if (!r) return { exam: e, status: t.status, published: false };
    if (!r.published) return { exam: e, status: t.status, published: false, evalStatus: r.eval_status };
    return { exam: e, status: t.status, ...r, published: true, passed: !!r.passed };
  }
  const listStudentResults = (a: Actor) =>
    all('SELECT id FROM attempts WHERE student_id=? ORDER BY started_at DESC', a.id).map((t) => studentResult(a, t.id));

  async function evaluate(a: Actor, attemptId: string, marks: Record<string, number | { marks: number; comment?: string | null }>, remarks?: string) {
    const t = get('SELECT * FROM attempts WHERE id=?', attemptId);
    if (!t) return fail(404, 'NOT_FOUND', 'Attempt not found.');
    ownExam(a, t.exam_id);
    if (t.status === 'IN_PROGRESS') fail(409, 'ATTEMPT_OPEN', 'Attempt not submitted yet.');
    for (const [qid, raw] of Object.entries(marks ?? {})) {
      const obj = raw !== null && typeof raw === 'object' ? (raw as any) : null;
      const m: any = obj ? obj.marks : raw, comment = obj && obj.comment != null ? String(obj.comment).slice(0, 1000) : null;
      const q = get('SELECT * FROM questions WHERE id=? AND exam_id=?', qid, t.exam_id);
      if (!q || !['SHORT', 'LONG'].includes(q.type)) fail(400, 'VALIDATION', 'Only subjective questions of this exam can be marked.');
      if (typeof m !== 'number' || m < 0 || m > q.marks) fail(400, 'VALIDATION', `Marks must be between 0 and ${q.marks}.`);
      run('INSERT INTO manual_marks (attempt_id,question_id,marks,comment) VALUES (?,?,?,?) ON CONFLICT(attempt_id,question_id) DO UPDATE SET marks=excluded.marks, comment=COALESCE(excluded.comment, manual_marks.comment)', attemptId, qid, m, comment);
    }
    computeResult(attemptId);
    if (remarks !== undefined) run('UPDATE results SET remarks=? WHERE attempt_id=?', String(remarks).slice(0, 1000), attemptId);
    await anchor(attemptId);                                           // new on-chain version after evaluation
    audit(a, 'EXAM_EVALUATED', 'attempt', attemptId);
    return get('SELECT * FROM results WHERE attempt_id=?', attemptId);
  }
  function publishResults(a: Actor, examId: string, password: string) {
    const e = ownExam(a, examId); reauth(a, password);
    const rows = all(`SELECT r.attempt_id, t.student_id FROM results r JOIN attempts t ON t.id=r.attempt_id
                      WHERE t.exam_id=? AND r.eval_status='COMPLETE' AND r.published=0`, examId);
    for (const r of rows) { run('UPDATE results SET published=1 WHERE attempt_id=?', r.attempt_id);
      notify(r.student_id, 'Result published', `Your result for "${e.title}" is available.`); }
    audit(a, 'RESULT_PUBLISHED', 'exam', examId, 'INFO', { count: rows.length });
    return { published: rows.length };
  }

  // ---------- violations ----------
  async function recordViolation(a: Actor, attemptId: string, i: any) {
    const t = await ownAttempt(a, attemptId);
    if (!VIOLATIONS[i?.type]) fail(400, 'VALIDATION', 'Unknown violation type.');
    if (t.status !== 'IN_PROGRESS') fail(409, 'ATTEMPT_CLOSED', 'Attempt is closed.');
    const e = get('SELECT * FROM exams WHERE id=?', t.exam_id), sev = VIOLATIONS[i.type];
    run('INSERT INTO violations VALUES (?,?,?,?,?,?,?,?,?,?)', randomUUID(), t.id, a.id, t.exam_id, i.type, sev,
      String(i.description ?? '').slice(0, 500), a.ip ?? null, a.ua ?? null, iso());
    audit(a, i.type, 'attempt', t.id, sev === 'LOW' ? 'INFO' : 'WARNING', { examId: t.exam_id });
    const signalOnly = SIGNAL_ONLY.has(i.type);
    const count = get(`SELECT COUNT(*) c FROM violations WHERE attempt_id=? AND type NOT IN ('HEARTBEAT_GAP','CAMERA_UNAVAILABLE','CAMERA_COVERED')`, t.id).c;
    let action = signalOnly ? 'SIGNAL_RECORDED' : 'WARNING';
    const flag = (reason: string, detail: any) => {
      if (t.suspicious) return; t.suspicious = 1;
      run('UPDATE attempts SET suspicious=1 WHERE id=?', t.id);
      audit(a, 'SUSPICIOUS_ACTIVITY', 'attempt', t.id, 'HIGH', { ...detail, reason });
      notifyRole('ADMIN', 'Suspicious exam session', `A student was flagged in "${e.title}" (${reason.replace('_', ' ')}).`);
      notify(e.faculty_id, 'Suspicious exam session', `A student was flagged in "${e.title}".`, 'HIGH');
    };
    if (!signalOnly && count >= e.max_violations && e.violation_policy !== 'WARN_ONLY') {
      action = 'FLAGGED'; flag('violation_count', { violations: count });
      if (e.violation_policy === 'AUTO_SUBMIT') { await finalize(t.id, 'AUTO_SUBMITTED', a); action = 'AUTO_SUBMITTED'; }
    } else if (e.violation_policy !== 'WARN_ONLY') {         // continuous analysis: combined weak signals can flag even below the count threshold
      const risk = riskAssessment(t.id);
      if (risk.score >= RISK_FLAG_AT) { flag('risk_score', { score: risk.score }); if (!signalOnly) action = 'FLAGGED'; }
    }
    return { count, max: e.max_violations, action };
  }
  // Continuous behavioural risk score (explainable: every point is attributable to a listed signal). Advisory only: never fails a student.
  function riskAssessment(attemptId: string) {
    const t = get('SELECT * FROM attempts WHERE id=?', attemptId);
    const vs = all('SELECT type, created_at FROM violations WHERE attempt_id=? ORDER BY created_at', attemptId);
    const signals: { code: string; points: number; detail: string }[] = [], byType: Record<string, number> = {};
    vs.forEach((v) => (byType[v.type] = (byType[v.type] ?? 0) + 1));
    for (const [type, n] of Object.entries(byType)) signals.push({ code: type, points: Math.min(30, n * (RISK_WEIGHT[type] ?? 1)), detail: `${n} event(s)` });
    const ts = vs.map((v) => Date.parse(v.created_at));
    for (let k = 0; k + 2 < ts.length; k++) if (ts[k + 2] - ts[k] <= 60_000) { signals.push({ code: 'BURST', points: 15, detail: '3+ events within 60 seconds' }); break; }
    const answered = get('SELECT COUNT(*) c FROM answers WHERE attempt_id=?', attemptId).c;
    if (t.submitted_at && answered >= 5) {
      const secs = (Date.parse(t.submitted_at) - Date.parse(t.started_at)) / 1000;
      if (secs / answered < 3) signals.push({ code: 'RAPID_ANSWERING', points: 10, detail: `${answered} answers in ${Math.round(secs)} s` });
    }
    const score = signals.reduce((x, y) => x + y.points, 0);
    return { score, level: score >= RISK_FLAG_AT ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW', signals };
  }
  async function heartbeat(a: Actor, attemptId: string) {
    const t = await ownAttempt(a, attemptId);
    if (t.status !== 'IN_PROGRESS') return attemptMeta(t);
    const last = t.last_heartbeat ? Date.parse(t.last_heartbeat) : null, nowMs = now().getTime();
    run('UPDATE attempts SET last_heartbeat=? WHERE id=?', iso(), t.id);
    if (last !== null && (nowMs - last) / 1000 > HEARTBEAT_GAP_S)
      await recordViolation(a, attemptId, { type: 'HEARTBEAT_GAP', description: `no signal for ${Math.round((nowMs - last) / 1000)} s` });
    return attemptMeta(get('SELECT * FROM attempts WHERE id=?', attemptId));       // includes server remaining time for clock re-sync
  }
  function studentReview(a: Actor, attemptId: string) {
    const t = get('SELECT * FROM attempts WHERE id=? AND student_id=?', attemptId, a.id);
    if (!t) return fail(404, 'NOT_FOUND', 'Result not found.');
    const r = get('SELECT * FROM results WHERE attempt_id=?', attemptId);
    if (!r || !r.published) return { published: false };
    const e = get('SELECT * FROM exams WHERE id=?', t.exam_id), qs = loadQ(t.exam_id);
    const ans = new Map<string, any>(all('SELECT question_id, answer FROM answers WHERE attempt_id=?', attemptId).map((x) => [x.question_id, parse(x.answer)]));
    const mm = all('SELECT question_id, marks, comment FROM manual_marks WHERE attempt_id=?', attemptId);
    const man = new Map<string, number>(mm.map((x) => [x.question_id, x.marks])), com = new Map<string, string>(mm.map((x) => [x.question_id, x.comment]));
    const pq = perQuestion(qs, ans, man, e);
    const rows = qs.map((q) => {
      const subj = q.type === 'SHORT' || q.type === 'LONG', info = pq.get(q.id)!;
      if (!e.show_answers && !subj) return null;                    // exam setting controls whether right/wrong detail is shown
      return { id: q.id, text: q.text, type: q.type, marks: q.marks, yourAnswer: ans.get(q.id) ?? null, status: info.status, awarded: info.awarded,
        comment: com.get(q.id) ?? null, ...(e.show_answers && !subj ? { correct: q.correct, options: q.options } : {}) };
    }).filter(Boolean);
    return { published: true, showAnswers: !!e.show_answers, remarks: r.remarks, questions: rows };
  }
  function examViolations(a: Actor, examId: string) {
    ownExam(a, examId);
    return all('SELECT * FROM violations WHERE exam_id=? ORDER BY created_at DESC', examId);
  }
  function securitySummary(f: { from?: string; to?: string; examId?: string } = {}) {
    const w: string[] = [], p: any[] = [];
    if (f.from) { w.push('created_at >= ?'); p.push(f.from); }
    if (f.to) { w.push('created_at <= ?'); p.push(f.to); }
    if (f.examId) { w.push('exam_id = ?'); p.push(f.examId); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const byType: Record<string, number> = {};
    all(`SELECT type, COUNT(*) c FROM violations ${where} GROUP BY type`, ...p).forEach((r) => (byType[r.type] = r.c));
    return { violationsByType: byType, totalViolations: Object.values(byType).reduce((s, n) => s + n, 0),
      failedLogins: get("SELECT COUNT(*) c FROM audit_logs WHERE action='FAILED_LOGIN'").c,
      suspiciousSessions: get('SELECT COUNT(*) c FROM attempts WHERE suspicious=1').c };
  }
  function listAudit(f: { action?: string; severity?: string; limit?: number; offset?: number } = {}) {
    const w: string[] = [], p: any[] = [];
    if (f.action) { w.push('action=?'); p.push(f.action); }
    if (f.severity) { w.push('severity=?'); p.push(f.severity); }
    return all(`SELECT * FROM audit_logs ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, ...p, Math.min(f.limit ?? 100, 500), Math.max(f.offset ?? 0, 0));
  }
  const listNotifications = (a: Actor) => all('SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100', a.id);
  const markNotificationRead = (a: Actor, id: string) => run('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?', id, a.id);

  // ---------- blockchain integrity ----------
  // Hash covers submission + grading data only: no names, emails or passwords ever leave PostgreSQL/SQL.
  function integrityPayload(attemptId: string) {
    const t = get('SELECT * FROM attempts WHERE id=?', attemptId);
    const r = get('SELECT * FROM results WHERE attempt_id=?', attemptId);
    return {
      attemptId: t.id, examId: t.exam_id, studentId: t.student_id, status: t.status, submittedAt: t.submitted_at,
      answers: all('SELECT question_id q, answer a FROM answers WHERE attempt_id=? ORDER BY question_id', attemptId),
      manualMarks: all('SELECT question_id q, marks m FROM manual_marks WHERE attempt_id=? ORDER BY question_id', attemptId),
      result: { score: r.score, positive: r.positive_marks, negative: r.negative_marks, max: r.max_marks,
        percentage: r.percentage, grade: r.grade, passed: r.passed, evalStatus: r.eval_status },
    };
  }
  const computeHash = (attemptId: string) => sha256(canonical(integrityPayload(attemptId)));
  async function anchor(attemptId: string) {
    const hash = computeHash(attemptId);
    if (get('SELECT 1 FROM blockchain_records WHERE attempt_id=? AND hash=? ORDER BY id DESC LIMIT 1', attemptId, hash)) return;   // already anchored (idempotent)
    const tx = await ledger.anchor(hash);
    run('INSERT INTO blockchain_records (attempt_id,hash,tx_ref,block_index,created_at) VALUES (?,?,?,?,?)', attemptId, hash, tx.txRef, tx.blockIndex, iso());
  }
  async function verifyIntegrity(a: Actor, attemptId: string) {
    const t = get('SELECT * FROM attempts WHERE id=?', attemptId);
    if (!t) return fail(404, 'NOT_FOUND', 'Submission not found.');
    if (a.role === 'FACULTY') ownExam(a, t.exam_id);
    const rec = get('SELECT * FROM blockchain_records WHERE attempt_id=? ORDER BY id DESC LIMIT 1', attemptId);
    if (!rec) return fail(409, 'NOT_ANCHORED', 'Submission has no blockchain record yet.');
    const recalculated = computeHash(attemptId), onChain = await ledger.lookup(rec.tx_ref);
    const verified = !!onChain && onChain.chainValid && recalculated === rec.hash && onChain.payloadHash === recalculated;
    audit(a, 'INTEGRITY_VERIFIED', 'attempt', attemptId, verified ? 'INFO' : 'CRITICAL', { verified });
    if (!verified) notifyRole('ADMIN', 'Integrity mismatch', `Submission ${attemptId} failed integrity verification.`, 'HIGH');
    return { submissionId: attemptId, verified, verdict: verified ? 'INTEGRITY VERIFIED' : 'INTEGRITY MISMATCH',
      recalculatedHash: recalculated, storedHash: rec.hash, onChainHash: onChain?.payloadHash ?? null,
      txRef: rec.tx_ref, anchoredAt: rec.created_at, chainValid: onChain?.chainValid ?? false, verifiedAt: iso() };
  }

  function mfaSetup(a: Actor) {
    const seed = base32(randomBytes(20)), u = get('SELECT email FROM users WHERE id=?', a.id);
    run('INSERT INTO mfa VALUES (?,?,0) ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret, enabled=0', a.id, seal(seed, secret));
    return { secret: seed, otpauthUrl: `otpauth://totp/SEMS:${encodeURIComponent(u.email)}?secret=${seed}&issuer=SEMS` };
  }
  function mfaEnable(a: Actor, code: string) {
    const m = get('SELECT * FROM mfa WHERE user_id=?', a.id);
    if (!m || !verifyTotp(unseal(m.secret, secret), code, now().getTime())) fail(400, 'MFA_INVALID', 'Invalid verification code.');
    run('UPDATE mfa SET enabled=1 WHERE user_id=?', a.id); audit(a, 'MFA_ENABLED', 'user', a.id);
  }

  function updateUser(a: Actor, userId: string, i: any, password?: string) {
    const u = get('SELECT * FROM users WHERE id=?', userId); if (!u) fail(404, 'NOT_FOUND', 'User not found.');
    const name = i.name === undefined ? u.name : String(i.name).trim();
    const email = i.email === undefined ? u.email : String(i.email).trim().toLowerCase();
    if (!name || name.length > 100) fail(400, 'VALIDATION', 'Valid name required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'VALIDATION', 'Valid email required.');
    if (email !== u.email) {                                     // email = login identity: sensitive, needs re-auth
      reauth(a, password as string);
      if (get('SELECT 1 FROM users WHERE email=? AND id<>?', email, userId)) fail(409, 'EMAIL_EXISTS', 'Email already registered.');
      run('UPDATE sessions SET revoked=1 WHERE user_id=?', userId);
    }
    run('UPDATE users SET name=?, email=? WHERE id=?', name, email, userId);
    audit(a, 'USER_UPDATED', 'user', userId, email !== u.email ? 'WARNING' : 'INFO', { emailChanged: email !== u.email });
    return publicUser(get('SELECT * FROM users WHERE id=?', userId));
  }
  const hasMfa = (userId: string) => !!get('SELECT 1 FROM mfa WHERE user_id=? AND enabled=1', userId);

  // Housekeeping for any instance: close expired attempts, repair half-finished submissions, anchor audit head, prune throttle rows.
  async function repairSubmissions() {
    const cutoff = new Date(now().getTime() - 60_000).toISOString();                 // grace period: never touch a submission another instance is still finalising
    const rows = all(`SELECT t.id FROM attempts t WHERE t.status<>'IN_PROGRESS' AND t.submitted_at < ? AND (
        NOT EXISTS (SELECT 1 FROM results r WHERE r.attempt_id=t.id) OR NOT EXISTS (SELECT 1 FROM blockchain_records b WHERE b.attempt_id=t.id))`, cutoff);
    for (const r of rows) { if (!get('SELECT 1 FROM results WHERE attempt_id=?', r.id)) computeResult(r.id); await anchor(r.id); }
    return rows.length;
  }
  async function maintenance() {
    const submitted = await autoSubmitExpired(), repaired = await repairSubmissions();
    await anchorAuditHead();
    run('DELETE FROM ip_hits WHERE w < ?', Math.floor(now().getTime() / 60000) - 5);
    return { submitted, repaired };
  }

  return { db, now, ledger, audit, createUser, login, authenticate, logout, changePassword, setUserStatus, listUsers,
    createExam, addQuestion, setExamStatus, listFacultyExams, listStudentExams, examInfo, startAttempt, getAttemptView,
    saveAnswer, submitAttempt, autoSubmitExpired, studentResult, listStudentResults, evaluate, publishResults,
    recordViolation, examViolations, securitySummary, listAudit, listNotifications, markNotificationRead,
    computeHash, verifyIntegrity, normalizeQuestion, notify, mfaSetup, mfaEnable, updateUser, hasMfa, verifyAuditChain, anchorAuditHead, maintenance, repairSubmissions, riskAssessment, heartbeat, studentReview };
}
export type Sems = ReturnType<typeof createSems>;
