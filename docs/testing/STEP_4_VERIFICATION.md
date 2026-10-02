# Step 4 verification — 2026-10-02

This is the original implementation snapshot. See [the later Step 4/5 manual verification](STEP_4_5_MANUAL_VERIFICATION.md) for the current checklist results.

Scope: initial society onboarding and committee verification. Migrations 001–007 and completed financial/audit protections are preserved. Additive 008 adds onboarding, invitations and safe event history plus lifecycle/immutability guards.

| Check                                   | Executed result                                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend npm run check                   | Format, lint, strict typecheck, 15 offline tests, build and 8 additive migration validation passed                                                                                 |
| Fresh MySQL 8.4.8 suite                 | 45 tests passed, including preserved database/auth behavior and Step 4 HTTP authorization/concurrency tests                                                                        |
| Frontend npm run check                  | Format, typed/template lint, strict types, 18 unit tests, 3 proxy tests, production build and static-only PWA checks passed                                                        |
| Chromium suite                          | 13 tests passed; all seven wizard steps checked with axe; privacy, pagination, invitation validation, explicit activation and prior shell/auth/offline/installability tests passed |
| Real local PWA + API + restricted MySQL | Complete draft → TLS email → existing-account invitation acceptance → building/flats → person-only resident → maintenance → committee review → explicit activation passed          |
| Real privacy/mobile/cache checks        | Platform private resident API returned 404; platform detail omitted resident names/rates; 390px screenshot/layout passed; no API Cache Storage or auth/token storage               |
| Local upgrade                           | Applied 008 to the owned loopback development database; restart reapplied zero migrations; prior accounts/data retained                                                            |
| Dependency audits                       | Both repositories reported zero vulnerabilities                                                                                                                                    |
| Local secret/diff review                | Tracked/untracked nonignored source and both Git histories scanned locally without findings; git diff --check passed                                                               |

There are 94 automated tests across backend offline/DB and frontend unit/proxy/browser suites, plus the real local browser smoke. The smoke creates synthetic demo societies and leaves them for inspection; it never drops or cleans up existing data. Latest local result and screenshot are ignored in .local-db/manual/step4-verification.json and step4-wizard.png.

Negative coverage includes platform/outsider denial, cross-tenant/nonexistent IDs, forged fields and unsupported sorting/query parameters, CSRF, expired/reissued/replayed invitation links, existing-account proof and identity reuse, stale revisions/from-status, concurrent setup/activation, duplicate buildings/flats, malformed dates/rates, activation before criteria/review, invalid lifecycle jumps, terminal revival and verification/audit tampering. The 52-flat API fixture and browser pagination verify that setup lists do not silently truncate.

The local API/PWA, owned MySQL 3307 and TLS inbox remain running; the unrelated existing database instance is untouched. Human OS installation, production HTTPS/Secure cookies and production SMTP remain deployment checks. Invitation delivery uses a bounded in-process queue; its durability limit is documented in [onboarding security](../security/SOCIETY_ONBOARDING.md).

No later roadmap module is implemented by this checkpoint.
