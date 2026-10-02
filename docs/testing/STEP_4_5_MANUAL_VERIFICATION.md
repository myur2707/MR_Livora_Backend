# Steps 4 and 5 manual verification — 2026-10-02

This report checks the current application against the requested Step 4/5 checklist. Earlier implementation reports remain historical snapshots. No later roadmap feature or new migration was implemented.

The real production Angular app, Express API, restricted runtime account and owned MySQL 8.4.8 were tested together at **http://127.0.0.1:4200**. Invitation delivery used the actual authenticated STARTTLS connection to local Mailpit, whose inbox is at port 8025. Initial manual-account passwords, existing societies and the unrelated XAMPP instance were preserved. Synthetic checklist records are retained for inspection; no cleanup/drop/truncate was run.

## Step 4

| Requested scenario                                         | Observed result                                                                                                                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform creates society and invites initial administrator | PASS: unique draft created through UI; invitation delivered into Mailpit and accepted by the intended existing admin account, without duplicating its global User                                                                          |
| Wizard progress survives refresh                           | PASS: building/flat rows, requirement flags, counts and revision match before/after reload                                                                                                                                                 |
| Committee reviews complete setup and activates             | PASS: person-only initial resident, maintenance and explicit section confirmations; attested committee review followed by a confirmation dialog and Verify & Activate                                                                      |
| Verifier, timestamp and audit event                        | PASS: database status ACTIVE; verifier membership belongs to the signed-in committee user; reviewed/current revision match; verified_at populated; exactly one society.activated entry in each of audit_logs and society_onboarding_events |
| Resident cannot create society                             | PASS: real session selected Blue Heights; API session confirmed RESIDENT as its only society role and no platform access; society creation and list both return 403                                                                        |
| Committee denied platform endpoints                        | PASS: real committee request to platform society list returns 403                                                                                                                                                                          |
| Premature activation                                       | PASS: real incomplete setup activation returns 409, verifier remains null; isolated tests additionally exercise missing required sections and absent/stale review                                                                          |
| Platform lacks private/financial access                    | PASS: real private resident wizard request returns 404, society management/persons and bills paths return 403; platform metadata omits resident names and maintenance rates                                                                |
| Invalid status transition                                  | PASS: DRAFT → SUSPENDED rejected with 409, status stays DRAFT; platform activation after committee review rejected with 403; isolated tests cover lifecycle jumps, suspension/resume, terminal deactivation and concurrent activation      |

Financial business APIs and explicit support access are not implemented. The denied bills-path request is therefore an authorization check, not a test of a functioning financial endpoint. The restricted runtime's inability to read financial tables was also retested in the isolated database suite.

## Step 5

These checks used the activated checklist society and real API/database records. Browser requests were forwarded to the running API without mocking responses.

| Requested scenario                                | Evidence                                                                                                                                                                                       |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Create building, flat and account-free person     | PASS: committee created a building, flat 501 and six people through UI; SQL confirms the owner's Person has no User                                                                            |
| Owner plus tenant                                 | PASS: current owner and tenant coexist in flat 501; current-occupancy API reports two rows                                                                                                     |
| End occupancy, replace tenant, retain history     | PASS: closed the old tenant on 2026-09-30 and added a new tenant from 2026-10-01; two historical and two current occupancies remain visible after refresh                                      |
| Valid imports and matching summaries              | PASS: corrected an invalid area in preview, confirmed 26 flats; confirmed 21 new people plus 22 occupancies, explicitly reusing one existing resident reference; UI summaries match SQL counts |
| Search/filter/pagination                          | PASS: real resident/flat searches each span two pages; page two is bounded to 20 rows; archived-state filters return an empty state; building picker filters the 27 task flats                 |
| Duplicate flat import                             | PASS: row 2 reports DUPLICATE_FLAT; forced confirmation returns 409; total remains 27 flats including the original manually created flat                                                       |
| Invalid building/flat references with row numbers | PASS: missing building and missing flat produce BUILDING_NOT_FOUND at row 2 and FLAT_NOT_FOUND at row 3                                                                                        |
| Malformed/unsupported/oversized file              | PASS: unsupported XLSX and files above 256 KiB rejected in UI; malformed CSV shows an alert; all three submissions also rejected server-side with 400                                          |
| Cross-society flats/residents                     | PASS: foreign-only flat/person reads and updates return 404; society query injection returns 400; spoofed headers cannot change active scope; SQL confirms foreign rows unchanged              |
| Protected society/audit actor fields              | PASS: societyId, society_id, actor_user_id and recorded_by in create requests each rejected with 400                                                                                           |
| Same name/mobile does not merge                   | PASS: manual and CSV pairs with matching names/mobile numbers retain distinct Person IDs and references; none of the imported residents receives a login                                       |

CSV is the supported import format: UTF-8, 256 KiB, up to 500 data rows. XLSX is deliberately rejected; the reason and import threat model remain in [property management security](../security/PROPERTY_MANAGEMENT.md). Contact similarity generates review warnings; only an explicit resident reference can reuse an existing person.

A global Person may legitimately have profiles in multiple societies. The foreign-person access probe selected a Person with no profile in the active society; a shared Person ID may correctly return that society's own profile, never the foreign profile.

Additional live checks found no axe WCAG A/AA violations on the populated building, flat, resident and flat-detail pages or the import page. The populated flat-detail page at 390 px has no document overflow; current occupants and history remain visible. Screenshots were inspected after loading completed, and no unhandled browser errors occurred.

## Executed checks

- Backend `npm run check`: format, lint, strict typecheck, **19 offline tests**, build and validation of **9 unchanged additive migrations** passed.
- Fresh, empty, isolated MySQL schema: **54 integration tests** passed, including the previous financial/auth/onboarding/property boundaries.
- Frontend `npm run check`: format, lint, strict application/template/test/tool checks, **21 unit tests**, **3 proxy tests**, production build and static-only PWA validation passed.
- Full browser regression suite: **18 tests passed**, including wizard, import, accessibility, mobile, auth and cache/offline checks.
- Both complete dependency audits: **0 reported vulnerabilities**.
- Both tracked Git histories: no secrets found; working-tree diff checks passed.

The automated total is **115 tests**, with additional real browser/API/SQL checks. Browser security fixtures are not treated as proof of server authorization; the isolated HTTP suite and real API requests provide that evidence. Live probes pace requests rather than clearing/disabling rate limits. Their scripts, raw evidence, screenshots and credentials stay in ignored local directories.

## Inspect the retained demonstration

Use the generated initial local accounts from ignored `.local-db/manual/TEST_ACCOUNTS.md`. The platform account can view the checklist society's limited metadata. The admin account can select it in the workspace chooser and inspect its buildings, flats, residents, occupancy history and imports.

The checklist society is **Checklist onboarding DEMO_1790963121678** (ID 7), activated at **2026-10-02 17:46:24 UTC**. The management block is **LOCAL_1790963409854**: flat 501 contains the retained owner/tenant history, and flats 502–527 show the imported records.

The `resident@example.invalid` fixture did not accept its originally recorded password; no password reset was performed. The resident permission checks instead used `multi@example.invalid` with its active Blue Heights RESIDENT role, confirmed by the real session endpoint. This account also retains its different role in Green Heights.

Exact synthetic society/resource IDs and verification timestamps are in ignored `.local-db/manual/step45-onboarding-verification.json` and `.local-db/manual/step45-property-verification.json`. Screenshots are in the same directory. Existing records and passwords were not replaced.
