# Step 5: society property and resident management

Only an active COMMITTEE_ADMIN with the existing society.members.manage permission may use this module. Each request independently checks an active account/session, the stored selected society, active membership and tenant profile, role/permission grants, and ACTIVE/unarchived society. Platform scope grants no private directory access. Guards and sidebar links are UX only.

## API contract

All paths are relative to /api/v1/society. JSON bodies are strict allowlists; unknown fields, client society/user/role fields, invalid IDs/dates/decimals and unsupported sort fields fail. All IDs and decimals are strings.

| Resource        | Endpoints / mutable fields                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------- |
| buildings       | GET list/detail, POST create, PUT /:id edit; code, name                                                   |
| flats           | GET list/detail, POST create, PUT /:id edit; buildingId, flatNumber, areaSqFt                             |
| persons         | GET list/detail, POST create, PUT /:id edit; displayName, contactEmail, contactPhone, reference           |
| archive         | POST /buildings/:id/archive, /flats/:id/archive, /persons/:id/archive; version                            |
| occupancies     | GET/POST /flats/:flatId/occupancies; personId, occupancyType, startsOn, endsOn                            |
| close occupancy | POST /flats/:flatId/occupancies/:id/close; version, endsOn                                                |
| imports         | GET list/detail, GET /imports/:id/rows; POST /imports/preview, /:id/revalidate, /:id/cancel, /:id/confirm |

List responses have items,total,page,pageSize. page defaults 1 (maximum 10000), pageSize defaults 20 (maximum 50). Directory filters: q (100 characters), state active/archived/all, direction asc/desc. Buildings sort by code/name/createdAt; flats by flatNumber/buildingCode/areaSqFt/createdAt with optional buildingId; people by displayName/reference/createdAt. Sort identifiers map to fixed SQL expressions; values are parameterized; LIKE wildcards are escaped. Occupancies filter current/history/all and optional occupancyType. Imports show only the current administrator's own batches.

PUT and archive/close require the version fingerprint returned by GET. Fingerprints cover the current whitelisted projection, with canonical JSON ordering and UTC timestamp serialization. A stale value returns 409; the client must refresh, with no automatic overwrite. Returning a record to the exact same values is intentionally allowed (value-based optimistic concurrency).

All writes use a transaction and lock the society after the session/account lock; membership and grants are then checked under locks. Cooperating API writes in the same society serialize, including imports and overlaps. This deliberately favors predictable bounded batches over parallel writes within one society. Database composite foreign keys and unique keys remain authoritative. Operators must not use direct SQL for resident changes, since interval overlap across arbitrary dated rows is a service invariant.

## Resident identity and history

Creating a resident inserts Person plus a society-owned profile and reference; it never creates User or membership. Name/email/mobile are contact attributes, never identity proof. Different references create different people even when names/mobile match; imports emit warnings requiring acknowledgement. A reference is unique per society, permanent once assigned and retained after archive. Legacy profiles without a reference receive one when edited. Sharing a global Person between societies requires verified identity through the earlier onboarding flow; this module cannot attach arbitrary global IDs.

OWNER, TENANT, FAMILY_MEMBER and AUTHORIZED_OCCUPANT are allowed. Co-owners and simultaneous owner/tenant are allowed. Overlapping inclusive intervals for the same person/flat/type are rejected, including batch duplicates and concurrent requests. Different people may share a flat/type. Current means start <= society-local today and end is null or >= today; history means end < today; all includes scheduled occupancies. DATE values remain calendar dates; UTC instants have ISO serialization and are displayed using the society IANA timezone when a local-time display is needed.

Only an open occupancy may be closed, with end >= start. Identity, type, start and closed history cannot be changed or deleted, including through SQL triggers. Close the original and append a new occupancy for future changes; closed history corrections require a separately reviewed append-only design. No business APIs for financial changes are added.

Archives never delete. Buildings require every child flat archived; flats and people require no current/future occupancy; people with an active membership cannot be archived. Historical occupancies, bills, payments, receipts and audits remain intact. Archived identifiers remain reserved and archived records are read-only. Initial Step 4 verifier/timestamp remain historical evidence; ongoing directory edits do not rewrite committee verification. Existing lifecycle resume gates still apply.

## CSV review and confirmation

Pinned csv-parse 7.0.3 handles bounded UTF-8 CSV. XLSX is deferred: no spreadsheet/archive library was selected; CSV supports the requested review flow without ZIP expansion, macros, embedded files or spreadsheet format ambiguity. [Parser options](https://csv.js.org/parse/options/), [synchronous API](https://csv.js.org/parse/api/sync/) and [record limits](https://csv.js.org/parse/options/max_record_size/) describe the primary library behavior.

Limits: 256 KiB UTF-8 CSV, 4096 characters per record, 1–500 data rows, 20 unexpired reviews per administrator, 24-hour preview expiry. Preview rate is 20 per user per 15 minutes plus the existing global/IP rate. Auth/tenant permission checks precede the larger 400 KiB JSON preview parser; ordinary JSON remains limited to 16 KiB. Filename must end .csv with no path separators. The browser rejects invalid UTF-8, binary/NUL is rejected, columns/order/quoting are verified, all fields are validated server-side. No file is stored or served; CSV is inert text, not executed or rendered as HTML, and there is no private CSV export. Antivirus is unnecessary for this text-only ingestion path; adding downloadable binary attachments/XLSX requires an explicit malware scanning and archive-limit design.

FLATS template: building_code,building_name,flat_number,area_sq_ft.
RESIDENTS template: person_reference,display_name,contact_email,contact_phone,building_code,flat_number,occupancy_type,starts_on,ends_on.
Optional values are blank; area uses two decimals. Residents require existing active building/flat. Only an explicit person_reference reuses an existing tenant person, with matching supplied details; details are never silently updated. One reference can occupy multiple flats/types without duplicating Person. Duplicate flats, repeated rows, conflicting reference attributes and overlaps are errors.

Preview parses, validates and stores tenant/creator-scoped review rows with logical CSV row numbers (header row 1) and physical ending line numbers. It creates no buildings/flats/people/occupancies. Errors and warnings identify field/code/message without echoing SQL. Correction uses an edited/reuploaded CSV with replaceBatchId; a successful new preview atomically cancels/minimizes the old review. Revalidation refreshes current database findings. The UI disables confirmation after local CSV edits until a new preview.

Confirmation requires confirmed=true, both sourceHash/reviewHash and acknowledgeWarnings when needed. It rechecks current tenant data and resolved resource IDs, then imports the entire bounded batch plus audits in one transaction. Changed decisions return REVALIDATE_REQUIRED; unexpected row constraints return a safe IMPORT_ROW_CONFLICT with row number and roll back all prior rows. Repeated confirmation returns the original summary, including concurrent retries. No automatic retries or partial commits. Split larger files into separately reviewed batches.

Confirmed/cancelled rows have personal payload/errors/warnings cleared; bounded maintenance clears expired payloads every minute (20 batches per tick). Confirmation evidence, hashes, row/line numbers and counts are retained and completed batch metadata is immutable. Expired previews are inaccessible even before cleanup; monitor maintenance availability/backlog. Staged PII at rest is protected by DB access and deployment encryption/backups. The browser holds CSV in component memory only; reload requires reupload for corrections. Starting another import clears tab content but the earlier staged review remains in your import history until cancelled/expired. No CSV/resident/API data enters localStorage or PWA caches.

## Threat model and rollout

Assets: tenant resident/contact data, property/occupancy history, pending CSV and immutable import evidence. Attackers: anonymous requests, residents/other tenants, forged roles/resources, malicious CSV and competing/stale submissions. Mitigations: fresh tenant authorization, composite keys, fixed SQL identifiers, strict schemas, CSRF/exact origin, limits, safe error/log handling, transactions, explicit references, immutable history and expiry/minimization. No private resident values appear in application/audit logs; audits record action/entity plus bounded counts.

Apply additive migration 009 with the migrator, then grantPropertyRuntime alongside existing auth/onboarding grants. New grants include SELECT/INSERT on staging/reference tables, column-specific updates on directory/occupancy/import tables, and no DELETE/DDL, finance reads, global account status writes or platform grants. The isolated local runner refreshes these grants automatically. See [schema](../database/PROPERTY_SCHEMA.md) and [verification](../testing/STEP_5_VERIFICATION.md). Stop at Step 5.
