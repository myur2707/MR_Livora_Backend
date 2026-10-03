# Step 11: dashboards and reports

The platform dashboard exposes only society lifecycle counts, total societies, pending verification and its UTC refresh timestamp. It never reads tenant financial or resident tables. A platform role alone cannot use committee dashboards, reports or exports.

`GET /api/v1/society/dashboard` requires `society.dashboard.manage`. Active Committee Admin, Committee Member and Accountant roles may receive this explicit grant. It returns active-flat counts, current occupancy counts/types, pending complaints and five recent published notices. Financial cards additionally require `society.finance.read`; without it `finance` is null. Billing balances and month-to-date collections reuse report projections in the same transaction. Residents keep their Step 9 dashboard and privacy rules.

## Reports and access

`GET /api/v1/society/reports/:kind` returns server-controlled columns, a page of rows, total matching rows, exact monetary summaries over **all** matching rows, society time zone, date range and current balance date. Pages are 1–10000; page sizes are 1–50 (UI: 20). Every call revalidates session, active society, membership, effective tenant person and role/permission ceilings. Tenant identifiers come from validated session context, never report query parameters. Referenced building/flat/period/collector identifiers must belong to that society; foreign identifiers return 404.

| Kind            | Required permission and role ceiling     | Date filter                                        | Totals                                                                           |
| --------------- | ---------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------- |
| outstanding     | finance.read; Committee Admin/Accountant | Billing-period start                               | Matching issued bills with positive current outstanding                          |
| billing         | finance.read; Committee Admin/Accountant | Billing-period start                               | Issued net bill totals, credits, paid after returns, outstanding, credit balance |
| payments        | finance.read; Committee Admin/Accountant | Original payment date                              | Original payments, all their refunds/reversals, current net amount               |
| collection      | finance.read; Committee Admin/Accountant | Each collection/refund/reversal event date         | Gross collections, refunds, reversals, signed net                                |
| cash-collection | finance.read; Committee Admin/Accountant | Each CASH event date                               | Same metrics, including only events whose actual method is CASH                  |
| residents       | members.manage; Committee Admin          | Tenant person creation date, society local time    | Count; includes people without accounts                                          |
| flat-occupancy  | members.manage; Committee Admin          | Occupancy interval overlaps range, inclusive dates | Count; owner/tenant/history remain separate                                      |

Permission keys above have the `society.` prefix. Report responses contain only the allowlisted display columns and a row identifier, not global user/person identifiers. Resident contact data is restricted to the existing directory-management permission. Financial reports cannot be used to browse the resident directory. Current occupancy excludes archived people/buildings/flats; archived, ended and future records remain available through filters.

Query fields: `page`, `pageSize`, `from`, `to`, `q`, `status`, `sort`, `direction`, `buildingId`, `flatId`, `periodId`, `collectorUserId`, `method`, `occupancyType`. Unknown fields and filters inappropriate for the selected report fail. Search is a literal parameterized substring. Sorts are allowlisted (`id`, `date`, `name`, `amount`, `outstanding` as applicable), with deterministic row/event tie breakers. SQL identifiers never come directly from client input. Collectors may be historical society collectors even if they no longer collect payments.

## Dates, money and reconciliation

Provide both dates or neither. Calendar dates must be valid, between 2000 and 2100, ordered and cover at most 366 inclusive days. Stored instants remain UTC. Resident creation filters convert local day boundaries to a half-open UTC interval using the society IANA time zone; daylight-saving days may have 23 or 25 hours. Business DATE columns already represent society calendar dates. Occupancy filters use inclusive start/end interval overlap; CURRENT is evaluated as of today, not reconstructed at a historical date.

Billing/outstanding and payment reports show **current balances**, not a historical ledger balance at the end of the filter range. Billing date filters select periods; payment date filters select payment cohorts and include all recorded returns for those payments. Billing summary `billed` is the issued net amount after bill credits; `credits` is separately disclosed. Draft rows can appear in the billing list but never contribute to issued-bill totals. Existing finalized bill snapshots remain unchanged.

Collection reports use a shared append-only event projection: original collections are positive, refunds and full reversals negative. Refunds use their actual refund method/date; reversals use the original method and explicit operation date. Legacy reversals lacking an operation-date detail retain their recorded UTC calendar date and are explicitly labeled `LEGACY_UTC`; newer events are `BUSINESS_DATE`. No historical date is invented or backfilled. Cash totals describe digitally recorded events; reconciliation with physical cash remains the committee's responsibility.

MySQL DECIMAL sums and subtraction remain exact; returned money is normalized through BigInt minor units. Aggregate totals may exceed an individual DECIMAL(12,2) record limit without precision loss. No authoritative JavaScript floating-point money calculation is introduced. Counts and totals share a transaction snapshot with paginated rows.

## CSV exports

`GET /api/v1/society/reports/:kind/export` requires both the report's read permission and explicit `society.reports.export`, rechecked in the transaction. It exports all matching rows, independent of page, up to 5000 rows. Larger results return 422 `EXPORT_TOO_LARGE` before loading rows; they are never silently truncated. The server limits exports to 10 per authenticated user per 15 minutes.

Exports use UTF-8 BOM, CRLF records, quoted cells and doubled embedded quotes. Cells beginning with `=`, `+`, `-`, `@`, tab, CR or LF, including formula prefixes hidden by leading whitespace/control/BOM characters, receive an apostrophe. Negative monetary cells are intentionally protected as text. This prevents spreadsheet evaluation while preserving literal names, multiline text and exact decimal strings. Exports use fixed validated filenames and `Cache-Control: no-store`. Audit records contain actor, society, report kind, row count and date range, never exported contacts, search text or CSV bodies.

## Safe rollout

Step 11 needs **no new schema migration**. Migrations 001–014 stay unchanged. After Step 10 migrations are present, run `npm run db:report-permissions` using the separate migration identity. This additive, repeatable transaction adds dashboard permission to canonical active committee/accountant roles already granted dashboard.read, and export permission only to canonical Committee Admin/Accountant roles already granted finance.read. It does not restore revoked finance/directory permissions or grant platform/resident access. New societies receive the updated canonical permissions. Runtime uses existing SELECT/audit privileges; no new broad grants or deletion permissions are required.

For the managed local stack, `npm run local:stop` followed by `npm run local:start` rebuilds both repositories and applies permission provisioning without resetting accounts or data. There is no destructive rollback. To remove a new capability, revoke its role-permission assignment explicitly while retaining report/export audit history.
