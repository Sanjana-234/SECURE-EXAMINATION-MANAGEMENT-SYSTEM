# Manual browser QA checklist (not automatable in the build sandbox)
Run once in Chrome, Firefox and Safari (desktop) and one mobile browser. Demo accounts: see README.

Student
- [ ] Login → dashboard shows welcome, upcoming exams, notices. Wrong portal URL bounces to own dashboard.
- [ ] Exam → Instructions → **Start Examination**: enters fullscreen, questions visible (no blue overlay), timer counts down.
- [ ] Select an MCQ option, reload the page (F5 → confirm), re-open via **Resume**: answer is still selected, timer continues from server time.
- [ ] Turn network off 20 s while answering, back on: header shows offline then recovers; answers persisted after reload.
- [ ] Press Esc (exit fullscreen): blue "Fullscreen required" overlay appears, violation count increments, "Return to fullscreen" restores.
- [ ] Switch tab / Alt-Tab: TAB_SWITCH recorded (count +1). Ctrl+C / Ctrl+V / right-click / Ctrl+P: blocked and recorded.
- [ ] Reach the violation threshold: warning → flagged banner (or auto-submit when the exam policy is AUTO_SUBMIT).
- [ ] Let the timer reach 00:00: exam is submitted automatically and you land on Results.
- [ ] Submit → confirmation dialog shows unanswered count → results page; second submit impossible.
Faculty
- [ ] Create exam (start = now), add each question type, Draft → Scheduled → Live; form shows errors for bad input.
- [ ] Submissions: open one, mark the short answer, save, publish results (password prompt), verify integrity → green verdict.
Admin
- [ ] Create user, change status (password prompt), edit email, audit filter + paging, security charts, integrity page on a tampered record shows MISMATCH.
Layout
- [ ] 360 px wide phone: nav scrolls, tables scroll sideways, exam screen usable. Keyboard-only: all buttons reachable, dialogs focus the first field.
