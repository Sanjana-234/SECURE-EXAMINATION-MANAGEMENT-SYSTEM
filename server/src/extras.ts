import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { AppError, type Sems, type Actor } from './service.ts';
import { sha256 } from './ledger.ts';

const fail = (s: number, c: string, m: string): never => { throw new AppError(s, c, m); };
const MAX_FILE = 5 * 1024 * 1024;

// Extension allow-list + content sniffing: the extension alone is never trusted.
const startsWith = (b: Buffer, sig: number[]) => sig.every((x, i) => b[i] === x);
const zipLike = (marker: string) => (b: Buffer) => startsWith(b, [0x50, 0x4b, 3, 4]) && b.includes('[Content_Types].xml') && b.includes(marker);
const ole = (b: Buffer) => startsWith(b, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ALLOWED: Record<string, { mime: string; ok: (b: Buffer) => boolean }> = {
  pdf: { mime: 'application/pdf', ok: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  png: { mime: 'image/png', ok: (b) => startsWith(b, [0x89, 0x50, 0x4e, 0x47]) },
  jpg: { mime: 'image/jpeg', ok: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  jpeg: { mime: 'image/jpeg', ok: (b) => startsWith(b, [0xff, 0xd8, 0xff]) },
  gif: { mime: 'image/gif', ok: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ok: zipLike('word/') },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ok: zipLike('ppt/') },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ok: zipLike('xl/') },
  doc: { mime: 'application/msword', ok: ole }, ppt: { mime: 'application/vnd.ms-powerpoint', ok: ole },
  txt: { mime: 'text/plain', ok: (b) => !b.subarray(0, 8192).includes(0) },
};
const isExecutable = (b: Buffer) => startsWith(b, [0x4d, 0x5a]) || startsWith(b, [0x7f, 0x45, 0x4c, 0x46]) ||
  startsWith(b, [0x23, 0x21]) || startsWith(b, [0xca, 0xfe, 0xba, 0xbe]) || startsWith(b, [0xcf, 0xfa, 0xed, 0xfe]);
export function sanitizeFilename(n: string): string {
  const base = basename(String(n ?? '').replace(/\\/g, '/')).replace(/[^A-Za-z0-9._ -]/g, '_').replace(/\.{2,}/g, '.').trim();
  return base.slice(-100) || 'file';
}

export function createExtras(s: Sems, opts: { uploadDir?: string } = {}) {
  const dir = opts.uploadDir ?? process.env.SEMS_UPLOADS ?? './uploads';
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const { db } = s;
  const get = (sql: string, ...p: any[]): any => db.prepare(sql).get(...p);
  const all = (sql: string, ...p: any[]): any[] => db.prepare(sql).all(...p);
  const run = (sql: string, ...p: any[]) => db.prepare(sql).run(...p);
  const iso = () => s.now().toISOString();
  const parse = (v: any) => (v == null ? null : JSON.parse(v));
  const j = (v: any) => (v == null ? null : JSON.stringify(v));
  const profile = (id: string) => get('SELECT department, class_name FROM profiles WHERE user_id=?', id) ?? { department: null, class_name: null };
  const matches = (row: any, p: any) => (!row.department || row.department === p.department) && (!row.class_name || row.class_name === p.class_name);
  const activeStudents = () => all("SELECT id,name FROM users WHERE role='STUDENT' AND status='ACTIVE'");

  // ---------- profile & catalog ----------
  function me(a: Actor) {
    const u = get('SELECT id,email,name,role,status FROM users WHERE id=?', a.id);
    return { ...u, profile: profile(a.id), mfaEnabled: !!get('SELECT 1 FROM mfa WHERE user_id=? AND enabled=1', a.id) };
  }
  function setProfile(a: Actor, userId: string, i: any) {
    if (!get('SELECT 1 FROM users WHERE id=?', userId)) fail(404, 'NOT_FOUND', 'User not found.');
    run('INSERT INTO profiles VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET department=excluded.department, class_name=excluded.class_name',
      userId, i.department ? String(i.department).slice(0, 100) : null, i.className ? String(i.className).slice(0, 100) : null);
    s.audit(a, 'PROFILE_UPDATED', 'user', userId);
  }
  function createCatalog(a: Actor, kind: string, name: string) {
    if (!['DEPARTMENT', 'COURSE', 'SUBJECT'].includes(kind)) fail(400, 'VALIDATION', 'Invalid kind.');
    const n = String(name ?? '').trim(); if (!n || n.length > 100) fail(400, 'VALIDATION', 'Name required (max 100).');
    if (get('SELECT 1 FROM catalog WHERE kind=? AND name=?', kind, n)) fail(409, 'EXISTS', 'Already exists.');
    const id = randomUUID(); run('INSERT INTO catalog VALUES (?,?,?,1,?)', id, kind, n, iso());
    s.audit(a, 'CATALOG_CREATED', kind.toLowerCase(), id); return { id, kind, name: n };
  }
  const listCatalog = (kind: string) => all('SELECT * FROM catalog WHERE kind=? ORDER BY name', kind);
  function setCatalogActive(a: Actor, id: string, active: boolean) {            // soft state, never hard delete
    if (!Number(run('UPDATE catalog SET active=? WHERE id=?', active ? 1 : 0, id).changes)) fail(404, 'NOT_FOUND', 'Not found.');
    s.audit(a, 'CATALOG_UPDATED', 'catalog', id, 'INFO', { active });
  }

  // ---------- notices ----------
  function createNotice(a: Actor, i: any) {
    const title = String(i.title ?? '').trim(), message = String(i.message ?? '').trim();
    if (!title || !message) fail(400, 'VALIDATION', 'Title and message required.');
    const pr = i.priority ?? 'NORMAL'; if (!['LOW', 'NORMAL', 'HIGH'].includes(pr)) fail(400, 'VALIDATION', 'Invalid priority.');
    const pub = i.publishAt ? Date.parse(i.publishAt) : s.now().getTime(), exp = i.expiresAt ? Date.parse(i.expiresAt) : null;
    if (Number.isNaN(pub) || (exp !== null && (Number.isNaN(exp) || exp <= pub))) fail(400, 'VALIDATION', 'Invalid dates.');
    const id = randomUUID();
    run('INSERT INTO notices VALUES (?,?,?,?,?,?,?,?,?,?)', id, a.id, title.slice(0, 200), message.slice(0, 5000), i.department ?? null,
      i.className ?? null, pr, new Date(pub).toISOString(), exp ? new Date(exp).toISOString() : null, iso());
    s.audit(a, 'NOTICE_CREATED', 'notice', id);
    if (pub <= s.now().getTime()) for (const st of activeStudents())
      if (matches({ department: i.department, class_name: i.className }, profile(st.id))) s.notify(st.id, `Notice: ${title}`, message.slice(0, 200), pr);
    return { id };
  }
  function listNotices(a: Actor) {
    const nowIso = iso();
    if (a.role !== 'STUDENT') return all(`SELECT * FROM notices ${a.role === 'FACULTY' ? 'WHERE author_id=?' : ''} ORDER BY publish_at DESC`, ...(a.role === 'FACULTY' ? [a.id] : []));
    const p = profile(a.id);
    return all('SELECT * FROM notices WHERE publish_at<=? AND (expires_at IS NULL OR expires_at>?) ORDER BY publish_at DESC', nowIso, nowIso).filter((n) => matches(n, p));
  }

  // ---------- resources (secure upload / authorised download) ----------
  function uploadResource(a: Actor, i: any) {
    const title = String(i.title ?? '').trim(); if (!title) fail(400, 'VALIDATION', 'Title required.');
    if (typeof i.contentBase64 !== 'string' || !i.contentBase64) fail(400, 'VALIDATION', 'File content required.');
    const buf = Buffer.from(i.contentBase64, 'base64');
    if (buf.length === 0) fail(400, 'VALIDATION', 'Empty file.');
    if (buf.length > MAX_FILE) fail(413, 'FILE_TOO_LARGE', 'File exceeds 5 MB.');
    const original = sanitizeFilename(i.filename), ext = (original.split('.').pop() ?? '').toLowerCase();
    const rule = ALLOWED[ext];
    if (!original.includes('.') || !rule) fail(415, 'FILE_TYPE_NOT_ALLOWED', 'File type not allowed.');
    if (isExecutable(buf) || !rule.ok(buf)) fail(415, 'FILE_CONTENT_MISMATCH', 'File content does not match its type.');
    const exp = i.expiresAt ? Date.parse(i.expiresAt) : null;
    if (exp !== null && Number.isNaN(exp)) fail(400, 'VALIDATION', 'Invalid expiry.');
    const id = randomUUID(), stored = `${id}.bin`;                         // user-supplied name never touches the filesystem
    writeFileSync(join(dir, stored), buf, { mode: 0o600 });
    run('INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)', id, a.id, title.slice(0, 200), String(i.description ?? '').slice(0, 1000),
      i.subject ?? null, i.department ?? null, i.className ?? null, exp ? new Date(exp).toISOString() : null, stored, original,
      rule.mime, buf.length, sha256(buf.toString('latin1')), iso());
    s.audit(a, 'RESOURCE_UPLOADED', 'resource', id, 'INFO', { size: buf.length, ext });
    for (const st of activeStudents()) if (matches({ department: i.department, class_name: i.className }, profile(st.id)))
      s.notify(st.id, 'New resource', title);
    return { id, name: original, mime: rule.mime, size: buf.length };
  }
  const visibleResource = (a: Actor, r: any) => a.role === 'ADMIN' || r.uploaded_by === a.id ||
    (a.role === 'STUDENT' && (!r.expires_at || Date.parse(r.expires_at) > s.now().getTime()) && matches(r, profile(a.id)));
  function listResources(a: Actor) {
    return all('SELECT id,title,description,subject,department,class_name,expires_at,original_name,mime,size,uploaded_by,created_at FROM resources ORDER BY created_at DESC')
      .filter((r) => visibleResource(a, r));
  }
  function downloadResource(a: Actor, id: string) {
    const r = get('SELECT * FROM resources WHERE id=?', id);
    if (!r || !visibleResource(a, r)) return fail(404, 'NOT_FOUND', 'Resource not found.');
    s.audit(a, 'RESOURCE_DOWNLOADED', 'resource', id);
    return { __file: { buffer: readFileSync(join(dir, r.stored_name)), name: r.original_name, mime: r.mime } };
  }
  function deleteResource(a: Actor, id: string) {
    const r = get('SELECT * FROM resources WHERE id=?', id);
    if (!r || (a.role !== 'ADMIN' && r.uploaded_by !== a.id)) return fail(404, 'NOT_FOUND', 'Resource not found.');
    run('DELETE FROM resources WHERE id=?', id); rmSync(join(dir, r.stored_name), { force: true });
    s.audit(a, 'RESOURCE_DELETED', 'resource', id);
  }

  // ---------- question bank ----------
  const bankOwn = (a: Actor, id: string) => {
    const q = get('SELECT * FROM question_bank WHERE id=? AND deleted=0', id);
    if (!q || (a.role !== 'ADMIN' && q.owner_id !== a.id)) return fail(404, 'NOT_FOUND', 'Question not found.');
    return q;
  };
  function bankAdd(a: Actor, i: any) {
    const n = s.normalizeQuestion(i), id = randomUUID();
    run('INSERT INTO question_bank VALUES (?,?,?,?,?,?,?,?,?,?,0,?)', id, a.id, n.type, n.text, j(n.options), j(n.correct), n.marks, n.neg, n.difficulty, n.topic, iso());
    s.audit(a, 'QUESTION_CREATED', 'question_bank', id); return { id };
  }
  function bankUpdate(a: Actor, id: string, i: any) {
    bankOwn(a, id); const n = s.normalizeQuestion(i);
    run('UPDATE question_bank SET type=?,text=?,options=?,correct=?,marks=?,neg_marks=?,difficulty=?,topic=? WHERE id=?',
      n.type, n.text, j(n.options), j(n.correct), n.marks, n.neg, n.difficulty, n.topic, id);
    s.audit(a, 'QUESTION_UPDATED', 'question_bank', id);
  }
  function bankDelete(a: Actor, id: string) { bankOwn(a, id); run('UPDATE question_bank SET deleted=1 WHERE id=?', id); s.audit(a, 'QUESTION_DELETED', 'question_bank', id); }
  function bankList(a: Actor, f: { q?: string; difficulty?: string; topic?: string; type?: string } = {}) {
    const w = ['deleted=0'], p: any[] = [];
    if (a.role !== 'ADMIN') { w.push('owner_id=?'); p.push(a.id); }
    if (f.q) { w.push("text LIKE ? ESCAPE '\\'"); p.push('%' + f.q.replace(/[\\%_]/g, '\\$&') + '%'); }
    if (f.difficulty) { w.push('difficulty=?'); p.push(f.difficulty); }
    if (f.topic) { w.push('topic=?'); p.push(f.topic); }
    if (f.type) { w.push('type=?'); p.push(f.type); }
    return all(`SELECT * FROM question_bank WHERE ${w.join(' AND ')} ORDER BY created_at DESC LIMIT 200`, ...p)
      .map((q) => ({ ...q, options: parse(q.options), correct: parse(q.correct) }));
  }
  function bankImport(a: Actor, examId: string, ids: string[]) {
    if (!Array.isArray(ids) || !ids.length) fail(400, 'VALIDATION', 'No questions selected.');
    const qs = ids.map((id) => bankOwn(a, id));
    return qs.map((q) => s.addQuestion(a, examId, { type: q.type, text: q.text, options: parse(q.options), correct: parse(q.correct),
      marks: q.marks, negMarks: q.neg_marks, difficulty: q.difficulty, topic: q.topic }));
  }

  // ---------- reports & dashboards ----------
  function examReport(a: Actor, examId: string) {
    const e = get('SELECT * FROM exams WHERE id=?', examId);
    if (!e || (a.role === 'FACULTY' && e.faculty_id !== a.id)) return fail(404, 'NOT_FOUND', 'Exam not found.');
    const rows = all(`SELECT r.score, r.percentage, r.passed, t.id attempt_id, t.student_id, t.suspicious FROM attempts t
                      JOIN results r ON r.attempt_id=t.id WHERE t.exam_id=?`, examId);
    const scores = rows.map((r) => r.score), students = activeStudents(), taken = new Set(all('SELECT student_id FROM attempts WHERE exam_id=?', examId).map((r) => r.student_id));
    const qs = all("SELECT * FROM questions WHERE exam_id=? AND type IN ('MCQ','MULTI','TF') ORDER BY position", examId);
    const perQ = qs.map((q) => {
      const ans = all('SELECT a.answer FROM answers a JOIN attempts t ON t.id=a.attempt_id WHERE a.question_id=? AND t.status<>? ', q.id, 'IN_PROGRESS');
      const c = parse(q.correct), ok = ans.filter((r) => { const v = parse(r.answer);
        return q.type === 'MULTI' ? Array.isArray(v) && [...v].sort().join() === [...c].sort().join() : String(v) === String(c); }).length;
      return { questionId: q.id, position: q.position, answered: ans.length, correct: ok, correctRate: ans.length ? Math.round((ok / ans.length) * 1000) / 10 : null };
    });
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return { examId, title: e.title, enrolled: students.length, participated: rows.length,
      participationRate: students.length ? r2((rows.length / students.length) * 100) : 0,
      average: scores.length ? r2(scores.reduce((x, y) => x + y, 0) / scores.length) : null,
      highest: scores.length ? Math.max(...scores) : null, lowest: scores.length ? Math.min(...scores) : null,
      passPercentage: rows.length ? r2((rows.filter((r) => r.passed).length / rows.length) * 100) : null,
      suspiciousAttempts: rows.filter((r) => r.suspicious).length,
      violations: get('SELECT COUNT(*) c FROM violations WHERE exam_id=?', examId).c,
      questionPerformance: perQ, absent: students.filter((x) => !taken.has(x.id)).map((x) => ({ id: x.id, name: x.name })),
      studentPerformance: rows.map((r) => ({ studentId: r.student_id, score: r.score, percentage: r.percentage, passed: !!r.passed })) };
  }
  function dashboard(a: Actor) {
    const c = (sql: string, ...p: any[]) => get(sql, ...p).c;
    if (a.role === 'STUDENT') {
      const nowIso = iso();
      return { upcoming: all("SELECT id,title,subject,start_at,status FROM exams WHERE status IN ('SCHEDULED','LIVE') AND start_at>=? ORDER BY start_at LIMIT 10", new Date(s.now().getTime() - 3600_000).toISOString()),
        today: all("SELECT id,title,start_at FROM exams WHERE status IN ('SCHEDULED','LIVE') AND substr(start_at,1,10)=?", nowIso.slice(0, 10)),
        recentResults: s.listStudentResults(a).filter((r: any) => r.published).slice(0, 5), notices: listNotices(a).slice(0, 5),
        resources: listResources(a).slice(0, 5), unreadNotifications: c('SELECT COUNT(*) c FROM notifications WHERE user_id=? AND is_read=0', a.id) };
    }
    if (a.role === 'FACULTY') {
      const st: Record<string, number> = {}; all('SELECT status, COUNT(*) c FROM exams WHERE faculty_id=? GROUP BY status', a.id).forEach((r) => (st[r.status] = r.c));
      return { examsByStatus: st, totalExams: Object.values(st).reduce((x, y) => x + y, 0),
        pendingEvaluations: c("SELECT COUNT(*) c FROM results r JOIN attempts t ON t.id=r.attempt_id JOIN exams e ON e.id=t.exam_id WHERE e.faculty_id=? AND r.eval_status<>'COMPLETE'", a.id),
        participation: c('SELECT COUNT(*) c FROM attempts t JOIN exams e ON e.id=t.exam_id WHERE e.faculty_id=?', a.id),
        suspiciousSessions: c('SELECT COUNT(*) c FROM attempts t JOIN exams e ON e.id=t.exam_id WHERE e.faculty_id=? AND t.suspicious=1', a.id),
        recentNotices: listNotices(a).slice(0, 5) };
    }
    const st: Record<string, number> = {}; all('SELECT status, COUNT(*) c FROM exams GROUP BY status').forEach((r) => (st[r.status] = r.c));
    return { students: c("SELECT COUNT(*) c FROM users WHERE role='STUDENT'"), faculty: c("SELECT COUNT(*) c FROM users WHERE role='FACULTY'"),
      examsByStatus: st, ...s.securitySummary(), recentActivity: s.listAudit({ limit: 10 }) };
  }

  // ---------- faculty/admin views ----------
  const ownExamRow = (a: Actor, id: string) => {
    const e = get('SELECT * FROM exams WHERE id=?', id);
    if (!e || (a.role === 'FACULTY' && e.faculty_id !== a.id)) return fail(404, 'NOT_FOUND', 'Exam not found.');
    return e;
  };
  function examDetail(a: Actor, id: string) {
    const e = ownExamRow(a, id);
    const questions = all('SELECT * FROM questions WHERE exam_id=? ORDER BY position', id).map((q) => ({ ...q, options: parse(q.options), correct: parse(q.correct), keywords: parse(q.keywords) }));
    return { exam: e, questions };
  }
  function listSubmissions(a: Actor, examId: string) {
    ownExamRow(a, examId);
    return all(`SELECT t.id attempt_id, u.name, u.email, t.status, t.suspicious, t.submitted_at, r.score, r.max_marks, r.percentage, r.grade, r.passed,
        r.eval_status, r.published, (SELECT COUNT(*) FROM violations v WHERE v.attempt_id=t.id) violations
        FROM attempts t JOIN users u ON u.id=t.student_id LEFT JOIN results r ON r.attempt_id=t.id WHERE t.exam_id=? ORDER BY t.started_at`, examId).map((r) => { const k = s.riskAssessment(r.attempt_id); return { ...r, risk_score: k.score, risk_level: k.level }; });
  }
  function submissionDetail(a: Actor, attemptId: string) {
    const t = get('SELECT * FROM attempts WHERE id=?', attemptId);
    if (!t) return fail(404, 'NOT_FOUND', 'Submission not found.');
    ownExamRow(a, t.exam_id);
    const ans = new Map(all('SELECT question_id, answer FROM answers WHERE attempt_id=?', attemptId).map((r) => [r.question_id, parse(r.answer)]));
    const man = new Map(all('SELECT question_id, marks FROM manual_marks WHERE attempt_id=?', attemptId).map((r) => [r.question_id, r.marks]));
    const com = new Map(all('SELECT question_id, comment FROM manual_marks WHERE attempt_id=?', attemptId).map((r) => [r.question_id, r.comment]));
    return { attempt: t, result: get('SELECT * FROM results WHERE attempt_id=?', attemptId),
      violations: all('SELECT type, severity, description, created_at FROM violations WHERE attempt_id=? ORDER BY created_at', attemptId),
      risk: s.riskAssessment(attemptId),
      nextPendingAttemptId: get(`SELECT t2.id FROM attempts t2 JOIN results r ON r.attempt_id=t2.id WHERE t2.exam_id=? AND t2.id<>? AND r.eval_status<>'COMPLETE'
        ORDER BY t2.submitted_at LIMIT 1`, t.exam_id, attemptId)?.id ?? null,
      questions: all('SELECT * FROM questions WHERE exam_id=? ORDER BY position', t.exam_id).map((q) => {
        const answer = ans.get(q.id) ?? null, kw: string[] = parse(q.keywords) ?? [], text = typeof answer === 'string' ? answer.toLowerCase() : '';
        const subj = q.type === 'SHORT' || q.type === 'LONG';
        return { id: q.id, position: q.position, type: q.type, text: q.text, marks: q.marks, correct: parse(q.correct), options: parse(q.options),
          answer, awarded: man.get(q.id) ?? null, comment: com.get(q.id) ?? null, keywords: kw,
          ...(subj ? { wordCount: typeof answer === 'string' ? answer.trim().split(/\s+/).filter(Boolean).length : 0,
            keywordHits: { found: kw.filter((k) => text.includes(k)), missing: kw.filter((k) => !text.includes(k)) } } : {}) };   // hints only: marks stay a human decision
      }) };
  }

  function pendingEvaluations(a: Actor) {
    return all(`SELECT t.id attempt_id, e.id exam_id, e.title, u.name student, t.submitted_at,
        (SELECT COUNT(*) FROM answers an JOIN questions q ON q.id=an.question_id WHERE an.attempt_id=t.id AND q.type IN ('SHORT','LONG')
           AND NOT EXISTS (SELECT 1 FROM manual_marks m WHERE m.attempt_id=t.id AND m.question_id=an.question_id)) pending
        FROM attempts t JOIN results r ON r.attempt_id=t.id JOIN exams e ON e.id=t.exam_id JOIN users u ON u.id=t.student_id
        WHERE r.eval_status<>'COMPLETE' ${a.role === 'FACULTY' ? 'AND e.faculty_id=?' : ''} ORDER BY t.submitted_at`, ...(a.role === 'FACULTY' ? [a.id] : []));
  }

  return { me, pendingEvaluations, setProfile, createCatalog, listCatalog, setCatalogActive, createNotice, listNotices, uploadResource, listResources,
    downloadResource, deleteResource, bankAdd, bankUpdate, bankDelete, bankList, bankImport, examReport, dashboard, examDetail, listSubmissions, submissionDetail, listAllExams: (a: Actor) => s.listFacultyExams(a) };
}
export type Extras = ReturnType<typeof createExtras>;
