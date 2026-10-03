# Step 12 checklist verification

Verified on 4 October 2026 (workspace date). This follow-up runs the requested security checklist against the existing Step 12 hardening changes. Only security validation, regression tests and documentation were added; no business feature or migration was added.

## Checklist results

| Requested check                                                | Result and evidence                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Representative cross-tenant checks for every module            | PASS: all 125 tests in the fresh MySQL security/domain suite passed. The module coverage table below identifies the real HTTP/MySQL security suites.                                                                                                                                                                                                                                                                   |
| Production errors omit stack traces and SQL                    | PASS: `http.unit.test.ts` runs Express in production mode, injects a database error carrying SQL/path/credential markers, and asserts the exact safe 500 response. `auth.integration.ts` also injects a repository failure behind the configured trusted proxy with Secure cookies and asserts a generic, non-cacheable response.                                                                                      |
| Logs omit passwords, tokens and secrets                        | PASS: production error regression asserts the exact structured `{code, requestId}` log and absence of credential/SQL/path markers. Known local credentials were checked against both existing backend operational logs without printing credentials: zero matches. Captured check logs contain no synthetic credential markers. Source review confirms the server logger forwards only a safe code and correlation ID. |
| Billing, payment and supported role changes have audit entries | PASS: read-only inspection found 31 attributed audit events across 11 critical action types; all have an actor and correlation ID. Issued bills, recorded-payment receipts and all seven role grants link to matching tenant records. General role editing is not an implemented feature; role-granting evidence covers initial Committee Admin acceptance, resident invitation acceptance and registration approval.  |
| Dependency and Sonar results are accurate                      | PASS: fresh full `npm audit --json` results show zero known vulnerabilities in both repositories, including development dependencies. SonarQube/SonarCloud was **not run**: no project/server/scanner configuration, installed scanner or SONAR environment setup was available.                                                                                                                                       |
| Repository and Git history accidental secrets                  | PASS: Gitleaks scanned both complete repository histories with redaction (24 backend and 16 frontend commits) and the combined nonignored working source; no leaks found. No credential remediation was required. Ignored environment files, local credentials, generated outputs and test logs remain ignored.                                                                                                        |
| Mass assignment of role, society and audit fields              | PASS: strict request schemas reject protected building/notice fields and report queries; existing suites cover forged user/role/society/recorder and membership identifiers.                                                                                                                                                                                                                                           |
| SQL injection in search/filter inputs                          | PASS: new probes exercise literal SQL/wildcard searches in property, billing, notices and all seven reports, and reject injected sort/direction/identifier values. The first run exposed the shared identifier-conversion bug described below.                                                                                                                                                                         |
| Valid login with the wrong membership                          | PASS: foreign resource IDs, unowned society context, disabled/revoked membership, stale context and platform-only identity are tested at the backend.                                                                                                                                                                                                                                                                  |
| Broad lint/Sonar suppressions                                  | PASS: source, tests, scripts, ESLint and CI configuration searches found no `eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `NOSONAR` or Sonar exclusion directives. Existing strict rules and the Step 12 complexity ceiling remain enabled.                                                                                                                                                                      |

## Module coverage

These are real backend HTTP requests and MySQL assertions with authorization, CSRF, rate limits, transactions and database constraints enabled. Coverage is representative; it does not prove every possible endpoint/state combination.

| Module                                          | Suite and representative boundary                                                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity, authentication and authorization      | `auth.integration.ts`: forged identities, unowned society selection, different roles across two societies, foreign flat IDOR, revoked sessions and platform scope.                           |
| Platform onboarding and activation              | `onboarding.integration.ts`: platform-only routes, foreign setup identifiers, private tenant setup restrictions, committee verification and invalid transitions.                             |
| Buildings, flats, people, occupancy and imports | `property.integration.ts`: tenant reads/writes/import ownership, strict mutation schemas, archive/occupancy history, revoked membership, literal searches and protected-field rejection.     |
| Resident invitations and registration           | `resident-access.integration.ts`: foreign invitations, intended person/account, token expiry/reuse, unauthorized approval and failed cross-tenant identity/occupancy linking.                |
| Maintenance and billing                         | `billing.integration.ts`: scoped configuration/period/flat/bill identifiers, unauthorized discounts, duplicate/concurrent generation, rollback and literal searches.                         |
| Payments, corrections, refunds and receipts     | `payments.integration.ts`: foreign bill/payment/receipt IDs, forged recorder, unauthorized collector, idempotency, concurrent allocation, rollback and reconciliation.                       |
| Resident portal/profile                         | `resident-portal.integration.ts`: multiple flats/societies, occupancy-period bill policy, personally owned payments/receipts, IDOR, disabled membership, archived person and session expiry. |
| Notices and complaints                          | `community.integration.ts`: foreign notices/complaints, resident ownership, committee permission checks, immutable status history, protected-field rejection and literal notice searches.    |
| Dashboards, all seven reports and CSV exports   | `reports.integration.ts`: tenant totals/filter references, export permissions, society switching, suspended membership, formula injection, literal searches and injected query rejection.    |

The Chromium production suite additionally covers auth/session loss, multiple society contexts, route permissions, mobile/keyboard/Axe behavior, HTML CSP and actual service-worker Cache Storage exclusions. Most domain browser tests use controlled API fixtures; the backend suites above provide real server/database boundary evidence. The earlier Step 10/11 real-backend browser verification is documented separately.

## Critical audit inspection

Read-only queries against the isolated schema verified these rows without exporting personal data or credentials. Each counted event has a non-null authenticated actor and a nonempty request ID. Same-society joins verified all five issued bills, all nine recorded-payment receipts, two Committee Admin grants, two invitation Resident grants and three approved-registration Resident grants.

| Action                           | Audit rows |
| -------------------------------- | ---------: |
| `BILL_ISSUED`                    |          5 |
| `BILL_GENERATION_COMPLETED`      |          4 |
| `BILL_DISCOUNT_AUTHORIZED`       |          1 |
| `payment.recorded`               |          9 |
| `payment.reversed`               |          1 |
| `payment.refunded`               |          2 |
| `payment.corrected`              |          1 |
| `committee.accepted`             |          2 |
| `resident.invitation_accepted`   |          2 |
| `resident.registration_approved` |          3 |
| `society.activated`              |          1 |

## Finding and fix

| Finding                                      | Severity | Evidence                                                                                                                                                                                                                                           | Fix                                                                                                                                                                                                                                                                                                                                                                           | Remaining risk                                                                                          |
| -------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Malformed identifier conversion returned 500 | Low      | The new report probe `buildingId=1 OR 1=1` returned a generic 500 and logged `REQUEST_FAILED`. Zod continued into the `BigInt` refinement after the identifier regex failed. No query or stack trace was exposed; injected text never reached SQL. | In `src/onboarding/contracts.ts`, pipe the format-validated string into the unsigned 64-bit bounds refinement. `tests/onboarding.unit.test.ts` now checks malformed, SQL-like, fractional, signed, oversized and nonstring identifiers produce a validation failure and safe 400; valid endpoints of the range remain accepted. The report integration assertion remains 400. | Future schemas performing potentially throwing conversions must validate their input before conversion. |

The first new full database run failed on this probe and the suite's expected-empty error-log assertion. Both failures are retained in ignored local evidence. Assertions and security settings were preserved while fixing the validator; the final rerun passed all 125 tests, including the injected-identifier probe and expected-empty operational error log.

## Executed checks and evidence

| Check                                            | Result                                                                                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Backend `npm run check`                          | PASS: formatter, lint, strict typecheck, 37 unit tests, production build and validation of 14 additive migrations.                        |
| Fresh MySQL 8.4 full security/domain integration | PASS: all 125 tests, no failures/skips; fresh migration apply/replay, restricted runtime grants and all nine security/domain HTTP suites. |
| Frontend `npm run check`                         | PASS: formatter, lint, app/spec/tool typechecks, 32 Angular unit tests, 4 proxy/static-host tests, production build and PWA validation.   |
| Frontend `npm run test:e2e`                      | PASS: 54 Chromium tests.                                                                                                                  |
| Full dependency audit, both repositories         | PASS: zero known vulnerabilities.                                                                                                         |
| Gitleaks histories and combined working source   | PASS: no leaks found.                                                                                                                     |
| Source suppression search and diff whitespace    | PASS: no suppression directives or diff whitespace errors; final documentation formatting checked.                                        |
| Existing development-data preservation           | PASS: original account/password-hash, membership, occupancy, financial/audit row fingerprints and all 14 migration checksums unchanged.   |
| Actual Sonar analysis                            | NOT RUN; configuration/scanner/server unavailable.                                                                                        |

Local evidence is deliberately ignored and contains no committed credentials: backend `.local-tools/step12-manual-check-final.log`, `step12-manual-db-final.log`, dependency/history scan logs and `.local-db/manual/step12-manual-audits.json`; frontend `.local-tools/step12-manual-check.log` and `step12-manual-e2e.log`; workspace `.local-tools/step12-manual-source-secrets.log`. The ignored test environment contains credentials and must never be committed or copied into this report.

## Scope and remaining checks

Each database run used a newly created empty loopback `livora_test_` schema with separate restricted migrator/runtime identities on the verified workspace-owned MySQL instance. Schemas were retained. No existing data was dropped, overwritten or migrated, and the unrelated local MySQL instance was untouched.

Production-mode and trusted-proxy tests ran locally; no real deployed HTTPS ingress, production log aggregation or Sonar service was available. Verify those deployment controls at the actual host. Secret/dependency scans are point-in-time and cannot prove a credential was never copied elsewhere. Operational-log checks cover the available local logs and current known credentials; they do not claim to inspect historical production logs. Read-only audit inspection covers application actions created by the tests, rather than administrative fixture SQL or arbitrary database changes.

See [SECURITY_AUDIT.md](../security/SECURITY_AUDIT.md) and [CODE_QUALITY.md](../quality/CODE_QUALITY.md). Stop at Step 12.
