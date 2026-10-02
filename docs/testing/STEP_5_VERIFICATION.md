# Step 5 verification

This is the original implementation snapshot. See [the later Step 4/5 manual verification](STEP_4_5_MANUAL_VERIFICATION.md) for the current checklist results.

Verified locally on 2 October 2026 with portable Node 24.21.0, npm 11.19.0, MySQL 8.4.8 and Chromium. Only Step 5 was implemented; prior database, authentication, onboarding and static PWA boundaries are preserved.

| Check                      | Result                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend npm run check      | Formatter, ESLint, strict TypeScript, 19 offline tests, build and 9-migration validation pass                                                                                                      |
| Fresh isolated MySQL tests | 54 tests pass, including previous financial/auth/onboarding invariants                                                                                                                             |
| Frontend npm run check     | Formatter, ESLint, strict Angular/TypeScript, 21 unit tests, 3 proxy tests, production build and PWA checks pass                                                                                   |
| Browser suite              | 17 tests pass, including 4 management/import checks, accessibility and private-cache/offline checks                                                                                                |
| Managed local upgrade      | 008→009 applied once; pre-existing table counts unchanged; no data/table drops                                                                                                                     |
| Real browser + API + MySQL | Directory creation, account-free resident, owner/current tenant/prior tenant, closing occupancy, CSV upload/error correction, confirmation, explicit reference reuse, warning acknowledgement pass |
| Mobile/accessibility       | All five management routes pass WCAG2A/AA axe checks; 390px flat details inspected with no page overflow                                                                                           |

The automated count is 114 tests (19 + 54 + 21 + 3 + 17). The real browser smoke uses generated local credentials and actual MySQL/runtime grants, separate from mocked browser regression tests. It respects existing rate limits and pauses before repeated accessibility navigation.

## Positive and negative evidence

- Every list paginates; search wildcards are escaped and sorting uses fixed allowlists. Invalid pages, oversized page size, arbitrary sort/tenant fields fail.
- Foreign and nonexistent building/flat/person IDs return the same unavailable response. Residents and platform-only accounts are denied private management. Revoked membership denies the next request. CSRF is enforced on writes.
- Buildings, flats and resident profiles can be created/edited/archived through strict field schemas. Stale edits conflict; cross-tenant edit/building assignments fail. Archives preserve data and reserve identifiers; active children/current or scheduled occupancy block archive.
- A Person is created without User. Identical name/mobile with distinct references remains distinct. References cannot be reassigned, and imports never merge on contact text.
- OWNER and TENANT coexist; prior tenants remain historical. Invalid/reversed dates and foreign profiles fail. Same-person/type/flat overlap and concurrent duplicates are rejected. Closed occupancy cannot be rewritten/deleted, including by privileged test SQL.
- Malformed quoting/header/column counts, NUL, oversized records and >500 rows are tested. File byte limits are enforced by input validation and the browser. CSV row numbers and ending physical line numbers accompany errors. No domain writes occur at preview.
- Correction replaces/cancels the prior review; cancelled/confirmed/expired staging personal values are cleared. Preview ownership/tenant scope are enforced.
- Changed society data requires revalidation. Warning acknowledgement is required. Confirmation is idempotent, and a forced failure on the second row leaves no building/flat/domain audit from the first row. Completed batch metadata is immutable.
- Existing financial DECIMAL(12,2), restrictive foreign keys and immutable completed records pass unchanged. Runtime privileges still deny financial reads, DDL, role/platform grants and audit mutation.
- PWA tests confirm private directory, occupancy and CSV preview endpoints stay out of caches and fail offline.

No lint/security rules were disabled. CSV uses pinned csv-parse 7.0.3; XLSX is deferred with the reason in the [management security document](../security/PROPERTY_MANAGEMENT.md). Application logs contain safe codes/correlation IDs; CSV payloads and credentials remain in ignored local paths.

## Repeat manual testing

Open http://127.0.0.1:4200, sign in with the generated admin (or multi account) and select Green Meadows as Committee Admin. Credentials are only in ignored .local-db/manual/TEST_ACCOUNTS.md. Use Buildings, Flats, Residents and CSV imports in the sidebar. The successful smoke left a synthetic LOCAL_ building with flats 501–503 and representative owner/history/import records for inspection; its exact IDs are in ignored .local-db/manual/step5-verification.json and screenshot step5-flat-details.png. Earlier incomplete synthetic attempts are retained, with no cleanup of existing data.

Use CSV templates, try an invalid amount, inspect row errors, correct/repreview, then explicitly confirm. Try same flat number, reversed dates, an overlapping occupancy and a stale editor in another tab. Switch to a resident/platform account to confirm hidden links and denied direct management routes. Reload the PWA once to pick up the latest static version.

Operator-only deployment checks remain: reviewed production migrator/runtime grants, encrypted database/backups, monitored staging cleanup, and performance at production-scale directory sizes. Closed history corrections and binary/XLSX attachment handling require separate designs; they were not added.
