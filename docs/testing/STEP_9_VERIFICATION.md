# Step 9 verification — 2026-10-03

Implemented resident routes only, preserving Steps 1–8. The user approved occupancy-date restrictions for bills and own-payer-only payment/receipt visibility. See [contract](../resident/STEP_9_RESIDENT_PORTAL.md), [security](../security/RESIDENT_PORTAL.md) and the separate frontend `docs/STEP_9_RESIDENT_PORTAL.md`.

## Executed checks

Windows, Node 24.21.0, MySQL 8.4.8 and Chromium. Both repositories passed Prettier, ESLint, strict typecheck and production build. No lint/security rule was disabled and no dependency upgrade was required.

| Check                                           | Result                                                                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Backend `npm run check`                         | Passed; 28 tests and validation of all 13 additive migrations                                                             |
| Real-MySQL `tests/database.integration.test.ts` | 100 passed, zero failed/skipped, in a newly provisioned empty `livora_test_*` schema                                      |
| Frontend `npm run check`                        | Passed; 30 Angular unit tests, 3 proxy tests, production build and PWA validation                                         |
| Frontend `npm run test:e2e`                     | 42 Chromium tests passed, including the prior 35 regressions and 7 resident scenarios                                     |
| Dependency audits in both repositories          | Zero vulnerabilities                                                                                                      |
| Gitleaks on changed/tracked/nonignored source   | No leaks found                                                                                                            |
| Git diff / migration review                     | No whitespace errors, applied migration edits, committed local credentials, generated builds or unrelated project changes |

Total: **203 tests passed** across the five suites. Focused MySQL/browser runs were also used during implementation; their duplicate scenarios are not added to this total. Earlier failures exposed fixture period uniqueness, missing mounted test routes, sidebar group rendering, narrow header overflow, keyboard scrolling accessibility, and a cache-test mock conflict. These were corrected without reducing authorization or cache assertions. The final full browser run and database run passed.

## Verified boundaries and behavior

Real backend HTTP requests against restricted runtime MySQL credentials verify two societies with different roles, multiple current flats, historical/future occupancies, effective approved person links overriding global identity, and active membership/profile/session checks. Issued bill lists/details and dashboard totals exclude drafts and earlier/future unauthorized occupancies; outstanding/current/overdue amounts reconcile exactly. Ending occupancy removes bill access but preserves the person's own historical receipt.

Other-society IDs and another payer's receipt in the same flat return safe 404s. Own complaint history excludes another membership's complaint even for the same flat. Foreign/future/historical/ended flat complaint submissions are denied. Strict fields reject forged society, submitter and status; CSRF is required; accepted submission records the authenticated audit actor. Notice drafts and future publications are hidden. Residents remain denied committee, platform and finance routes even with an erroneous finance grant. Stale context returns 409, revoked membership/archived person 403, and expired/anonymous sessions 401 without private diagnostics.

Browser tests verify all resident list/detail routes, flat/status filters and removal of an old flat filter, same-account society switching, empty occupancy states, safe error messages, memory-only data and ignored late responses, private view removal after a 401, associated complaint validation, authorized flat/CSRF payloads, text escaping, receipt print layout, and 320px light/dark accessibility. The complete static-worker regression fetches cacheable private-response sentinels over the preview network, confirms they never enter CacheStorage, and confirms they are unavailable offline. The production manifest/worker contain static assets only and no API data groups.

## Live local verification and preservation

The managed stack was rebuilt and restarted at `http://127.0.0.1:4200`, API port 3000, owned MySQL port 3307 and Mailpit port 8025. The unrelated MySQL service on 3306 was not changed. The updater applied zero new migrations and provisioned SELECT notices plus SELECT/INSERT complaints for the existing runtime user.

An existing Step 6 approved synthetic resident signed in with its existing password, selected the approved community, opened every portal page, and called all eight list/summary/profile endpoints against the real API. All returned 200 with `no-store`; there is one currently authorized flat. That account currently has no eligible bills, own payments/receipts or published notices, so live testing confirmed those empty states. Nonempty billing/receipt/notice cases are covered independently by real MySQL integration fixtures and browser scenarios.

One clearly labeled **Step 9 local portal verification** complaint was submitted through the real form and retained for manual inspection. Repeated verification reads the same complaint rather than creating duplicates. Live 320px layout, both-theme Axe checks, no page errors and logout passed. This check did not reset passwords, create another account, or modify occupancy/financial history. Credentials remain only in ignored `.local-db/manual/STEP6_TEST_ACCOUNTS.md`; live evidence/screenshot remain in ignored local directories.

Before/after fingerprints confirm unchanged existing users/password hashes/statuses, memberships, occupancies, migration checksums/statuses and previously captured bill/item/adjustment/payment/allocation/reversal/receipt/audit rows. New authentication and complaint audit events are additive. All 13 migrations remain APPLIED. No existing tables/data were dropped or overwritten. Local status confirms all four owned services are running.

## Remaining manual/deployment checks

- Confirm native printer/PDF destination and paper layout with the intended device; automated print-media checks validate the resident receipt layout.
- Verify HTTPS Secure/HttpOnly/SameSite cookies and reverse-proxy configuration in the deployed environment; local loopback deliberately uses the existing development cookie policy.
- PWA installation was not repeated in Step 9. Production manifest/installability and static offline/cache boundaries passed; OS/browser installation remains the existing manual flow.
- Review actual committee-published notice content before use. Step 9 reads society-wide publications; targeted publishing and complaint assignment/resolution remain outside this step.

No Step 10 or later work was started. Further work requires the user's next requested step.
