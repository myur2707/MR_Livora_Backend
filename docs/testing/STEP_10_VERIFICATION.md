# Step 10 verification

Follow-up: [real browser/API manual checklist verification](STEP_10_11_MANUAL_VERIFICATION.md) on 4 October 2026 covers every requested Step 10 and Step 11 checklist item.

Verified 3 October 2026 with pinned Node 24, MySQL 8.4 and Angular 22. No dependency upgrade or external integration was added.

| Check                                        | Result                                                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Backend format/lint/typecheck/unit/build     | Passed; 30 unit tests                                                                                  |
| Migration validation                         | Passed; 14 ordered additive migrations; 001–013 unchanged                                              |
| Real MySQL/runtime HTTP integration          | Passed; 108 tests on a fresh empty isolated schema                                                     |
| Frontend format/lint/typecheck/unit          | Passed; 30 unit tests                                                                                  |
| Proxy/build/PWA validation                   | Passed; three proxy tests, production manifest/static worker, no private data groups                   |
| Full Chromium browser suite                  | Passed; 46 tests with one worker, including four community scenarios and existing cache/offline checks |
| Both dependency audits                       | Zero vulnerabilities                                                                                   |
| Nonignored source Gitleaks / git diff review | No leaks or whitespace errors; no generated/local secrets or changed applied migrations                |

Total: **217 tests passed** across the regular suites; focused duplicate database scenarios are not added to this total. Early verification exposed numeric revisions returned as strings by MySQL COALESCE and a locking read requiring a broader complaints privilege. Revision DTOs/comparisons now use safe bounded integers; complaint updates serialize under the existing society lock while legacy complaints retain SELECT/INSERT-only runtime privileges. Full final suites passed without weakening security assertions.

Real database scenarios cover draft/edit/publish/archive visibility and timestamps, literal unsafe text round-tripping, categorized resident submission, own history, required eligible tenant assignees, complete status sequence, concurrent updates with one revision winner, pagination/filters, CSRF and protected fields, resident role ceilings, cross-society Committee Member actions, legacy OPEN compatibility, foreign keys and immutable history. Browser scenarios exercise associated field validation, text interpolation without injected elements, publishing/archive, all complaint transitions/history, typed-route denial and 320px light/dark accessibility.

The managed stack was rebuilt/restarted at `http://127.0.0.1:4200` with API 3000 and owned MySQL 3307. Its updater applied one additive migration and new permission/grant provisioning; no account reset, seed rerun, data deletion or unrelated MySQL 3306 changes were performed. Existing users/password hashes/statuses, memberships, occupancies and captured financial/audit records are checked with before/after fingerprints; old migration checksums remain intact. Live read-only committee screens and API lists use existing local credentials. Evidence remains in ignored local files.

Manual/deployment checks remain actual device touch behavior, review of publication content, and production HTTPS cookie/proxy configuration. Attachments, external notifications and read tracking are outside Step 10. Step 11 is separately authorized by the user's sequential request and starts after these completion gates.
