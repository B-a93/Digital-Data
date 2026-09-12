# School prototype — first review build

School is product 1. Businesses are 2, government/public institutions 3, NGOs/associations 4. One repository does not imply one combined database or product. Product name and domain remain unapproved; this build uses “School workspace”.

## Implemented for fictional-data review

- Dashboard with enrolment, charge/payment balance totals and selected-date attendance.
- Student registration with required name, unique generated admission number, class assignment, search and class filters.
- Attendance: present, absent, late, excused and unmarked; save distinct from complete. Present/late proportion excludes unmarked and excused; this is a demo policy, not a nationally prescribed formula.
- Fees: fictional charges in dalasi; payment receipts with client operation keys, fingerprint checks and overpayment displayed as credit. Payment entry records a demo cash transaction, not money collection.
- Results: editable draft marks, configurable pass mark, explicit publish action producing an immutable snapshot. Changing a draft requires a new published version; current report export uses the latest snapshot.
- Reports: student, fee and published-result CSV downloads with formula-injection escaping.
- School settings: display name, term label and demo pass threshold.

## Not implemented / not represented as production features

Authentication and MFA, school membership enforcement, database tenant policies, scoped support access, audit logs, private uploads, scanned documents, imports, guardian relationships, student history/transfers, charge reversals/refunds, reconciliation close, weighted multi-subject grading, reviewer separation, printable official report cards, API retries/concurrency, authorised exports, backup/restore, deletion/retention controls, monitoring and billing.

The role selector is visual guidance only. All browsers/users can inspect all demo records. Browser-local records can be cleared or altered and cannot guarantee idempotency across devices. No real data is permitted. Static prototype testing is not evidence of compliance, performance at the proposed school capacity, production security or school acceptance.

## Next gates

Review workflows and UX with a school, agree authentication/backend/hosting and detailed schema, implement and test server-side isolation and ledger integrity, then authorise a controlled school pilot. Android implementation and Google Play distribution require their own build and release testing. The current web prototype is not an APK.

## Verification of this build

Automated domain and HTTP-server tests run with `npm test`. A Playwright smoke script is included, but browser execution and visual QA remain outstanding: the current environment could not download Chromium. No browser-test pass or visual verification is claimed.
