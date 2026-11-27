# LabBridge Session Log

## 2026-11-26 - Audit fixes C1-C5

### Objective
Implement the first high-priority audit batch on `audit-fixes` without changing `v2`.

### Completed
- C1 role authorization across protected route groups.
- C2 masking of sensitive tests in list, detail, dashboard, and sign-off responses.
- C3 guardrail word-boundary and qualitative translation checks.
- C4 authenticated draft ownership and atomic sign-off.
- C5 HMAC coverage for signed record content.
- Added integration tests using the Node test runner and an in-memory Supabase/PostgREST mock.
- Addressed supplied Codex review findings: atomic draft sign-off, draft provenance HMAC, full-field signed HMAC, sensitive-test aliases, and contextual guardrail patterns.
- Pushed commits:
  - `283a40c Fix C1-C5 security and approval issues`
  - `5d06055 Harden draft sign-off and sensitive test handling`
- Test result: 7 passed, 0 failed.

### Notes
- `v2` remains at `9e43cc3`.
- Legacy unsigned drafts created before the DRAFT HMAC change must be reprocessed.
- Guardrails remain pattern-based and are not a complete clinical language classifier.

## 2026-11-26 - Audit fixes C6-C8

### Objective
Implement C6-C8 on `audit-fixes`, run regression tests, request independent Codex reviews, and stop for human review before C9-C10.

### Scope
- C6: PHI exposure in application logs and third-party AI providers.
- C7: patient identity storage and accurate record retrieval.
- C8: inequality reference-range severity calculations.

### Planned changes
- Add centralized identifier redaction and safe error summaries.
- Remove patient names, raw clinical content, translations, and AI response bodies from application logs.
- Redact direct identifiers before external AI calls and skip third-party clinical-significance calls for sensitive tests.
- Persist a normalized `patient_id` on drafts and signed records, require it for processing/sign-off, and look records up by exact ID.
- Add a Supabase migration for `patient_id` and a backfill for legacy rows.
- Parse `<`, `>`, `<=`, `>=`, and textual one-sided reference ranges for severity, confidence, and reference comparison.
- Document the migration prerequisite before deployment.

### Progress
- Implemented C6 in `src/privacy.js`, `src/index.js`, and `src/ai-core.js`.
  - Added `redactIdentifiers`, `buildDeidentifiedClinicalData`, and `safeErrorCode`.
  - Redacts patient name, normalized patient ID, compact ID variants, name tokens, clinician, email addresses, URLs, separated phone numbers, and simple street addresses before AI calls.
  - Clinical test names are preserved for sensitive-test detection; only contact-style identifiers are removed from them.
  - Removed patient name, test value, raw finding, AI response content, translation output, and provider response bodies from application logs and route error logs.
  - Sensitive qualitative tests no longer call external clinical-significance AI.
  - Sensitive numeric tests are processed locally with a generic translated patient message.
  - Sign-off audit logs now store the patient ID and record ID instead of the patient name and test value.
- Implemented C7 in `src/index.js`, `public/index.html`, and `supabase/migrations/20261126000000_add_patient_id.sql`.
  - `patientId` is required and normalized for process and sign-off requests.
  - Draft and signed records persist `patient_id`; version 2 HMAC records cover `signature_version` and `patient_id`.
  - Legacy records keep signature version 1 and authenticate against the pre-C7 field set, so the migration's `patient_id` backfill does not invalidate their hashes.
  - New drafts and signed records use signature version 2.
  - List and detail responses return `recordId` and `patientId`.
  - Detail lookup uses exact `patient_id` plus optional `recordId`, preventing cross-patient record selection.
  - Archive UI passes both patient ID and record ID.
  - Migration adds `patient_id` and `signature_version`, backfills legacy patient IDs as uppercase `LEGACY-<uuid>`, leaves legacy signatures at version 1, and indexes `patient_id`.
- Implemented C8 in `src/ai-core.js` and `public/index.html`.
  - Added parsing for `<`, `<=`, `>`, `>=`, Unicode `≤`/`≥`, textual one-sided ranges, and hyphenated ranges.
  - Severity, reference comparison, and the review status badge now handle one-sided ranges.
  - Confidence no longer treats the single bound of a one-sided range as a center; in-range values are not penalized as extreme deviations.
- Files changed: `src/index.js`, `src/ai-core.js`, `src/privacy.js`, `public/index.html`, `test/security.test.js`, `supabase/migrations/20261126000000_add_patient_id.sql`, `session.md`.
- Regression tests added for C6-C8. Final test result: 11 passed, 0 failed.
- `node --check` passed for changed JavaScript files and the inline frontend script.
- Three independent Codex review cycles were completed.
  - Cycle 1: sensitive test-name preservation and textual one-sided frontend ranges; both fixed.
  - Cycle 2: legacy HMAC mismatch after `patient_id` backfill; fixed with signature versioning.
  - Cycle 3: contact identifiers in free text and one-sided confidence distortion; both fixed.
  - A fourth review was not run because the automatic review limit is three cycles.
- Migration is not yet applied to the live Supabase project. It must be applied before deploying C7 writes, because `patient_records` currently lacks `patient_id` and `signature_version`.
- Existing rows appear as `LEGACY-<uuid>` after migration. Existing unsigned drafts still require reprocessing to be found by their real patient ID during sign-off, even though their legacy signatures remain verifiable.
- Non-sensitive clinical text is still sent to external AI providers after best-effort identifier redaction. Sensitive results stay local for clinical significance and use a generic translated message.
- Redaction is best-effort and does not guarantee removal of every possible identifier from free-text findings.
