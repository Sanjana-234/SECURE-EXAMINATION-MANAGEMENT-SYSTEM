export type Q = { id: string; type: string; marks: number; neg_marks: number; correct: any };

const sameSet = (a: any, b: any) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const r2 = (n: number) => Math.round(n * 100) / 100;

export function letter(pct: number, passed: boolean): string {
  if (!passed) return 'F';
  return pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'E';
}

// Pure function: all marking is computed on the server from stored data only.
export function grade(questions: Q[], answers: Map<string, any>, manual: Map<string, number>,
                      exam: { negative_marking: number; pass_marks: number }) {
  let pos = 0, neg = 0, attempted = 0, correct = 0, incorrect = 0, unanswered = 0, pending = 0, max = 0;
  for (const q of questions) {
    max += q.marks;
    const a = answers.get(q.id);
    const has = a !== undefined && a !== null && a !== '' && !(Array.isArray(a) && a.length === 0);
    if (has) attempted++; else unanswered++;
    if (q.type === 'SHORT' || q.type === 'LONG') {
      if (manual.has(q.id)) pos += manual.get(q.id)!; else if (has) pending++;
      continue;
    }
    if (!has) continue;
    const ok = q.type === 'MULTI' ? sameSet(a, q.correct) : String(a) === String(q.correct);
    if (ok) { correct++; pos += q.marks; } else { incorrect++; if (exam.negative_marking) neg += q.neg_marks; }
  }
  const score = r2(pos - neg), percentage = max ? r2((score / max) * 100) : 0, passed = score >= exam.pass_marks;
  return {
    total_questions: questions.length, attempted, correct, incorrect, unanswered,
    positive_marks: r2(pos), negative_marks: r2(neg), score, max_marks: max, percentage,
    grade: letter(percentage, passed), passed: passed ? 1 : 0,
    eval_status: pending > 0 ? 'PENDING_FACULTY_EVALUATION' : 'COMPLETE',
  };
}

export const isAnswered = (a: any) => a !== undefined && a !== null && a !== '' && !(Array.isArray(a) && a.length === 0);

// Per-question outcome (same rules as grade(); used for result review).
export function perQuestion(questions: Q[], answers: Map<string, any>, manual: Map<string, number>, exam: { negative_marking: number }) {
  const out = new Map<string, { status: string; awarded: number | null }>();
  for (const q of questions) {
    const a = answers.get(q.id), has = isAnswered(a);
    if (q.type === 'SHORT' || q.type === 'LONG') {
      out.set(q.id, manual.has(q.id) ? { status: 'MARKED', awarded: manual.get(q.id)! } : has ? { status: 'PENDING', awarded: null } : { status: 'UNANSWERED', awarded: 0 });
      continue;
    }
    if (!has) { out.set(q.id, { status: 'UNANSWERED', awarded: 0 }); continue; }
    const ok = q.type === 'MULTI' ? sameSet(a, q.correct) : String(a) === String(q.correct);
    out.set(q.id, ok ? { status: 'CORRECT', awarded: q.marks } : { status: 'INCORRECT', awarded: exam.negative_marking ? -q.neg_marks : 0 });
  }
  return out;
}
