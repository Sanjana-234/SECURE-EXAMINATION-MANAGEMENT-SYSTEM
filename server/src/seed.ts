import type { Sems } from './service.ts';

export const DEMO_PASSWORD = 'Demo@12345!';   // DEMO ONLY. Accounts are flagged must-change-password.

export async function seed(s: Sems) {
  const admin = s.createUser(null, { email: 'admin@example.com', name: 'Demo Admin', role: 'ADMIN', password: DEMO_PASSWORD, mustChangePassword: true });
  const fac = s.createUser(null, { email: 'faculty@example.com', name: 'Demo Faculty', role: 'FACULTY', password: DEMO_PASSWORD, mustChangePassword: true });
  const stu = s.createUser(null, { email: 'student@example.com', name: 'Demo Student', role: 'STUDENT', password: DEMO_PASSWORD, mustChangePassword: true });
  s.createUser(null, { email: 'student2@example.com', name: 'Second Student', role: 'STUDENT', password: DEMO_PASSWORD, mustChangePassword: true });
  const f = { id: fac.id, role: 'FACULTY' as const };
  const exam = s.createExam(f, { title: 'Data Structures Midterm', subject: 'Data Structures',
    startAt: new Date(Date.now() - 60_000).toISOString(), durationMin: 60, passMarks: 6, negativeMarking: true,
    instructions: 'Answer all questions. Tab switching and copy/paste are logged.', maxViolations: 3, violationPolicy: 'FLAG', publishImmediately: true });
  const ab = [{ id: 'A', text: 'Stack' }, { id: 'B', text: 'Queue' }, { id: 'C', text: 'Tree' }, { id: 'D', text: 'Graph' }];
  s.addQuestion(f, exam.id, { type: 'MCQ', text: 'Which structure is FIFO?', options: ab, correct: 'B', marks: 2, negMarks: 0.5, topic: 'Basics' });
  s.addQuestion(f, exam.id, { type: 'MULTI', text: 'Which are linear structures?', options: ab, correct: ['A', 'B'], marks: 3, negMarks: 1, difficulty: 'HARD' });
  s.addQuestion(f, exam.id, { type: 'TF', text: 'A binary search tree allows O(log n) average search.', correct: 'true', marks: 1, negMarks: 0.25, difficulty: 'EASY' });
  s.addQuestion(f, exam.id, { type: 'SHORT', text: 'Define a hash collision.', marks: 4 });
  s.setExamStatus(f, exam.id, 'SCHEDULED');
  s.createExam(f, { title: 'Algorithms Quiz (draft)', subject: 'Algorithms', startAt: new Date(Date.now() + 86_400_000).toISOString(), durationMin: 30, passMarks: 5 });
  return { admin, fac, stu, examId: exam.id };
}

/** Dev convenience: the seeded demo exam is only open for its duration, so a database created days ago would show
 *  "Exam window has closed". Re-open it (only if nobody has attempted it yet). Never call this in production. */
export function refreshDemoExam(s: Sems): boolean {
  const e: any = s.db.prepare(`SELECT e.id, e.start_at, e.duration_min FROM exams e JOIN users u ON u.id = e.faculty_id
                               WHERE u.email = 'faculty@example.com' AND e.title = 'Data Structures Midterm'`).get();
  if (!e) return false;
  const t = s.now().getTime();
  if (t <= Date.parse(e.start_at) + e.duration_min * 60_000) return false;                 // still open (or upcoming)
  if (s.db.prepare('SELECT 1 FROM attempts WHERE exam_id = ?').get(e.id)) return false;   // never rewrite an exam that has attempts
  s.db.prepare('UPDATE exams SET start_at = ? WHERE id = ?').run(new Date(t - 60_000).toISOString(), e.id);
  return true;
}
