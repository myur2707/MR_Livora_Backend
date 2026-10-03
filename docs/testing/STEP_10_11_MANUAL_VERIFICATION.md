# Step 10 and Step 11 checklist verification

Verified on 4 October 2026 (workspace date). All 19 requested checklist items passed using browser automation and direct API probes against the production Angular build, real cookie-authenticated Express API and isolated MySQL 8.4 schemas. Requests reached the real backend; browser routes only paced requests and did not mock API responses. Runtime database grants, CSRF checks, authorization and rate limits remained enabled.

Step 10 and the final Step 11 run used separate fresh `livora_test_` schemas. Test accounts had randomly generated passwords. The controlled domain clock used 5 October 2026 and advanced with elapsed time. Fixtures and schemas were retained; the existing manual-development database was never used for fixture writes.

## Step 10 results

| Checklist item                              | Result and evidence                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Committee publishes; society resident views | PASS: created draft and published through Angular; resident opened the same notice; author and publication timestamp present.                                           |
| Resident submits; committee resolves        | PASS: resident form submitted a categorized complaint for an authorized flat; committee UI assigned, progressed, resolved and closed it.                                |
| Status history                              | PASS: resident API/UI exposed NEW, ASSIGNED, IN_PROGRESS, RESOLVED and CLOSED history entries and resolution timestamp.                                                 |
| Archived visibility                         | PASS: committee retained ARCHIVED detail; resident list excluded it; resident detail API returned 404 and the page displayed an unavailable outcome.                    |
| Cross-society notice/complaint              | PASS: foreign IDs returned 404.                                                                                                                                         |
| Another resident's complaint                | PASS: detail returned 404; attempted edit/assignment could not change stored title/description. Complaint content editing is unsupported; a PATCH attempt returned 403. |
| Resident publishing/assignment              | PASS: direct committee mutation requests returned 403; typed committee URLs redirected to Workspace.                                                                    |
| HTML/script content                         | PASS: notice and complaint displayed literal script/image markup; no injected script/image elements, execution flag or browser dialog appeared.                         |
| Invalid status transition                   | PASS: NEW to RESOLVED and CLOSED to NEW returned 409.                                                                                                                   |

## Step 11 results

| Checklist item                         | Result and evidence                                                                                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard totals                       | PASS: financial summaries matched independent integer calculations; active flats, occupancy, pending complaints and recent published notices matched seeded records. All seven report APIs returned paginated, no-store responses. |
| Date/building/method/collector filters | PASS: event-day totals, populated/empty building subsets, UPI-only rows and separate committee/accountant collectors matched expected records. Browser date/method filtering displayed the expected UPI row.                       |
| Stable pagination                      | PASS: distinct billing pages, repeatable ordering and identical full-filter totals across pages.                                                                                                                                   |
| Filtered CSV                           | PASS: parsed export matched every filtered API row/column; real browser CSV download contained one expected UPI row and UTF-8 BOM.                                                                                                 |
| Platform metadata                      | PASS: response contained only statuses, totalSocieties, pendingVerification and updatedAt; platform UI exposed no tenant finance/contact details; tenant export returned 403.                                                      |
| Invalid filters                        | PASS: reversed, impossible or incomplete dates, unknown sort, invalid page sizes and supplied societyId returned 400.                                                                                                              |
| Cross-society export                   | PASS: foreign building/flat/period references returned 404; unauthorized society-context selection returned 403; resident export returned 403.                                                                                     |
| Formula injection                      | PASS: resident names beginning with =, +, - and @ exported with leading apostrophes; quoted/multiline names round-tripped through CSV parsing.                                                                                     |
| Large reports                          | PASS: 5005 occupancy records produced 20 rows in the real API/browser page; export over 5000 returned 422 with visible narrowing guidance. The browser received a page rather than the entire result set.                          |
| Midnight/timezone boundaries           | PASS: Asia/Kolkata 3 October includes UTC 2 October 18:30 through 3 October 18:29:59.999999; immediately preceding and next-day instants were excluded. Reversal appeared on its explicit 4 October business date.                 |

## Independent financial sample

Two issued bills total 100.25 + 200.10 = **300.35**. Original recorded payments total 100.25 CASH + 20.05 CASH + 30.10 UPI = **150.40**. A 20.00 cash refund and 20.05 cash reversal yield **110.35** net payments/collections, **190.00** outstanding and **80.25** net cash. The UPI payment was collected by the accountant; cash was collected by the committee administrator.

On 3 October the collection ledger shows 50.15 original collections less 20.00 refunds = **30.15** net. The 4 October reversal yields **-20.05** that day. These are isolated synthetic fixtures; physical cash reconciliation remains an operator check.

## Fix and regression checks

The additional live 320px accessibility check found an empty report-totals div with an invalid ARIA label on nonfinancial reports. The frontend now renders a named semantic section only when totals exist. A browser regression test covers resident and occupancy reports in light/dark themes without empty totals or Axe violations. The final real 5005-row report passed Axe checks, fit its mobile viewport and was visually reviewed.

- Backend `npm run check` passed formatter, lint, strict typecheck, 34 unit tests, build and validation of 14 additive migrations.
- Frontend `npm run check` passed formatter, lint, strict typecheck, 31 unit tests, 3 proxy tests, production build and PWA checks.
- Frontend full Chromium suite passed 52 tests, including the new regression and prior community/security/offline scenarios.
- The unchanged backend revision also passed 118 tests against fresh MySQL during the preceding Step 11 recheck. Those checks were not repeated for this frontend markup fix.
- Before/after fingerprints confirmed existing accounts/password hashes, memberships, occupancies and captured financial/audit records were preserved; all 14 applied migration checksums remained intact.

No schema migration, dependency change, business API or later roadmap feature was added. Changes are the frontend report template, its browser regression test and verification documentation. Local app/services remain available at `http://127.0.0.1:4200`.

## Local evidence

Ignored machine-local evidence lives under backend `.local-tools/` and `.local-db/manual/`: Step 10 checklist results, final Step 11 checklist results, combined verification JSON, preservation fingerprints, filtered CSV and mobile screenshot. Check logs are `step10-11-final-check.log` in each repository and frontend `step10-11-final-e2e.log`; the earlier 118-test database log is `step11-recheck-2026-10-04-db.log`. Credentials and fixture artifacts remain ignored. Native device/spreadsheet behavior and production HTTPS deployment are environment-specific operator checks.
