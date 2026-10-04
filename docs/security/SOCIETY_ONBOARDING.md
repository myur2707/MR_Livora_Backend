# Step 4: initial society onboarding

This module covers initial setup and lifecycle management only. Resident imports, ongoing resident/flat management, billing and payment APIs remain later steps.

## Actors and privacy

Platform Admin can create/list/view societies, see bounded setup counts and safe onboarding history, invite the initial Committee Admin, add initial buildings/flats, submit for verification, reopen setup, suspend/resume and deactivate. Platform scope has no tenant-context override. It cannot list private residents, read maintenance rates, record committee review or activate a newly configured society. The invitation recipient's name/email is deliberately visible to its issuing platform administrator.

An active Committee Admin membership, unarchived tenant profile, unarchived tenant role and society.members.manage permission are revalidated on every setup request. Setup access works before activation without granting access to normal tenant business APIs. Other society roles, foreign committee memberships and nonexistent identifiers return no setup access. Platform permissions do not imply committee permissions.

The runtime DB user still cannot SELECT bills/payments/receipts, read general tenant audit logs, grant platform roles, modify users' status or run DDL. INSERT of a new ACTIVE global account is limited to verified invitation acceptance in the application.

## Flow and gates

1. Platform creates DRAFT with tenant roles and permission grants, then begins SETUP_IN_PROGRESS.
2. Platform invites the initial Committee Admin. The recipient proves possession of an expiring single-use email link. Existing accounts must sign in as that account; acceptance never resets its password or enables disabled/pending accounts. New recipients choose a password and receive a global Person/User plus tenant profile/membership/role. A new Person is not created merely by sending an invitation.
3. Platform or Committee Admin adds initial buildings and flats. Each building requires 1–100 unique flat numbers. Flat lists are paginated in batches of 50, including the resident flat chooser.
4. Committee enters person-only initial occupancies, preserving dates/history, or explicitly confirms the vacant resident list. Private names are committee-only and are never returned in platform progress/audits.
5. Committee adds initial maintenance configurations and explicitly confirms them. Maintenance lists are paginated in batches of 20. Amounts use DECIMAL strings. Per-square-foot charges require area on every flat.
6. Committee explicitly records a review of the current revision. This moves the society to PENDING_VERIFICATION. Platform can also submit a complete setup to pending, but that does not count as committee review.
7. The reviewing Committee Admin explicitly confirms Verify & Activate. The server checks all criteria again, records verifier membership and UTC timestamp, and sets ACTIVE atomically. There is no platform bypass.

All criteria are required: accepted initial administrator with active account/tenant grants, at least one building/flat and no empty buildings, explicit resident review, explicit maintenance review and at least one configuration, and areas for per-square-foot charges.

| From                 | Allowed targets                                                           |
| -------------------- | ------------------------------------------------------------------------- |
| DRAFT                | SETUP_IN_PROGRESS, DEACTIVATED                                            |
| SETUP_IN_PROGRESS    | PENDING_VERIFICATION, DEACTIVATED                                         |
| PENDING_VERIFICATION | SETUP_IN_PROGRESS, ACTIVE (reviewing committee only), DEACTIVATED         |
| ACTIVE               | SUSPENDED, DEACTIVATED                                                    |
| SUSPENDED            | ACTIVE (previous verification and current criteria required), DEACTIVATED |
| DEACTIVATED          | None                                                                      |

Setup writes are allowed only in SETUP_IN_PROGRESS. Reopening or any setup change invalidates review. Completed verification is immutable and cannot be replaced by resume/deactivation. No deletion occurs. Societies created before migration 008 remain readable platform metadata; no automatic baseline, reset or inferred verifier is performed.

## API

All routes are under /api/v1. Session cookies, exact-origin CSRF and global request limits from Step 3 are preserved. All bodies/paths/queries are strict allowlists.

| Route                                                                          | Access / result                                                 |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| GET /platform/dashboard                                                        | Platform; lifecycle totals only                                 |
| GET/POST /platform/societies                                                   | Platform; paginated metadata / create DRAFT                     |
| GET /platform/societies/:id                                                    | Platform; metadata, progress and safe history                   |
| POST /platform/societies/:id/status                                            | Platform; revision, fromStatus, status                          |
| POST /platform/societies/:id/committee-invitations                             | Platform; revision, email, displayName; generic 202             |
| GET /{platform or onboarding}/societies/:id/structure                          | Scoped platform/committee; initial flats                        |
| POST /{platform or onboarding}/societies/:id/buildings                         | Scoped platform/committee; initial building/flats               |
| GET /onboarding/societies/:id                                                  | Committee; scoped setup progress                                |
| GET/POST /onboarding/societies/:id/residents                                   | Committee; paginated occupancies / person-only entry            |
| GET/POST /onboarding/societies/:id/maintenance                                 | Committee; initial configs / append configuration               |
| POST /onboarding/societies/:id/{residents,maintenance,review,activate}/confirm | Committee; revision and explicit confirmed:true                 |
| POST /onboarding/invitations/inspect                                           | Token proof, CSRF and IP rate limit                             |
| POST /onboarding/invitations/accept                                            | Token proof, CSRF, IP rate limit; password only for new account |

Society pagination allows page 1–10000, pageSize 1–50, optional lifecycle status; fixed ordering. Structure uses page 1–10000 with 50 rows per page; resident and maintenance lists use the same page bounds with 20 rows. Unknown parameters are rejected. GET responses and all API errors are no-store. Datetime instants are ISO UTC strings; DATE fields remain local calendar dates. Angular displays instants with Intl in the society's IANA timezone.

## Threats and concurrency

- IDOR/BOLA and mass assignment: identifiers are not authorization; each transaction rechecks current account/session, platform grant or the specific tenant membership/role/permission graph. Every private query includes society_id.
- Concurrent edits: locks serialize the society/onboarding lease; revision mismatches return safe 409. Lifecycle requests additionally compare fromStatus after activation because verification revisions are immutable. Unique tenant flat/building/config constraints remain authoritative.
- Review race: every setup mutation invalidates review; review is tied to revision and verifier. Two activation requests yield one commit and one conflict.
- Credential/role revocation: locks protect current actor/session and role grants. FOR SHARE protects read-only permission/flat rows without widening runtime privileges; see [MySQL locking reads](https://dev.mysql.com/doc/refman/8.4/en/innodb-locking-reads.html). Future operations changing criteria must use the same society lease.
- Invitation theft/replay: random 256-bit tokens, SHA-256 storage, 72-hour expiry, one pending invite per society, reissue revokes the predecessor, one-use acceptance under locks. Fragments are removed from browser history before API inspection and never persisted. Avoid sharing inbox/token URLs. Invitation acceptance does not auto-login.
- Enumeration: invitation inspection requires an unguessable token before exposing the recipient's own account-exists hint; sending invitations never exposes that hint. Authentication/reset responses remain generic.
- Audit tampering: writes append both minimal general audit records and a dedicated safe onboarding projection. Triggers reject projection updates/deletes and changes to completed verification. Platform never queries private general audit rows.
- SMTP failures: delivery is QUEUED/SENT/FAILED; a bounded queue overflow or delivery failure marks FAILED. Reissue is explicit. The in-process queue is not durable across a crash; inspect stale QUEUED invites and reissue rather than assuming delivery.
- PWA/offline: cache only static shells. Setup APIs, private residents, charges, invitations and auth stay network-only. No long-lived auth/token storage.

## Rollout and grants

Apply additive migration 008 after 001–007 using the separate migrator. It adds three tables and five triggers, with no ALTER/DROP/backfill. Existing data is untouched. Deploy during a maintenance window, inspect checksums/status, apply, grant and then restart the new API.

Existing auth runtime grants remain required. A DBA grants the exact additions in src/database/onboarding-grants.ts: SELECT/INSERT on initial setup identity/tenant tables; INSERT and UPDATE(code) on permissions; UPDATE(status) on societies; SELECT/INSERT/UPDATE on onboarding and invitation tables; SELECT/INSERT on safe onboarding events; INSERT only on general audit_logs. Never grant schema-wide runtime access. Use a specific application host and verified TLS in production; the helper is used only by guarded test/local provisioners, never by the running API.

The managed Windows local:start runner checks the owned loopback MySQL datadir and fixed development schema before applying additive pending migrations and granting the local runtime additions. Stop/start upgrades an already-running old API. Data, credentials and the unrelated MySQL instance are retained.

Run npm run check, then npm run test:db against a new empty livora_test_* schema. The full real-MySQL suite covers prior invariants/auth and Step 4 authorization, invitation/account reuse, strict queries, CSRF, revision conflicts, activation gates, immutable audits and lifecycle preservation.

## Row house setup

Committee resident setup offers separate Flats and Row houses choices. Structure reads accept an optional allowlisted `propertyType=FLAT|ROW_HOUSE` query, filtering both items and totals before pagination using the reserved `ROW_HOUSES` group. Resident creation accepts the same optional field for older-client compatibility and checks it against the tenant-scoped, unarchived property and building before creating a person or occupancy. Forged types, foreign identifiers and archived buildings cannot be used to bypass authorization. Resident details remain committee-only, network-only, and covered by existing revision locks and immutable audit events. No schema migration or new grants are needed.

Structure reads also accept a trimmed `search` query of at most 80 characters. The tenant-scoped property number, building code and building name are matched with escaped literal SQL `LIKE` values before counting and pagination. The picker shows only bounded pages; selecting a result does not change authorization on resident creation.

The platform and committee society setup prefixes expose `POST /row-houses` with strict `{ revision, houses: [{ number, areaSqFt }] }` input, up to 200 unique houses. The authenticated row-house endpoint accepts up to 32 KiB JSON to fit the maximum batch with full-length Unicode numbers and areas; ordinary endpoints retain their 16 KiB limit. The same authentication, tenant membership, CSRF, editable lifecycle and locked revision checks protect setup metadata. The operation creates or reuses the tenant-scoped `ROW_HOUSES` building group and inserts its units using existing flat storage, foreign keys and uniqueness. Wing creation reserves this code; an existing incompatible or archived group produces a safe conflict. No migration or grants change is required.

Assets are property identifiers and optional areas; actors remain Platform Admin during initial setup and the authorized committee. Client numbers, areas and revisions cross the API boundary and are validated. Scope overrides, duplicates, concurrent submissions and cross-tenant requests cannot bypass existing permissions or uniqueness. One transaction inserts the whole range, advances revision, invalidates review and appends the existing `building.created` setup/audit event for the committed property addition. Overlaps roll back all inserts and preserve existing data. No resident/financial access is added; private data remains network-only. Existing rows are not reclassified or overwritten. Integration tests cover lifecycle, scope, CSRF, replay races, rollback and later ranges.

## Multiple-wing setup batch

`POST /api/v1/platform/societies/:id/buildings/batch` and the committee-scoped `/api/v1/onboarding/societies/:id/buildings/batch` accept a strict revision/buildings payload. They use the same authenticated scope checks, CSRF protection, row lock and editable-state policy as single-building setup. The server validates unique wing codes, up to 10 wings, up to 100 flats each and at most 500 flats total. Flat numbers may repeat across different wings. All inserts, the single revision advance and a `building.created` audit event per wing commit together. A late uniqueness conflict rolls back every new wing and flat; concurrent/stale revisions cannot replay a committed batch. Existing building creation remains supported.

This bounded operation adds no database migration or runtime grants. The authenticated batch route alone accepts up to 128 KiB JSON so the maximum 500-flat payload fits; ordinary API JSON remains limited to 16 KiB. Initial Platform Admin setup does not grant private resident/financial read access. Batch payloads contain only wing/flat setup metadata; logs must not include raw request bodies. The UI retains an unsuccessful draft for correction, without automatically overwriting existing wings. Real-MySQL tests cover atomic rollback, concurrent duplicate requests, lifecycle, tenant permissions, CSRF and audit integrity.
