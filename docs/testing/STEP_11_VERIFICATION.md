# Step 11 verification — 2026-10-03

Follow-up: [real browser/API manual checklist verification](STEP_10_11_MANUAL_VERIFICATION.md) on 4 October 2026 covers every requested checklist item and records a report accessibility fix.

Step 10 was completed and checked separately before Step 11. Step 10 passed 217 regular tests and both GitHub quality workflows. Step 11 preserves its migration/workflows and all earlier resident/billing/payment privacy boundaries.

## Executed checks

- Backend `npm run check`: formatter, typed ESLint, strict typecheck, **34 unit tests**, production build and validation of **14 additive migrations** passed.
- Full `npm run test:db` on a fresh, isolated MySQL 8.4 schema: **118 tests passed**, including all earlier steps and nine new report/dashboard subtests. Runtime used restricted grants; fixtures were retained for inspection. No existing development database was used for fixture writes.
- A focused fresh-MySQL run passed all **10 tests** again after the final export authorization ordering change. This repeat is separate evidence, not added to the regular-suite count.
- Frontend `npm run check`: formatter, typed/template ESLint, strict app/test/tool typecheck, **31 unit tests**, **3 proxy tests**, production build and PWA manifest/static-cache checks passed.
- Frontend `npm run test:e2e -- --workers=1`: **51 browser tests passed**, including report pagination/date feedback, safe CSV downloads/limits, discarded exports after society switching, role-specific dashboards/guards, expired-session clearing, 320px light/dark accessibility and real service-worker private-response/offline exclusion for all report/export URLs. The regular suites total **237 passing tests**; focused repeats and live smoke checks are additional evidence.
- Dependency audits in both repositories reported **zero vulnerabilities**. Local Gitleaks source scanning and git-diff review found no exposed credentials, generated build output or migration edits.

The database tests reconcile issued bills/current balances with original payments, refunds, reversals and cash events; verify full-filter totals independent of page; check inclusive business dates and half-open society-local resident-creation boundaries; reject inappropriate sort/filter fields and foreign references; enforce role ceilings despite malicious grants; verify limited platform metadata and committee-member finance exclusion; parse formula-protected multiline CSV; check explicit/revoked export permission and audit actor; reject results over 5000 without truncation; and test export rate limits, society switching and suspended memberships. Date utility tests include India, 23/25-hour New York days and Samoa's skipped civil day.

## Local verification and data preservation

The managed loopback stack was rebuilt/restarted. Step 11 applied **zero schema migrations** and provisioned additive report permissions. All 14 applied migration checksums remained intact. Before/after fingerprints confirmed existing account/password records, society memberships, occupancies and prior bills/items/adjustments/payments/allocations/reversals/receipts/audit rows were preserved. Test-created isolated schemas were not dropped.

Using an existing Committee Admin account without changing its password, the real Angular app/cookie API successfully displayed the committee dashboard and all seven report pages. Each real report API paginated and returned no-store responses; a CSV downloaded with UTF-8 BOM and the expected receipt columns. The actual 320px report screen fit its viewport, passed Axe accessibility checks and was visually reviewed. Existing local financial fixtures reconciled: recorded payments 1900.00 less refunds 200.00 and reversals 500.00 equals net collections/payments 1200.00; cash net is 800.00. These are development-fixture values, not production financial assertions. Read-only checks and an authorized export added normal session/audit events without rewriting old financial records.

Ignored local evidence/logs: backend `.local-tools/step11-{check,db,focused,live}.log`, `.local-db/manual/step11-preservation.json`, `.local-db/manual/step11-live-verification.json`; frontend `.local-tools/step11-check.log` and `.local-tools/step11-e2e.log`. Credentials, screenshots containing fixture identifiers and downloaded artifacts remain ignored.

## Remaining operator checks

Physical PWA installation and device/OS-specific spreadsheet/download behavior need the target device/browser. Confirm production HTTPS cookie/header configuration through the existing deployment checklist. Committee cash reconciliation still requires comparison with physical cash/bank records. Legacy reversals without explicit operation-date details remain labeled LEGACY_UTC; no historical business date has been invented.

Step 11 adds no schema migration, paid service, external notification integration or payment gateway. No work beyond Step 11 was started.
