# Resident portal threat model

## Assets, actors and boundaries

Assets include tenant identity/contact details, occupancy dates, issued bills, own payment receipts, notices, private complaint text and immutable audit events. Actors are approved residents, committee members using their own resident view, unauthenticated/pending users, hostile members from the same or another society, and platform administrators without tenant approval.

The untrusted browser sends only resource IDs, allowlisted filters and complaint text. Cookie/CSRF middleware validates requests; backend services reread live session, membership, linked person and role grants in the transaction before querying tenant data. MySQL composite foreign keys and restricted runtime privileges supplement this boundary. Angular guards and switcher options provide usability only. Static PWA assets are public; authenticated API responses cross no service-worker cache boundary.

## Abuse cases and mitigations

| Abuse                                                   | Control and evidence                                                                                                                                                             |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Guess a flat, bill, receipt or complaint ID             | Society plus person/occupancy or submitting-membership predicates on list and detail queries; indistinguishable safe 404; HTTP/MySQL IDOR tests                                  |
| View another payer's receipt in one's own flat          | Receipt and payment history require the effective tenant person as payer; same-flat IDOR test                                                                                    |
| View previous/future occupants' bills                   | Current occupancy plus billing-period start eligibility, ACTIVE member/society and nonarchived building/flat; historical/future/draft tests                                      |
| Change context while an old request is in flight        | Session society reread and compared with captured request context; 409 for stale context; frontend clears data on identity/context change and ignores obsolete/destroyed results |
| Keep access after revocation, expiry or person archival | Live locked user/session/member/person grants are checked in each transaction; browser 401 clears identity and CSRF, removes private child routes; revocation/expiry/link tests  |
| Use platform role or inflated tenant grant              | No platform bypass; named tenant-role capability ceiling; resident remains denied committee/finance routes even with an erroneous finance grant                                  |
| Set society/submitter/status/audit actor in complaint   | Strict input schemas; authenticated scope supplies all protected fields; CSRF, current-flat authorization, transactional audit and rate limits                                   |
| Inject notice/complaint HTML or leak safe errors        | Plain Angular text interpolation, bounded text, centralized error codes and reviewed client messages; browser text/validation and safe-error checks                              |
| Modify completed finance/audits from resident routes    | Read-only finance endpoints, preserved runtime restrictions and append-only migrations; no financial writes added                                                                |
| Read private data offline or through storage            | `no-store` APIs and Angular interceptor, no worker data groups or runtime asset URLs, API navigation exclusion, memory-only views; offline/cache regression tests                |

Identity linkage is an explicit committee-approved database relationship, never a match by name/mobile. With current membership but no occupancy, own profile and published society notices remain available; flats and bills are empty and new complaints are denied. Own receipts/complaints can retain history after an occupancy ends, according to the approved policy. Archived linked profiles or inactive membership remove all portal access.

Read transactions hold shared society/identity locks while performing their authorized projection. Existing property and financial writers serialize with their own validated transaction locks. Revocation that wins first denies the request; a request already authorized within its transaction may complete before a later revocation. New requests revalidate. This is not a promise to retract data already downloaded or printed by an authorized user.

## Minimization, retention and residual limits

No resident directory, other occupants, collector/recorder identities, payment notes, refund/correction reasons or audit payloads are returned. Published notices are currently society-wide; committee publishing must review audience and content before exposing targeted/private announcements in a later step. Complaint text should contain only information needed to resolve the issue; confidential committee notes must not be added to resident-visible description. Profile is read-only to prevent unverified contact changes.

Existing archive/financial retention policy applies; Step 9 introduces no deletion or retention job and does not shorten immutable records. Operational retention periods and a lawful deletion/export process remain deployment decisions. Physical printing, production HTTPS cookie settings, and browser/OS PWA installation require deployment/manual verification. No paid services, gateway, file upload or new third-party package is introduced.
