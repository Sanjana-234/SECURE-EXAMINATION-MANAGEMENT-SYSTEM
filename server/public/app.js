// SEMS browser client. Dependency-free. All DOM is built with textContent (never innerHTML) so
// user-supplied data cannot inject markup; the server CSP additionally blocks inline/third-party script.
const app = document.getElementById('app');
const S = { token: sessionStorage.getItem('sems_token'), user: JSON.parse(sessionStorage.getItem('sems_user') || 'null') };
let cleanup = [];                                    // listeners/timers owned by the current page

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) { if (kid == null || kid === false) continue; el.append(kid instanceof Node ? kid : document.createTextNode(String(kid))); }
  return el;
}
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
const PAGE = 25; let usersOffset = 0, auditOffset = 0;
const pager = (off, hasNext, set) => h('div', { class: 'row', style: 'margin-top:.6rem' }, h('button', { class: 'btn sm sec', disabled: off === 0, onclick: () => set(Math.max(0, off - PAGE)) }, 'Previous'),
  h('span', { class: 'mut' }, `Page ${off / PAGE + 1}`), h('button', { class: 'btn sm sec', disabled: !hasNext, onclick: () => set(off + PAGE) }, 'Next'));
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '-');
const tag = (text, kind) => h('span', { class: 'tag ' + (kind || '') }, text);
const statusKind = (s) => (['PUBLISHED', 'COMPLETE', 'SUBMITTED', 'ACTIVE', 'LIVE'].includes(s) ? 'ok' : ['SUSPENDED', 'HIGH', 'CRITICAL'].includes(s) ? 'bad' : ['PENDING_FACULTY_EVALUATION', 'WARNING', 'MEDIUM', 'INACTIVE', 'AUTO_SUBMITTED'].includes(s) ? 'warn' : '');

function toast(msg, bad) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg); document.getElementById('toasts').append(t); setTimeout(() => t.remove(), 4500);
}
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  if (raw && r.ok) return r;
  const j = await r.json().catch(() => ({ success: false, message: 'Unexpected server response.' }));
  if (r.status === 401 && S.token) { signOut(); throw new Error('Session expired. Please sign in again.'); }
  if (!j.success) { const e = new Error(j.message); e.code = j.errorCode; if (e.code === 'MFA_SETUP_REQUIRED' && S.user) go(`#/${S.user.role.toLowerCase()}/profile`); throw e; }
  return j.data;
}
function signOut() { S.token = null; S.user = null; sessionStorage.clear(); location.hash = '#/login'; route(); }
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message, true); } };

// modal for confirmations and sensitive-action re-authentication
function dialog({ title, message, fields = [], ok = 'Confirm' }) {
  return new Promise((resolve) => {
    const inputs = fields.map((f) => h('input', { type: f.type || 'text', id: 'dlg_' + f.name, autocomplete: 'off' }));
    const close = (v) => { bg.remove(); resolve(v); };
    const bg = h('div', { class: 'modal-bg', role: 'dialog', 'aria-modal': 'true' }, h('div', { class: 'modal' }, h('h2', {}, title), message && h('p', {}, message),
      fields.map((f, i) => [h('label', { for: 'dlg_' + f.name }, f.label), inputs[i]]),
      h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'btn', onclick: () => close(Object.fromEntries(fields.map((f, i) => [f.name, inputs[i].value]))) }, ok),
        h('button', { class: 'btn sec', onclick: () => close(null) }, 'Cancel'))));
    document.body.append(bg); (inputs[0] || bg.querySelector('button')).focus();
  });
}
// generic accessible form builder
function formEl(fields, submitLabel, onSubmit) {
  const els = {};
  const body = fields.map((f) => {
    let el;
    if (f.type === 'select') el = h('select', {}, f.options.map((o) => h('option', { value: o }, o)));
    else if (f.type === 'textarea') el = h('textarea', { rows: f.rows || 3 });
    else el = h('input', { type: f.type || 'text', ...(f.min != null ? { min: f.min } : {}), ...(f.step ? { step: f.step } : {}) });
    el.id = 'f_' + f.name; if (f.type === 'checkbox') el.checked = !!f.value; else if (f.value != null) el.value = f.value; if (f.required) el.required = true;
    els[f.name] = el;
    return f.type === 'checkbox' ? h('div', {}, el, ' ', h('label', { for: el.id, style: 'display:inline' }, f.label)) : [h('label', { for: el.id }, f.label), el];
  });
  return h('form', { onsubmit: guard(async (ev) => {
    ev.preventDefault(); const v = {};
    for (const f of fields) v[f.name] = f.type === 'checkbox' ? els[f.name].checked : f.type === 'file' ? els[f.name].files[0] : els[f.name].value;
    await onSubmit(v, ev.target);
  }) }, body, h('div', { style: 'margin-top:.9rem' }, h('button', { class: 'btn', type: 'submit' }, submitLabel)));
}
const table = (heads, rows, empty = 'Nothing to show yet.') => rows.length
  ? h('div', { class: 'tbl' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map((x) => h('th', {}, x)))), h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))))
  : h('p', { class: 'mut' }, empty);
const bars = (items, max) => items.map(([l, v]) => h('div', { class: 'bar' }, h('span', { class: 'l', title: l }, l), h('i', { style: `width:${Math.max(2, ((v || 0) / (max || 1)) * 60)}%` }), h('span', {}, String(v ?? '-'))));
const go = (hash) => { location.hash = hash; };
const dtLocal = (offsetMin = 0) => { const d = new Date(Date.now() + offsetMin * 60000 - new Date().getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };

// ---------- shell ----------
const NAV = {
  STUDENT: [['dashboard', 'Dashboard'], ['exams', 'My Exams'], ['resources', 'Resources'], ['notices', 'Notices'], ['results', 'Results'], ['notifications', 'Notifications'], ['profile', 'Profile']],
  FACULTY: [['dashboard', 'Dashboard'], ['exams', 'Examinations'], ['queue', 'Evaluation Queue'], ['bank', 'Question Bank'], ['resources', 'Resources'], ['notices', 'Notices'], ['profile', 'Profile']],
  ADMIN: [['dashboard', 'Dashboard'], ['users', 'Users'], ['exams', 'Examinations'], ['notices', 'Notices'], ['resources', 'Resources'], ['audit', 'Audit Logs'], ['security', 'Security Monitoring'], ['integrity', 'Verify Integrity'], ['catalog', 'Departments & Subjects'], ['profile', 'Profile']],
};
function shell(active, content) {
  const role = S.user.role.toLowerCase();
  app.replaceChildren(h('header', { class: 'top' }, h('b', {}, 'SEMS · ' + S.user.role + ' portal'), h('span', {}, S.user.name + ' ', h('button', { class: 'btn sm', onclick: guard(async () => { await api('POST', '/api/auth/logout').catch(() => {}); signOut(); }) }, 'Logout'))),
    h('div', { class: 'layout' }, h('nav', { class: 'side', 'aria-label': 'Main' }, NAV[S.user.role].map(([k, l]) => h('a', { href: `#/${role}/${k}`, class: active === k ? 'on' : '' }, l))), h('main', {}, content)));
}
async function page(active, title, build) {
  shell(active, [h('h1', {}, title), h('p', { class: 'mut' }, 'Loading…')]);
  try { const c = await build(); shell(active, [h('h1', {}, title), c]); } catch (e) { shell(active, [h('h1', {}, title), h('p', { class: 'err', role: 'alert' }, e.message)]); }
}

// ---------- login ----------
function loginPage() {
  let needTotp = false;
  const box = h('div', { class: 'login' });
  const draw = () => box.replaceChildren(h('div', { class: 'card' }, h('h1', {}, 'Student Examination Management System'), h('p', { class: 'mut' }, 'Secure, automated and transparent online examination management.'),
    formEl([{ name: 'email', label: 'Email', type: 'email', required: true }, { name: 'password', label: 'Password', type: 'password', required: true }, ...(needTotp ? [{ name: 'totp', label: 'Verification code', required: true }] : [])], 'Sign in',
      async (v) => {
        try {
          const d = await api('POST', '/api/auth/login', { email: v.email, password: v.password, totp: v.totp });
          S.token = d.token; S.user = d.user; sessionStorage.setItem('sems_token', d.token); sessionStorage.setItem('sems_user', JSON.stringify(d.user));
          if (d.user.mustChangePassword) toast('Please change your password under Profile.');
          go(`#/${d.user.role.toLowerCase()}/dashboard`);
        } catch (e) { if (e.code === 'MFA_REQUIRED') { needTotp = true; draw(); } throw e; }
      })));
  draw(); app.replaceChildren(box);
}

// ---------- shared pages ----------
const profilePage = () => page('profile', 'Profile', async () => {
  const me = await api('GET', '/api/me'), mfa = h('div', {});
  return [h('div', { class: 'card' }, h('p', {}, h('b', {}, me.name), ' · ', me.email, ' · ', tag(me.role)), h('p', { class: 'mut' }, `Department: ${me.profile.department || '-'} · Class: ${me.profile.class_name || '-'}`)),
    h('div', { class: 'card' }, h('h2', {}, 'Change password'), formEl([{ name: 'oldPassword', label: 'Current password', type: 'password', required: true }, { name: 'newPassword', label: 'New password (10+ chars, upper, lower, digit, symbol)', type: 'password', required: true }], 'Change password',
      async (v, f) => { await api('POST', '/api/auth/change-password', v); toast('Password changed.'); f.reset(); })),
    h('div', { class: 'card' }, h('h2', {}, 'Two-factor authentication'), h('p', { class: 'mut' }, me.mfaEnabled ? 'Enabled.' : 'Not enabled.'),
      h('button', { class: 'btn sec', onclick: guard(async () => { const d = await api('POST', '/api/auth/mfa/setup'); mfa.replaceChildren(h('p', {}, 'Add this secret to an authenticator app, then enter a code:'), h('code', {}, d.secret),
        formEl([{ name: 'code', label: '6-digit code', required: true }], 'Enable', async (v) => { await api('POST', '/api/auth/mfa/enable', v); toast('MFA enabled.'); profilePage(); })); }) }, 'Set up authenticator'), mfa)];
});
const noticesPage = () => page('notices', 'Notices', async () => {
  const list = await api('GET', '/api/notices'), canWrite = S.user.role !== 'STUDENT';
  return [canWrite && h('div', { class: 'card' }, h('h2', {}, 'New notice'), formEl([{ name: 'title', label: 'Title', required: true }, { name: 'message', label: 'Message', type: 'textarea', required: true },
    { name: 'department', label: 'Target department (blank = all)' }, { name: 'className', label: 'Target class (blank = all)' }, { name: 'priority', label: 'Priority', type: 'select', options: ['NORMAL', 'HIGH', 'LOW'] },
    { name: 'expiresAt', label: 'Expires (optional)', type: 'datetime-local' }], 'Publish', async (v, f) => {
      await api('POST', '/api/faculty/notices', { ...v, expiresAt: v.expiresAt ? new Date(v.expiresAt).toISOString() : undefined, department: v.department || undefined, className: v.className || undefined }); toast('Notice published.'); noticesPage(); })),
    list.length ? list.map((n) => h('div', { class: 'card' }, h('h2', {}, n.title, ' ', tag(n.priority, statusKind(n.priority))), h('p', {}, n.message), h('p', { class: 'mut' }, `Published ${fmt(n.publish_at)} · Target: ${n.department || 'all'} / ${n.class_name || 'all'}`))) : h('p', { class: 'mut' }, 'No notices.')];
});
const resourcesPage = () => page('resources', 'Resources', async () => {
  const list = await api('GET', '/api/resources'), canWrite = S.user.role !== 'STUDENT';
  const download = guard(async (r) => { const res = await api('GET', `/api/resources/${r.id}/download`, null, true); const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: r.original_name }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); });
  return [canWrite && h('div', { class: 'card' }, h('h2', {}, 'Upload resource'), h('p', { class: 'mut' }, 'PDF, Office documents, images or text. Max 5 MB. Content is verified server-side.'),
    formEl([{ name: 'title', label: 'Title', required: true }, { name: 'description', label: 'Description' }, { name: 'subject', label: 'Subject' }, { name: 'department', label: 'Target department (blank = all)' },
      { name: 'className', label: 'Target class (blank = all)' }, { name: 'file', label: 'File', type: 'file', required: true }], 'Upload', async (v, f) => {
      const buf = new Uint8Array(await v.file.arrayBuffer()); let bin = ''; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      await api('POST', '/api/faculty/resources', { title: v.title, description: v.description, subject: v.subject, department: v.department || undefined, className: v.className || undefined, filename: v.file.name, contentBase64: btoa(bin) });
      toast('Uploaded.'); resourcesPage(); })),
    h('div', { class: 'card' }, table(['Title', 'Subject', 'File', 'Size', 'Expires', ''], list.map((r) => [r.title, r.subject || '-', r.original_name, Math.ceil(r.size / 1024) + ' KB', fmt(r.expires_at),
      h('span', { class: 'row' }, h('button', { class: 'btn sm', onclick: () => download(r) }, 'Download'), canWrite && h('button', { class: 'btn sm bad', onclick: guard(async () => { if (await dialog({ title: 'Delete resource?', message: r.title })) { await api('DELETE', `/api/faculty/resources/${r.id}`); resourcesPage(); } }) }, 'Delete'))]), 'No resources available.'))];
});

// ---------- student ----------
const studentDashboard = () => page('dashboard', `Welcome, ${S.user.name}`, async () => {
  const d = await api('GET', '/api/dashboard');
  return [h('div', { class: 'grid' }, h('div', { class: 'card' }, h('div', { class: 'stat' }, d.today.length), 'Exams today'), h('div', { class: 'card' }, h('div', { class: 'stat' }, d.upcoming.length), 'Upcoming exams'), h('div', { class: 'card' }, h('div', { class: 'stat' }, d.unreadNotifications), 'Unread notifications')),
    h('div', { class: 'card' }, h('h2', {}, 'Upcoming examinations'), table(['Exam', 'Subject', 'Starts', 'Status'], d.upcoming.map((e) => [h('a', { href: `#/student/exam/${e.id}` }, e.title), e.subject, fmt(e.start_at), tag(e.status, statusKind(e.status))]), 'No upcoming exams.')),
    h('div', { class: 'card' }, h('h2', {}, 'Recent results'), table(['Exam', 'Score', '%', 'Grade', 'Result'], d.recentResults.map((r) => [r.exam.title, `${r.score}/${r.max_marks}`, r.percentage, r.grade, tag(r.passed ? 'PASS' : 'FAIL', r.passed ? 'ok' : 'bad')]), 'No published results yet.')),
    h('div', { class: 'card' }, h('h2', {}, 'Latest notices'), d.notices.length ? d.notices.map((n) => h('p', {}, h('b', {}, n.title), ' – ', n.message)) : h('p', { class: 'mut' }, 'No notices.')),
    h('div', { class: 'card' }, h('h2', {}, 'Resources'), d.resources.length ? d.resources.map((r) => h('p', {}, r.title)) : h('p', { class: 'mut' }, 'No resources.'))];
});
const studentExams = () => page('exams', 'My Exams', async () => {
  const list = await api('GET', '/api/student/exams');
  return h('div', { class: 'card' }, table(['Exam', 'Subject', 'Starts', 'Duration', 'Status', ''], list.map((e) => [e.title, e.subject, fmt(e.start_at), e.duration_min + ' min', tag(e.attempt_status || e.status, statusKind(e.attempt_status || e.status)),
    e.attempt_status ? (e.attempt_status === 'IN_PROGRESS' ? h('button', { class: 'btn sm', onclick: () => startExam(e.id) }, 'Resume') : h('a', { href: '#/student/results' }, 'Results')) : h('a', { href: `#/student/exam/${e.id}` }, 'Instructions')]), 'No exams scheduled.'));
});
// Can the student start right now? (server stays authoritative; this only avoids entering fullscreen for nothing)
function startState(e, mine) {
  if (mine && mine.attempt_status === 'IN_PROGRESS') return { ok: true, label: 'Resume Examination' };
  if (mine && mine.attempt_status) return { ok: false, msg: 'You have already submitted this exam.', results: true };
  const t = Date.now(), start = Date.parse(e.startAt);
  if (t < start) return { ok: false, msg: `This exam has not started yet. It opens at ${fmt(e.startAt)}.` };
  if (t > start + e.durationMin * 60_000) return { ok: false, msg: 'The exam window has closed. Please contact your faculty if you missed it.' };
  return { ok: true, label: 'Start Examination' };
}
const instructionsPage = (id) => page('exams', 'Exam Instructions', async () => {
  const [e, me, list] = [await api('GET', `/api/student/exams/${id}`), await api('GET', '/api/me'), await api('GET', '/api/student/exams')];
  const st = startState(e, list.find((x) => x.id === id));
  return h('div', { class: 'card' }, h('h2', {}, e.title), table(['Subject', 'Starts', 'Duration', 'Questions', 'Total marks', 'Passing marks'], [[e.subject, fmt(e.startAt), e.durationMin + ' min', e.totalQuestions, e.totalMarks, e.passMarks]]),
    h('h3', {}, 'Instructions'), h('p', {}, e.instructions || 'Answer all questions.'),
    h('h3', {}, 'Security rules'), h('ul', {}, h('li', {}, 'The exam runs in fullscreen. Leaving fullscreen or switching tabs is recorded.'), h('li', {}, 'Copy, cut, paste, right-click, printing and shortcuts are blocked and recorded.'),
      h('li', {}, `Policy: ${e.violationPolicy}. After ${e.maxViolations} violations your attempt is ${e.violationPolicy === 'AUTO_SUBMIT' ? 'automatically submitted' : e.violationPolicy === 'FLAG' ? 'flagged as suspicious for review' : 'only warned'}.`),
      h('li', {}, 'The timer is controlled by the server. Answers save automatically; submit before time ends.'), h('li', {}, 'Your connection is checked every few seconds; long gaps are logged as a signal.'),
      e.randomize && h('li', {}, 'Question and option order is randomised per student.'),
      e.requireWebcam && h('li', {}, 'Your camera must stay on. Frames are analysed on your own device to check the camera is not covered or switched off; no image or video is uploaded or stored.')),
    st.ok ? h('button', { class: 'btn', onclick: () => startExam(id) }, st.label)
      : h('div', {}, h('p', { class: 'notice-bad' }, st.msg), st.results ? h('a', { class: 'btn', href: '#/student/results' }, 'View results') : h('button', { class: 'btn', disabled: true }, 'Start Examination')));
});
function startExam(examId) {            // runs inside the click gesture so fullscreen is allowed
  document.documentElement.requestFullscreen?.().catch(() => {});
  (async () => {
    try { const a = await api('POST', `/api/student/exams/${examId}/start`); go(`#/exam/${a.id}`); }
    catch (e) { if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {}); toast(e.message, true); }   // don't strand the student in fullscreen
  })();
}
const studentResults = () => page('results', 'Results', async () => {
  const list = await api('GET', '/api/student/results');
  return h('div', { class: 'card' }, table(['Exam', 'Status', 'Marks', '%', 'Grade', 'Result', 'Evaluation', 'Remarks', 'Review'], list.map((r) => r.published
    ? [r.exam.title, r.status, `${r.score}/${r.max_marks}`, r.percentage, r.grade, tag(r.passed ? 'PASS' : 'FAIL', r.passed ? 'ok' : 'bad'), tag(r.eval_status, statusKind(r.eval_status)), r.remarks || '-', h('a', { href: `#/student/review/${r.attempt_id}` }, 'Review')]
    : [r.exam.title, r.status, '-', '-', '-', '-', tag(r.evalStatus || 'NOT PUBLISHED', 'warn'), '-', '-']), 'No attempts yet.'));
});
const optText = (q, v) => (q.options?.find((o) => o.id === v)?.text ?? v);
const reviewPage = (id) => page('results', 'Result review', async () => {
  const rv = await api('GET', `/api/student/results/${id}/review`);
  if (!rv.published) return h('p', { class: 'mut' }, 'Results are not published yet.');
  return [rv.remarks && h('div', { class: 'card' }, h('b', {}, 'Faculty remarks: '), rv.remarks),
    rv.questions.length ? rv.questions.map((q) => h('div', { class: 'card' }, h('b', {}, q.text), ' ', tag(q.status, ['CORRECT', 'MARKED'].includes(q.status) ? 'ok' : q.status === 'INCORRECT' ? 'bad' : 'warn'),
      h('p', {}, 'Your answer: ', q.yourAnswer == null ? h('i', {}, 'unanswered') : [].concat(q.yourAnswer).map((x) => optText(q, x)).join(', ')),
      q.correct != null && h('p', { class: 'mut' }, 'Correct answer: ' + [].concat(q.correct).map((x) => optText(q, x)).join(', ')),
      h('p', {}, `Marks: ${q.awarded ?? 'pending'} / ${q.marks}`), q.comment && h('p', {}, h('b', {}, 'Feedback: '), q.comment))) : h('p', { class: 'mut' }, 'Detailed answers are not shown for this exam.')];
});
const notificationsPage = () => page('notifications', 'Notifications', async () => {
  const list = await api('GET', '/api/notifications');
  return list.length ? list.map((n) => h('div', { class: 'card' }, h('b', {}, n.title), ' ', tag(n.priority, statusKind(n.priority)), !n.is_read && tag('NEW', 'warn'), h('p', {}, n.message), h('span', { class: 'mut' }, fmt(n.created_at), ' '),
    !n.is_read && h('button', { class: 'btn sm sec', onclick: guard(async () => { await api('POST', `/api/notifications/${n.id}/read`); notificationsPage(); }) }, 'Mark read'))) : h('p', { class: 'mut' }, 'No notifications.');
});

// ---------- secure exam screen ----------
async function examPage(attemptId) {
  app.replaceChildren(h('p', { style: 'padding:1rem' }, 'Loading exam…'));
  let view, info;
  try { view = await api('GET', `/api/student/attempts/${attemptId}`); info = await api('GET', `/api/student/exams/${view.attempt.examId}`); } catch (e) { toast(e.message, true); return go('#/student/exams'); }
  if (view.attempt.status !== 'IN_PROGRESS') return go('#/student/results');
  const Q = view.questions, answers = { ...view.answers }, pending = new Map();
  let idx = 0, deadline = Date.now() + view.attempt.remainingSeconds * 1000, violations = view.violationCount, seq = Date.now(), ended = false, offline = false, lastV = {};
  const on = (t, ev, fn, o) => { t.addEventListener(ev, fn, o); cleanup.push(() => t.removeEventListener(ev, fn, o)); };
  const every = (fn, ms) => { const id = setInterval(fn, ms); cleanup.push(() => clearInterval(id)); };

  const video = h('video', { autoplay: true, muted: true, playsinline: true, width: 120, 'aria-label': 'Camera preview', style: 'border-radius:8px;background:#000' });
  const timeEl = h('span', { class: 'time' }), secEl = h('div', { class: 'status' }), qbox = h('div', { class: 'card' }), navEl = h('div', { class: 'qnav' }), banner = h('div', { role: 'alert' });
  const overlay = h('div', { class: 'overlay', hidden: true }, h('h1', {}, 'Fullscreen required'), h('p', {}, 'Leaving fullscreen has been recorded. Return to fullscreen to continue.'),
    h('button', { class: 'btn', onclick: () => document.documentElement.requestFullscreen?.().catch(() => {}) }, 'Return to fullscreen'));
  const fs = () => !!document.fullscreenElement;

  async function flush() {
    for (const [qid, p] of [...pending]) {
      try { await api('PUT', `/api/student/attempts/${attemptId}/answers/${qid}`, { answer: p.answer, seq: p.seq }); if (pending.get(qid)?.seq === p.seq) pending.delete(qid); offline = false; }
      catch (e) { if (e.code === 'ATTEMPT_CLOSED') return finish('Time is up or the attempt was closed.'); offline = true; }   // network error: keep and retry
    }
    drawStatus();
  }
  const save = (qid, answer) => { answers[qid] = answer; pending.set(qid, { answer, seq: ++seq }); drawNav(); flush(); };
  async function finish(msg) {
    if (ended) return; ended = true; cleanup.forEach((f) => f()); cleanup = []; document.exitFullscreen?.().catch(() => {});
    toast(msg || 'Exam submitted.'); go('#/student/results');
  }
  async function report(type, description) {
    if (ended || (lastV[type] && Date.now() - lastV[type] < 1500)) return; lastV[type] = Date.now();
    try {
      const r = await api('POST', `/api/student/attempts/${attemptId}/violations`, { type, description }); violations = r.count;
      banner.replaceChildren(h('div', { class: 'card', style: 'border-color:#b25e09' }, `⚠ Violation recorded (${type.replace(/_/g, ' ').toLowerCase()}): ${r.count} of ${r.max}. ` +
        (r.action === 'FLAGGED' ? 'Your attempt has been flagged for review.' : r.action === 'AUTO_SUBMITTED' ? 'Your exam was submitted automatically.' : 'This is a warning.')));
      drawStatus(); if (r.action === 'AUTO_SUBMITTED') finish('Exam auto-submitted due to violations.');
    } catch (e) { if (e.code === 'ATTEMPT_CLOSED') finish('Attempt closed.'); }
  }
  function drawStatus() {
    fill(secEl,h('div', {}, h('span', { class: 'ok' }, '✓'), ' Exam active'), h('div', {}, fs() ? h('span', { class: 'ok' }, '✓ Fullscreen active') : h('span', { class: 'bad' }, '✗ Fullscreen inactive')),
      h('div', {}, violations ? h('span', { class: 'bad' }, `⚠ Violations: ${violations}/${info.maxViolations}`) : '✓ Violations: 0'), offline && h('div', { class: 'bad' }, '⚠ Offline – answers will retry'), pending.size > 0 && h('div', { class: 'mut' }, 'Saving…'));
    overlay.hidden = fs();
  }
  const has = (q) => { const a = answers[q.id]; return a != null && a !== '' && !(Array.isArray(a) && !a.length); };
  function drawNav() { navEl.replaceChildren(...Q.map((q, i) => h('button', { class: (has(q) ? 'done ' : '') + (i === idx ? 'cur' : ''), 'aria-label': `Question ${i + 1}${has(q) ? ' answered' : ''}`, onclick: () => { idx = i; drawQ(); } }, i + 1))); }
  function drawQ() {
    const q = Q[idx], a = answers[q.id];
    let input;
    if (q.type === 'MCQ' || q.type === 'TF') {
      const opts = q.type === 'TF' ? [{ id: 'true', text: 'True' }, { id: 'false', text: 'False' }] : q.options;
      input = opts.map((o) => h('label', { class: 'opt' }, h('input', { type: 'radio', name: 'q' + q.id, checked: a === o.id, onchange: () => save(q.id, o.id) }), o.text));
    } else if (q.type === 'MULTI') {
      input = q.options.map((o) => h('label', { class: 'opt' }, h('input', { type: 'checkbox', checked: (a || []).includes(o.id), onchange: (ev) => { const s = new Set(answers[q.id] || []); ev.target.checked ? s.add(o.id) : s.delete(o.id); save(q.id, [...s]); } }), o.text));
    } else {
      let t; input = h('textarea', { rows: q.type === 'LONG' ? 10 : 3, value: a || '', 'aria-label': 'Your answer', oninput: (ev) => { clearTimeout(t); t = setTimeout(() => save(q.id, ev.target.value), 800); } });
    }
    fill(qbox,h('p', { class: 'mut' }, `Question ${idx + 1} / ${Q.length} · ${q.marks} marks${q.negMarks ? ` · −${q.negMarks} if wrong` : ''} · ${q.type}`), h('h2', {}, q.text), input,
      h('div', { class: 'row', style: 'margin-top:1rem' }, h('button', { class: 'btn sec', disabled: idx === 0, onclick: () => { idx--; drawQ(); } }, 'Previous'),
        h('button', { class: 'btn', onclick: () => { flush(); if (idx < Q.length - 1) idx++; drawQ(); } }, idx < Q.length - 1 ? 'Save & Next' : 'Save')));
    drawNav();
  }
  function tick() {
    const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    timeEl.textContent = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`; timeEl.className = 'time' + (left < 60 ? ' low' : '');
    if (left === 0) { ended || api('GET', `/api/student/attempts/${attemptId}`).finally(() => finish('Time is up. Your exam was submitted.')); }   // server finalises on read
  }
  app.replaceChildren(h('div', { class: 'exam' }, overlay, h('div', { class: 'hdr' }, h('div', {}, h('small', {}, 'SECURE EXAM MODE'), h('div', {}, h('b', {}, info.title))), h('div', {}, h('small', {}, 'Time remaining'), h('div', {}, timeEl))), banner,
    h('div', { class: 'row', style: 'align-items:flex-start;margin-top:1rem' }, h('div', { style: 'flex:1 1 520px;min-width:0' }, qbox), h('div', { class: 'card', style: 'flex:0 0 260px' }, h('h3', {}, 'Question navigator'), navEl, info.requireWebcam && h('div', {}, h('h3', {}, 'Camera'), video, h('p', { class: 'mut' }, 'Checked on your device only. Nothing is uploaded.')), h('h3', {}, 'Security status'), secEl,
      h('button', { class: 'btn bad', style: 'margin-top:1rem;width:100%', onclick: guard(async () => {
        const un = Q.filter((q) => !has(q)).length;
        if (!(await dialog({ title: 'Submit exam?', message: un ? `${un} question(s) are unanswered. You cannot change answers after submitting.` : 'You cannot change answers after submitting.', ok: 'Submit' }))) return;
        await flush(); await api('POST', `/api/student/attempts/${attemptId}/submit`); finish('Exam submitted.'); }) }, 'SUBMIT EXAM')))));
  // camera presence check: signal only (permission denied, track stopped, view covered). Frames never leave the browser.
  let camStream = null, camDark = 0;
  async function startCamera() {
    try { camStream = await navigator.mediaDevices.getUserMedia({ video: { width: 160, height: 120 }, audio: false }); video.srcObject = camStream; video.muted = true; video.play?.().catch?.(() => {}); cleanup.push(() => camStream.getTracks().forEach((t) => t.stop())); }
    catch { report('CAMERA_UNAVAILABLE', 'camera permission denied or no camera found'); }
  }
  function checkCamera() {
    if (!camStream) return report('CAMERA_UNAVAILABLE', 'camera not available');
    const tr = camStream.getVideoTracks()[0];
    if (!tr || tr.readyState !== 'live' || tr.muted) return report('CAMERA_UNAVAILABLE', 'camera stopped or muted');
    try {
      const c = document.createElement('canvas'); c.width = 16; c.height = 12; const ctx = c.getContext('2d'); ctx.drawImage(video, 0, 0, 16, 12);
      const d = ctx.getImageData(0, 0, 16, 12).data; let sum = 0; for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
      camDark = sum / (d.length / 4) < 12 ? camDark + 1 : 0;
      if (camDark >= 2) { camDark = 0; report('CAMERA_COVERED', 'camera view is dark or covered'); }
    } catch { /* frame not ready yet */ }
  }
  drawQ(); drawStatus(); tick();
  every(tick, 1000); every(flush, 10000);
  if (info.requireWebcam) { startCamera(); every(checkCamera, 15000); }
  every(() => api('POST', `/api/student/attempts/${attemptId}/heartbeat`).then((m) => { if (m.status !== 'IN_PROGRESS') finish('Attempt closed.'); else deadline = Date.now() + m.remainingSeconds * 1000; }).catch(() => {}), 5000);   // liveness signal + server clock re-sync
  every(guard(async () => { const v = await api('GET', `/api/student/attempts/${attemptId}`); if (v.attempt.status !== 'IN_PROGRESS') finish('Attempt closed.'); else deadline = Date.now() + v.attempt.remainingSeconds * 1000; }), 20000);   // re-sync with the server clock
  // prevention + detection (best-effort: a browser cannot fully stop other apps/devices)
  const stop = (type, desc) => (ev) => { ev.preventDefault(); report(type, desc); };
  on(document, 'copy', stop('COPY_ATTEMPT', 'copy blocked')); on(document, 'cut', stop('CUT_ATTEMPT', 'cut blocked')); on(document, 'paste', stop('PASTE_ATTEMPT', 'paste blocked'));
  on(document, 'contextmenu', stop('RIGHT_CLICK', 'context menu blocked')); on(document, 'dragstart', (e) => e.preventDefault()); on(document, 'drop', (e) => e.preventDefault());
  on(document, 'selectstart', (e) => { if (!/^(INPUT|TEXTAREA)$/.test(e.target.tagName ?? e.target.parentElement?.tagName)) e.preventDefault(); });
  on(window, 'beforeprint', () => report('SUSPICIOUS_KEYBOARD_EVENT', 'print attempt'));
  on(document, 'visibilitychange', () => { if (document.hidden) report('TAB_SWITCH', 'page hidden'); });
  on(window, 'blur', () => report('TAB_SWITCH', 'window lost focus'));
  on(document, 'fullscreenchange', () => { drawStatus(); if (!fs()) report('FULLSCREEN_EXIT', 'left fullscreen'); });
  on(document, 'keydown', (e) => {
    const k = e.key.toLowerCase(), c = e.ctrlKey || e.metaKey;
    if (e.key === 'F12' || e.key === 'PrintScreen' || (c && ['p', 's', 'u'].includes(k)) || (c && e.shiftKey && ['i', 'j', 'c'].includes(k))) { e.preventDefault(); report('SUSPICIOUS_KEYBOARD_EVENT', `blocked key ${e.ctrlKey ? 'Ctrl+' : ''}${e.key}`); }
    else if (c && ['c', 'v', 'x'].includes(k)) { e.preventDefault(); report(k === 'c' ? 'COPY_ATTEMPT' : k === 'v' ? 'PASTE_ATTEMPT' : 'CUT_ATTEMPT', 'keyboard shortcut'); }
  });
  on(window, 'beforeunload', (e) => { if (!ended) { e.preventDefault(); e.returnValue = ''; } });
}

// ---------- faculty & shared exam management ----------
const R = () => S.user.role.toLowerCase();
const NEXT = { DRAFT: 'SCHEDULED', SCHEDULED: 'LIVE', LIVE: 'COMPLETED', COMPLETED: 'EVALUATING', EVALUATING: 'PUBLISHED' };
function parseQuestion(v) {
  const q = { type: v.type, text: v.text, marks: Number(v.marks), negMarks: Number(v.negMarks || 0), difficulty: v.difficulty, topic: v.topic || undefined };
  if (v.type === 'MCQ' || v.type === 'MULTI') {
    q.options = v.options.split('\n').map((s) => s.trim()).filter(Boolean).map((t, i) => ({ id: String.fromCharCode(65 + i), text: t }));
    q.correct = v.type === 'MULTI' ? v.correct.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : v.correct.trim().toUpperCase();
  } else if (v.type === 'TF') q.correct = v.correct.trim().toLowerCase();
  if ((v.type === 'SHORT' || v.type === 'LONG') && v.keywords && v.keywords.trim()) q.keywords = v.keywords.split(',').map((x) => x.trim()).filter(Boolean);
  return q;
}
const questionForm = (label, onSave) => formEl([{ name: 'type', label: 'Type', type: 'select', options: ['MCQ', 'MULTI', 'TF', 'SHORT', 'LONG'] }, { name: 'text', label: 'Question', type: 'textarea', required: true },
  { name: 'options', label: 'Options (one per line; lettered A, B, C… automatically)', type: 'textarea' }, { name: 'correct', label: 'Correct answer (A / A,B / true / false; blank for subjective)' },
  { name: 'marks', label: 'Marks', type: 'number', value: 1, min: 0.25, step: '0.25', required: true }, { name: 'negMarks', label: 'Negative marks', type: 'number', value: 0, min: 0, step: '0.25' },
  { name: 'difficulty', label: 'Difficulty', type: 'select', options: ['EASY', 'MEDIUM', 'HARD'] }, { name: 'topic', label: 'Subject / topic' }, { name: 'keywords', label: 'Expected keywords for grading hints (comma separated; subjective questions only)' }], label, async (v, f) => { await onSave(parseQuestion(v)); f.reset(); });

const facultyDashboard = () => page('dashboard', 'Dashboard', async () => {
  const d = await api('GET', '/api/dashboard'), st = d.examsByStatus;
  return [h('div', { class: 'grid' }, ...[['Total examinations', d.totalExams], ['Live', st.LIVE || 0], ['Scheduled', st.SCHEDULED || 0], ['Completed', (st.COMPLETED || 0) + (st.PUBLISHED || 0)], ['Pending evaluations', d.pendingEvaluations], ['Participation', d.participation], ['Suspicious sessions', d.suspiciousSessions]]
    .map(([l, v]) => h('div', { class: 'card' }, h('div', { class: 'stat' }, v), l))), h('div', { class: 'card' }, h('h2', {}, 'Recent notices'), d.recentNotices.length ? d.recentNotices.slice(0, 5).map((n) => h('p', {}, n.title)) : h('p', { class: 'mut' }, 'None.'))];
});
const examsPage = () => page('exams', 'Examinations', async () => {
  const list = await api('GET', S.user.role === 'ADMIN' ? '/api/admin/exams' : '/api/faculty/exams');
  return [S.user.role === 'FACULTY' && h('div', { class: 'card' }, h('h2', {}, 'Create exam'), formEl([{ name: 'title', label: 'Exam name', required: true }, { name: 'subject', label: 'Subject', required: true },
    { name: 'startAt', label: 'Start', type: 'datetime-local', value: dtLocal(5), required: true }, { name: 'durationMin', label: 'Duration (minutes)', type: 'number', value: 60, min: 1, required: true },
    { name: 'passMarks', label: 'Passing marks', type: 'number', value: 0, min: 0, step: '0.25' }, { name: 'negativeMarking', label: 'Enable negative marking', type: 'checkbox' }, { name: 'instructions', label: 'Instructions', type: 'textarea' },
    { name: 'violationPolicy', label: 'Violation policy', type: 'select', options: ['FLAG', 'WARN_ONLY', 'AUTO_SUBMIT'] }, { name: 'maxViolations', label: 'Violations before action', type: 'number', value: 3, min: 1 },
    { name: 'publishImmediately', label: 'Publish results immediately after grading', type: 'checkbox' },
    { name: 'showAnswers', label: 'Let students review correct/incorrect answers after publication', type: 'checkbox' }, { name: 'randomize', label: 'Randomise question and option order per student', type: 'checkbox', value: true },
    { name: 'requireWebcam', label: 'Camera presence check (analysed on the student device; nothing is uploaded)', type: 'checkbox' }], 'Create exam', async (v) => {
      await api('POST', '/api/faculty/exams', { ...v, startAt: new Date(v.startAt).toISOString(), durationMin: +v.durationMin, passMarks: +v.passMarks, maxViolations: +v.maxViolations }); toast('Exam created (draft).'); examsPage(); })),
    h('div', { class: 'card' }, table(['Exam', 'Subject', 'Start', 'Status', 'Policy', ''], list.map((e) => [e.title, e.subject, fmt(e.start_at), tag(e.status, statusKind(e.status)), e.violation_policy,
      h('span', { class: 'row' }, S.user.role === 'FACULTY' && h('a', { href: `#/faculty/exam/${e.id}` }, 'Manage'), h('a', { href: `#/${R()}/submissions/${e.id}` }, 'Submissions'), h('a', { href: `#/${R()}/report/${e.id}` }, 'Report'))]), 'No exams yet.'))];
});
const manageExam = (id) => page('exams', 'Manage exam', async () => {
  const d = await api('GET', `/api/faculty/exams/${id}`), e = d.exam, bank = e.status === 'DRAFT' ? await api('GET', '/api/faculty/bank') : [], picked = new Set();
  return [h('div', { class: 'card' }, h('h2', {}, e.title, ' ', tag(e.status, statusKind(e.status))), h('p', { class: 'mut' }, `${e.subject} · ${fmt(e.start_at)} · ${e.duration_min} min · pass ${e.pass_marks} · policy ${e.violation_policy} (${e.max_violations})`),
    NEXT[e.status] && h('button', { class: 'btn', onclick: guard(async () => { if (await dialog({ title: `Change status to ${NEXT[e.status]}?`, ok: 'Change' })) { await api('POST', `/api/faculty/exams/${id}/status`, { status: NEXT[e.status] }); manageExam(id); } }) }, `Move to ${NEXT[e.status]}`)),
    h('div', { class: 'card' }, h('h2', {}, `Questions (${d.questions.length})`), table(['#', 'Type', 'Question', 'Marks', 'Correct'], d.questions.map((q) => [q.position, q.type, q.text, q.marks, q.correct == null ? '(manual)' : [].concat(q.correct).join(', ')]), 'No questions yet.')),
    e.status === 'DRAFT' && h('div', { class: 'card' }, h('h2', {}, 'Add question'), questionForm('Add question', async (q) => { await api('POST', `/api/faculty/exams/${id}/questions`, q); toast('Question added.'); manageExam(id); })),
    e.status === 'DRAFT' && bank.length > 0 && h('div', { class: 'card' }, h('h2', {}, 'Reuse from question bank'), bank.map((q) => h('label', { style: 'font-weight:400' }, h('input', { type: 'checkbox', onchange: (ev) => (ev.target.checked ? picked.add(q.id) : picked.delete(q.id)) }), ` [${q.type}] ${q.text}`)),
      h('button', { class: 'btn sec', style: 'margin-top:.6rem', onclick: guard(async () => { await api('POST', `/api/faculty/exams/${id}/import-questions`, { questionIds: [...picked] }); toast('Imported.'); manageExam(id); }) }, 'Import selected'))];
});
const submissionsPage = (id) => page('exams', 'Student Submissions', async () => {
  const list = await api('GET', `/api/faculty/exams/${id}/submissions`);
  return [h('div', { class: 'card' }, S.user.role === 'FACULTY' && h('button', { class: 'btn', onclick: guard(async () => { const v = await dialog({ title: 'Publish results', message: 'Re-enter your password to publish all fully-evaluated results.', fields: [{ name: 'password', label: 'Password', type: 'password' }], ok: 'Publish' });
    if (v) { const r = await api('POST', `/api/faculty/exams/${id}/publish-results`, v); toast(`${r.published} result(s) published.`); submissionsPage(id); } }) }, 'Publish results'), ' ',
    h('a', { href: `#/${R()}/report/${id}` }, 'View report')),
    h('div', { class: 'card' }, table(['Student', 'Status', 'Score', 'Evaluation', 'Violations', 'Risk', 'Flag', ''], list.map((s) => [`${s.name} (${s.email})`, tag(s.status, statusKind(s.status)), s.score == null ? '-' : `${s.score}/${s.max_marks} (${s.grade})`,
      tag(s.eval_status || '-', statusKind(s.eval_status)), s.violations, tag(`${s.risk_level} (${s.risk_score})`, s.risk_level === 'HIGH' ? 'bad' : s.risk_level === 'MEDIUM' ? 'warn' : 'ok'), s.suspicious ? tag('SUSPICIOUS', 'bad') : '-', h('a', { href: `#/${R()}/submission/${s.attempt_id}` }, 'Open')]), 'No submissions yet.'))];
});
const queuePage = () => page('queue', 'Evaluation Queue', async () => {
  const list = await api('GET', '/api/faculty/pending-evaluations');
  return h('div', { class: 'card' }, table(['Exam', 'Student', 'Submitted', 'Answers to mark', ''], list.map((r) => [r.title, r.student, fmt(r.submitted_at), r.pending, h('a', { href: `#/faculty/submission/${r.attempt_id}` }, 'Mark')]), 'All caught up: nothing is waiting for evaluation.'));
});
const submissionPage = (id) => page(S.user.role === 'FACULTY' ? 'queue' : 'exams', 'Submission', async () => {
  const d = await api('GET', `/api/faculty/attempts/${id}`), canGrade = S.user.role === 'FACULTY', inputs = {}, comments = {}, out = h('div', {});
  const remarks = h('textarea', { rows: 2, value: d.result?.remarks || '' }), risk = d.risk;
  const riskCard = h('div', { class: 'card' }, h('h2', {}, 'Behaviour risk ', tag(`${risk.level} (${risk.score})`, risk.level === 'HIGH' ? 'bad' : risk.level === 'MEDIUM' ? 'warn' : 'ok')),
    h('p', { class: 'mut' }, 'Advisory score built from recorded signals. It never fails a student: a person decides.'),
    risk.signals.length ? table(['Signal', 'Points', 'Detail'], risk.signals.map((x) => [x.code, x.points, x.detail])) : h('p', {}, 'No suspicious signals.'));
  const qCards = d.questions.map((q) => {
    const subj = q.type === 'SHORT' || q.type === 'LONG';
    const mark = subj && canGrade ? (inputs[q.id] = h('input', { type: 'number', min: 0, max: q.marks, step: '0.25', value: q.awarded ?? '', id: 'm_' + q.id })) : null;
    return h('div', { class: 'card' }, h('b', {}, `${q.position}. ${q.text}`, ` (${q.marks} marks, ${q.type})`),
      h('p', {}, 'Student answer: ', q.answer == null ? h('i', {}, 'unanswered') : [].concat(q.answer).join(', ')),
      !subj && q.correct != null && h('p', { class: 'mut' }, 'Correct: ' + [].concat(q.correct).join(', ')),
      subj && h('div', {}, h('p', { class: 'mut' }, `${q.wordCount} words`), q.keywords.length > 0 && h('p', {}, 'Expected keywords: ', q.keywordHits.found.map((k) => [tag('✓ ' + k, 'ok'), ' ']), q.keywordHits.missing.map((k) => [tag('✗ ' + k, 'warn'), ' ']), h('span', { class: 'mut' }, ' (hints only; marks are your decision)'))),
      mark && h('div', {}, h('label', { for: 'm_' + q.id }, `Marks (0 to ${q.marks})`), mark,
        h('div', { class: 'row', style: 'margin:.4rem 0' }, [0, q.marks / 2, q.marks].map((v) => h('button', { type: 'button', class: 'btn sm sec', onclick: () => { mark.value = v; } }, v === 0 ? 'Zero' : v === q.marks ? 'Full marks' : 'Half'))),
        h('label', { for: 'c_' + q.id }, 'Feedback to student'), (comments[q.id] = h('textarea', { rows: 2, id: 'c_' + q.id, value: q.comment || '' }))));
  });
  const save = async () => {
    const marks = {}; for (const [qid, el] of Object.entries(inputs)) if (el.value !== '') marks[qid] = { marks: Number(el.value), comment: comments[qid].value || undefined };
    await api('POST', `/api/faculty/attempts/${id}/evaluate`, { marks, remarks: remarks.value }); toast('Evaluation saved.');
  };
  return [h('div', { class: 'card' }, h('p', {}, `Status ${d.attempt.status} · submitted ${fmt(d.attempt.submitted_at)}`), d.result && h('p', {}, `Score ${d.result.score}/${d.result.max_marks} · ${d.result.percentage}% · grade ${d.result.grade} · `, tag(d.result.eval_status, statusKind(d.result.eval_status))),
    h('button', { class: 'btn sec', onclick: guard(async () => { const v = await api('GET', `/api/integrity/${id}`);
      out.replaceChildren(h('div', { class: 'verdict ' + (v.verified ? 'ok' : 'bad') }, (v.verified ? '✓ ' : '⚠ ') + v.verdict), table(['Field', 'Value'], [['Submission ID', v.submissionId], ['Recalculated hash', h('code', {}, v.recalculatedHash)], ['Stored hash', h('code', {}, v.storedHash)],
        ['On-chain hash', h('code', {}, v.onChainHash || '-')], ['Transaction', h('code', {}, v.txRef)], ['Anchored', fmt(v.anchoredAt)], ['Chain valid', String(v.chainValid)], ['Verified at', fmt(v.verifiedAt)]])); }) }, 'Verify Examination Integrity'), out),
    riskCard, h('h2', {}, 'Answers'), qCards,
    canGrade && h('div', { class: 'card' }, h('h2', {}, 'Overall remarks'), remarks, h('div', { class: 'row', style: 'margin-top:.6rem' },
      h('button', { class: 'btn', onclick: guard(async () => { await save(); submissionPage(id); }) }, 'Save evaluation'),
      h('button', { class: 'btn sec', onclick: guard(async () => { await save(); go(d.nextPendingAttemptId ? `#/faculty/submission/${d.nextPendingAttemptId}` : '#/faculty/queue'); }) }, d.nextPendingAttemptId ? 'Save & next pending' : 'Save & back to queue'))),
    h('div', { class: 'card' }, h('h2', {}, 'Violations'), table(['Time', 'Type', 'Severity', 'Details'], d.violations.map((v) => [fmt(v.created_at), v.type, tag(v.severity, statusKind(v.severity)), v.description || '-']), 'None recorded.'))];
});
const reportPage = (id) => page('exams', 'Exam Report', async () => {
  const r = await api('GET', `/api/faculty/exams/${id}/report`);
  return [h('h2', {}, r.title), h('div', { class: 'grid' }, ...[['Participation', `${r.participated}/${r.enrolled} (${r.participationRate}%)`], ['Average', r.average ?? '-'], ['Highest', r.highest ?? '-'], ['Lowest', r.lowest ?? '-'], ['Pass %', r.passPercentage ?? '-'], ['Suspicious', r.suspiciousAttempts], ['Violations', r.violations]]
    .map(([l, v]) => h('div', { class: 'card' }, h('div', { class: 'stat' }, String(v)), l))),
    h('div', { class: 'card' }, h('h2', {}, 'Question performance (% correct)'), r.questionPerformance.length ? bars(r.questionPerformance.map((q) => [`Q${q.position} (${q.answered} answered)`, q.correctRate]), 100) : h('p', { class: 'mut' }, 'No objective questions answered yet.')),
    h('div', { class: 'card' }, h('h2', {}, 'Absent students'), r.absent.length ? h('ul', {}, r.absent.map((a) => h('li', {}, a.name))) : h('p', { class: 'mut' }, 'None.'))];
});
const bankPage = () => page('bank', 'Question Bank', async () => {
  let filters = {}; const box = h('div', { class: 'card' });
  const load = guard(async () => { const qs = await api('GET', '/api/faculty/bank?' + new URLSearchParams(Object.entries(filters).filter(([, v]) => v)));
    box.replaceChildren(table(['Type', 'Question', 'Difficulty', 'Topic', 'Marks', ''], qs.map((q) => [q.type, q.text, q.difficulty, q.topic || '-', q.marks, h('button', { class: 'btn sm bad', onclick: guard(async () => { if (await dialog({ title: 'Delete question?', message: q.text })) { await api('DELETE', `/api/faculty/bank/${q.id}`); load(); } }) }, 'Delete')]), 'No questions match.')); });
  load();
  return [h('div', { class: 'card' }, h('h2', {}, 'Search'), formEl([{ name: 'q', label: 'Text' }, { name: 'difficulty', label: 'Difficulty', type: 'select', options: ['', 'EASY', 'MEDIUM', 'HARD'] }, { name: 'topic', label: 'Topic' }], 'Filter', async (v) => { filters = v; load(); })),
    h('div', { class: 'card' }, h('h2', {}, 'Add to bank'), questionForm('Add to bank', async (q) => { await api('POST', '/api/faculty/bank', q); toast('Saved to bank.'); load(); })), box];
});

// ---------- admin ----------
const adminDashboard = () => page('dashboard', 'Dashboard', async () => {
  const d = await api('GET', '/api/dashboard'), st = d.examsByStatus;
  return [h('div', { class: 'grid' }, ...[['Students', d.students], ['Faculty', d.faculty], ['Live exams', st.LIVE || 0], ['Upcoming', st.SCHEDULED || 0], ['Completed', (st.COMPLETED || 0) + (st.PUBLISHED || 0)], ['Suspicious sessions', d.suspiciousSessions], ['Failed logins', d.failedLogins], ['Violations', d.totalViolations]]
    .map(([l, v]) => h('div', { class: 'card' }, h('div', { class: 'stat' }, v), l))), h('div', { class: 'card' }, h('h2', {}, 'Violations by type'), Object.keys(d.violationsByType).length ? bars(Object.entries(d.violationsByType), Math.max(...Object.values(d.violationsByType))) : h('p', { class: 'mut' }, 'None.')),
    h('div', { class: 'card' }, h('h2', {}, 'Recent system activity'), table(['Time', 'Action', 'Role', 'Severity'], d.recentActivity.map((a) => [fmt(a.created_at), a.action, a.role || '-', tag(a.severity, statusKind(a.severity))])))];
});
const usersPage = () => page('users', 'Users', async () => {
  const list = await api('GET', `/api/admin/users?limit=${PAGE}&offset=${usersOffset}`);
  const setStatus = (u, status) => guard(async () => { const v = await dialog({ title: `Set ${u.email} to ${status}?`, message: 'Re-enter your password to confirm this sensitive action.', fields: [{ name: 'password', label: 'Your password', type: 'password' }] });
    if (v) { await api('POST', `/api/admin/users/${u.id}/status`, { status, password: v.password }); toast('Status updated.'); usersPage(); } });
  return [h('div', { class: 'card' }, h('h2', {}, 'Add user'), formEl([{ name: 'name', label: 'Name', required: true }, { name: 'email', label: 'Email', type: 'email', required: true }, { name: 'role', label: 'Role', type: 'select', options: ['STUDENT', 'FACULTY', 'ADMIN'] },
    { name: 'password', label: 'Temporary password', type: 'password', required: true }], 'Create user', async (v, f) => { await api('POST', '/api/admin/users', v); toast('User created; they must change the password at first login.'); usersPage(); })),
    h('div', { class: 'card' }, table(['Name', 'Email', 'Role', 'Status', 'Actions'], list.map((u) => [u.name, u.email, tag(u.role), tag(u.status, statusKind(u.status)), h('span', { class: 'row' },
      ['ACTIVE', 'INACTIVE', 'SUSPENDED'].filter((s) => s !== u.status).map((s) => h('button', { class: 'btn sm sec', onclick: setStatus(u, s) }, s.toLowerCase())),
      h('button', { class: 'btn sm sec', onclick: guard(async () => { const v = await dialog({ title: 'Edit user', message: 'Changing the email requires your password and signs the user out.', fields: [{ name: 'name', label: 'Name' }, { name: 'email', label: 'Email' }, { name: 'password', label: 'Your password (only for email change)', type: 'password' }] });
        if (v) { const body = { password: v.password }; if (v.name.trim()) body.name = v.name; if (v.email.trim() && v.email.trim().toLowerCase() !== u.email) body.email = v.email; await api('PUT', `/api/admin/users/${u.id}`, body); toast('User updated.'); usersPage(); } }) }, 'edit'),
      h('button', { class: 'btn sm sec', onclick: guard(async () => { const v = await dialog({ title: 'Department & class', fields: [{ name: 'department', label: 'Department' }, { name: 'className', label: 'Class' }] }); if (v) { await api('PUT', `/api/admin/users/${u.id}/profile`, v); toast('Saved.'); } }) }, 'dept/class'))]))), pager(usersOffset, list.length === PAGE, (o) => { usersOffset = o; usersPage(); })];
});
const auditPage = () => page('audit', 'Audit Logs', async () => {
  let f = {}; const box = h('div', { class: 'card' }), vbox = h('div', {});
  const load = guard(async () => { const l = await api('GET', '/api/admin/audit?' + new URLSearchParams([...Object.entries(f).filter(([, v]) => v), ['limit', PAGE], ['offset', auditOffset]]));
    box.replaceChildren(table(['Time', 'Action', 'Role', 'Entity', 'Severity', 'IP', 'Metadata'], l.map((a) => [fmt(a.created_at), a.action, a.role || '-', `${a.entity_type || ''} ${a.entity_id ? a.entity_id.slice(0, 8) : ''}`, tag(a.severity, statusKind(a.severity)), a.ip || '-', a.metadata || '-']), 'No matching events.'), pager(auditOffset, l.length === PAGE, (o) => { auditOffset = o; load(); })); });
  load();
  return [h('div', { class: 'card' }, h('p', { class: 'mut' }, 'Every entry is chained with SHA-256 and the chain head is anchored on the ledger, so edits, deletions and truncation are detectable.'),
    h('button', { class: 'btn sec', onclick: guard(async () => { const r = await api('GET', '/api/admin/audit/verify');
      vbox.replaceChildren(h('div', { class: 'verdict ' + (r.valid ? 'ok' : 'bad') }, r.valid ? `✓ AUDIT CHAIN INTACT (${r.entries} entries, ${r.anchors} ledger anchors${r.legacyUnprotected ? `, ${r.legacyUnprotected} legacy unprotected` : ''})` : `⚠ AUDIT CHAIN BROKEN: ${r.reason}${r.brokenAtRow ? ` (row ${r.brokenAtRow})` : ''}`)); }) }, 'Verify audit chain'), vbox),
    h('div', { class: 'card' }, formEl([{ name: 'action', label: 'Action (e.g. FAILED_LOGIN)' }, { name: 'severity', label: 'Severity', type: 'select', options: ['', 'INFO', 'WARNING', 'HIGH', 'CRITICAL'] }], 'Filter', async (v) => { f = v; auditOffset = 0; load(); })), box];
});
const securityPage = () => page('security', 'Security Monitoring', async () => {
  const box = h('div', {});
  const load = guard(async (q = '') => { const d = await api('GET', '/api/admin/security/summary' + q); const t = d.violationsByType;
    box.replaceChildren(h('div', { class: 'grid' }, ...[['Total violations', d.totalViolations], ['Tab switches', t.TAB_SWITCH || 0], ['Fullscreen exits', t.FULLSCREEN_EXIT || 0], ['Copy attempts', t.COPY_ATTEMPT || 0], ['Paste attempts', t.PASTE_ATTEMPT || 0], ['Failed logins', d.failedLogins], ['Suspicious sessions', d.suspiciousSessions]]
      .map(([l, v]) => h('div', { class: 'card' }, h('div', { class: 'stat' }, v), l))), h('div', { class: 'card' }, h('h2', {}, 'Violations by type'), Object.keys(t).length ? bars(Object.entries(t), Math.max(...Object.values(t))) : h('p', { class: 'mut' }, 'No violations in range.'))); });
  load();
  return [h('div', { class: 'card' }, formEl([{ name: 'from', label: 'From', type: 'datetime-local' }, { name: 'to', label: 'To', type: 'datetime-local' }], 'Apply', async (v) => {
    const p = new URLSearchParams(); if (v.from) p.set('from', new Date(v.from).toISOString()); if (v.to) p.set('to', new Date(v.to).toISOString()); load(p.toString() ? '?' + p : ''); })), box];
});
const integrityPage = () => page('integrity', 'Verify Examination Integrity', async () => {
  const out = h('div', {});
  return [h('div', { class: 'card' }, h('p', { class: 'mut' }, 'Enter a submission (attempt) ID. The system recalculates the SHA-256 hash and compares it with the database and ledger records.'),
    formEl([{ name: 'id', label: 'Submission ID', required: true }], 'Verify', async (v) => { const r = await api('GET', `/api/integrity/${encodeURIComponent(v.id.trim())}`);
      out.replaceChildren(h('div', { class: 'verdict ' + (r.verified ? 'ok' : 'bad') }, (r.verified ? '✓ ' : '⚠ ') + r.verdict), table(['Field', 'Value'], [['Submission ID', r.submissionId], ['Hash', h('code', {}, r.recalculatedHash)], ['Transaction', h('code', {}, r.txRef)], ['Timestamp', fmt(r.anchoredAt)], ['Verified at', fmt(r.verifiedAt)]])); }), out)];
});
const catalogPage = () => page('catalog', 'Departments, Courses & Subjects', async () => Promise.all(['department', 'course', 'subject'].map(async (k) => {
  const list = await api('GET', `/api/catalog/${k}`);
  return h('div', { class: 'card' }, h('h2', {}, k[0].toUpperCase() + k.slice(1) + 's'), formEl([{ name: 'name', label: 'Name', required: true }], 'Add', async (v) => { await api('POST', `/api/admin/catalog/${k}`, v); catalogPage(); }),
    table(['Name', 'Status', ''], list.map((c) => [c.name, tag(c.active ? 'ACTIVE' : 'INACTIVE', c.active ? 'ok' : 'warn'), h('button', { class: 'btn sm sec', onclick: guard(async () => { await api('POST', `/api/admin/catalog/item/${c.id}/active`, { active: !c.active }); catalogPage(); }) }, c.active ? 'Deactivate' : 'Activate')]), 'None yet.'));
})));

// ---------- router ----------
const ROUTES = {
  student: { dashboard: studentDashboard, exams: studentExams, exam: instructionsPage, resources: resourcesPage, notices: noticesPage, results: studentResults, review: reviewPage, notifications: notificationsPage, profile: profilePage },
  faculty: { dashboard: facultyDashboard, exams: examsPage, queue: queuePage, exam: manageExam, submissions: submissionsPage, submission: submissionPage, report: reportPage, bank: bankPage, resources: resourcesPage, notices: noticesPage, profile: profilePage },
  admin: { dashboard: adminDashboard, users: usersPage, exams: examsPage, submissions: submissionsPage, submission: submissionPage, report: reportPage, audit: auditPage, security: securityPage, integrity: integrityPage, catalog: catalogPage, notices: noticesPage, resources: resourcesPage, profile: profilePage },
};
function route() {
  cleanup.forEach((f) => f()); cleanup = [];
  const [a, b, c] = location.hash.replace(/^#\//, '').split('/');
  if (!S.token || !S.user) return a === 'login' ? loginPage() : (location.hash = '#/login');
  if (a === 'login') return go(`#/${R()}/dashboard`);
  if (a === 'exam' && S.user.role === 'STUDENT' && b) return examPage(b);           // distraction-free exam: no navigation
  if (a !== R() || !ROUTES[a][b]) return go(`#/${R()}/dashboard`);                  // role portals are separate; server enforces too
  ROUTES[a][b](c);
}
window.addEventListener('hashchange', route);
route();
