# Step 8 verification

Only Step 8 was implemented. Prior architecture/authentication/onboarding/resident management and Step 7 billing remain preserved. Added APIs/Angular screens cover payment recording, exact allocations, immutable receipts/history, partial/full refunds, reversals, linked corrections and filtered collection reports. No gateway, production deployment or later roadmap feature was added. See [policies/API](../billing/STEP_8_PAYMENTS.md), [schema 013](../database/PAYMENT_SCHEMA.md) and [security](../security/PAYMENTS.md).

## Executed local checks (2026-10-03)

| Check                              | Result                                                                                                                                                   |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend `npm run check`            | Format, ESLint, strict TypeScript, 26 unit/offline tests, production build and 13 additive migration validation passed                                   |
| Backend real MySQL 8.4.8 tests     | 91 tests passed on a fresh disposable schema; includes migration rerun/checksums, tenant/FK/immutability/privilege invariants and prior-step regressions |
| Frontend `npm run check`           | Format, ESLint, strict Angular/TypeScript, 27 unit tests, 3 proxy tests, production build and PWA checks passed                                          |
| Frontend `npm run test:e2e`        | 35 Chromium tests passed, including six payment flow/security/accessibility tests and private-response cache/offline checks                              |
| `npm audit`                        | Zero reported vulnerabilities in both repositories                                                                                                       |
| Gitleaks current nonignored source | No leaks found; ignored local credentials/test output excluded from source distribution                                                                  |
| Diff review                        | No applied migration changes, dependencies/upgrades, global lint/security suppressions, source credentials or unrelated roadmap work                     |

Payment integration verifies multi-bill partial/full allocations, live outstanding, canonical same-key retry/conflicting content, foreign receipt/payment/bill/flat/payer/collector denial, disabled/unauthorized collector denial, forged recorder rejection, dates/CSRF, noncash reference duplicates, refund boundaries/reuse, simultaneous refund ceiling, full reversal/receipt preservation, distinct-recorder concurrent overpayment, identical-key concurrency, atomic linked correction, injected full-write rollback including correction reversal, immutable snapshots, exact report reconciliation against both movements and allocations, historical collector choices after account/profile deactivation, live permission revocation, filtering/pagination and parent deletion protection. Disabling the synthetic collector revokes their session; tests explicitly sign in again after restoring that disposable account.

Browser tests exercise record allocation payloads/CSRF/derived recorder, in-memory retry key, safe overpayment feedback, associated invalid-money feedback, refunds, replacement/original route navigation, print media/native print invocation, date/collector/method filters, accountant restrictions, resident guards and mobile light/dark accessibility. Static-only service-worker checks include the payment/report/receipt APIs and prove private responses do not enter caches or work offline.

## Retained local demonstration

The owned loopback stack was rebuilt and safely upgraded to **13 applied / 0 pending** migrations. Account/password, membership and occupancy fingerprints were unchanged; every preexisting bill/item/adjustment/payment/allocation/reversal/receipt/audit row was preserved. No reset/seed or destructive database command was used. The unrelated MySQL service on port 3306 was untouched.

At `http://127.0.0.1:4200`, use the existing local credentials from ignored `.local-db/manual/TEST_ACCOUNTS.md`; choose ACTIVE society **Checklist onboarding DEMO_1790963121678** (ID 7). Maintenance → Payments/Collection report contains explicitly synthetic entries for the retained Step 7 flat **STEP6_1790973998614 / 601** and bill **B-1-53**:

- Original bill gross **2500.25**, approved credit **100.00**, net **2400.25** remain unchanged.
- Payment 1 / **R-7-1** records **1000.00 CASH**, with a **200.00 CASH** refund; effective amount **800.00**. The original receipt remains PARTIALLY_REFUNDED with its full history.
- Payment 2 / R-7-2 is preserved and reversed by a linked correction; replacement payment 3 / **R-7-3** records **400.00 UPI**.
- Payment 4 / R-7-4 records **100.00 CASH** and is fully reversed as an incorrect synthetic entry.
- Effective allocations total **1200.00**; bill outstanding **1200.25**. All-method report collections **1900.00**, refunds **200.00**, bookkeeping reversals **500.00**, net **1200.00**. CASH-filter net is **800.00**.

Actual local API checks confirmed unchanged-request retry reuses the payment and an allocation of 1200.26 against 1200.25 outstanding is rejected. Real rebuilt Angular screens rendered receipt/history/report and followed correction links without page errors, including a 390-pixel mobile report with no page overflow. Native Chromium print-to-PDF generated ignored `.local-db/manual/step8-receipt-demo.pdf`; screenshots/proof IDs are retained locally. The demo helper keeps its original idempotency plan in an ignored file so repeating it replays operations rather than duplicating payments. No real money was collected or returned.

## Remaining manual/environment checks

Use the browser/OS Print dialog to choose printer/PDF destination and confirm final paper margins. Committee users must reconcile actual cash/bank/UPI/cheque collections and physical returns, confirm payer/collector and refund/correction reasons, and validate date-range interpretations. Production HTTPS/cookie behavior, deployment grants, backups/restore and retention policy need the actual deployment environment; local HTTP cannot prove production cookies. INR and one flat per payment are current policies; excess credit is rejected. Receipt numbers are unique and may have gaps. Application downgrade must stop payment writes because older Step 7 code does not account for refunds. No Sonar analysis was claimed. Stop at Step 8.
